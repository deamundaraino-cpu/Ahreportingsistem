// ════════════════════════════════════════════════════════════════
// GA4 por fuente / medio / campaña y eventos clave
// ════════════════════════════════════════════════════════════════
//
// El GA4 de `metricas_diarias` son tres totales por día del sitio entero: solo
// cruzan con el gasto por FECHA. Este módulo trae las sesiones y los eventos
// clave por la tupla UTM de la sesión y los guarda en crudo en
// `ga4_sesiones_diarias` / `ga4_eventos_clave_diarios` (migración 097). El BI
// resuelve la campaña al consultar con el mismo motor que los leads.
//
// Diferencias con el `fetchGA4` diario del worker:
//  · UNA petición por ventana de hasta 31 días con la dimensión `date`, no una
//    por día (un backfill de un año son ~24 peticiones, no ~1.800).
//  · Paginada: sin `limit` la API corta en 10.000 filas en silencio.
//  · Lee los metadatos (umbral, fila «(other)», muestreo, zona y moneda de la
//    propiedad) y los deja en `ga4_estado` para la salud de fuentes.
//  · El error se GUARDA (`ga4_estado.ultimo_error`) en vez de ir a un log.
//
// Núcleo puro arriba (lo prueba `verify-ga4-desglose.ts` sin red); E/S abajo.

import type { SupabaseClient } from '@supabase/supabase-js';
import { ga4Run } from '@/lib/rate-limit';
import { addDaysISO } from '@/lib/colombia-date';
import { rutaDePagina } from '@/lib/report-utm/page-url';
import {
  clasificarErrorGa4,
  crearClienteGa4,
  mensajeErrorGa4,
  type ClienteGa4,
} from './ga4-cliente';

// ─── Tipos de la respuesta (subconjunto de IRunReportResponse) ───────────────

type Valor = { value?: string | null } | null | undefined;
export interface RespuestaGa4 {
  dimensionHeaders?: Array<{ name?: string | null }> | null;
  metricHeaders?: Array<{ name?: string | null }> | null;
  rows?: Array<{ dimensionValues?: Valor[] | null; metricValues?: Valor[] | null }> | null;
  rowCount?: number | null;
  metadata?: {
    timeZone?: string | null;
    currencyCode?: string | null;
    subjectToThresholding?: boolean | null;
    dataLossFromOtherRow?: boolean | null;
    samplingMetadatas?: unknown[] | null;
  } | null;
  propertyQuota?: unknown;
}

export interface FilaSesionesGa4 {
  fecha: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_id: string;
  sesiones: number;
  sesiones_interaccion: number;
  eventos_clave: number;
  ingresos: number;
}

export interface FilaEventoGa4 {
  fecha: string;
  evento: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_id: string;
  eventos_clave: number;
}

/** Sesiones por página de entrada × tupla UTM (`ga4_landing_diarios`). */
export interface FilaLandingGa4 extends FilaSesionesGa4 {
  /** Ruta normalizada con `rutaDePagina`; `''` = `(not set)`. */
  landing: string;
  /** `totalUsers` del día para la tupla: NO se suma entre días ni filas. */
  visitantes: number;
}

/** Vistas por página (`ga4_vistas_diarias`). */
export interface FilaVistaGa4 {
  fecha: string;
  host: string;
  pagina: string;
  vistas: number;
}

export interface MetadatosGa4 {
  zona_horaria: string | null;
  moneda: string | null;
  umbral: boolean;
  fila_otros: boolean;
  muestreo: boolean;
  cuota: unknown;
}

// ─── Peticiones ──────────────────────────────────────────────────────────────

export const LIMITE_PAGINA_GA4 = 10_000;
/** Tope de seguridad por ventana: por encima algo va mal (bots, UTMs basura). */
export const MAX_FILAS_VENTANA = 50_000;
/** Días por petición: una ventana larga multiplica filas pero no peticiones. */
export const DIAS_VENTANA_GA4 = 31;

const DIMS_SESION = [
  'date',
  'sessionSource',
  'sessionMedium',
  'sessionCampaignName',
  'sessionCampaignId',
] as const;

