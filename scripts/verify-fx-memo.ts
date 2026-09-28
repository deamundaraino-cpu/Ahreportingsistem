/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * El memo de `getUsdRate` (lib/fx.ts): qué se recuerda y cuánto.
 *
 * Todo PURO: una `fx_rates` falsa en memoria, `fetch` sustituido por un doble y
 * `Date.now` por un reloj que avanza a mano. Ni red ni base.
 *
 *   npx tsx --conditions=react-server scripts/verify-fx-memo.ts
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────
 * El memo se guardaba para toda la vida del proceso, también cuando la tasa NO
 * se había resuelto ('none') o era una aproximación ('stale'). En el worker VPS
 * el proceso vive días: una API de FX caída cinco minutos dejaba esa moneda sin
 * convertir hasta el siguiente reinicio, aunque la API volviera enseguida. Ahora
 * esos resultados caducan a los `FX_MEMO_TTL_SIN_TASA_MS` y las tasas buenas se
 * siguen recordando como siempre.
 */

import { clearFxMemo, FX_MEMO_TTL_SIN_TASA_MS, getUsdRate } from '../src/lib/fx';
import { salir } from './_salida';

// Si el proceso se queda sin nada pendiente antes del resumen, que no salga con
// 0 como si todo hubiera pasado: `salir` fija el código de verdad al final.
process.exitCode = 1;

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
}

function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Reloj ───────────────────────────────────────────────────────────────────

const ahoraReal = Date.now;
let reloj = ahoraReal();
Date.now = () => reloj;
const avanzar = (ms: number) => (reloj += ms);

// ─── fx_rates falsa ──────────────────────────────────────────────────────────

type Fila = { fecha: string; moneda: string; usd_rate: number; fuente?: string };

/**
 * Lo justo del cliente de Supabase que usa `getUsdRate`: select/eq/order/limit
 * con `maybeSingle`, y `upsert` que no pisa (ignoreDuplicates).
 * `consultas` cuenta las lecturas: si no se mueve, la respuesta salió del memo.
 */
function dbFalsa(filas: Fila[] = []) {
  const estado = { consultas: 0, upserts: 0, fallarProximas: 0, demoraMs: 0 };
  const db = {
    from(tabla: string) {
      if (tabla !== 'fx_rates') throw new Error(`tabla inesperada: ${tabla}`);
      const filtros: Record<string, string> = {};
      let desc = false;
      const q: any = {
        select: () => q,
        eq: (col: string, v: string) => ((filtros[col] = v), q),
        order: (_col: string, o?: { ascending?: boolean }) => ((desc = o?.ascending === false), q),
        limit: () => q,
        maybeSingle: async () => {
          estado.consultas++;
          const falla = estado.fallarProximas > 0;
          if (falla) estado.fallarProximas--;
          if (estado.demoraMs > 0) await esperar(estado.demoraMs);
          if (falla) throw new Error('conexión con Postgres caída');
          const r = filas
            .filter((f) => Object.entries(filtros).every(([c, v]) => (f as any)[c] === v))
            .sort((a, b) =>
              desc ? b.fecha.localeCompare(a.fecha) : a.fecha.localeCompare(b.fecha)
            );
          return { data: r[0] ?? null, error: null };
        },
        upsert: async (rows: Fila[]) => {
          estado.upserts++;
          for (const row of rows) {
            if (!filas.some((f) => f.fecha === row.fecha && f.moneda === row.moneda)) {
              filas.push(row);
            }
          }
          return { data: null, error: null };
        },
      };
      return q;
    },
  };
  return { db, estado, filas };
}

// ─── API de FX falsa ─────────────────────────────────────────────────────────

const fetchReal = globalThis.fetch;
const api = { caida: true, llamadas: 0, demoraMs: 0 };

/** 1 USD = 4.000 COP = 5 BRL, en el formato de @fawazahmed0/currency-api. */
globalThis.fetch = (async (url: string | URL | Request) => {
  api.llamadas++;
  if (!String(url).includes('currency-api')) throw new Error(`URL inesperada: ${String(url)}`);
  if (api.demoraMs > 0) await esperar(api.demoraMs);
  if (api.caida) return new Response('Service Unavailable', { status: 503 });
  return new Response(JSON.stringify({ usd: { cop: 4000, brl: 5 } }), { status: 200 });
}) as typeof fetch;

// Fechas antiguas: siempre van a la API histórica, sea cual sea el día real.
const F1 = '2025-01-15';
const F2 = '2025-02-20';
const F3 = '2025-03-10';

