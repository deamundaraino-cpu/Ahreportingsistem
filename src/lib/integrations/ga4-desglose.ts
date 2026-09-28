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

function base(desde: string, hasta: string, offset: number) {
  return {
    dateRanges: [{ startDate: desde, endDate: hasta }],
    limit: LIMITE_PAGINA_GA4,
    offset,
    keepEmptyRows: false,
    // Orden estable: sin él dos páginas pueden solapar o saltarse filas.
    orderBys: DIMS_SESION.map((d) => ({ dimension: { dimensionName: d } })),
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
  if (total > MAX_FILAS_VENTANA) {
    throw new Error(`GA4 devolvió ${total} filas en una ventana (tope ${MAX_FILAS_VENTANA})`);
  }
  const resto = await Promise.all(offsetsPendientes(total).map(run));
  return [primera, ...resto];
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