function base(desde: string, hasta: string, offset: number, dims: readonly string[] = DIMS_SESION) {
  return {
    dateRanges: [{ startDate: desde, endDate: hasta }],
    limit: LIMITE_PAGINA_GA4,
    offset,
    keepEmptyRows: false,
    // Orden estable por TODAS las dimensiones: sin él dos páginas pueden
    // solapar o saltarse filas.
    orderBys: dims.map((d) => ({ dimension: { dimensionName: d } })),
    returnPropertyQuota: offset === 0,
  };
}

export function peticionSesiones(desde: string, hasta: string, offset = 0) {
  return {
    ...base(desde, hasta, offset),
    dimensions: DIMS_SESION.map((name) => ({ name })),
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
    ],
  };
}

export function peticionEventos(desde: string, hasta: string, offset = 0) {
  return {
    ...base(desde, hasta, offset),
    dimensions: [...DIMS_SESION, 'eventName'].map((name) => ({ name })),
    metrics: [{ name: 'keyEvents' }],
    // Solo eventos clave: sin el filtro vendrían page_view, scroll… con 0.
    metricFilter: {
      filter: {
        fieldName: 'keyEvents',
        numericFilter: { operation: 'GREATER_THAN' as const, value: { int64Value: '0' } },
      },
    },
  };
}

/** Dimensiones del informe por página de entrada: la tupla + `landingPage`. */
const DIMS_LANDING = [...DIMS_SESION, 'landingPage'] as const;
/** Dimensiones del informe de vistas por página. */
const DIMS_VISTAS = ['date', 'hostName', 'pagePath'] as const;

/**
 * Sesiones por página de entrada. `landingPage` es la ruta de la PRIMERA vista
 * de la sesión, sin host ni query: cada sesión cuenta en una sola página, así
 * que las sesiones por landing se pueden sumar.
 */
export function peticionLanding(desde: string, hasta: string, offset = 0) {
  return {
    ...base(desde, hasta, offset, DIMS_LANDING),
    dimensions: DIMS_LANDING.map((name) => ({ name })),
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: 'keyEvents' },
      { name: 'totalRevenue' },
      { name: 'totalUsers' },
    ],
  };
}

/** Vistas por página de todo el sitio, como el informe «Páginas» de GA4. */
export function peticionVistas(desde: string, hasta: string, offset = 0) {
  return {
    ...base(desde, hasta, offset, DIMS_VISTAS),
    dimensions: DIMS_VISTAS.map((name) => ({ name })),
    metrics: [{ name: 'screenPageViews' }],
  };
}

// ─── Normalización ───────────────────────────────────────────────────────────

