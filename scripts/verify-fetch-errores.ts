/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Comprobaciones puras de dos piezas que deciden qué ve el usuario cuando algo
 * falla por debajo:
 *
 *   • `describirErrorDeRed` — traduce el `TypeError: fetch failed` de undici a un
 *     mensaje con el motivo real. «Detectar pestañas» enseñaba `fetch failed`
 *     cuando lo que pasaba era que NEXT_PUBLIC_APP_URL apuntaba a un puerto vacío.
 *   • `fetchAllRows` en modo estricto — el recálculo de los agregados diarios de
 *     un Sheet no puede trabajar con un recuento parcial, porque después borra el
 *     lote anterior.
 *   • El deadline de reintentos de `rate-limit.ts` es por petición
 *     (`conDeadline`). Era global: en el servidor del VPS, `/api/worker` lo dejaba
 *     vencido y `/api/worker/hotmart` se quedaba sin reintentos para siempre.
 *   • `hotmartFetch` lleva un timeout propio por intento y lo reintenta como un
 *     error de red. Sin él, una conexión colgada colgaba la corrida entera.
 *
 * Todo puro: `fetch` y `AbortSignal.timeout` se sustituyen por dobles.
 *
 *   npx tsx --conditions=react-server scripts/verify-fetch-errores.ts
 */

import { codigoErrorDeRed, describirErrorDeRed, esTimeoutDeFetch } from '../src/lib/fetch-json';
import {
  conDeadline,
  hotmartFetch,
  HOTMART_TIMEOUT_MS,
  setRetryDeadline,
  withRetry,
} from '../src/lib/rate-limit';
import { fetchAllRows } from '../src/lib/supabase-paginate';
import { salir } from './_salida';

// Si el bucle de eventos se vacía antes del resumen (una promesa que no se
// resuelve nunca y nada que mantenga vivo el proceso), Node sale con 0 sin
// imprimir nada más. Que eso no pase por bueno: `salir` lo fija al final.
process.exitCode = 1;

let pasadas = 0;
let fallidas = 0;

