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
 * tarjeta se perdería en el siguiente guardado. Sin ajuste se usa la moneda de
 * las cuentas de Meta del cliente, y solo sin ella, USD (`resolverMonedaReporte`).
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

/** El ajuste explícito del JSONB `config` del cliente UTM, o `null` si no hay. */
export function monedaAjustada(config: unknown): MonedaReporte | null {
  const v =
    config && typeof config === 'object'
      ? (config as Record<string, unknown>).moneda_reporte
      : null;
  return esMonedaReporte(v) ? (String(v).toUpperCase() as MonedaReporte) : null;
}

/**
 * Lee SOLO el ajuste explícito del `config` del cliente UTM. Por defecto, USD.
 * La moneda con la que se reporta es la de `resolverMonedaReporte`, que además
 * mira la cuenta de Meta.
 */
export function leerMonedaReporte(config: unknown): MonedaReporte {
  return monedaAjustada(config) ?? 'USD';
}

/** Id de cuenta de Meta sin el prefijo `act_`, como lo guarda `meta_estado_cuentas`. */
function idCuenta(v: unknown): string {
  return String(v ?? '').replace(/^act_/, '');
}

/**
 * Monedas (distintas, en mayúsculas y ordenadas) de las cuentas de Meta del
 * cliente, según `config_api.meta_estado_cuentas`, que el worker rellena con la
 * `currency` que devuelve Meta (`lib/meta/alerta-cuenta.ts`).
 *
 * Solo cuentan las cuentas que siguen configuradas (`meta_accounts` o
 * `meta_account_id`): el estado de una cuenta ya quitada se queda en el JSONB y
 * no debe decidir la moneda. Si no hay lista de cuentas, valen todas.
 */
export function monedasDeCuentasMeta(configApi: unknown): string[] {
  if (!configApi || typeof configApi !== 'object') return [];
  const cfg = configApi as Record<string, unknown>;
  const estados = cfg.meta_estado_cuentas;
  if (!estados || typeof estados !== 'object') return [];

  const actuales = new Set<string>();
  if (Array.isArray(cfg.meta_accounts)) {
    for (const a of cfg.meta_accounts as Array<Record<string, unknown>>) {
      if (a?.account_id) actuales.add(idCuenta(a.account_id));
    }
  }
  if (actuales.size === 0 && cfg.meta_account_id) actuales.add(idCuenta(cfg.meta_account_id));

  const monedas = new Set<string>();
  for (const [id, e] of Object.entries(estados as Record<string, unknown>)) {
    if (actuales.size > 0 && !actuales.has(idCuenta(id))) continue;
    const m = (e as { moneda?: unknown } | null)?.moneda;
    if (typeof m === 'string' && m.trim()) monedas.add(m.trim().toUpperCase());
  }
  return [...monedas].sort();
}

/**
 * La moneda de las cuentas de Meta, si todas comparten una que se pueda usar
 * como moneda de reporte. Con monedas mezcladas o desconocidas, `null`: no hay
 * una respuesta correcta y se prefiere no adivinar.
 */
export function monedaDeCuentasMeta(configApi: unknown): MonedaReporte | null {
  const monedas = monedasDeCuentasMeta(configApi);
  return monedas.length === 1 && esMonedaReporte(monedas[0]) ? (monedas[0] as MonedaReporte) : null;
}

export type OrigenMoneda = 'ajuste' | 'meta' | 'defecto';

export type MonedaResuelta = {
  moneda: MonedaReporte;
  origen: OrigenMoneda;
  /** Monedas de las cuentas de Meta, para avisar de desajustes. */
  monedasMeta: string[];
};

/**
 * La moneda en la que se reporta un cliente:
 *   1. el ajuste explícito (`report_utm.clientes.config.moneda_reporte`);
 *   2. si no hay, la de sus cuentas de Meta: el gasto NO se convierte, así que
 *      es la única moneda en la que el ROAS compara lo mismo con lo mismo;
 *   3. si tampoco, USD.
 */
export function resolverMonedaReporte(configUtm: unknown, configApi: unknown): MonedaResuelta {
  const monedasMeta = monedasDeCuentasMeta(configApi);
  const ajuste = monedaAjustada(configUtm);
  if (ajuste) return { moneda: ajuste, origen: 'ajuste', monedasMeta };
  const meta = monedaDeCuentasMeta(configApi);
  if (meta) return { moneda: meta, origen: 'meta', monedasMeta };
  return { moneda: 'USD', origen: 'defecto', monedasMeta };
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
  /**
   * Fechas con dinero que no tenían tasa propia y se convirtieron con la de
   * otro día (la anterior más cercana). El importe es razonable, pero no es la
   * tasa congelada de esa venta: el informe lo avisa.
   */
  aproximadas: Set<string>;
};