/** `20260927` → `2026-09-27`. */
export function fechaGa(v: string): string {
  const s = String(v ?? '').trim();
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

/**
 * Marcadores de GA que significan «sin campaña». Se guardan como `''` para que
 * el resolver los trate como vacíos y caigan en «(sin campaña)», la misma fila
 * que los leads sin campaña.
 */
const SIN_VALOR = new Set([
  '(not set)',
  '(none)',
  '(direct)',
  '(organic)',
  '(referral)',
  '(cross-network)',
  '(data not available)',
  '(not provided)',
]);

export function normalizarValorGa(v: unknown): string {
  const s = String(v ?? '').trim();
  return SIN_VALOR.has(s.toLowerCase()) ? '' : s;
}

/** Fuente y medio se guardan tal cual (salvo los marcadores): `(direct)` → `''`. */
const num = (v: Valor): number => {
  const n = Number(v?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function indices(resp: RespuestaGa4) {
  const dims = new Map<string, number>();
  (resp.dimensionHeaders ?? []).forEach((h, i) => h?.name && dims.set(h.name, i));
  const mets = new Map<string, number>();
  (resp.metricHeaders ?? []).forEach((h, i) => h?.name && mets.set(h.name, i));
  return { dims, mets };
}

function tuplaDe(
  row: NonNullable<RespuestaGa4['rows']>[number],
  dims: Map<string, number>
): Omit<FilaSesionesGa4, 'sesiones' | 'sesiones_interaccion' | 'eventos_clave' | 'ingresos'> {
  const d = (name: string) => {
    const i = dims.get(name);
    return i === undefined ? '' : String(row.dimensionValues?.[i]?.value ?? '');
  };
  return {
    fecha: fechaGa(d('date')),
    utm_source: normalizarValorGa(d('sessionSource')),
    utm_medium: normalizarValorGa(d('sessionMedium')),
    utm_campaign: normalizarValorGa(d('sessionCampaignName')),
    utm_id: normalizarValorGa(d('sessionCampaignId')),
  };
}

const claveTupla = (t: {
  fecha: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_id: string;
}) => [t.fecha, t.utm_source, t.utm_medium, t.utm_campaign, t.utm_id].join('\u0001');

/**
 * Filas de sesiones. Mapea por NOMBRE de cabecera (nunca por posición) y suma
 * las filas que colisionan tras normalizar: `(direct)` y `(not set)` en la misma
 * columna acaban siendo la misma tupla.
 */
export function filasSesiones(resps: RespuestaGa4[]): FilaSesionesGa4[] {
  const acc = new Map<string, FilaSesionesGa4>();
  for (const resp of resps) {
    const { dims, mets } = indices(resp);
    const m = (row: NonNullable<RespuestaGa4['rows']>[number], name: string) => {
      const i = mets.get(name);
      return i === undefined ? 0 : num(row.metricValues?.[i]);
    };
    for (const row of resp.rows ?? []) {
      const t = tuplaDe(row, dims);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.fecha)) continue;
      const k = claveTupla(t);
      const prev = acc.get(k) ?? {
        ...t,
        sesiones: 0,
        sesiones_interaccion: 0,
        eventos_clave: 0,
        ingresos: 0,
      };
      prev.sesiones += m(row, 'sessions');
      prev.sesiones_interaccion += m(row, 'engagedSessions');
      prev.eventos_clave += m(row, 'keyEvents') || m(row, 'conversions');
      prev.ingresos += m(row, 'totalRevenue');
      acc.set(k, prev);
    }
  }
  return [...acc.values()];
}

export function filasEventos(resps: RespuestaGa4[]): FilaEventoGa4[] {
  const acc = new Map<string, FilaEventoGa4>();
  for (const resp of resps) {
    const { dims, mets } = indices(resp);
    const iEv = dims.get('eventName');
    for (const row of resp.rows ?? []) {
      const t = tuplaDe(row, dims);
      const evento =
        iEv === undefined ? '' : String(row.dimensionValues?.[iEv]?.value ?? '').trim();
      if (!evento || !/^\d{4}-\d{2}-\d{2}$/.test(t.fecha)) continue;
      const iM = mets.get('keyEvents') ?? mets.get('conversions');
      const v = iM === undefined ? 0 : num(row.metricValues?.[iM]);
      if (v <= 0) continue;
      const k = `${claveTupla(t)}\u0001${evento}`;
      const prev = acc.get(k) ?? { ...t, evento, eventos_clave: 0 };
      prev.eventos_clave += v;
      acc.set(k, prev);
    }
  }
  return [...acc.values()];
}

/**
 * Filas por página de entrada. La ruta se normaliza con `rutaDePagina` (la
 * misma función que agrupa los leads), y las filas que colisionan tras
 * normalizar (`/a` y `/A/`) se suman.
 */
export function filasLanding(resps: RespuestaGa4[]): FilaLandingGa4[] {
  const acc = new Map<string, FilaLandingGa4>();
  for (const resp of resps) {
    const { dims, mets } = indices(resp);
    const m = (row: NonNullable<RespuestaGa4['rows']>[number], name: string) => {
      const i = mets.get(name);
      return i === undefined ? 0 : num(row.metricValues?.[i]);
    };
    const iLp = dims.get('landingPage');
    for (const row of resp.rows ?? []) {
      const t = tuplaDe(row, dims);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.fecha)) continue;
      const landing = rutaDePagina(
        iLp === undefined ? '' : String(row.dimensionValues?.[iLp]?.value ?? '')
      );
      const k = `${claveTupla(t)}\u0001${landing}`;
      const prev = acc.get(k) ?? {
        ...t,
        landing,
        sesiones: 0,
        sesiones_interaccion: 0,
        eventos_clave: 0,
        ingresos: 0,
        visitantes: 0,
      };
      prev.sesiones += m(row, 'sessions');
      prev.sesiones_interaccion += m(row, 'engagedSessions');
      prev.eventos_clave += m(row, 'keyEvents') || m(row, 'conversions');
      prev.ingresos += m(row, 'totalRevenue');
      prev.visitantes += m(row, 'totalUsers');
      acc.set(k, prev);
    }
  }
  return [...acc.values()];
}

