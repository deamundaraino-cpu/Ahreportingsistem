/**
 * Moneda de reporte del cliente.
 *
 * Hotmart se guarda en dólares (`bruto_usd`, `neto_*_usd`, `metricas_diarias.
 * ventas_*`) y el gasto de Meta en la moneda de la cuenta publicitaria. En Cris
 * Tributario eso es USD contra pesos chilenos: el ROAS dividía una cosa entre
 * otra y no significaba nada (reunión del 2026-09-08: «aquí no puedo medir ROAS»).
 *
 * La decisión fue reportar en la moneda del CLIENTE, con la tasa del día de cada
 * venta congelada. No hace falta una tabla nueva para congelarla: `fx_rates`
 * guarda UNA fila por (fecha, moneda) y `getUsdRate` no la reescribe una vez
 * cacheada. Convertir al leer con la tasa de la fecha de la venta ES la tasa
 * congelada; solo el día en curso puede moverse, porque es el único que aún
 * sincroniza.
 *
 * Dónde vive el ajuste: `report_utm.clientes.config.moneda_reporte`, en el espejo
 * UTM del cliente. No en `public.clientes.config_api`: ese JSONB lo reescribe
 * entero el formulario de Ajustes al guardar, y un valor puesto desde otra
 * tarjeta se perdería en el siguiente guardado.
 *
 * El invariante de `fx.ts` se mantiene: sin tasa el importe NO se convierte a 0.
 * Si no hay ninguna tasa conocida de esa moneda, se deja en dólares y el llamador
 * lo sabe por `sinTasa`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const MONEDA_BASE = 'USD';

/** Monedas que se ofrecen como moneda de reporte. */
export const MONEDAS_REPORTE = ['USD', 'CLP', 'COP', 'MXN', 'PEN', 'ARS', 'BRL', 'EUR'] as const;
export type MonedaReporte = (typeof MONEDAS_REPORTE)[number];

export function esMonedaReporte(v: unknown): v is MonedaReporte {
  return typeof v === 'string' && (MONEDAS_REPORTE as readonly string[]).includes(v.toUpperCase());
}

/** Lee la moneda del JSONB `config` del cliente UTM. Por defecto, USD. */
export function leerMonedaReporte(config: unknown): MonedaReporte {
  const v =
    config && typeof config === 'object'
      ? (config as Record<string, unknown>).moneda_reporte
      : null;
  return esMonedaReporte(v) ? (String(v).toUpperCase() as MonedaReporte) : 'USD';
}

/**
 * Columnas de dinero de Hotmart en `metricas_diarias` (en USD). Solo estas se
 * convierten: el gasto ya está en la moneda de la cuenta y los conteos no son
 * dinero.
 */
export const COLUMNAS_USD_METRICAS = [
  'ventas_principal',
  'ventas_bump',
  'ventas_upsell',
  'ventas_downsell',
  'ventas_principal_bruto',
  'ventas_bump_bruto',
  'ventas_upsell_bruto',
  'ventas_downsell_bruto',
  'ventas_reembolsado',
] as const;

/** Convertidor de USD a la moneda de reporte, por fecha. */
export type ConversorMoneda = {
  moneda: MonedaReporte;
  /** Unidades de la moneda de reporte por 1 USD en esa fecha, o null. */
  tasa: (fecha: string) => number | null;
  /** USD → moneda de reporte. Sin tasa devuelve el importe en USD sin tocar. */
  convertir: (usd: number, fecha: string) => number;
  /** Fechas para las que no hubo ninguna tasa y el importe quedó en USD. */
  sinTasa: Set<string>;
};

/** El conversor identidad: moneda de reporte USD, o nada que convertir. */
export function conversorIdentidad(): ConversorMoneda {
  return {
    moneda: 'USD',
    tasa: () => 1,
    convertir: (usd) => usd,
    sinTasa: new Set(),
  };
}

/**
 * Construye el conversor a partir de las tasas guardadas (puro: recibe las filas
 * de `fx_rates`). Para una fecha sin fila exacta usa la última tasa ANTERIOR
 * conocida —la cotización de ayer sirve, un 0 no—; si no hay ninguna anterior,
 * la primera posterior. Solo sin ninguna tasa el importe se queda en USD.
 */
