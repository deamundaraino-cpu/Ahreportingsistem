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
 *
 * Este módulo lo importan también componentes de cliente: nada de `server-only`.
 */

import { addDaysISO } from './colombia-date';

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

/** Sufijo de la copia en dólares que acompaña a cada columna convertida. */
export const SUFIJO_USD = '_usd';

/**
 * Tasa de cambio del día en una fila del dashboard: unidades de la moneda del
 * cliente por 1 USD. Viaja con su numerador y denominador (`__num`/`__den`)
 * porque una tasa NO se suma entre días: el motor de fórmulas recalcula el total
 * de un rango como Σnum / Σden, que es el promedio de las tasas diarias.
 */
export const CLAVE_TASA_CAMBIO = 'tasa_cambio';

/**
 * Métricas que están SIEMPRE en dólares, sea cual sea la moneda del cliente: las
 * gemelas sin convertir de la facturación de Hotmart. Se pintan con «USD» aunque
 * el cliente reporte en pesos.
 */
export const METRICAS_EN_USD: ReadonlySet<string> = new Set<string>([
  'hm_neto_usd',
  'hm_bruto_usd',
  ...COLUMNAS_USD_METRICAS.map((c) => `${c}${SUFIJO_USD}`),
  'total_facturacion_neta_usd',
  'total_facturacion_bruta_usd',
]);

/** Moneda en la que se lee una métrica de dinero: la del cliente, salvo las gemelas en USD. */
export function monedaDeMetrica(metrica: string, monedaCliente?: string | null): string {
  if (METRICAS_EN_USD.has(metrica)) return 'USD';
  return (monedaCliente || MONEDA_BASE).toUpperCase();
}

// ── Formato ───────────────────────────────────────────────────────────

/** Monedas que no usan centavos en la práctica: se pintan sin decimales. */
export const DECIMALES_MONEDA: Readonly<Record<string, number>> = { CLP: 0, COP: 0, ARS: 0 };

export function decimalesDe(moneda: string): number {
  return DECIMALES_MONEDA[String(moneda || '').toUpperCase()] ?? 2;
}

/**
 * Importe con el código de su moneda: «CLP 233.487», «USD 12,81».
 * Mismo estilo que `report-utm/formatters.ts` (código delante, separadores es-AR).
 */