/** Filas de vistas por página: `pagePath` normalizado, host en minúsculas. */
export function filasVistas(resps: RespuestaGa4[]): FilaVistaGa4[] {
  const acc = new Map<string, FilaVistaGa4>();
  for (const resp of resps) {
    const { dims, mets } = indices(resp);
    const d = (row: NonNullable<RespuestaGa4['rows']>[number], name: string) => {
      const i = dims.get(name);
      return i === undefined ? '' : String(row.dimensionValues?.[i]?.value ?? '');
    };
    const iV = mets.get('screenPageViews');
    for (const row of resp.rows ?? []) {
      const fecha = fechaGa(d(row, 'date'));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
      const vistas = iV === undefined ? 0 : num(row.metricValues?.[iV]);
      if (vistas <= 0) continue;
      const host = normalizarValorGa(d(row, 'hostName')).toLowerCase();
      const pagina = rutaDePagina(d(row, 'pagePath'));
      const k = [fecha, host, pagina].join('\u0001');
      const prev = acc.get(k) ?? { fecha, host, pagina, vistas: 0 };
      prev.vistas += vistas;
      acc.set(k, prev);
    }
  }
  return [...acc.values()];
}

/**
 * ¿Qué informe de páginas NO se debe escribir? Si la ventana tiene sesiones
 * pero el informe de landing o el de vistas llegó vacío, algo falló a medias
 * (un corte de GA4, un límite): mejor conservar lo guardado que borrarlo.
 */
export function paginasSospechosas(
  sesionesVentana: number,
  landing: FilaLandingGa4[],
  vistas: FilaVistaGa4[]
): { landing: boolean; vistas: boolean } {
  if (sesionesVentana <= 0) return { landing: false, vistas: false };
  return { landing: landing.length === 0, vistas: vistas.length === 0 };
}

/**
 * Diferencia relativa entre las sesiones por landing y las de la tupla UTM. Son
 * dos informes distintos de GA4: con umbrales o fila «(other)» no tienen por
 * qué cuadrar al 100 %, pero un desvío grande es un aviso.
 */
export function desvioLanding(sesionesTupla: number, landing: FilaLandingGa4[]): number {
  const l = landing.reduce((a, f) => a + f.sesiones, 0);
  if (sesionesTupla <= 0) return l > 0 ? 1 : 0;
  return Math.abs(l - sesionesTupla) / sesionesTupla;
}

/** Metadatos combinados de varias respuestas (un flag en cualquiera cuenta). */
export function metadatosDeRespuestas(resps: RespuestaGa4[]): MetadatosGa4 {
  const out: MetadatosGa4 = {
    zona_horaria: null,
    moneda: null,
    umbral: false,
    fila_otros: false,
    muestreo: false,
    cuota: null,
  };
  for (const r of resps) {
    const md = r.metadata ?? {};
    out.zona_horaria ??= md.timeZone || null;
    out.moneda ??= md.currencyCode || null;
    out.umbral ||= !!md.subjectToThresholding;
    out.fila_otros ||= !!md.dataLossFromOtherRow;
    out.muestreo ||= (md.samplingMetadatas?.length ?? 0) > 0;
    if (r.propertyQuota) out.cuota = r.propertyQuota;
  }
  return out;
}

/** Offsets de las páginas que faltan tras la primera. */
export function offsetsPendientes(rowCount: number, limite = LIMITE_PAGINA_GA4): number[] {
  const out: number[] = [];
  for (let o = limite; o < rowCount; o += limite) out.push(o);
  return out;
}