export function crearConversor(
  moneda: MonedaReporte,
  filas: Array<{ fecha: string; usd_rate: number | string }>
): ConversorMoneda {
  if (moneda === 'USD') return conversorIdentidad();

  // usd_rate = USD por 1 unidad → unidades por 1 USD = 1 / usd_rate.
  const tasas = filas
    .map((f) => ({ fecha: String(f.fecha).slice(0, 10), porUsd: 1 / Number(f.usd_rate) }))
    .filter((f) => Number.isFinite(f.porUsd) && f.porUsd > 0)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  const memo = new Map<string, number | null>();
  const tasa = (fecha: string): number | null => {
    const dia = String(fecha).slice(0, 10);
    if (memo.has(dia)) return memo.get(dia)!;
    let elegida: number | null = null;
    for (const t of tasas) {
      if (t.fecha <= dia) elegida = t.porUsd;
      else {
        if (elegida === null) elegida = t.porUsd;
        break;
      }
    }
    memo.set(dia, elegida);
    return elegida;
  };

  const sinTasa = new Set<string>();
  return {
    moneda,
    tasa,
    sinTasa,
    convertir: (usd, fecha) => {
      if (!usd) return usd;
      const t = tasa(fecha);
      if (t === null) {
        sinTasa.add(String(fecha).slice(0, 10));
        return usd;
      }
      return Math.round(usd * t * 100) / 100;
    },
  };
}

/**
 * Carga de `fx_rates` lo necesario para convertir un rango. Trae un margen de
 * 45 días antes del rango para tener siempre una «última tasa anterior».
 */
export async function cargarConversor(
  db: any,
  moneda: MonedaReporte,
  desde: string,
  hasta: string
): Promise<ConversorMoneda> {
  if (moneda === 'USD') return conversorIdentidad();
  const inicio =
    desde === 'all'
      ? '2000-01-01'
      : new Date(Date.parse(`${desde}T00:00:00Z`) - 45 * 86400_000).toISOString().slice(0, 10);
  const { data, error } = await db
    .from('fx_rates')
    .select('fecha, usd_rate')
    .eq('moneda', moneda)
    .gte('fecha', inicio)
    .lte('fecha', hasta)
    .order('fecha', { ascending: true })
    .limit(5000);
  let filas = (error ? [] : (data ?? [])) as Array<{ fecha: string; usd_rate: number }>;
  // Sin ninguna tasa en la ventana, la última conocida de esa moneda.
  if (filas.length === 0) {
    const { data: ultima } = await db
      .from('fx_rates')
      .select('fecha, usd_rate')
      .eq('moneda', moneda)
      .order('fecha', { ascending: false })
      .limit(1);
    filas = (ultima ?? []) as Array<{ fecha: string; usd_rate: number }>;
  }
  return crearConversor(moneda, filas);
}

/** Convierte las columnas de dinero de Hotmart de filas de `metricas_diarias`. */
export function convertirFilasMetricas<T extends Record<string, any>>(
  filas: T[],
  conv: ConversorMoneda
): T[] {
  if (conv.moneda === 'USD') return filas;
  return filas.map((f) => {
    const fecha = String(f.fecha ?? '');
    const out: Record<string, any> = { ...f };
    for (const col of COLUMNAS_USD_METRICAS) {
      const v = Number(f[col]);
      if (Number.isFinite(v) && v !== 0) out[col] = conv.convertir(v, fecha);
    }
    return out as T;
  });
}

// ── Caché del ajuste por cliente ──────────────────────────────────────
const TTL_MS = 60_000;
const cache = new Map<string, { moneda: MonedaReporte; ts: number }>();

/**
 * Moneda de reporte de un cliente de `report_utm`. Cacheada: se pregunta en cada
 * widget de un informe.
 */
export async function monedaDeClienteUtm(db: any, rtmClienteId: string): Promise<MonedaReporte> {
  if (!rtmClienteId) return 'USD';
  const hit = cache.get(rtmClienteId);
  if (hit && Date.now() - hit.ts <= TTL_MS) return hit.moneda;
  const { data, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('config')
    .eq('id', rtmClienteId)
    .maybeSingle();
  if (error) return 'USD';
  const moneda = leerMonedaReporte(data?.config);
  if (cache.size > 500) cache.clear();
  cache.set(rtmClienteId, { moneda, ts: Date.now() });
  return moneda;
}

/** Moneda de reporte de un cliente del reporting, vía su espejo UTM. */
export async function monedaDeClientePublico(db: any, publicId: string): Promise<MonedaReporte> {
  if (!publicId) return 'USD';
  const { data } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId)
    .limit(1);
  const id = data?.[0]?.id as string | undefined;
  return id ? monedaDeClienteUtm(db, id) : 'USD';
}

/** Solo para las comprobaciones. */
export function _limpiarCacheMoneda(): void {
  cache.clear();
}