async function main() {
  // ════════════════════════════════════════════════════════════
  seccion("'none' caduca a los 10 minutos");
  // ════════════════════════════════════════════════════════════
  {
    clearFxMemo();
    const { db, estado } = dbFalsa();
    api.caida = true;
    api.llamadas = 0;

    const r1 = await getUsdRate(db, 'COP', F1);
    check('sin cache ni API ni tasa anterior → none', r1.source === 'none' && r1.rate === null);
    const consultas = estado.consultas;

    const r2 = await getUsdRate(db, 'cop', F1);
    check(
      'al momento sale del memo (ni base ni API)',
      r2.source === 'none' && estado.consultas === consultas && api.llamadas === 1
    );

    avanzar(FX_MEMO_TTL_SIN_TASA_MS - 1000);
    await getUsdRate(db, 'COP', F1);
    check(
      'a los 9:59 sigue en el memo',
      estado.consultas === consultas && api.llamadas === 1,
      `${estado.consultas - consultas} consultas nuevas`
    );

    api.caida = false;
    avanzar(2000);
    const r3 = await getUsdRate(db, 'COP', F1);
    check(
      'pasados los 10 minutos se reintenta y la API ya responde',
      r3.source === 'api' && r3.rate === 1 / 4000 && api.llamadas === 2,
      `${r3.source} ${r3.rate}, ${api.llamadas} llamadas`
    );
    check('y la tasa queda escrita en fx_rates', estado.upserts === 1);

    // ── Una tasa buena, en cambio, no caduca.
    const consultasBuena = estado.consultas;
    avanzar(30 * 24 * 60 * 60_000);
    const r4 = await getUsdRate(db, 'COP', F1);
    check(
      "una tasa 'api' sigue en el memo 30 días después",
      r4.source === 'api' && estado.consultas === consultasBuena && api.llamadas === 2
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion("'cache' no caduca");
  // ════════════════════════════════════════════════════════════
  {
    clearFxMemo();
    const { db, estado } = dbFalsa([{ fecha: F1, moneda: 'BRL', usd_rate: 0.2 }]);
    api.llamadas = 0;
    const r1 = await getUsdRate(db, 'BRL', F1);
    const consultas = estado.consultas;
    avanzar(FX_MEMO_TTL_SIN_TASA_MS * 100);
    const r2 = await getUsdRate(db, 'BRL', F1);
    check('la tasa cacheada se resuelve de la base', r1.source === 'cache' && r1.rate === 0.2);
    check(
      'y horas después sigue saliendo del memo',
      r2.source === 'cache' && estado.consultas === consultas && api.llamadas === 0
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion("'stale' caduca igual que 'none'");
  // ════════════════════════════════════════════════════════════
  {
    clearFxMemo();
    // Solo hay una tasa BRL anterior: la del día no está en la base.
    const { db, estado } = dbFalsa([{ fecha: '2025-02-10', moneda: 'BRL', usd_rate: 0.18 }]);
    api.caida = true;
    api.llamadas = 0;

    const r1 = await getUsdRate(db, 'BRL', F2);
    check(
      'con la API caída usa la última tasa conocida',
      r1.source === 'stale' && r1.rate === 0.18
    );
    const consultas = estado.consultas;

    avanzar(FX_MEMO_TTL_SIN_TASA_MS / 2);
    await getUsdRate(db, 'BRL', F2);
    check('dentro del TTL sale del memo', estado.consultas === consultas && api.llamadas === 1);

    api.caida = false;
    avanzar(FX_MEMO_TTL_SIN_TASA_MS);
    const r2 = await getUsdRate(db, 'BRL', F2);
    check(
      'pasado el TTL se pide la tasa del día y se deja de aproximar',
      r2.source === 'api' && r2.rate === 1 / 5 && api.llamadas === 2,
      `${r2.source} ${r2.rate}`
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('Llamadas concurrentes y fallos transitorios');
  // ════════════════════════════════════════════════════════════
  {
    clearFxMemo();
    const { db } = dbFalsa();
    api.caida = false;
    api.llamadas = 0;
    api.demoraMs = 20;
    const rs = await Promise.all(Array.from({ length: 5 }, () => getUsdRate(db, 'COP', F3)));
    api.demoraMs = 0;
    check(
      'cinco llamadas a la vez comparten una sola consulta a la API',
      api.llamadas === 1 && rs.every((r) => r.source === 'api'),
      `${api.llamadas} llamadas`
    );
  }

  {
    clearFxMemo();
    const { db, estado } = dbFalsa([{ fecha: F3, moneda: 'COP', usd_rate: 0.00025 }]);
    estado.fallarProximas = 1;
    const r1 = await getUsdRate(db, 'COP', F3);
    const consultas = estado.consultas;
    const r2 = await getUsdRate(db, 'COP', F3);
    check(
      'una excepción no queda memoizada: la siguiente llamada vuelve a la base',
      r1.source === 'none' && r2.source === 'cache' && estado.consultas > consultas,
      `${r1.source} → ${r2.source}`
    );
  }

  {
    // Una llamada lenta que acaba en excepción DESPUÉS de un clearFxMemo no
    // puede borrar la entrada nueva que otra llamada ya dejó resuelta.
    clearFxMemo();
    const { db, estado } = dbFalsa([{ fecha: F3, moneda: 'COP', usd_rate: 0.00025 }]);
    estado.fallarProximas = 1;
    estado.demoraMs = 30;
    const vieja = getUsdRate(db, 'COP', F3);
    clearFxMemo();
    estado.demoraMs = 0;
    const nueva = await getUsdRate(db, 'COP', F3);
    await vieja;
    const consultas = estado.consultas;
    const otra = await getUsdRate(db, 'COP', F3);
    check(
      'el fallo de una llamada anterior no borra la entrada nueva',
      nueva.source === 'cache' && otra.source === 'cache' && estado.consultas === consultas,
      `${estado.consultas - consultas} consultas nuevas`
    );
  }
}

main()
  .catch((e) => {
    fallos++;
    console.log(`  ✗ excepción inesperada — ${e instanceof Error ? e.message : e}`);
  })
  .finally(() => {
    Date.now = ahoraReal;
    globalThis.fetch = fetchReal;
    clearFxMemo();
    console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
    salir(fallos);
  });