/** Parte `[desde, hasta]` en ventanas de hasta `dias` días. */
export function ventanas(
  desde: string,
  hasta: string,
  dias = DIAS_VENTANA_GA4
): Array<[string, string]> {
  if (!desde || !hasta || hasta < desde) return [];
  const out: Array<[string, string]> = [];
  let ini = desde;
  while (ini <= hasta) {
    const finMax = addDaysISO(ini, dias - 1);
    const fin = finMax < hasta ? finMax : hasta;
    out.push([ini, fin]);
    ini = addDaysISO(fin, 1);
  }
  return out;
}

/**
 * ¿Una respuesta vacía es sospechosa? GA devuelve 0 filas tanto si el sitio no
 * tuvo tráfico como si el tag dejó de disparar. Solo se desconfía si la ventana
 * incluye días ya asentados (más de 2 días atrás) y hubo sesiones en los 7 días
 * anteriores: entonces no se borra lo guardado.
 */
export function sospechosoVacio(
  filas: FilaSesionesGa4[],
  hayDatosPrevios: boolean,
  hasta: string,
  hoy: string
): boolean {
  if (filas.length > 0) return false;
  return hayDatosPrevios && hasta <= addDaysISO(hoy, -2);
}

// ─── E/S ─────────────────────────────────────────────────────────────────────

type ClienteDb = { id: string; nombre?: string; config_api: unknown };

export interface ResultadoSyncGa4 {
  ok: boolean;
  sesiones: number;
  eventos: number;
  /** Filas escritas por página de entrada y por vistas (migración 100). */
  landing: number;
  vistas: number;
  /** Aviso no fatal de las páginas (no hacen fallar la ventana). */
  avisoPaginas?: string;
  ventanas: number;
  partial: boolean;
  resumeFrom: string | null;
  error?: string;
  codigo?: string;
}

async function paginar(
  ga: ClienteGa4,
  peticion: (offset: number) => Record<string, unknown>
): Promise<RespuestaGa4[]> {
  const run = async (offset: number) => {
    const [resp] = await ga4Run(() =>
      ga.client.runReport({ property: ga.propertyName, ...peticion(offset) } as never)
    );
    return resp as unknown as RespuestaGa4;
  };
  const primera = await run(0);
  const total = Number(primera.rowCount ?? primera.rows?.length ?? 0);
  if (total > MAX_FILAS_VENTANA) throw new DemasiadasFilas(total);
  const resto = await Promise.all(offsetsPendientes(total).map(run));
  return [primera, ...resto];
}

/** La ventana devolvió más filas que el tope: hay que partirla. */
class DemasiadasFilas extends Error {
  constructor(total: number) {
    super(`GA4 devolvió ${total} filas en una ventana (tope ${MAX_FILAS_VENTANA})`);
  }
}

/**
 * `paginar` que, si la ventana supera el tope de filas, la parte en dos (hasta
 * llegar a un día) antes de rendirse. Los informes por página tienen más
 * cardinalidad que el de campaña; con el volumen de hoy (~700 filas/mes) no
 * salta, pero un sitio con miles de URL no debe tumbar la sincronización.
 */
async function paginarPartiendo(
  ga: ClienteGa4,
  desde: string,
  hasta: string,
  peticion: (d: string, h: string, offset: number) => Record<string, unknown>
): Promise<RespuestaGa4[]> {
  try {
    return await paginar(ga, (o) => peticion(desde, hasta, o));
  } catch (e) {
    if (!(e instanceof DemasiadasFilas) || desde >= hasta) throw e;
    const dias = Math.round(
      (Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000
    );
    const medio = addDaysISO(desde, Math.floor(dias / 2));
    const [a, b] = await Promise.all([
      paginarPartiendo(ga, desde, medio, peticion),
      paginarPartiendo(ga, addDaysISO(medio, 1), hasta, peticion),
    ]);
    return [...a, ...b];
  }
}

/** ¿La RPC no existe (migración 100 sin aplicar)? */
function faltaRpc(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? ''))
  );
}

async function registrarError(
  db: SupabaseClient,
  clienteId: string,
  propiedad: string | null,
  codigo: string,
  mensaje: string
) {
  const ahora = new Date().toISOString();
  await db.from('ga4_estado').upsert(
    {
      cliente_id: clienteId,
      propiedad,
      ultimo_intento_at: ahora,
      ultimo_error: mensaje.slice(0, 1000),
      ultimo_error_codigo: codigo,
      ultimo_error_at: ahora,
      updated_at: ahora,
    },
    { onConflict: 'cliente_id' }
  );
}

