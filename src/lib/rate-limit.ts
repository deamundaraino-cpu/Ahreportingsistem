/**
 * rate-limit.ts — Pool de concurrencia + reintentos con backoff por plataforma.
 *
 * Objetivo: desacoplar "velocidad" de "riesgo de baneo". El worker puede
 * paralelizar la lógica todo lo que quiera; aquí controlamos la TASA FÍSICA de
 * peticiones salientes a cada API (Meta, TikTok, Hotmart, GA4) con un límite de
 * concurrencia + separación mínima entre arranques, y reintentamos los throttles
 * transitorios (429 / códigos de rate-limit) con backoff exponencial + jitter.
 *
 * ⚠️ LIMITACIÓN: los limiters son singletons EN-MEMORIA del proceso. Con un
 * único contenedor de la app acotan todas sus peticiones a la vez, pero NO se
 * coordinan con otros procesos (una segunda réplica, scripts lanzados a mano).
 * Aceptable a esta escala (10–50 clientes); un límite verdaderamente global
 * requeriría Redis (fuera de alcance).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { esTimeoutDeFetch } from './fetch-json';

export type Platform = 'meta' | 'tiktok' | 'hotmart' | 'ga4';

/** Gate estilo p-limit: máx. concurrencia + separación mínima entre arranques. */
class Limiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private lastStart = 0;

  constructor(
    private max: number,
    private minGapMs = 0
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    if (this.minGapMs > 0) {
      const wait = this.lastStart + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastStart = Date.now();
    }
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

// Topes conservadores por plataforma (concurrencia, separación mínima ms).
// Sustentado en límites típicos: Meta ~ pocas req/s sostenidas; TikTok QPS bajo;
// Hotmart paginación con cursor (de por sí casi serial); GA4 cuota holgada.
const limiters: Record<Platform, Limiter> = {
  meta: new Limiter(6, 120),
  tiktok: new Limiter(4, 150),
  hotmart: new Limiter(3, 0),
  ga4: new Limiter(5, 0),
};

/** Encola `fn` en el pool de la plataforma indicada. */
export function limit<T>(platform: Platform, fn: () => Promise<T>): Promise<T> {
  return limiters[platform].run(fn);
}

// ─── Guarda de presupuesto de tiempo ─────────────────────────────────────────
// Las rutas de sync trabajan con un presupuesto por petición.
// Para no consumir todo el presupuesto en reintentos, dejamos de reintentar pasado
// el deadline (se devuelve el último resultado/lanza el último error tal cual).
//
// El deadline vive POR PETICIÓN en un AsyncLocalStorage. Antes era una variable
// global del proceso: `/api/worker` la fijaba a now+50s y, en el servidor de larga
// duración del VPS (el sync-worker corre el servidor de Next), `/api/worker/hotmart`
// —que nunca la toca— heredaba ese deadline ya vencido: todas las llamadas a
// Hotmart posteriores del mismo proceso se quedaban SIN reintentos.

/** Mutable a propósito: `setRetryDeadline` dentro del contexto lo ajusta sin abrir otro. */
type ContextoDeadline = { deadlineMs: number };
const deadlinePorPeticion = new AsyncLocalStorage<ContextoDeadline>();

/** Deadline heredado: solo lo ven las llamadas hechas FUERA de cualquier `conDeadline`. */
let retryDeadlineGlobalMs = Infinity;

/**
 * Ejecuta `fn` con un deadline de reintentos propio. `ms` es un instante
 * ABSOLUTO en epoch ms, igual que en `setRetryDeadline`:
 *
 *   conDeadline(Date.now() + 50_000, () => correrSync())
 *
 * Todo lo que cuelgue de `fn` (awaits, timers, promesas en paralelo) ve este
 * deadline y solo este: ni el global ni el de otra petición concurrente. Cada
 * llamada abre un contexto nuevo, así que un `conDeadline` anidado sustituye al
 * exterior mientras dura y al salir vuelve el de fuera.
 */
export async function conDeadline<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return deadlinePorPeticion.run({ deadlineMs: ms }, fn);
}

/**
 * Fija el deadline de reintentos (epoch ms absoluto).
 *  • Dentro de `conDeadline`: ajusta el de ESE contexto; ni el global ni el de
 *    otras peticiones se enteran.
 *  • Fuera: el comportamiento de siempre, un valor global para todo el proceso.
 *    En un servidor de larga duración eso contamina las llamadas posteriores de
 *    otras rutas; el código nuevo debe usar `conDeadline`.
 */
export function setRetryDeadline(absoluteMs: number) {
  const ctx = deadlinePorPeticion.getStore();
  if (ctx) ctx.deadlineMs = absoluteMs;
  else retryDeadlineGlobalMs = absoluteMs;
}