/** El conversor identidad: moneda de reporte USD, o nada que convertir. */
export function conversorIdentidad(): ConversorMoneda {
  return {
    moneda: 'USD',
    tasa: () => 1,
    convertir: (usd) => usd,
    sinTasa: new Set(),
    aproximadas: new Set(),
  };
}

/**
 * Resumen serializable de los días sin tasa de un conversor, para mandarlo a la
 * UI junto al resultado. `null` si no hubo ninguno (lo normal).
 */
export type AvisoTasas = { sinTasa: string[]; aproximadas: string[] };

export function avisoDeTasas(conv: ConversorMoneda | null | undefined): AvisoTasas | null {
  if (!conv || (conv.sinTasa.size === 0 && conv.aproximadas.size === 0)) return null;
  return { sinTasa: [...conv.sinTasa].sort(), aproximadas: [...conv.aproximadas].sort() };
}

/** Une avisos de varias consultas (un informe con varios conversores). */
export function unirAvisosTasas(avisos: Array<AvisoTasas | null | undefined>): AvisoTasas | null {
  const sin = new Set<string>();
  const apx = new Set<string>();
  for (const a of avisos) {
    a?.sinTasa?.forEach((d) => sin.add(d));
    a?.aproximadas?.forEach((d) => apx.add(d));
  }
  if (sin.size === 0 && apx.size === 0) return null;
  return { sinTasa: [...sin].sort(), aproximadas: [...apx].sort() };
}