/**
 * Sincroniza `[desde, hasta]` de un cliente, ventana a ventana y hacia delante.
 * Una ventana solo se escribe si sus DOS informes terminaron completos; ante un
 * error se registra en `ga4_estado` y no se toca nada de lo guardado.
 */
export async function sincronizarGa4Cliente(
  db: SupabaseClient,
  cliente: ClienteDb,
  desde: string,
  hasta: string,
  opts: { hayTiempo: () => boolean; hoy: string; log?: (m: string) => void }
): Promise<ResultadoSyncGa4> {
  const log = opts.log ?? (() => {});
  const res: ResultadoSyncGa4 = {
    ok: true,
    sesiones: 0,
    eventos: 0,
    landing: 0,
    vistas: 0,
    ventanas: 0,
    partial: false,
    resumeFrom: null,
  };
  const config = (cliente.config_api ?? {}) as Record<string, string | null | undefined>;
  const ga = await crearClienteGa4(config);
  if (!ga) {
    return { ...res, ok: false, error: 'GA4 sin configurar', codigo: 'sin_configurar' };
  }

  const tope = hasta > opts.hoy ? opts.hoy : hasta;
  // Sin la migración 100 las páginas se saltan en todo el rango (una vez avisado).
  let paginasDisponibles = true;
  for (const [ini, fin] of ventanas(desde, tope)) {
    if (!opts.hayTiempo()) {
      res.partial = true;
      res.resumeFrom = ini;
      break;
    }
    try {
      const [rs, re] = await Promise.all([
        paginar(ga, (o) => peticionSesiones(ini, fin, o)),
        paginar(ga, (o) => peticionEventos(ini, fin, o)),
      ]);
      const sesiones = filasSesiones(rs);
      const eventos = filasEventos(re);

      if (sesiones.length === 0) {
        const { count } = await db
          .from('ga4_sesiones_diarias')
          .select('id', { count: 'exact', head: true })
          .eq('cliente_id', cliente.id)
          .gte('fecha', addDaysISO(ini, -7))
          .lt('fecha', ini);
        if (sospechosoVacio(sesiones, (count ?? 0) > 0, fin, opts.hoy)) {
          const msg = `GA4 devolvió 0 sesiones en ${ini}…${fin} con datos la semana anterior: no se sobrescribe.`;
          log(`[GA4 desglose] ${cliente.nombre ?? cliente.id}: ${msg}`);
          await registrarError(db, cliente.id, ga.propertyId, 'vacio_sospechoso', msg);
          res.ok = false;
          res.error = msg;
          res.codigo = 'vacio_sospechoso';
          continue;
        }
      }

      const md = metadatosDeRespuestas([...rs, ...re]);
      const { data, error } = await db.rpc('ga4_reemplazar_rango', {
        p_cliente_id: cliente.id,
        p_desde: ini,
        p_hasta: fin,
        p_sesiones: sesiones,
        p_eventos: eventos,
        p_estado: { propiedad: ga.propertyId, ...md },
      });
      if (error) throw new Error(`ga4_reemplazar_rango: ${error.message}`);
      const escr = (data ?? {}) as { sesiones?: number; eventos?: number };
      res.sesiones += escr.sesiones ?? sesiones.length;
      res.eventos += escr.eventos ?? eventos.length;
      res.ventanas++;
      log(
        `[GA4 desglose] ${cliente.nombre ?? cliente.id} ${ini}…${fin}: ${sesiones.length} tuplas, ${eventos.length} eventos${md.umbral ? ' (umbral)' : ''}`
      );

      // ── Páginas (migración 100): no obligatorias ──────────────────
      // Un fallo aquí se registra en `ga4_estado.paginas_*` y NO hace fallar la
      // ventana: las campañas ya se escribieron y son lo que más se usa.
      if (paginasDisponibles) {
        const r = await sincronizarPaginas(db, ga, cliente.id, ini, fin, sesiones);
        if (r.faltaMigracion) {
          paginasDisponibles = false;
          res.avisoPaginas = 'Migración 100 sin aplicar: no se sincronizan las páginas de GA4.';
          log(`[GA4 páginas] ${res.avisoPaginas}`);
        } else {
          res.landing += r.landing;
          res.vistas += r.vistas;
          if (r.aviso) {
            res.avisoPaginas = r.aviso;
            log(`[GA4 páginas] ${cliente.nombre ?? cliente.id} ${ini}…${fin}: ${r.aviso}`);
          }
        }
      }
    } catch (e) {
      const codigo = clasificarErrorGa4(e);
      const msg = mensajeErrorGa4(codigo, {
        via: ga.via,
        propertyId: ga.propertyId,
        detalle: e instanceof Error ? e.message : String(e),
      });
      log(`[GA4 desglose] ${cliente.nombre ?? cliente.id}: ${msg}`);
      await registrarError(db, cliente.id, ga.propertyId, codigo, msg).catch(() => {});
      return { ...res, ok: false, error: msg, codigo };
    }
  }
  return res;
}

