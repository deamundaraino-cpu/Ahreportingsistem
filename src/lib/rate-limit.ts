/**
 * rate-limit.ts — Pool de concurrencia + reintentos con backoff por plataforma.
 *
 * Objetivo: desacoplar "velocidad" de "riesgo de baneo". El worker puede
 * paralelizar la lógica todo lo que quiera; aquí controlamos la TASA FÍSICA de
 * peticiones salientes a cada API (Meta, TikTok, Hotmart, GA4) con un límite de
 * concurrencia + separación mínima entre arranques, y reintentamos los throttles
 * transitorios (429 / códigos de rate-limit) con backoff exponencial + jitter.
 *
 * ⚠️ LIMITACIÓN (serverless): los limiters son singletons EN-MEMORIA, así que solo
 * acotan UNA invocación serverless. El cron diario corre todos los clientes en una
 * sola invocación (sí acota la ráfaga global) y el sync manual es un cliente por
 * invocación (sí acota el escenario que optimizamos). NO coordina invocaciones
 * concurrentes distintas — aceptable a esta escala (10–50 clientes). Un límite
 * verdaderamente global requeriría Redis/Upstash (fuera de alcance).
 */

export type Platform = 'meta' | 'tiktok' | 'hotmart' | 'ga4'

/** Gate estilo p-limit: máx. concurrencia + separación mínima entre arranques. */
class Limiter {
    private active = 0
    private queue: Array<() => void> = []
    private lastStart = 0

    constructor(private max: number, private minGapMs = 0) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active >= this.max) {
            await new Promise<void>((resolve) => this.queue.push(resolve))
        }
        this.active++
        if (this.minGapMs > 0) {
            const wait = this.lastStart + this.minGapMs - Date.now()
            if (wait > 0) await sleep(wait)
            this.lastStart = Date.now()
        }
        try {
            return await fn()
        } finally {
            this.active--
            this.queue.shift()?.()
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
}

/** Encola `fn` en el pool de la plataforma indicada. */
export function limit<T>(platform: Platform, fn: () => Promise<T>): Promise<T> {
    return limiters[platform].run(fn)
}

// ─── Guarda de presupuesto de tiempo ─────────────────────────────────────────
// En Vercel Hobby la función se corta a 60s (el worker self-hosted no tiene tope).
// Para no consumir todo el presupuesto en reintentos, dejamos de reintentar pasado
// el deadline (se devuelve el último resultado/lanza el último error tal cual).
let retryDeadlineMs = Infinity
/** Llamar al inicio de la corrida: setRetryDeadline(Date.now() + 50_000) en Vercel. */
export function setRetryDeadline(absoluteMs: number) {
    retryDeadlineMs = absoluteMs
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

/** Parsea el header Retry-After (segundos o fecha HTTP) → ms, o null. */
function parseRetryAfter(value: string | null): number | null {
    if (!value) return null
    const secs = Number(value)
    if (!Number.isNaN(secs)) return Math.max(0, secs * 1000)
    const date = Date.parse(value)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
    return null
}

type Verdict = { throttled: boolean; retryAfterMs?: number | null }

/**
 * Ejecuta `fn` a través del pool de la plataforma con reintentos por throttle.
 * `classify(result, error)` decide si la respuesta/el error es un throttle.
 */
export async function withRetry<T>(
    platform: Platform,
    fn: () => Promise<T>,
    classify: (result: T | undefined, error: any) => Verdict,
    maxRetries = 4,
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        let result: T | undefined
        let error: any
        try {
            result = await limit(platform, fn)
        } catch (e) {
            error = e
        }

        const verdict = classify(result, error)
        const exhausted = attempt >= maxRetries || Date.now() >= retryDeadlineMs
        if (!verdict.throttled || exhausted) {
            if (error !== undefined) throw error
            return result as T
        }

        const base = verdict.retryAfterMs ?? Math.min(30_000, 500 * 2 ** attempt)
        const jitter = Math.random() * base * 0.3
        await sleep(base + jitter)
    }
}

// ─── Respuesta buffereada ─────────────────────────────────────────────────────
// fetch normal solo deja leer el body una vez. Para que el clasificador inspeccione
// el JSON (Meta/TikTok devuelven 200 con error en el body) Y el call-site lo vuelva
// a leer, buffereamos el cuerpo una sola vez y exponemos json()/text() idempotentes.
export interface BufferedResponse {
    ok: boolean
    status: number
    headers: Headers
    parsed: any
    json: () => Promise<any>
    text: () => Promise<string>
}

async function bufferedFetch(url: string, init?: RequestInit): Promise<BufferedResponse> {
    const res = await fetch(url, init)
    const raw = await res.text()
    let parsed: any = null
    try {
        parsed = raw ? JSON.parse(raw) : null
    } catch {
        parsed = null
    }
    return {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        parsed,
        json: async () => parsed,
        text: async () => raw,
    }
}

/** ¿Es un error de red (sin respuesta) que conviene reintentar? */
function isNetworkError(error: any): boolean {
    return error instanceof TypeError // fetch lanza TypeError en fallos de red/DNS
}

function httpThrottled(res: BufferedResponse): Verdict {
    if ([429, 500, 502, 503, 504].includes(res.status)) {
        return { throttled: true, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) }
    }
    return { throttled: false }
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
            if (error) return { throttled: isNetworkError(error) }
            if (!res) return { throttled: false }
            const http = httpThrottled(res)
            if (http.throttled) return http
            const code = res.parsed?.error?.code
            const sub = res.parsed?.error?.error_subcode
            if ([4, 17, 32, 613].includes(code) || [2446079, 1487390].includes(sub)) {
                return { throttled: true }
            }
            return { throttled: false }
        },
    )
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
            if (error) return { throttled: isNetworkError(error) }
            if (!res) return { throttled: false }
            const http = httpThrottled(res)
            if (http.throttled) return http
            if ([40100, 40016, 50002].includes(res.parsed?.code)) return { throttled: true }
            return { throttled: false }
        },
    )
}

/** Hotmart: throttle por HTTP 429 / 5xx. */
export function hotmartFetch(url: string, init?: RequestInit): Promise<BufferedResponse> {
    return withRetry<BufferedResponse>(
        'hotmart',
        () => bufferedFetch(url, init),
        (res, error) => {
            if (error) return { throttled: isNetworkError(error) }
            if (!res) return { throttled: false }
            return httpThrottled(res)
        },
    )
}

/**
 * GA4 (cliente gRPC, no fetch): reintenta en RESOURCE_EXHAUSTED (8) / UNAVAILABLE (14).
 * Uso: ga4Run(() => client.runReport(...)).
 */
export function ga4Run<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry<T>(
        'ga4',
        fn,
        (_result, error) => {
            if (error && [8, 14].includes(error.code)) return { throttled: true }
            return { throttled: false }
        },
    )
}