/** Deadline vigente para la llamada en curso: el de su contexto o, sin contexto, el global. */
function deadlineVigente(): number {
  return deadlinePorPeticion.getStore()?.deadlineMs ?? retryDeadlineGlobalMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parsea el header Retry-After (segundos o fecha HTTP) → ms, o null. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (!Number.isNaN(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

type Verdict = { throttled: boolean; retryAfterMs?: number | null };

/**
 * Ejecuta `fn` a través del pool de la plataforma con reintentos por throttle.
 * `classify(result, error)` decide si la respuesta/el error es un throttle.
 */
export async function withRetry<T>(
  platform: Platform,
  fn: () => Promise<T>,
  classify: (result: T | undefined, error: any) => Verdict,
  maxRetries = 4
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let result: T | undefined;
    let error: any;
    try {
      result = await limit(platform, fn);
    } catch (e) {
      error = e;
    }

    const verdict = classify(result, error);
    const exhausted = attempt >= maxRetries || Date.now() >= deadlineVigente();
    if (!verdict.throttled || exhausted) {
      if (error !== undefined) throw error;
      return result as T;
    }

    const base = verdict.retryAfterMs ?? Math.min(30_000, 500 * 2 ** attempt);
    const jitter = Math.random() * base * 0.3;
    await sleep(base + jitter);
  }
}

// ─── Respuesta buffereada ─────────────────────────────────────────────────────
// fetch normal solo deja leer el body una vez. Para que el clasificador inspeccione
// el JSON (Meta/TikTok devuelven 200 con error en el body) Y el call-site lo vuelva
// a leer, buffereamos el cuerpo una sola vez y exponemos json()/text() idempotentes.
export interface BufferedResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  parsed: any;
  json: () => Promise<any>;
  text: () => Promise<string>;
}

async function bufferedFetch(url: string, init?: RequestInit): Promise<BufferedResponse> {
  const res = await fetch(url, init);
  const raw = await res.text();
  let parsed: any = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    parsed,
    json: async () => parsed,
    text: async () => raw,
  };
}

/** ¿Es un error de red (sin respuesta) que conviene reintentar? */
function isNetworkError(error: any): boolean {
  return error instanceof TypeError; // fetch lanza TypeError en fallos de red/DNS
}

function httpThrottled(res: BufferedResponse): Verdict {
  if ([429, 500, 502, 503, 504].includes(res.status)) {
    return { throttled: true, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
  }
  return { throttled: false };
}

/**
 * Meta Graph API: devuelve HTTP 200 con `error.code` en throttles.
 *  4   = app-level rate limit
 *  17  = user request limit reached
 *  32  = page-level throttle
 *  613 = calls-per-second limit
 *  subcódigos 2446079 / 1487390 = límites de Ads API
 */
export function metaFetch(url: string, init?: RequestInit): Promise<BufferedResponse> {
  return withRetry<BufferedResponse>(
    'meta',
    () => bufferedFetch(url, init),
    (res, error) => {
      if (error) return { throttled: isNetworkError(error) };
      if (!res) return { throttled: false };
      const http = httpThrottled(res);
      if (http.throttled) return http;
      const code = res.parsed?.error?.code;
      const sub = res.parsed?.error?.error_subcode;
      if ([4, 17, 32, 613].includes(code) || [2446079, 1487390].includes(sub)) {
        return { throttled: true };
      }
      return { throttled: false };
    }
  );
}

/**
 * TikTok Business API: devuelve HTTP 200 con `code !== 0`.
 *  40100 = too many requests / QPS excedido
 *  40016 = límite de frecuencia
 *  50002 = service busy (transitorio)
 */
export function tiktokFetch(url: string, init?: RequestInit): Promise<BufferedResponse> {
  return withRetry<BufferedResponse>(
    'tiktok',
    () => bufferedFetch(url, init),
    (res, error) => {
      if (error) return { throttled: isNetworkError(error) };
      if (!res) return { throttled: false };
      const http = httpThrottled(res);
      if (http.throttled) return http;
      if ([40100, 40016, 50002].includes(res.parsed?.code)) return { throttled: true };
      return { throttled: false };
    }
  );
}

/** Tope de cada intento de una llamada a Hotmart, lectura del cuerpo incluida. */
export const HOTMART_TIMEOUT_MS = 20_000;

/**
 * Hotmart: throttle por HTTP 429 / 5xx.
 *
 * Sin `init.signal`, cada INTENTO lleva su propio `AbortSignal.timeout` (uno
 * compartido llegaría ya vencido al reintento). Antes no había ninguno: una
 * conexión que Hotmart dejaba colgada colgaba la corrida entera en el worker
 * VPS, que no tiene tope de tiempo. Ese timeout propio se reintenta
 * igual que un error de red. Si el `signal` lo pasa quien llama, su abort se
 * respeta: ni se sustituye ni se reintenta.
 *
 * Meta y TikTok siguen sin tope por defecto: no se les pone uno sin medir antes
 * cuánto tardan sus insights más pesados.
 */
export function hotmartFetch(url: string, init?: RequestInit): Promise<BufferedResponse> {
  const signalPropio = !init?.signal;
  return withRetry<BufferedResponse>(
    'hotmart',
    () =>
      bufferedFetch(
        url,
        signalPropio ? { ...init, signal: AbortSignal.timeout(HOTMART_TIMEOUT_MS) } : init
      ),
    (res, error) => {
      if (error) {
        return { throttled: isNetworkError(error) || (signalPropio && esTimeoutDeFetch(error)) };
      }
      if (!res) return { throttled: false };
      return httpThrottled(res);
    }
  );
}

/**
 * GA4 (cliente gRPC, no fetch): reintenta en RESOURCE_EXHAUSTED (8) / UNAVAILABLE (14).
 * Uso: ga4Run(() => client.runReport(...)).
 */
export function ga4Run<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry<T>('ga4', fn, (_result, error) => {
    if (error && [8, 14].includes(error.code)) return { throttled: true };
    return { throttled: false };
  });
}