/**
 * Informes por página de una ventana: sesiones por página de entrada y vistas
 * por página. Se piden a la vez; cada uno se escribe solo si llegó completo y no
 * es sospechoso (el otro se pasa como NULL y la RPC lo deja intacto).
 */
async function sincronizarPaginas(
  db: SupabaseClient,
  ga: ClienteGa4,
  clienteId: string,
  ini: string,
  fin: string,
  sesionesTupla: FilaSesionesGa4[]
): Promise<{ landing: number; vistas: number; aviso?: string; faltaMigracion?: boolean }> {
  const [rl, rv] = await Promise.allSettled([
    paginarPartiendo(ga, ini, fin, peticionLanding),
    paginarPartiendo(ga, ini, fin, peticionVistas),
  ]);
  const landing = rl.status === 'fulfilled' ? filasLanding(rl.value) : null;
  const vistas = rv.status === 'fulfilled' ? filasVistas(rv.value) : null;
  const totalSes = sesionesTupla.reduce((a, f) => a + f.sesiones, 0);
  const sospecha = paginasSospechosas(totalSes, landing ?? [], vistas ?? []);
  const escribirLanding = landing !== null && !sospecha.landing;
  const escribirVistas = vistas !== null && !sospecha.vistas;

  const avisos: string[] = [];
  if (rl.status === 'rejected')
    avisos.push(`landing: ${(rl.reason as Error)?.message ?? rl.reason}`);
  if (rv.status === 'rejected')
    avisos.push(`vistas: ${(rv.reason as Error)?.message ?? rv.reason}`);
  if (landing && sospecha.landing) avisos.push('landing vacío con sesiones: no se sobrescribe');
  if (vistas && sospecha.vistas) avisos.push('vistas vacías con sesiones: no se sobrescribe');
  if (escribirLanding && desvioLanding(totalSes, landing!) > 0.05) {
    avisos.push(
      `las sesiones por landing difieren más de un 5 % de las de campaña (${landing!.reduce((a, f) => a + f.sesiones, 0)} frente a ${totalSes})`
    );
  }
  const aviso = avisos.length ? avisos.join(' · ') : undefined;
  if (!escribirLanding && !escribirVistas) return { landing: 0, vistas: 0, aviso };

  const md = metadatosDeRespuestas([
    ...(rl.status === 'fulfilled' ? rl.value : []),
    ...(rv.status === 'fulfilled' ? rv.value : []),
  ]);
  const { data, error } = await db.rpc('ga4_reemplazar_paginas', {
    p_cliente_id: clienteId,
    p_desde: ini,
    p_hasta: fin,
    p_landing: escribirLanding ? landing : null,
    p_vistas: escribirVistas ? vistas : null,
    p_estado: { umbral: md.umbral, fila_otros: md.fila_otros, error: aviso ?? null },
  });
  if (faltaRpc(error)) return { landing: 0, vistas: 0, faltaMigracion: true };
  if (error) return { landing: 0, vistas: 0, aviso: `ga4_reemplazar_paginas: ${error.message}` };
  const escr = (data ?? {}) as { landing?: number; vistas?: number };
  return { landing: escr.landing ?? 0, vistas: escr.vistas ?? 0, aviso };
}
