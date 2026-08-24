/**
 * Conversión de moneda a USD para las ventas de Hotmart.
 *
 * El worker solo sumaba importes cuya moneda fuera USD: una venta en COP, BRL,
 * EUR o MXN entraba como 0 y hundía el ROAS del cliente sin aviso. Este módulo
 * resuelve la tasa del día con tres niveles de respaldo:
 *
 *   1. `fx_rates` (cache en Postgres, una fila por fecha+moneda).
 *   2. API pública sin key (open.er-api.com) → se cachea al vuelo.
 *   3. Última tasa conocida de esa moneda (la cotización de ayer sirve; un 0 no).
 *
 * Si ninguno responde, `getUsdRate` devuelve `null`: quien llama debe CONTAR el
 * importe como no convertido y alertar, nunca sumarlo como cero.
 */

export type FxLookup = {
  /** USD por 1 unidad de la moneda pedida, o null si no se pudo resolver. */
  rate: number | null;
  source: 'usd' | 'cache' | 'api' | 'stale' | 'none';
};

/** Tasas resueltas en esta corrida — evita repetir la consulta por transacción. */
type FxMemo = Map<string, Promise<FxLookup>>;

const memoByRun: FxMemo = new Map();

function memoKey(moneda: string, fecha: string) {
  return `${fecha}|${moneda.toUpperCase()}`;
}

/**
 * Respuesta de open.er-api.com/v6/latest/USD:
 * `rates` mapea MONEDA → cuántas unidades de esa moneda vale 1 USD.
 * Nosotros guardamos la inversa (USD por unidad), que es lo que multiplica el importe.
 */
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
    const out = new Map<string, number>();
    for (const [moneda, porUsd] of Object.entries(data.rates as Record<string, number>)) {
      const n = Number(porUsd);
      if (Number.isFinite(n) && n > 0) out.set(moneda.toUpperCase(), 1 / n);
    }
    return out;
  } catch {
    return null;
  }
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

  const rates = await fetchRatesFromApi();
  if (!rates) return;

  const rows = missing
    .filter((m) => rates.has(m))
    .map((m) => ({ fecha, moneda: m, usd_rate: rates.get(m)!, fuente: 'open.er-api.com' }));
  if (rows.length > 0) {
    await db.from('fx_rates').upsert(rows, { onConflict: 'fecha,moneda' });
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

    // 2. API pública → cachear para el resto de la corrida y días futuros.
    const rates = await fetchRatesFromApi();
    const fresh = rates?.get(cur);
    if (fresh) {
      await db
        .from('fx_rates')
        .upsert([{ fecha, moneda: cur, usd_rate: fresh, fuente: 'open.er-api.com' }], {
          onConflict: 'fecha,moneda',
        });
      return { rate: fresh, source: 'api' };
    }

    // 3. Última tasa conocida: aproximada, pero infinitamente mejor que 0.
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
