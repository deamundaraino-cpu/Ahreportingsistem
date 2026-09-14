/**
 * Conversión de moneda a USD para las ventas de Hotmart.
 *
 * El worker solo sumaba importes cuya moneda fuera USD: una venta en COP, BRL,
 * EUR o MXN entraba como 0 y hundía el ROAS del cliente sin aviso. Este módulo
 * resuelve la tasa del día con tres niveles de respaldo:
 *
 *   1. `fx_rates` (cache en Postgres, una fila por fecha+moneda).
 *   2. API pública sin key → se cachea al vuelo. Cuál depende de la fecha (ver
 *      `fuenteParaFecha`): la cotización de HOY solo vale para hoy y ayer.
 *   3. Última tasa conocida de esa moneda (la cotización de ayer sirve; un 0 no).
 *      Esta NO se cachea: es una aproximación, y guardarla la congelaría.
 *
 * Si ninguno responde, `getUsdRate` devuelve `null`: quien llama debe CONTAR el
 * importe como no convertido y alertar, nunca sumarlo como cero.
 *
 * Una tasa cacheada no se reescribe nunca (gana la primera escritura): es lo que
 * la mantiene congelada para la moneda de reporte (`lib/moneda-reporte.ts`).
 */

import { addDaysISO, colombiaToday } from './colombia-date';
import { MONEDAS_REPORTE } from './moneda-reporte';

export type FxLookup = {
  /** USD por 1 unidad de la moneda pedida, o null si no se pudo resolver. */
  rate: number | null;
  source: 'usd' | 'cache' | 'api' | 'stale' | 'none';
};

export const FUENTE_LATEST = 'open.er-api.com';
export const FUENTE_HISTORICA = 'fawazahmed0/currency-api';

/**
 * Qué API sirve para la tasa de `fecha`.
 *
 * open.er-api.com solo da la cotización ACTUAL (su plan libre no tiene
 * histórico). Guardarla bajo una fecha antigua —lo que hacían el backfill y las
 * re-sincronizaciones— congelaba la tasa de hoy como si fuera la de hace tres
 * semanas. Hoy y ayer pueden usarla (ayer es el día que sincroniza el worker por
 * la mañana); cualquier fecha anterior pide la histórica de ESE día.
 */
export function fuenteParaFecha(
  fecha: string,
  hoy: string = colombiaToday()
): 'latest' | 'historica' {
  return fecha >= addDaysISO(hoy, -1) ? 'latest' : 'historica';
}

/** Tasas resueltas en esta corrida — evita repetir la consulta por transacción. */
type FxMemo = Map<string, Promise<FxLookup>>;

const memoByRun: FxMemo = new Map();

function memoKey(moneda: string, fecha: string) {
  return `${fecha}|${moneda.toUpperCase()}`;
}

/**
 * Convierte un mapa MONEDA → unidades por 1 USD en MONEDA → USD por 1 unidad,
 * que es lo que guarda `fx_rates` y lo que multiplica el importe.
 */
function invertir(porUsd: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [moneda, v] of Object.entries(porUsd)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out.set(moneda.toUpperCase(), 1 / n);
  }
  return out;
}