function check(nombre: string, condicion: boolean, detalle?: string) {
  if (condicion) {
    pasadas++;
    console.log(`  ✓ ${nombre}`);
  } else {
    fallidas++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

function sec(titulo: string) {
  console.log(`\n${titulo}`);
}

/** Un `fetch failed` como el de undici, con el código de sistema en la causa. */
function fetchFailed(causa: unknown): TypeError {
  return new TypeError('fetch failed', { cause: causa });
}

function conCodigo(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

const ORIGEN = 'http://localhost:3001';

// ─── describirErrorDeRed ────────────────────────────────────────────────────

sec('describirErrorDeRed — el motivo real en vez de «fetch failed»');

{
  const msg = describirErrorDeRed(fetchFailed(conCodigo('ECONNREFUSED')), ORIGEN);
  check(
    'ECONNREFUSED nombra el destino y el código',
    !!msg && msg.includes(ORIGEN) && msg.includes('ECONNREFUSED'),
    String(msg)
  );
  check('y apunta a NEXT_PUBLIC_APP_URL', !!msg?.includes('NEXT_PUBLIC_APP_URL'), String(msg));

  // `localhost` prueba ::1 y 127.0.0.1: si los dos rechazan, la causa es un
  // AggregateError sin `code` propio.
  const agregado = fetchFailed(
    Object.assign(new AggregateError([conCodigo('ECONNREFUSED'), conCodigo('ECONNREFUSED')]), {})
  );
  check(
    'lee el código dentro de un AggregateError',
    codigoErrorDeRed(agregado) === 'ECONNREFUSED',
    String(codigoErrorDeRed(agregado))
  );
  check(
    'y describe el AggregateError igual',
    !!describirErrorDeRed(agregado, ORIGEN)?.includes('ECONNREFUSED')
  );

  const casos: [string, string][] = [
    ['ENOTFOUND', 'dominio'],
    ['UND_ERR_CONNECT_TIMEOUT', 'a tiempo'],
    ['ECONNRESET', 'se cortó'],
    ['CERT_HAS_EXPIRED', 'certificado'],
    ['ERR_INVALID_URL', 'URL válida'],
  ];
  for (const [code, texto] of casos) {
    const m = describirErrorDeRed(fetchFailed(conCodigo(code)), ORIGEN);
    check(`${code} → mensaje propio`, !!m && m.includes(code) && m.includes(texto), String(m));
  }

  // Causa anidada: undici a veces envuelve el error de socket otra vez.
  const anidado = fetchFailed(new Error('envoltorio', { cause: conCodigo('ENOTFOUND') }));
  check('baja por causas anidadas', codigoErrorDeRed(anidado) === 'ENOTFOUND');

  check(
    '«fetch failed» sin código sigue siendo un fallo de red',
    !!describirErrorDeRed(new TypeError('fetch failed'), ORIGEN)?.includes(ORIGEN)
  );
}

{
  // Los timeouts tienen su propio mensaje en cada llamador: no se tocan.
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const abort = new DOMException('This operation was aborted', 'AbortError');
  check('TimeoutError → null', describirErrorDeRed(timeout, ORIGEN) === null);
  check('AbortError → null', describirErrorDeRed(abort, ORIGEN) === null);
  check(
    'y esTimeoutDeFetch los sigue reconociendo',
    esTimeoutDeFetch(timeout) && esTimeoutDeFetch(abort)
  );

  check('un Error cualquiera → null', describirErrorDeRed(new Error('boom'), ORIGEN) === null);
  check(
    'otro TypeError sin causa → null (no se reetiqueta)',
    describirErrorDeRed(new TypeError('Headers.set: invalid header'), ORIGEN) === null
  );
  check('null/undefined → null', describirErrorDeRed(undefined, ORIGEN) === null);
}

// ─── fetchAllRows estricto ──────────────────────────────────────────────────

/**
 * Builder de query falso al estilo PostgREST: `order/limit/gt` devuelven el
 * builder y `await` resuelve `{ data, error }`. `falla(pagina)` decide qué
 * páginas devuelven error (todas sus llamadas, para agotar los reintentos).
 */
function builderFalso(
  total: number,
  opts: { falla?: (pagina: number) => boolean; sinId?: boolean } = {}
) {
  const filas = Array.from({ length: total }, (_, i) => ({
    id: String(i + 1).padStart(8, '0'),
    n: i,
  }));
  return () => {
    let limite = 1000;
    let desde: string | null = null;
    const q: any = {
      order: () => q,
      limit: (n: number) => ((limite = n), q),
      gt: (_col: string, v: string) => ((desde = v), q),
      then: (resolve: (r: any) => void) => {
        const resto = desde === null ? filas : filas.filter((f) => f.id > desde!);
        const pagina = Math.floor((total - resto.length) / limite) + 1;
        if (opts.falla?.(pagina)) {
          resolve({ data: null, error: { message: `página ${pagina} caída` } });
          return;
        }
        const data = resto.slice(0, limite).map((f) => (opts.sinId ? { n: f.n } : f));
        resolve({ data, error: null });
      },
    };
    return q;
  };
}

async function lanza(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function comprobarPaginacion() {
  sec('fetchAllRows — modo estricto');

  const completo = await fetchAllRows(builderFalso(2500));
  const completoEstricto = await fetchAllRows(builderFalso(2500), 1000, 200_000, {
    estricto: true,
  });
  check('2.500 filas completas (normal)', completo.length === 2500, String(completo.length));
  check('2.500 filas completas (estricto)', completoEstricto.length === 2500);

  const exacto = await fetchAllRows(builderFalso(2000), 1000, 200_000, { estricto: true });
  check(
    'un múltiplo exacto de la página termina bien',
    exacto.length === 2000,
    String(exacto.length)
  );

  const vacio = await fetchAllRows(builderFalso(0), 1000, 200_000, { estricto: true });
  check('una tabla vacía no es un error', vacio.length === 0);

  const falla2 = { falla: (p: number) => p === 2 };
  const parcial = await fetchAllRows(builderFalso(2500, falla2));
  check(
    'normal: con la página 2 caída devuelve lo ya traído',
    parcial.length === 1000,
    String(parcial.length)
  );
  const errPagina = await lanza(() =>
    fetchAllRows(builderFalso(2500, falla2), 1000, 200_000, { estricto: true })
  );
  check(
    'estricto: con la página 2 caída lanza',
    !!errPagina?.includes('página fallida'),
    String(errPagina)
  );

  const tope = await fetchAllRows(builderFalso(2500), 1000, 1000);
  check('normal: el tope corta en silencio', tope.length === 1000, String(tope.length));
  const errTope = await lanza(() =>
    fetchAllRows(builderFalso(2500), 1000, 1000, { estricto: true })
  );
  check(
    'estricto: llegar al tope sin terminar lanza',
    !!errTope?.includes('tope'),
    String(errTope)
  );

  const errSinId = await lanza(() =>
    fetchAllRows(builderFalso(2500, { sinId: true }), 1000, 200_000, { estricto: true })
  );
  check('estricto: un select sin `id` lanza', !!errSinId?.includes('id'), String(errSinId));
}

// ─── Deadline de reintentos por petición ────────────────────────────────────

function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const FUTURO = () => Date.now() + 60_000;
const VENCIDO = () => Date.now() - 1;

/**
 * Cuántos intentos hace `withRetry` con un clasificador que SIEMPRE pide
 * reintentar (sin espera, `retryAfterMs: 0`). Con el deadline vigente agota los
 * reintentos (1 + 3 = 4); con el deadline vencido se queda en el primero.
 */
async function intentos(): Promise<number> {
  let n = 0;
  await withRetry(
    'ga4',
    async () => {
      n++;
      await esperar(5);
      return n;
    },
    () => ({ throttled: true, retryAfterMs: 0 }),
    3
  );
  return n;
}

async function comprobarDeadline() {
  sec('conDeadline — el deadline de reintentos es de cada petición');

  check('fuera de contexto y sin deadline: agota los reintentos', (await intentos()) === 4);

  {
    const [vencido, vigente] = await Promise.all([
      conDeadline(VENCIDO(), () => intentos()),
      conDeadline(FUTURO(), () => intentos()),
    ]);
    check('dos contextos concurrentes: el vencido no reintenta…', vencido === 1, String(vencido));
    check('…y el vigente sí, a la vez', vigente === 4, String(vigente));
  }

  {
    // `setRetryDeadline` DENTRO de un contexto: solo toca el suyo. El segundo
    // contexto espera a que el primero lo haya vencido antes de medir.
    let avisar!: () => void;
    const yaVencido = new Promise<void>((r) => (avisar = r));
    const [a, b] = await Promise.all([
      conDeadline(FUTURO(), async () => {
        setRetryDeadline(VENCIDO());
        avisar();
        return intentos();
      }),
      conDeadline(FUTURO(), async () => {
        await yaVencido;
        return intentos();
      }),
    ]);
    check('setRetryDeadline dentro de un contexto vence ese contexto', a === 1, String(a));
    check('pero no se filtra al contexto concurrente', b === 4, String(b));
    check('ni al global', (await intentos()) === 4);
  }

  {
    // Fuera de contexto se conserva el comportamiento de siempre (global)…
    setRetryDeadline(VENCIDO());
    const fuera = await intentos();
    const dentro = await conDeadline(FUTURO(), () => intentos());
    setRetryDeadline(Infinity);
    check('fuera de contexto: setRetryDeadline sigue siendo global', fuera === 1, String(fuera));
    check('…pero un global vencido no entra en un conDeadline', dentro === 4, String(dentro));
    check('restaurado el global, vuelve a reintentar', (await intentos()) === 4);
  }

  {
    // El contexto sobrevive a timers y promesas en paralelo.
    const vistos = await conDeadline(VENCIDO(), async () => {
      const enTimer = await new Promise<number>((r) => setTimeout(() => r(intentos()), 5));
      const enParalelo = await Promise.all([intentos(), intentos()]);
      return [enTimer, ...enParalelo];
    });
    check(
      'timers y Promise.all dentro del contexto ven su deadline',
      vistos.every((n) => n === 1),
      vistos.join(',')
    );
  }

  {
    const [interior, exterior] = await conDeadline(VENCIDO(), async () => {
      const interior = await conDeadline(FUTURO(), () => intentos());
      const exterior = await intentos();
      return [interior, exterior];
    });
    check('un conDeadline anidado sustituye al exterior', interior === 4, String(interior));
    check('y al salir vuelve el exterior', exterior === 1, String(exterior));
  }

  {
    // La cola del limiter: quien espera turno detrás de otra petición conserva
    // SU deadline al reanudarse (lo despierta el `finally` de la otra).
    const ocupantes = Array.from({ length: 5 }, () =>
      conDeadline(FUTURO(), () =>
        withRetry(
          'ga4',
          () => esperar(40),
          () => ({ throttled: false })
        )
      )
    );
    const [enColaVencido, enColaVigente] = await Promise.all([
      conDeadline(VENCIDO(), () => intentos()),
      conDeadline(FUTURO(), () => intentos()),
      ...ocupantes,
    ]);
    check(
      'en la cola del limiter cada petición conserva su deadline',
      enColaVencido === 1 && enColaVigente === 4,
      `${enColaVencido}/${enColaVigente}`
    );
  }
}

// ─── hotmartFetch: timeout propio y reintentable ────────────────────────────

type LlamadaFetch = { url: string; init?: RequestInit };

const fetchReal = globalThis.fetch;
const timeoutReal = AbortSignal.timeout;

/** Sustituye `fetch`: cada llamada ejecuta el siguiente paso de la cola (el último se repite). */
function simularFetch(pasos: Array<(init?: RequestInit) => Promise<Response>>): LlamadaFetch[] {
  const llamadas: LlamadaFetch[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init });
    return pasos[Math.min(llamadas.length - 1, pasos.length - 1)](init);
  }) as typeof fetch;
  return llamadas;
}

/** Registra los ms pedidos a `AbortSignal.timeout`; `realMs` acorta el timer de verdad. */
function espiarTimeout(realMs?: number): number[] {
  const pedidos: number[] = [];
  AbortSignal.timeout = (ms: number) => {
    pedidos.push(ms);
    return timeoutReal.call(AbortSignal, realMs ?? ms);
  };
  return pedidos;
}

function restaurar() {
  globalThis.fetch = fetchReal;
  AbortSignal.timeout = timeoutReal;
}

/**
 * Falla si `p` no termina en `ms`. Además mantiene vivo el proceso: el timer de
 * `AbortSignal.timeout` va sin ref y el doble colgado no abre ningún socket, así
 * que sin esto Node se quedaría sin nada pendiente y saldría a mitad de prueba.
 */
async function conVigilancia<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vigilancia = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`sin respuesta en ${ms} ms: se colgó`)), ms);
  });
  try {
    return await Promise.race([p, vigilancia]);
  } finally {
    clearTimeout(timer);
  }
}