export function formatearMoneda(
  valor: number,
  moneda: string,
  opts: { decimales?: number } = {}
): string {
  const m = String(moneda || MONEDA_BASE).toUpperCase();
  const d = opts.decimales ?? decimalesDe(m);
  return `${m} ${valor.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/**
 * Lo que va delante de un importe. Mientras el cliente reporte en dólares se
 * sigue pintando «$», como siempre; en cuanto reporta en otra moneda se pinta el
 * código ISO de cada cifra («CLP» la convertida, «USD» la gemela sin convertir),
 * porque un «$» a secas ya no dice cuál de las dos es.
 */
export function simboloMoneda(
  monedaValor: string | null | undefined,
  monedaCliente?: string | null
): string {
  const cliente = String(monedaCliente || MONEDA_BASE).toUpperCase();
  const valor = String(monedaValor || cliente).toUpperCase();
  return cliente === 'USD' && valor === 'USD' ? '$' : valor;
}

/** El símbolo listo para anteponer: «$» va pegado, un código lleva espacio. */
export function prefijoMoneda(simbolo: string): string {
  return simbolo === '$' ? '$' : `${simbolo} `;
}

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
 * Tasa promedio de un rango de días: la media simple de la tasa de cada día
 * (con el mismo respaldo de `conv.tasa`: la última anterior conocida). Es la
 * definición única de «Tasa de cambio» en BI y dashboard. `null` si ningún día
 * del rango tiene tasa.
 */
export function tasaPromedio(conv: ConversorMoneda, desde: string, hasta: string): number | null {
  let suma = 0;
  let dias = 0;
  // Tope de diez años: un rango mal formado no debe colgar el informe.
  for (let d = desde, i = 0; d <= hasta && i < 3660; d = addDaysISO(d, 1), i++) {
    const t = conv.tasa(d);
    if (t !== null) {
      suma += t;
      dias++;
    }
  }
  return dias > 0 ? Math.round((suma / dias) * 100) / 100 : null;
}

/** Lunes de la semana de `fecha` (misma regla que `truncateDate` del BI). */
function lunesDe(fecha: string): string {
  const dia = new Date(`${fecha}T12:00:00Z`).getUTCDay();
  return addDaysISO(fecha, dia === 0 ? -6 : 1 - dia);
}

/**
 * Claves de fila de un rango agrupado por fecha, con la misma forma que el BI:
 * `yyyy-MM-dd` por día, el lunes por semana, `yyyy-MM` por mes. Sirven para que
 * la tasa de cambio tenga fila también los días sin ventas.
 */
export function clavesDeRango(desde: string, hasta: string, agrupacion?: string): string[] {
  const out = new Set<string>();
  for (let d = desde, i = 0; d <= hasta && i < 3660; d = addDaysISO(d, 1), i++) {
    out.add(agrupacion === 'month' ? d.slice(0, 7) : agrupacion === 'week' ? lunesDe(d) : d);
  }
  return [...out];
}

/**
 * Días que cubre una clave de fila del BI, recortados al rango consultado. Una
 * clave que no es fecha (una campaña, el total) cubre el rango entero.
 */
export function rangoDeClave(
  clave: string,
  agrupacion: string | undefined,
  desde: string,
  hasta: string
): { desde: string; hasta: string } {
  let ini = desde;
  let fin = hasta;
  if (/^\d{4}-\d{2}$/.test(clave)) {
    const [y, m] = clave.split('-').map(Number);
    ini = `${clave}-01`;
    fin = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(clave)) {
    ini = clave;
    fin = agrupacion === 'week' ? addDaysISO(clave, 6) : clave;
  }
  return { desde: ini < desde ? desde : ini, hasta: fin > hasta ? hasta : fin };
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

/** Convierte `net`/`gross` de un desglose de Hotmart (`{ net, gross, … }`). */
function convertirDesglose(d: unknown, conv: ConversorMoneda, fecha: string): unknown {
  if (!d || typeof d !== 'object') return d;
  const out: Record<string, unknown> = { ...(d as Record<string, unknown>) };
  for (const k of ['net', 'gross'] as const) {
    const v = Number(out[k]);
    if (Number.isFinite(v) && v !== 0) out[k] = conv.convertir(v, fecha);
  }
  return out;
}

/**
 * El dinero que viaja en `hotmart_funnel_data` (desglose por pestaña y
 * productos extra) también está en USD. Sin convertirlo, las fórmulas
 * `funnel_*_neto` y la tabla de extras mezclarían dólares con la facturación ya
 * convertida del resto de la fila.
 */
function convertirFunnelData(fd: unknown, conv: ConversorMoneda, fecha: string): unknown {
  if (!fd || typeof fd !== 'object') return fd;
  const src = fd as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if (src.by_tab && typeof src.by_tab === 'object') {
    const byTab: Record<string, unknown> = {};
    for (const [tabId, tab] of Object.entries(src.by_tab as Record<string, unknown>)) {
      if (!tab || typeof tab !== 'object') {
        byTab[tabId] = tab;
        continue;
      }
      const t: Record<string, unknown> = { ...(tab as Record<string, unknown>) };
      for (const etapa of ['principal', 'bump', 'upsell', 'downsell'] as const) {
        if (etapa in t) t[etapa] = convertirDesglose(t[etapa], conv, fecha);
      }
      byTab[tabId] = t;
    }
    out.by_tab = byTab;
  }
  if (Array.isArray(src.extras)) {
    out.extras = src.extras.map((e) => convertirDesglose(e, conv, fecha));
  }
  return out;
}

/**
 * Prepara las filas de `metricas_diarias` para la moneda de reporte:
 *
 *   • Convierte las columnas de dinero de Hotmart y el dinero de
 *     `hotmart_funnel_data` con la tasa del día de la fila.
 *   • Deja al lado la copia SIN convertir (`<columna>_usd`), para poder poner
 *     la facturación en dólares junto a la convertida.
 *   • Añade la tasa del día (`tasa_cambio` y su par `__num`/`__den`).
 *
 * Nunca muta las filas recibidas. Con moneda USD solo añade las copias (iguales
 * al original) y una tasa de 1.
 */
export function convertirFilasMetricas<T extends Record<string, any>>(
  filas: T[],
  conv: ConversorMoneda
): T[] {
  const esUsd = conv.moneda === 'USD';
  return filas.map((f) => {
    const fecha = String(f.fecha ?? '');
    const out: Record<string, any> = { ...f };
    for (const col of COLUMNAS_USD_METRICAS) {
      if (f[col] === undefined || f[col] === null) continue;
      const v = Number(f[col]);
      if (!Number.isFinite(v)) continue;
      out[`${col}${SUFIJO_USD}`] = v;
      if (!esUsd && v !== 0) out[col] = conv.convertir(v, fecha);
    }
    if (!esUsd && f.hotmart_funnel_data) {
      out.hotmart_funnel_data = convertirFunnelData(f.hotmart_funnel_data, conv, fecha);
    }
    const t = conv.tasa(fecha);
    if (t !== null) {
      out[CLAVE_TASA_CAMBIO] = t;
      out[`${CLAVE_TASA_CAMBIO}__num`] = t;
      out[`${CLAVE_TASA_CAMBIO}__den`] = 1;
    }
    return out as T;
  });
}

// ── Última tasa guardada (para la tarjeta de ajustes) ─────────────────

export type TasaGuardada = { fecha: string; porUsd: number };

/**
 * Última tasa guardada en `fx_rates` de cada moneda de reporte (menos USD).
 * Una consulta pequeña por moneda: son siete, en paralelo.
 */
export async function ultimasTasasGuardadas(
  db: any
): Promise<Partial<Record<MonedaReporte, TasaGuardada>>> {
  const monedas = MONEDAS_REPORTE.filter((m) => m !== 'USD');
  const filas = await Promise.all(
    monedas.map(async (m) => {
      const { data } = await db
        .from('fx_rates')
        .select('fecha, usd_rate')
        .eq('moneda', m)
        .order('fecha', { ascending: false })
        .limit(1);
      const r = (data ?? [])[0] as { fecha: string; usd_rate: number | string } | undefined;
      const porUsd = r ? 1 / Number(r.usd_rate) : NaN;
      return Number.isFinite(porUsd) && porUsd > 0
        ? ([m, { fecha: String(r!.fecha).slice(0, 10), porUsd }] as const)
        : null;
    })
  );
  const out: Partial<Record<MonedaReporte, TasaGuardada>> = {};
  for (const f of filas) if (f) out[f[0]] = f[1];
  return out;
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