/** Cotización ACTUAL (open.er-api.com/v6/latest/USD). */
async function fetchRatesFromApi(): Promise<Map<string, number> | null> {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', {
      headers: { Accept: 'application/json' },
      // La API es un servicio de terceros: si tarda, no bloquear el sync.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.result !== 'success' || !data?.rates) return null;
    return invertir(data.rates as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Cotización HISTÓRICA de un día: el conjunto público `@fawazahmed0/currency-api`
 * servido por jsDelivr, con un archivo por día desde 2024-03. Sin clave.
 *
 * Devuelve MONEDA → USD por 1 unidad, igual que la cotización actual.
 */
export async function fetchRatesHistoricas(fecha: string): Promise<Map<string, number> | null> {
  const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${fecha}/v1/currencies/usd.json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { usd?: Record<string, unknown> };
    return j.usd ? invertir(j.usd) : null;
  } catch {
    return null;
  }
}

/**
 * Tasas para `fecha` de la fuente que le corresponde. Si la actual falla para
 * hoy/ayer se intenta la histórica, que para ayer ya existe.
 */
async function tasasPara(
  fecha: string
): Promise<{ rates: Map<string, number>; fuente: string } | null> {
  if (fuenteParaFecha(fecha) === 'latest') {
    const actual = await fetchRatesFromApi();
    if (actual) return { rates: actual, fuente: FUENTE_LATEST };
  }
  const historica = await fetchRatesHistoricas(fecha);
  return historica ? { rates: historica, fuente: FUENTE_HISTORICA } : null;
}

/**
 * Precarga en `fx_rates` todas las monedas pedidas para una fecha.
 * Llamar UNA vez por corrida (cuando ya se conocen las monedas del día) para no
 * pegarle a la API de FX dentro del loop de transacciones.
 */
export async function preloadUsdRates(db: any, monedas: string[], fecha: string): Promise<void> {
  const wanted = Array.from(
    new Set(monedas.map((m) => String(m || '').toUpperCase()).filter((m) => m && m !== 'USD'))
  );
  if (wanted.length === 0) return;

  const { data: cached } = await db
    .from('fx_rates')
    .select('moneda')
    .eq('fecha', fecha)
    .in('moneda', wanted);
  const have = new Set((cached || []).map((r: any) => String(r.moneda).toUpperCase()));
  const missing = wanted.filter((m) => !have.has(m));
  if (missing.length === 0) return;

  const got = await tasasPara(fecha);
  if (!got) return;

  const rows = missing
    .filter((m) => got.rates.has(m))
    .map((m) => ({ fecha, moneda: m, usd_rate: got.rates.get(m)!, fuente: got.fuente }));
  if (rows.length > 0) {
    // ignoreDuplicates: si otra corrida la escribió entre medias, gana la que
    // ya estaba. Una tasa cacheada no se reescribe nunca.
    await db.from('fx_rates').upsert(rows, { onConflict: 'fecha,moneda', ignoreDuplicates: true });
  }
}

/**
 * Deja guardada la tasa de HOY de todas las monedas de reporte, haya o no
 * ventas. Antes solo se guardaba al sincronizar un día con ventas de Hotmart:
 * un cliente sin ventas en septiembre se quedaba sin una sola tasa CLP, y el
 * día que vendiera se convertiría con la última conocida.
 *
 * Todas las monedas ofrecidas, no solo las que hoy usa algún cliente: es una
 * sola llamada a la API y así un cliente que cambie de moneda ya tiene historia
 * desde hoy. Nunca lanza.
 */
export async function capturarTasasDelDia(db: any, hoy: string = colombiaToday()): Promise<void> {
  try {
    await preloadUsdRates(db, [...MONEDAS_REPORTE], hoy);
  } catch {
    // Una API de FX caída no debe tumbar la sincronización.
  }
}

/**
 * USD por 1 unidad de `moneda` en `fecha`.
 * Resultado memoizado por corrida del proceso.
 */
export async function getUsdRate(db: any, moneda: string, fecha: string): Promise<FxLookup> {
  const cur = String(moneda || '').toUpperCase();
  if (!cur) return { rate: null, source: 'none' };
  if (cur === 'USD') return { rate: 1, source: 'usd' };

  const key = memoKey(cur, fecha);
  const hit = memoByRun.get(key);
  if (hit) return hit;

  const promise = (async (): Promise<FxLookup> => {
    // 1. Cache exacta (fecha + moneda).
    const { data: exact } = await db
      .from('fx_rates')
      .select('usd_rate')
      .eq('fecha', fecha)
      .eq('moneda', cur)
      .maybeSingle();
    if (exact?.usd_rate) return { rate: Number(exact.usd_rate), source: 'cache' };

    // 2. API de la fecha que toca → cachear para el resto de la corrida y días futuros.
    const got = await tasasPara(fecha);
    const fresh = got?.rates.get(cur);
    if (got && fresh) {
      await db
        .from('fx_rates')
        .upsert([{ fecha, moneda: cur, usd_rate: fresh, fuente: got.fuente }], {
          onConflict: 'fecha,moneda',
          ignoreDuplicates: true,
        });
      return { rate: fresh, source: 'api' };
    }

    // 3. Última tasa conocida: aproximada, pero infinitamente mejor que 0.
    // No se guarda: congelaría una aproximación como si fuera la del día.
    const { data: stale } = await db
      .from('fx_rates')
      .select('usd_rate')
      .eq('moneda', cur)
      .order('fecha', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (stale?.usd_rate) return { rate: Number(stale.usd_rate), source: 'stale' };

    return { rate: null, source: 'none' };
  })().catch(() => {
    // Un fallo transitorio no debe quedar memoizado.
    memoByRun.delete(key);
    return { rate: null, source: 'none' } as FxLookup;
  });

  memoByRun.set(key, promise);
  return promise;
}

/** Limpia el memo (útil en tests y en procesos de larga duración como el worker VPS). */
export function clearFxMemo(): void {
  memoByRun.clear();
}