const ok = async () => new Response('{"items":[]}', { status: 200 });
const lanzaTimeout = async (): Promise<Response> => {
  throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
};
const lanzaAbort = async (): Promise<Response> => {
  throw new DOMException('This operation was aborted', 'AbortError');
};
/** Como undici: no responde nunca y rechaza con el motivo del signal cuando éste aborta. */
const colgado = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const s = init?.signal;
    if (!s) return; // sin signal se colgaría para siempre: justo el fallo que se corrige
    if (s.aborted) reject(s.reason);
    else s.addEventListener('abort', () => reject(s.reason), { once: true });
  });

const URL_HOTMART = 'https://developers.hotmart.com/payments/api/v1/sales/history';

async function comprobarTimeoutHotmart() {
  sec('hotmartFetch — timeout propio por intento, reintentable');

  try {
    {
      const pedidos = espiarTimeout();
      const llamadas = simularFetch([lanzaTimeout, ok]);
      const res = await conDeadline(FUTURO(), () =>
        hotmartFetch(URL_HOTMART, { headers: { Authorization: 'Bearer x' } })
      );
      const [s1, s2] = llamadas.map((l) => l.init?.signal);
      check('un TimeoutError propio se reintenta', res.status === 200 && llamadas.length === 2);
      check(
        `cada intento pide su timeout de ${HOTMART_TIMEOUT_MS} ms`,
        pedidos.length === 2 && pedidos.every((ms) => ms === HOTMART_TIMEOUT_MS),
        pedidos.join(',')
      );
      check(
        'y lleva un signal nuevo (uno compartido llegaría vencido al reintento)',
        s1 instanceof AbortSignal && s2 instanceof AbortSignal && s1 !== s2
      );
      check(
        'sin perder las cabeceras de quien llama',
        llamadas.every(
          (l) => (l.init?.headers as Record<string, string>)?.Authorization === 'Bearer x'
        )
      );
    }

    {
      // De punta a punta: el primer intento se cuelga de verdad y lo corta el
      // timer propio (acortado a 30 ms).
      espiarTimeout(30);
      const llamadas = simularFetch([colgado, ok]);
      const t0 = Date.now();
      const res = await conVigilancia(
        conDeadline(FUTURO(), () => hotmartFetch(URL_HOTMART)),
        5000
      );
      check(
        'una conexión colgada se corta y se reintenta',
        res.status === 200 && llamadas.length === 2,
        `${res.status} en ${llamadas.length} llamadas, ${Date.now() - t0} ms`
      );
    }

    {
      espiarTimeout();
      const llamadas = simularFetch([lanzaAbort, ok]);
      const res = await conDeadline(FUTURO(), () => hotmartFetch(URL_HOTMART));
      check('un AbortError de nuestro signal también', res.status === 200 && llamadas.length === 2);
    }

    {
      espiarTimeout();
      const llamadas = simularFetch([
        async () => {
          throw new TypeError('fetch failed');
        },
        ok,
      ]);
      const res = await conDeadline(FUTURO(), () => hotmartFetch(URL_HOTMART));
      check('un error de red se sigue reintentando', res.status === 200 && llamadas.length === 2);
    }

    {
      const pedidos = espiarTimeout();
      const ctrl = new AbortController();
      ctrl.abort();
      const llamadas = simularFetch([colgado, ok]);
      const err = await conDeadline(FUTURO(), () =>
        hotmartFetch(URL_HOTMART, { signal: ctrl.signal }).then(
          () => null,
          (e: unknown) => e
        )
      );
      check(
        'el abort del signal de quien llama no se reintenta',
        esTimeoutDeFetch(err) && llamadas.length === 1,
        `${String(err)} en ${llamadas.length} llamadas`
      );
      check(
        'y su signal se respeta tal cual (sin timeout propio)',
        llamadas[0]?.init?.signal === ctrl.signal && pedidos.length === 0
      );
    }

    {
      espiarTimeout();
      const llamadas = simularFetch([lanzaTimeout, ok]);
      const err = await conDeadline(FUTURO(), () =>
        hotmartFetch(URL_HOTMART, { signal: new AbortController().signal }).then(
          () => null,
          (e: unknown) => e
        )
      );
      check(
        'un timeout con signal ajeno tampoco',
        esTimeoutDeFetch(err) && llamadas.length === 1,
        `${llamadas.length} llamadas`
      );
    }

    {
      espiarTimeout();
      const llamadas = simularFetch([
        async () => {
          throw new Error('boom');
        },
        ok,
      ]);
      const err = await conDeadline(FUTURO(), () =>
        hotmartFetch(URL_HOTMART).then(
          () => null,
          (e: unknown) => e
        )
      );
      check(
        'cualquier otro error no se reintenta',
        err instanceof Error && err.message === 'boom' && llamadas.length === 1
      );
    }

    {
      espiarTimeout();
      const llamadas = simularFetch([lanzaTimeout, ok]);
      const err = await conDeadline(VENCIDO(), () =>
        hotmartFetch(URL_HOTMART).then(
          () => null,
          (e: unknown) => e
        )
      );
      check(
        'con el deadline vencido el timeout se devuelve sin reintentar',
        esTimeoutDeFetch(err) && llamadas.length === 1,
        `${llamadas.length} llamadas`
      );
    }
  } finally {
    restaurar();
  }
}

async function main() {
  await comprobarPaginacion();
  await comprobarDeadline();
  await comprobarTimeoutHotmart();
}

main()
  .catch((e) => {
    fallidas++;
    console.log(`  ✗ excepción inesperada — ${e instanceof Error ? e.message : e}`);
  })
  .finally(() => {
    console.log(
      `\n${fallidas === 0 ? '✓' : '✗'} ${pasadas} comprobaciones pasadas, ${fallidas} fallidas`
    );
    salir(fallidas);
  });