/** Texto del aviso: «Sin tasa de cambio para 2 días (15-09, 16-09): …». */
export function textoAvisoTasas(aviso: AvisoTasas | null | undefined): string | null {
  if (!aviso) return null;
  const lista = (dias: string[]) => {
    const cortos = dias.slice(0, 4).map((d) => `${d.slice(8, 10)}-${d.slice(5, 7)}`);
    return `${cortos.join(', ')}${dias.length > 4 ? '…' : ''}`;
  };
  const partes: string[] = [];
  if (aviso.aproximadas.length > 0) {
    const n = aviso.aproximadas.length;
    partes.push(
      `Sin tasa de cambio para ${n} día${n === 1 ? '' : 's'} (${lista(aviso.aproximadas)}): se usó la más cercana.`
    );
  }
  if (aviso.sinTasa.length > 0) {
    const n = aviso.sinTasa.length;
    partes.push(
      `Sin ninguna tasa de cambio para ${n} día${n === 1 ? '' : 's'} (${lista(aviso.sinTasa)}): esos importes quedaron en USD.`
    );
  }
  return partes.join(' ');
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

  const memo = new Map<string, { t: number | null; exacta: boolean }>();
  const buscar = (fecha: string) => {
    const dia = String(fecha).slice(0, 10);
    const hit = memo.get(dia);
    if (hit) return hit;
    let elegida: number | null = null;
    let exacta = false;
    for (const t of tasas) {
      if (t.fecha <= dia) {
        elegida = t.porUsd;
        exacta = t.fecha === dia;
      } else {
        if (elegida === null) elegida = t.porUsd;
        break;
      }
    }
    const r = { t: elegida, exacta };
    memo.set(dia, r);
    return r;
  };

  const sinTasa = new Set<string>();
  const aproximadas = new Set<string>();
  return {
    moneda,
    tasa: (fecha) => buscar(fecha).t,
    sinTasa,
    aproximadas,
    convertir: (usd, fecha) => {
      if (!usd) return usd;
      const { t, exacta } = buscar(fecha);
      const dia = String(fecha).slice(0, 10);
      if (t === null) {
        sinTasa.add(dia);
        return usd;
      }
      if (!exacta) aproximadas.add(dia);
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
  // Sin ninguna tasa en la ventana: la más cercana ANTERIOR al rango, y solo si
  // no hay ninguna, la primera posterior. No la última de la tabla: para un
  // rango de hace un año, la tasa de hoy es la peor elección posible.
  if (filas.length === 0) {
    const { data: anterior } = await db
      .from('fx_rates')
      .select('fecha, usd_rate')
      .eq('moneda', moneda)
      .lte('fecha', hasta)
      .order('fecha', { ascending: false })
      .limit(1);
    filas = (anterior ?? []) as Array<{ fecha: string; usd_rate: number }>;
    if (filas.length === 0) {
      const { data: posterior } = await db
        .from('fx_rates')
        .select('fecha, usd_rate')
        .eq('moneda', moneda)
        .gt('fecha', hasta)
        .order('fecha', { ascending: true })
        .limit(1);
      filas = (posterior ?? []) as Array<{ fecha: string; usd_rate: number }>;
    }
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

/**
 * Un precio configurado en USD (el del principal del funnel de una pestaña)
 * como promedio de fila en la moneda de reporte, con la tasa de ESA fila.
 *
 * Una fila sin `tasa_cambio` (un día que solo tiene datos de Sheet o de leads y
 * no pasó por `convertirFilasMetricas`) no aporta al promedio: antes aportaba el
 * precio en USD, y el promedio del rango mezclaba dólares con pesos. Con moneda
 * de reporte USD no hace falta tasa.
 */
export function precioUsdEnFila(
  precioUsd: number,
  tasaFila: unknown,
  monedaCliente: string | null | undefined
): Record<string, number> {
  const esUsd = String(monedaCliente || MONEDA_BASE).toUpperCase() === 'USD';
  const tasa = Number(tasaFila);
  const factor = esUsd ? 1 : Number.isFinite(tasa) && tasa > 0 ? tasa : null;
  if (factor === null) return { valor: 0 };
  const valor = precioUsd * factor;
  return { valor, num: valor, den: 1 };
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

// ── Caché de la moneda por cliente ────────────────────────────────────
const TTL_MS = 60_000;
const cache = new Map<string, { resuelta: MonedaResuelta; ts: number }>();

function guardarEnCache(clave: string, resuelta: MonedaResuelta): MonedaResuelta {
  if (cache.size > 500) cache.clear();
  cache.set(clave, { resuelta, ts: Date.now() });
  return resuelta;
}

const SIN_DATOS: MonedaResuelta = { moneda: 'USD', origen: 'defecto', monedasMeta: [] };

/**
 * `config_api` del cliente del reporting, solo con lo que necesita
 * `monedasDeCuentasMeta`. `schema('public')` explícito: hay llamantes que pasan
 * un cliente cuyo esquema por defecto es `report_utm`.
 */
async function configMetaPublica(db: any, publicId: string): Promise<unknown> {
  const { data, error } = await db
    .schema('public')
    .from('clientes')
    .select('config_api')
    .eq('id', publicId)
    .maybeSingle();
  if (error || !data) return null;
  const cfg = (data.config_api ?? {}) as Record<string, unknown>;
  return {
    meta_estado_cuentas: cfg.meta_estado_cuentas,
    meta_accounts: Array.isArray(cfg.meta_accounts)
      ? (cfg.meta_accounts as Array<Record<string, unknown>>).map((a) => ({
          account_id: a?.account_id,
        }))
      : undefined,
    meta_account_id: cfg.meta_account_id,
  };
}

/**
 * Moneda de un cliente de `report_utm` con su origen (ajuste, Meta o defecto).
 * Cacheada: se pregunta en cada widget de un informe.
 */
export async function resolverMonedaDeClienteUtm(
  db: any,
  rtmClienteId: string
): Promise<MonedaResuelta> {
  if (!rtmClienteId) return SIN_DATOS;
  const hit = cache.get(rtmClienteId);
  if (hit && Date.now() - hit.ts <= TTL_MS) return hit.resuelta;
  const { data, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('config, public_cliente_id')
    .eq('id', rtmClienteId)
    .maybeSingle();
  if (error) return SIN_DATOS;
  const ajuste = monedaAjustada(data?.config);
  // Con ajuste no hace falta leer Meta para la moneda, pero sí para poder avisar
  // en la tarjeta de ajustes de que no coincide; solo cuesta una consulta y va
  // cacheada.
  const configApi = data?.public_cliente_id
    ? await configMetaPublica(db, String(data.public_cliente_id)).catch(() => null)
    : null;
  const resuelta = ajuste
    ? { moneda: ajuste, origen: 'ajuste' as const, monedasMeta: monedasDeCuentasMeta(configApi) }
    : resolverMonedaReporte(null, configApi);
  return guardarEnCache(rtmClienteId, resuelta);
}

/** Moneda de reporte de un cliente de `report_utm` (ver `resolverMonedaReporte`). */
export async function monedaDeClienteUtm(db: any, rtmClienteId: string): Promise<MonedaReporte> {
  return (await resolverMonedaDeClienteUtm(db, rtmClienteId)).moneda;
}

/**
 * Moneda de reporte de un cliente del reporting, vía su espejo UTM. Sin espejo
 * no hay ajuste posible, pero sí la moneda de sus cuentas de Meta.
 */
export async function monedaDeClientePublico(db: any, publicId: string): Promise<MonedaReporte> {
  if (!publicId) return 'USD';
  const { data } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId)
    .limit(1);
  const id = data?.[0]?.id as string | undefined;
  if (id) return monedaDeClienteUtm(db, id);

  const clave = `public:${publicId}`;
  const hit = cache.get(clave);
  if (hit && Date.now() - hit.ts <= TTL_MS) return hit.resuelta.moneda;
  const configApi = await configMetaPublica(db, publicId).catch(() => null);
  return guardarEnCache(clave, resolverMonedaReporte(null, configApi)).moneda;
}

/** Solo para las comprobaciones. */
export function _limpiarCacheMoneda(): void {
  cache.clear();
}
