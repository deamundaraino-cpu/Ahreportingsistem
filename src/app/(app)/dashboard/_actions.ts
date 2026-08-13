'use server';

import { createAdminClient, createClient } from '@/utils/supabase/server';
import { filterCampaignList, parseTabFilter } from '@/lib/campaign-filter';
import { notifyUsers } from '@/lib/notifications/notify';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import { getWeeksInRange, clampRangeToToday, colombiaToday, addDaysISO } from '@/lib/date-utils';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { loadCamposCliente } from '@/lib/sheets/campos-db';
import { hotmartConectado } from '@/lib/hotmart/cliente';
import { enqueueJob } from '@/lib/sync/queue';
import { agregarDiarios, vistaIncluyeValor, clavesPlanasDelDia } from '@/lib/sheets/campos';
import type { CampoValorDiario, CampoAgg, CampoFormato } from '@/lib/sheets/campos';
import { mergeMetricasDelRango, agruparOfflinePorFecha } from '@/lib/dashboard/merge-metrics';
import { fetchAllRows } from '@/lib/supabase-paginate';
import { normalizeSheetConfigs } from '@/lib/integrations/google-sheets-conversiones';
import type { SyncConversionesResponse } from '@/lib/integrations/google-sheets-conversiones';
import { leerJsonRespuesta, esTimeoutDeFetch } from '@/lib/fetch-json';
import { resolveRtmClienteId } from '@/lib/report-utm/campaign-resolver';
import { formulaUsaRespuestas, camposEnFormula } from '@/lib/dashboard/lead-answer-aggregation';
import { BUCKET_OTROS } from '@/lib/report-utm/lead-campos';
import type { LeadAnswerCampoResumen } from '@/lib/dashboard/metric-catalog';
import { loadLeadCampos, saveLeadCampo } from '@/lib/report-utm/lead-campos-db';
import { slugCampo } from '@/lib/report-utm/lead-campos';
import { getUserRole } from '@/lib/report-utm/auth';
import { cargarRespuestasLead, campoSintetico, datasetVacio } from '@/lib/report-utm/lead-answers-db';
import type { LeadAnswerDataset } from '@/lib/report-utm/lead-answers-db';
import type { LeadCampoDef } from '@/lib/report-utm/lead-campos';
import type { LeadAnswerBlockDef } from '@/lib/layout-types';

/** Un campo de Sheet tal como lo necesita la UI del dashboard. */
export interface SheetCampoResumen {
  clave: string
  nombre: string
  agregacion: CampoAgg
  formato: CampoFormato
}
/** Una vista guardada, con su formato propio. */
export interface SheetVistaResumen {
  clave: string
  nombre: string
  agregacion: CampoAgg
  formato: 'number' | 'currency' | 'percent'
}

interface SheetCamposDelDia {
  porFecha: Map<string, Record<string, number>>
  /** Las 4 métricas legacy de leads, derivadas del campo de calidad migrado. */
  leadsLegacy: Map<string, Record<string, number>>
  campos: SheetCampoResumen[]
  vistas: SheetVistaResumen[]
}

/** Días por debajo de los cuales el sync se ejecuta al momento en vez de encolarse. */
const SYNC_DIRECTO_MAX_DIAS = 7;

/** Aquí el sync es de todos los sheets a la vez; el de uno en uno está en Ajustes. */
const TIMEOUT_SHEETS = 'El Sheet tardó demasiado. Sincronízalo desde Ajustes del cliente.';

/** Resultado de `triggerWorkerSync`, consumido por el botón "Sincronizar Datos". */
export type SyncResult = {
  ok: boolean;
  error?: string;
  queued?: boolean;
  jobs?: number;
  /** Rango efectivo encolado, para que la UI sondee su progreso. */
  range?: { from: string; to: string };
  partial?: boolean;
  /** Aviso no bloqueante (p. ej. "sin datos que sincronizar"). */
  warning?: string;
  message?: string;
  platform_status: { meta?: string; hotmart?: string; ga4?: string } | null;
};

/** Resultado del sync de Google Sheets, que va aparte del de métricas. */
export type SheetsSyncResult = {
  ok: boolean
  /** El cliente no tiene Sheets configurados: no es un error, no hay nada que hacer. */
  configured: boolean
  filas?: number
  camposRecalculados?: number
  warnings?: string[]
  error?: string
}

/**
 * Sincroniza los Google Sheets del cliente y recalcula sus campos.
 *
 * Va aparte de `triggerWorkerSync` por dos razones: el worker de métricas ya
 * consume casi todo el presupuesto de tiempo de una función de Vercel, y
 * separarlas permite que el botón informe de en qué fase está en vez de quedarse
 * mudo. El endpoint que llama encadena `syncClienteConversiones` →
 * `recalcularCamposCliente`, que es lo único que repuebla el desglose diario.
 */
export async function triggerSheetsSync(clientId: string): Promise<SheetsSyncResult> {
  if (!clientId) return { ok: false, configured: false, error: 'Cliente inválido' }

  try {
    const supabase = await createAdminClient()
    const { data: cliente } = await supabase
      .from('clientes').select('config_api').eq('id', clientId).maybeSingle()

    const sheets = normalizeSheetConfigs((cliente as any)?.config_api?.google_sheets_conversiones)
      .filter(s => s.enabled && s.sheet_url)
    if (sheets.length === 0) return { ok: true, configured: false }

    const headersList = await headers()
    const host = headersList.get('host') || 'localhost:3001'
    const protocol = host.includes('localhost') ? 'http' : 'https'

    const res = await fetch(`${protocol}://${host}/api/admin/sync-conversiones-offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
      cache: 'no-store',
      // Un punto por debajo del maxDuration de la ruta, para devolver un error
      // legible en vez de que la petición muera sin más.
      signal: AbortSignal.timeout(58_000),
    })

    const leido = await leerJsonRespuesta<SyncConversionesResponse>(res, 'Error al sincronizar el Sheet', TIMEOUT_SHEETS)
    if (!leido.ok) return { ok: false, configured: true, error: leido.error }
    const data = leido.data

    if (!res.ok) {
      return { ok: false, configured: true, error: data.error || 'Error al sincronizar el Sheet' }
    }

    return {
      ok: true,
      configured: true,
      filas: data.totalFilas ?? 0,
      camposRecalculados: data.camposRecalculados ?? 0,
      warnings: data.warnings ?? [],
    }
  } catch (e: any) {
    return {
      ok: false,
      configured: true,
      error: esTimeoutDeFetch(e)
        ? TIMEOUT_SHEETS
        : (e?.message || 'Error al sincronizar el Sheet'),
    }
  }
}

/**
 * Lanza la sincronización de un cliente para un rango.
 *
 * Rangos cortos van directos al worker (el usuario ve el resultado al instante).
 * Los largos se encolan en `sync_jobs`: Hotmart y GA4 se consultan día a día, así
 * que un rango de meses no cabe en los 60s de una función de Vercel — antes la
 * petición simplemente moría y el usuario no se enteraba de que faltaban datos.
 *
 * Solo trae `metricas_diarias`. Los Google Sheets van por `triggerSheetsSync`.
 */
export async function triggerWorkerSync(clientId: string, from: string, to: string): Promise<SyncResult> {
  if (!clientId || !from || !to) {
    return { ok: false, error: 'Parámetros inválidos', platform_status: null };
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, error: 'CRON_SECRET no configurado en el servidor', platform_status: null };
  }

  const h = await headers();
  const host = h.get('host');
  const proto = h.get('x-forwarded-proto') || (host?.startsWith('localhost') ? 'http' : 'https');
  if (!host) {
    return { ok: false, error: 'No se pudo determinar el host', platform_status: null };
  }
  const base = `${proto}://${host}`;

  // El selector permite mirar un rango que termina en el futuro (la ventana
  // completa de un lanzamiento, p. ej.), pero sincronizarlo no tiene sentido: las
  // APIs no tienen esos días. Antes se encolaba tal cual y el chunk futuro moría
  // con "El rango pedido no incluye ninguna fecha pasada o de hoy" tras 3
  // reintentos. Se recorta aquí, y la UI sondea el rango YA recortado.
  const hoy = colombiaToday();
  const rango = clampRangeToToday(from, to, hoy);
  if (!rango) {
    return {
      ok: true,
      queued: false,
      warning: `El rango seleccionado empieza después de hoy (${hoy}); todavía no hay datos que sincronizar.`,
      platform_status: null,
    };
  }
  const desde = rango.start;
  const hasta = rango.end;

  const dias = Math.floor(
    (new Date(`${hasta}T00:00:00Z`).getTime() - new Date(`${desde}T00:00:00Z`).getTime()) / 86_400_000
  ) + 1;

  // ─── Rango largo: a la cola ───
  if (!Number.isFinite(dias) || dias > SYNC_DIRECTO_MAX_DIAS) {
    try {
      const res = await fetch(`${base}/api/worker/enqueue`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo: 'metricas',
          cliente_id: clientId,
          start: desde,
          end: hasta,
          prioridad: 1,
          triggered_by: 'dashboard',
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.error || `HTTP ${res.status}`, platform_status: null };
      }

      // Empujón inmediato al ejecutor de respaldo para no esperar al poll del VPS.
      after(async () => {
        await fetch(`${base}/api/worker/run-jobs`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}` },
          cache: 'no-store',
        }).catch((e) => console.error('[sync] run-jobs push failed', e));
      });

      return {
        ok: true,
        queued: true,
        jobs: data?.encolados ?? 0,
        // El rango real que hay que vigilar en el polling: el recortado contra
        // hoy, no el que se pidió (puede diferir además si el índice único
        // dedupe contra jobs ya pendientes).
        range: { from: desde, to: hasta },
        platform_status: null,
        message: `${data?.encolados ?? 0} tarea(s) en cola — sincronizando en segundo plano…`,
      };
    } catch (err) {
      const msg = err instanceof Error && err.name === 'TimeoutError'
        ? 'La cola no respondió a tiempo (timeout).'
        : (err instanceof Error ? err.message : 'Error de red');
      return { ok: false, error: msg, platform_status: null };
    }
  }

  // ─── Rango corto: directo ───
  const url = `${base}/api/worker?start=${encodeURIComponent(desde)}&end=${encodeURIComponent(hasta)}&client_id=${encodeURIComponent(clientId)}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: 'no-store',
      // Los endpoints tienen maxDuration=60; cortamos antes para no dejar la
      // promesa colgada si Vercel mata la función.
      signal: AbortSignal.timeout(58_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error || `HTTP ${res.status}`, platform_status: null };
    }

    const results = Array.isArray(data?.results) ? data.results : [];
    const firstResult = results[0] ?? null;

    // El endpoint responde 200 aunque el upsert a `metricas_diarias` falle: lo
    // marca con status:'failed' por cliente. Hay que propagarlo como error real,
    // no dar por buena una sincronización que no guardó nada.
    const failed = results.filter((r: any) => r?.status === 'failed');
    if (failed.length > 0) {
      return {
        ok: false,
        error: `La descarga terminó, pero falló el guardado en la base de datos (${failed.length} día${failed.length > 1 ? 's' : ''}).`,
        platform_status: firstResult?.platform_status ?? null,
      };
    }

    // Sin resultados = no había nada que sincronizar (cliente sin config de APIs
    // o rango totalmente congelado). No es un error, pero tampoco un "éxito" que
    // haya traído datos: se avisa para no confundir al usuario.
    if (results.length === 0) {
      return {
        ok: true,
        queued: false,
        warning:
          'No había datos que sincronizar en este rango. Revisa la configuración de APIs del cliente o si el período está congelado.',
        platform_status: null,
      };
    }

    return {
      ok: true,
      queued: false,
      partial: !!data?.partial,
      platform_status: firstResult?.platform_status ?? null,
      message: data?.partial ? 'Sincronización parcial: el resto continúa en segundo plano.' : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'TimeoutError'
      ? 'La sincronización tardó demasiado (timeout). Prueba con un rango más corto.'
      : (err instanceof Error ? err.message : 'Error de red');
    return { ok: false, error: msg, platform_status: null };
  }
}

/**
 * Progreso real de un sync encolado para un rango concreto.
 *
 * Lo consume el polling del botón "Sincronizar Datos": tras encolar, el
 * dashboard pregunta aquí hasta que la cola termine, para no fingir "¡Actualizado!"
 * cuando en realidad nadie ha procesado los jobs todavía.
 */
export async function getSyncProgress(clienteId: string, from: string, to: string) {
  const supabase = await createAdminClient();
  // Ventana amplia para no confundir jobs de este sync con los del plan diario
  // de días anteriores (que siguen en la tabla como 'done' hasta la limpieza).
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: jobs, error } = await supabase
    .from('sync_jobs')
    .select('id, estado, last_error, fecha_inicio, fecha_fin, updated_at')
    .eq('cliente_id', clienteId)
    .gte('created_at', since)
    .lte('fecha_inicio', to)
    .gte('fecha_fin', from)
    .order('updated_at', { ascending: false })
    .limit(100);

  if (error) return { ok: false, estado: 'error' as const, error: error.message };

  const list = jobs ?? [];
  const pendientes = list.filter((j) => j.estado === 'pending' || j.estado === 'running').length;
  const errores = list.filter((j) => j.estado === 'error');
  const totales = list.length;

  // 'empty' = no encontramos jobs en la ventana (procesados hace rato o nunca
  // encolados). El caller lo interpreta como "ya no hay nada en cola".
  let estado: 'working' | 'done' | 'error' | 'empty';
  if (totales === 0) estado = 'empty';
  else if (pendientes > 0) estado = 'working';
  else if (errores.length > 0) estado = 'error';
  else estado = 'done';

  return { ok: true, estado, pendientes, totales, error: errores[0]?.last_error ?? null };
}

/**
 * Frescura de los datos de un cliente para el semáforo del dashboard: última
 * verificación en `metricas_diarias` + estado de la última ejecución en
 * `sync_runs` (para pintar rojo cuando el último intento falló aunque haya datos
 * viejos guardados).
 */
export async function getDataFreshness(clienteId: string) {
  const supabase = await createAdminClient();
  const [metricaRes, runRes] = await Promise.all([
    supabase
      .from('metricas_diarias')
      .select('fecha, synced_at, source_synced_at, is_partial')
      .eq('cliente_id', clienteId)
      .order('synced_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('sync_runs')
      .select('estado, finished_at, error')
      .or(`cliente_id.eq.${clienteId},cliente_id.is.null`)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (metricaRes.error) return { data: null, lastRun: null, error: metricaRes.error.message };
  return { data: metricaRes.data, lastRun: runRes.data ?? null, error: null };
}

export async function getLeadsDiarios(clientId: string) {
  const supabase = await createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('leads_diarios')
    .select('*')
    .eq('client_id', clientId)
    .gte('date', thirtyDaysAgo)
    .lte('date', today)
    .order('date', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function getConversionesOfflineDiarias(clientId: string) {
  const supabase = await createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('conversiones_offline_diarias')
    .select('*')
    .eq('cliente_id', clientId)
    .gte('fecha', thirtyDaysAgo)
    .lte('fecha', today)
    .order('fecha', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

/**
 * Claves reservadas que crea la migración del legacy "Google Sheets — Leads"
 * (`scripts/migracion-leads-legacy.ts campos`). Son el contrato que permite
 * seguir sirviendo `leads_totales` y compañía sin que ningún layout guardado
 * necesite edición: la `clave` de un campo es inmutable, así que sirve de ancla.
 */
const CAMPO_CALIDAD_LEAD = 'calidad_lead';
const VISTA_LEADS_CALIFICADOS = 'leads_calificados';

/**
 * Campos de Sheet de un cliente, aplanados por fecha para el dashboard clásico.
 *
 * Devuelve `sf_<clave>` (el campo con su agregación) y `sv_<clave>` (cada vista
 * guardada). Esos prefijos son deliberadamente distintos de `sheet_`, que ya lo
 * produce el aplanado de `custom_fields`: una colisión cambiaría en silencio los
 * valores de layouts que ya existen.
 *
 * El motor de fórmulas no necesita cambios — `evaluateFormula` ya registra
 * cualquier clave numérica de la fila y `aggregateFormula` las suma.
 *
 * Nunca lanza: si faltan las tablas del módulo (migración 058), el dashboard
 * tiene que seguir cargando igual que antes de esta feature.
 */
async function getSheetCamposDelDia(
  supabase: any,
  clienteId: string,
  startStr: string,
  endStr: string
): Promise<SheetCamposDelDia> {
  const vacio: SheetCamposDelDia = {
    porFecha: new Map<string, Record<string, number>>(),
    leadsLegacy: new Map<string, Record<string, number>>(),
    campos: [],
    vistas: [],
  };
  try {
    const { campos, vistas } = await loadCamposCliente(supabase, clienteId, { soloActivos: true });
    if (campos.length === 0) return vacio;

    const resumen = () => ({
      campos: campos.map(c => ({
        clave: c.clave, nombre: c.nombre, agregacion: c.agregacion, formato: c.formato,
      })),
      vistas: vistas.map(v => ({
        clave: v.clave, nombre: v.nombre, agregacion: v.agregacion, formato: v.formato,
      })),
    });

    // Paginado: PostgREST corta en ~1000 filas y un cliente con varios campos ×
    // muchos valores × 90 días se truncaba en silencio, dejando el dashboard con
    // cifras de menos que no cuadraban con el BI.
    const data = await fetchAllRows(() => {
      let q = supabase
        .from('sheet_campo_valores_diarios')
        .select('id, campo_id, fecha, valor, filas, suma, n_num, minimo, maximo')
        .eq('cliente_id', clienteId)
        .lte('fecha', endStr);
      if (startStr !== 'all') q = q.gte('fecha', startStr);
      return q;
    });

    // Desglose agrupado por (fecha, campo) para agregar cada día por separado.
    const porFechaCampo = new Map<string, CampoValorDiario[]>();
    for (const r of data as any[]) {
      const fecha = String(r.fecha ?? '').slice(0, 10);
      const key = `${fecha} ${r.campo_id}`;
      const fila: CampoValorDiario = {
        campo_id: String(r.campo_id), fecha, valor: String(r.valor ?? ''),
        filas: Number(r.filas ?? 0), suma: Number(r.suma ?? 0), n_num: Number(r.n_num ?? 0),
        minimo: r.minimo === null ? null : Number(r.minimo),
        maximo: r.maximo === null ? null : Number(r.maximo),
      };
      const lista = porFechaCampo.get(key);
      if (lista) lista.push(fila);
      else porFechaCampo.set(key, [fila]);
    }

    const porFecha = new Map<string, Record<string, number>>();
    const leadsLegacy = new Map<string, Record<string, number>>();

    // Campo y vista que dejó la migración del legacy de leads, si existen.
    const campoCalidad = campos.find(c => c.clave === CAMPO_CALIDAD_LEAD);
    const vistaCalificados = vistas.find(v => v.clave === VISTA_LEADS_CALIFICADOS);

    for (const [key, filas] of porFechaCampo) {
      const [fecha, campoId] = key.split(' ');
      const campo = campos.find(c => c.id === campoId);
      if (!campo) continue;

      // Incluye los sumandos (`__num`/`__den`/`__min`/`__max`) cuando la
      // agregación no es aditiva, para que agrupar por semana o mes salga bien.
      porFecha.set(fecha, {
        ...(porFecha.get(fecha) ?? {}),
        ...clavesPlanasDelDia(campo, vistas, filas),
      });

      // Las 4 métricas del legacy de leads, reconstruidas desde el campo de
      // calidad migrado. Se conservan los NOMBRES para que ningún layout ya
      // guardado necesite edición: un `leads_calificados` escrito hace meses
      // en una tarjeta sigue resolviendo al mismo número.
      if (campoCalidad && campo.id === campoCalidad.id) {
        const totales = agregarDiarios(filas, 'count');
        const calificados = vistaCalificados
          ? agregarDiarios(filas.filter(f => vistaIncluyeValor(vistaCalificados, f.valor)), 'count')
          : 0;
        leadsLegacy.set(fecha, {
          leads_totales: totales,
          leads_calificados: calificados,
          leads_no_calificados: Math.max(0, totales - calificados),
          tasa_calificacion: totales > 0 ? Math.round((calificados / totales) * 10000) / 100 : 0,
        });
      }
    }

    return { porFecha, leadsLegacy, ...resumen() };
  } catch (err) {
    console.error('[dashboard] campos de Sheet no disponibles:', err);
    return vacio;
  }
}

/**
 * Recolecta los bloques de respuestas de un cliente: los del layout general MÁS
 * los de todas sus pestañas.
 *
 * Se miran todas las pestañas y no solo la activa porque la carga es única: el
 * usuario cambia de pestaña sin volver al servidor, así que un bloque que solo
 * existe en la pestaña 3 tiene que venir en la misma tanda o saldría vacío hasta
 * recargar. Se deduplica por la pregunta, no por el id del bloque: dos pestañas
 * que miran el mismo campo comparten una sola consulta.
 */
function recolectarBloquesRespuesta(
  layout: { lead_answer_blocks?: LeadAnswerBlockDef[] } | null | undefined,
  tabs: { lead_answer_blocks?: LeadAnswerBlockDef[] | null }[] | null | undefined,
): LeadAnswerBlockDef[] {
  const vistos = new Set<string>();
  const out: LeadAnswerBlockDef[] = [];
  const añadir = (bloques: LeadAnswerBlockDef[] | null | undefined) => {
    for (const b of bloques ?? []) {
      const firma = b.origen === 'catalogo'
        ? `c:${b.clave ?? ''}`
        : `a:${[...(b.clavesOrigen ?? [])].sort().join('~')}`;
      if (firma === 'c:' || firma === 'a:') continue;   // bloque recién creado, sin pregunta
      if (vistos.has(firma)) continue;
      vistos.add(firma);
      out.push(b);
    }
  };
  añadir(layout?.lead_answer_blocks);
  for (const t of tabs ?? []) añadir(t.lead_answer_blocks);
  return out;
}

/**
 * ¿Alguna fórmula del cliente usa las métricas de Report-UTM (`utm_leads` o
 * `lf__*`)?
 *
 * Decide si hace falta el total diario de contactos. Es una consulta que lee
 * TODOS los leads del rango, y en el cliente más grande (Eduversio, 22.000 leads
 * en un mes) eso son ~7.600 páginas de heap: 1 s en caliente, pero en frío se
 * come el `statement_timeout` de 8 s. Cobrárselo a un cliente que no usa ninguna
 * de estas métricas —Eduversio es justo uno: sus formularios no preguntan nada—
 * sería pagar el peor caso por nada.
 *
 * Mismo patrón y misma razón que `layoutUsaSheetFilter`, incluidas las pestañas
 * y las plantillas que estas referencian.
 */
type FuenteDeFormulas = {
  columnas?: { formula?: string | null }[] | null;
  tarjetas?: { formula?: string | null; targetFormula?: string | null }[] | null;
  graficos?: { valueFormulas?: string[] | null }[] | null;
  ranking_tables?: { columns?: { formula?: string | null }[] | null }[] | null;
  custom_metrics?: { formula?: string | null }[] | null;
};

function layoutUsaRespuestasLead(
  layout: FuenteDeFormulas | null | undefined,
  tabs: (FuenteDeFormulas & { plantilla_id?: string | null })[] | null | undefined,
  plantillas: (FuenteDeFormulas & { id?: string })[] | null | undefined,
  /** Claves del catálogo del cliente, para resolver `lf__<clave>__<x>` sin ambigüedad. */
  clavesCatalogo: string[] = [],
): { usaTotales: boolean; claves: string[] } {
  let usaTotales = false;
  const claves = new Set<string>();

  const usa = (f: string | null | undefined) => {
    if (!f) return;
    if (formulaUsaRespuestas(f)) usaTotales = true;
    for (const c of camposEnFormula(f, clavesCatalogo)) claves.add(c);
  };

  const revisar = (fuente: FuenteDeFormulas | null | undefined) => {
    if (!fuente) return;
    for (const c of fuente.columnas ?? []) usa(c?.formula);
    for (const c of fuente.tarjetas ?? []) { usa(c?.formula); usa(c?.targetFormula); }
    for (const g of fuente.graficos ?? []) for (const f of g?.valueFormulas ?? []) usa(f);
    for (const r of fuente.ranking_tables ?? []) for (const c of r?.columns ?? []) usa(c?.formula);
    for (const m of fuente.custom_metrics ?? []) usa(m?.formula);
  };

  revisar(layout);
  for (const t of tabs ?? []) revisar(t);

  const plantillasUsadas = new Set((tabs ?? []).map(t => t?.plantilla_id).filter(Boolean));
  for (const p of plantillas ?? []) if (plantillasUsadas.has(p?.id)) revisar(p);

  return { usaTotales, claves: [...claves] };
}

/**
 * Catálogo de preguntas del cliente, para el selector de métricas.
 *
 * Se lee SIN escanear leads: `report_utm.lead_campos` es una tabla pequeña. Con
 * esto, las respuestas configuradas se pueden elegir en cualquier tarjeta o
 * columna aunque la pestaña no tenga ningún bloque de respuestas.
 *
 * Los buckets salen de `valores_map` —los valores a los que el analista mapeó las
 * respuestas crudas— porque `valores_orden` está vacío en todos los campos reales.
 * Eso tiene dos consecuencias que la UI debe declarar:
 *
 *   • un campo sin `valores_map` no aporta ninguna respuesta ofrecible (`sinBuckets`);
 *   • con `sin_mapear: 'crudo'` la lista NUNCA es completa, porque hay buckets que
 *     solo emergen de los datos. El catálogo sirve para DESCUBRIR; la cifra
 *     correcta la da siempre el cubo, que sí los conoce todos.
 */
async function getCatalogoRespuestas(clienteId: string): Promise<LeadAnswerCampoResumen[]> {
  if (process.env.NEXT_PUBLIC_REPORT_UTM_ENABLED !== 'true') return [];
  try {
    const rtmClienteId = await resolveRtmClienteId(clienteId);
    if (!rtmClienteId) return [];
    const supabase = await createAdminClient();
    const campos = await loadLeadCampos(supabase.schema('report_utm'), rtmClienteId, { soloActivos: true });
    return campos.map(c => {
      const buckets = [...new Set(Object.values(c.valores_map ?? {}))].filter(Boolean) as string[];
      if (c.sin_mapear === 'otros') buckets.push(BUCKET_OTROS);
      return { clave: c.clave, nombre: c.nombre, buckets, sinBuckets: buckets.length === 0 };
    });
  } catch (err) {
    console.error('[dashboard] catálogo de respuestas no disponible:', err);
    return [];
  }
}

/**
 * ¿Alguna columna, tarjeta o gráfico filtra por columna del Sheet?
 *
 * Decide si el periodo previo necesita `offline_rows`. Sin ellas
 * `enrichOfflineRow` ve una lista vacía y devuelve 0 en todas las claves
 * offline: el comparativo de una tarjeta con filtro salía 0 y el delta se
 * ocultaba, sin que nada avisara. Cargarlas siempre serían decenas de miles de
 * objetos para los clientes que no usan el filtro, de ahí la comprobación.
 *
 * Se miran también las pestañas y las plantillas que estas referencian, por la
 * misma razón que en `recolectarBloquesRespuesta`: la carga es única.
 */
type BloqueFiltrable = { sheetFilter?: { field?: string } | null };
type FuenteDeBloques = {
  columnas?: BloqueFiltrable[] | null;
  tarjetas?: BloqueFiltrable[] | null;
  graficos?: BloqueFiltrable[] | null;
};

function layoutUsaSheetFilter(
  layout: FuenteDeBloques | null | undefined,
  tabs: (FuenteDeBloques & { plantilla_id?: string | null })[] | null | undefined,
  plantillas: (FuenteDeBloques & { id?: string })[] | null | undefined,
): boolean {
  const conFiltro = (bloques: BloqueFiltrable[] | null | undefined) =>
    Array.isArray(bloques) && bloques.some(b => !!b?.sheetFilter?.field);
  const revisar = (fuente: FuenteDeBloques | null | undefined) =>
    !!fuente && (conFiltro(fuente.columnas) || conFiltro(fuente.tarjetas) || conFiltro(fuente.graficos));

  if (revisar(layout)) return true;
  for (const t of tabs ?? []) if (revisar(t)) return true;

  const plantillasUsadas = new Set((tabs ?? []).map(t => t?.plantilla_id).filter(Boolean));
  for (const p of plantillas ?? []) if (plantillasUsadas.has(p?.id) && revisar(p)) return true;

  return false;
}

/**
 * Respuestas de formulario del cliente, listas para los bloques de respuestas.
 *
 * Espejo de `getSheetCamposDelDia`: carga un dato configurable por cliente y
 * NUNCA lanza. Si falta la migración 071, si el cliente report_utm no está
 * enlazado o si la RPC agota el tiempo, el dashboard tiene que seguir cargando
 * exactamente igual que antes de esta feature.
 *
 * `clienteId` es el id PÚBLICO (`public.clientes.id`). El puente al espacio de
 * report_utm se resuelve aquí dentro precisamente para que quien llama no tenga
 * que saber que hay dos espacios de identidad.
 */
async function getRespuestasLeadDelDia(
  clienteId: string,
  startStr: string,
  endStr: string,
  bloques: LeadAnswerBlockDef[],
  /** ¿Hay algún bloque o alguna fórmula que use estas métricas? */
  conTotales: boolean,
  /** Claves del catálogo que mencionan las fórmulas, además de los bloques. */
  clavesDeFormulas: string[] = [],
): Promise<LeadAnswerDataset> {
  // Si no hay ni bloques ni fórmulas que lo usen, no se toca la red: el total
  // diario es la consulta cara y no tiene sentido cobrársela a un cliente que no
  // mide nada de esto.
  if (bloques.length === 0 && !conTotales) return datasetVacio();
  // Misma guarda que la ficha del cliente: sin el módulo activo no se toca la red.
  if (process.env.NEXT_PUBLIC_REPORT_UTM_ENABLED !== 'true') return datasetVacio();

  try {
    const rtmClienteId = await resolveRtmClienteId(clienteId);
    if (!rtmClienteId) return datasetVacio();

    const supabase = await createAdminClient();
    const rtm = supabase.schema('report_utm');

    // El catálogo se lee si lo usa un bloque o si alguna fórmula nombra una de
    // sus claves: una tarjeta puede apuntar a una pregunta sin que exista ningún
    // bloque de respuestas en la pestaña.
    const necesitaCatalogo = bloques.some(b => b.origen === 'catalogo') || clavesDeFormulas.length > 0;
    const catalogo: LeadCampoDef[] = necesitaCatalogo
      ? await loadLeadCampos(rtm, rtmClienteId, { soloActivos: true })
      : [];

    const campos: LeadCampoDef[] = [];
    const origenes: Record<string, 'catalogo' | 'auto'> = {};
    for (const b of bloques) {
      if (b.origen === 'catalogo') {
        const campo = catalogo.find(c => c.clave === b.clave);
        // Un campo borrado del catálogo NO cae a 'auto' automáticamente: eso
        // cambiaría las cifras del bloque sin avisar. Se omite y el componente
        // muestra que la pregunta ya no existe.
        if (!campo) continue;
        campos.push(campo);
        origenes[campo.clave] = 'catalogo';
      } else {
        const claves = b.clavesOrigen ?? [];
        if (claves.length === 0) continue;
        const clave = `auto:${[...claves].sort().join('~')}`;
        if (origenes[clave]) continue;
        campos.push(campoSintetico(clave, b.label || b.title || claves[0], claves));
        origenes[clave] = 'auto';
      }
    }
    // Campos que solo pide una fórmula, sin bloque que los declare. Van DESPUÉS
    // de los bloques para que, si hay que recortar por el tope, se conserve lo
    // que está pintado en la pestaña.
    for (const clave of clavesDeFormulas) {
      if (origenes[clave]) continue;
      const campo = catalogo.find(c => c.clave === clave);
      if (!campo) continue;
      campos.push(campo);
      origenes[clave] = 'catalogo';
    }

    // Sin campos NO se corta: `cargarRespuestasLead` sigue trayendo el total
    // diario de contactos, que es lo que alimenta `utm_leads`.

    // `all` abarca desde 2020: escanear el histórico entero reventaría el
    // statement_timeout y no aporta nada a un desglose de respuestas.
    const desde = startStr === 'all' ? addDaysISO(endStr, -365) : startStr;

    // Un bloque de respuestas necesita el total sí o sí: sin él no puede calcular
    // su `(sin respuesta)` y la tabla diaria no cerraría.
    const necesitaTotales = conTotales || bloques.length > 0;

    return await cargarRespuestasLead(
      rtm, rtmClienteId, desde, endStr, campos, origenes, necesitaTotales);
  } catch (err) {
    console.error('[dashboard] respuestas de formulario no disponibles:', err);
    return datasetVacio();
  }
}

/**
 * Carga las filas de métricas de un rango YA enriquecidas (leads, conversiones
 * offline y campos de Sheet).
 *
 * Es el único camino: lo usan el dashboard, el espejo público, el archivo de
 * pestañas y el periodo anterior de los comparativos. Antes cada uno tenía su
 * propia copia del merge —o ninguna—, y por eso una tarjeta con un campo de
 * Sheet funcionaba en el dashboard y salía vacía en el enlace público.
 */
async function cargarMetricasEnriquecidas(
  supabase: any,
  clienteId: string,
  startStr: string,
  endStr: string,
  opts?: {
    incluirFilasOffline?: boolean
    leadAnswerBlocks?: LeadAnswerBlockDef[]
    leadAnswerFormulas?: boolean
    /** Claves del catálogo que mencionan las fórmulas del layout. */
    leadAnswerClaves?: string[]
  }
): Promise<{
  metrics: any[]
  leadsRaw: any[]
  conversionesOfflineRaw: any[]
  sheetCampos: SheetCampoResumen[]
  sheetVistas: SheetVistaResumen[]
  leadAnswers: LeadAnswerDataset
}> {
  // Todas paginadas por keyset: sin esto PostgREST corta en ~1000 filas. Para
  // `metricas_diarias` es 1 fila/día (solo se nota en el archivo, que abarca
  // años), pero `conversiones_offline` puede traer miles por día y se estaba
  // truncando en silencio, dejando los totales offline por debajo de lo real.
  const enRango = (q: any, col: string) =>
    startStr === 'all' ? q.lte(col, endStr) : q.gte(col, startStr).lte(col, endStr)

  const [metricas, leads, offline, sheetData, leadAnswers] = await Promise.all([
    fetchAllRows(() => enRango(
      supabase.from('metricas_diarias').select('*').eq('cliente_id', clienteId), 'fecha')),
    fetchAllRows(() => enRango(
      supabase.from('leads_diarios').select('*').eq('client_id', clienteId), 'date')),
    fetchAllRows(() => enRango(
      supabase.from('conversiones_offline').select('*').eq('cliente_id', clienteId), 'fecha')),
    getSheetCamposDelDia(supabase, clienteId, startStr, endStr),
    getRespuestasLeadDelDia(clienteId, startStr, endStr, opts?.leadAnswerBlocks ?? [],
      opts?.leadAnswerFormulas ?? false, opts?.leadAnswerClaves ?? []),
  ])

  const metrics = mergeMetricasDelRango({
    metricas,
    leads,
    offlinePorFecha: agruparOfflinePorFecha(offline),
    sheetPorFecha: sheetData.porFecha,
    leadsLegacyPorFecha: sheetData.leadsLegacy,
    incluirFilasOffline: opts?.incluirFilasOffline,
  })

  // `leadAnswers` viaja como campo HERMANO de `metrics`, no dentro de sus filas,
  // y por eso `mergeMetricasDelRango` no se toca. Ese merge es "la única
  // definición de qué claves ve una fórmula", y estas respuestas no son una clave
  // escalar por día sino un cubo (día × campaña × bucket). Aplanarlas a algo como
  // `leadanswer_rango_2m_3m` las convertiría en identificadores de fórmula, y en
  // ese momento alguien escribiría `meta_spend / leadanswer_x` — reintroduciendo
  // justo el reparto de gasto por respuesta que docs/17 y docs/18 rechazan.
  return {
    metrics,
    leadsRaw: leads,
    conversionesOfflineRaw: offline,
    sheetCampos: sheetData.campos,
    sheetVistas: sheetData.vistas,
    leadAnswers,
  }
}

export async function getDashboardData(clientId: string, startStr: string, endStr: string) {
  const supabase = await createAdminClient();

  // Fetch client + global assigned layout + client tabs + conversions catalog + campaign groups + all layout templates
  const [clienteRes, clienteLayoutRes, tabsRes, conversionesRes, campaignGroupsRes, allLayoutsRes, tabTemplatesRes] =
    await Promise.all([
      supabase
        .from('clientes')
        .select('*, global_layout:layouts_reporte(*)')
        .eq('id', clientId)
        .limit(1),
      supabase.from('clientes_layouts').select('*').eq('cliente_id', clientId).maybeSingle(),
      supabase
        .from('cliente_tabs')
        .select('*')
        .eq('cliente_id', clientId)
        .order('orden', { ascending: true }),
      supabase
        .from('meta_conversiones_catalogo')
        .select('conversion_key, label, field_id')
        .eq('cliente_id', clientId)
        .order('label', { ascending: true }),
      supabase
        .from('campaign_groups')
        .select(
          `
                *,
                campaign_group_mappings (
                    id,
                    campaign_id,
                    campaign_name_pattern
                )
            `
        )
        .eq('cliente_id', clientId)
        .order('nombre', { ascending: true }),
      supabase.from('layouts_reporte').select('*').order('nombre'),
      supabase.from('tab_templates').select('*').order('nombre'),
    ]);

  const cliente = clienteRes.data?.[0];
  if (!cliente) return null;

  // Compute available platforms from client API config (used for attribution fallback)
  const cfg = (cliente.config_api as any) || {};
  const availablePlatforms = new Set<string>(['meta']);
  // Basta el property id: la autenticación puede venir del OAuth de agencia
  // (sin ga_client_email). Mismo criterio que el worker y que getReportData.
  if (cfg.ga_property_id) availablePlatforms.add('ga4');
  // Criterio ÚNICO, compartido con el worker. Antes aquí se miraba solo
  // `hotmart_basic || hotmart_token`, que deja fuera a los clientes conectados por
  // HotConnect: esos perdían la resolución de los alias $facturacion_* del motor
  // de fórmulas y sus ventas salían en 0 sin ningún aviso.
  if (hotmartConectado(cfg)) availablePlatforms.add("hotmart");
  if (cfg.tiktok_advertiser_id && cfg.tiktok_access_token) availablePlatforms.add('tiktok');

  // Priority: client-specific layout → global assigned layout → null (classic)
  const layout = clienteLayoutRes.data || cliente.global_layout || null;

  // Periodo anterior para los deltas: misma duración, terminando un día antes.
  const rangoPrevio = startStr !== 'all'
    ? (() => {
        const startMs = new Date(startStr + 'T00:00:00').getTime()
        const endMs   = new Date(endStr   + 'T00:00:00').getTime()
        const prevEndMs   = startMs - 86400000
        const prevStartMs = prevEndMs - (endMs - startMs)
        return {
          desde: new Date(prevStartMs).toISOString().split('T')[0],
          hasta: new Date(prevEndMs).toISOString().split('T')[0],
        }
      })()
    : null

  // Los bloques de respuestas se recolectan del layout MÁS todas las pestañas:
  // la carga es única y el usuario cambia de pestaña sin volver al servidor.
  const leadAnswerBlocks = recolectarBloquesRespuesta(layout, tabsRes.data);
  // El catálogo del cliente alimenta el selector de métricas y resuelve las
  // claves `lf__<clave>__<x>` que mencionen las fórmulas. No escanea leads.
  const leadAnswerCatalogo = await getCatalogoRespuestas(clientId);
  // El total diario solo se pide si alguna fórmula lo menciona (ver helper).
  const leadAnswerUso = layoutUsaRespuestasLead(
    layout, tabsRes.data, allLayoutsRes.data, leadAnswerCatalogo.map(c => c.clave));

  // El periodo anterior pasa por el MISMO enriquecimiento: si no, las tarjetas
  // con campos de Sheet, offline o leads se quedaban sin comparativo en silencio.
  // Sus `offline_rows` solo se traen si algo filtra por Sheet (ver helper).
  const previoNecesitaFilasOffline = layoutUsaSheetFilter(layout, tabsRes.data, allLayoutsRes.data);
  const [actual, previo] = await Promise.all([
    cargarMetricasEnriquecidas(supabase, cliente.id, startStr, endStr,
      { leadAnswerBlocks, leadAnswerFormulas: leadAnswerUso.usaTotales, leadAnswerClaves: leadAnswerUso.claves }),
    rangoPrevio
      ? cargarMetricasEnriquecidas(supabase, cliente.id, rangoPrevio.desde, rangoPrevio.hasta,
          { incluirFilasOffline: previoNecesitaFilasOffline, leadAnswerBlocks,
            leadAnswerFormulas: leadAnswerUso.usaTotales, leadAnswerClaves: leadAnswerUso.claves })
      : Promise.resolve(null),
  ]);

  const { metrics, leadsRaw, conversionesOfflineRaw, sheetCampos, sheetVistas, leadAnswers } = actual;

  const effectiveStart = startStr === 'all' ? '2020-01-01' : startStr;
  const weeks = getWeeksInRange(effectiveStart, endStr);

  return {
    cliente,
    metrics: metrics || [],
    prevMetrics: (previo?.metrics ?? []) as any[],
    sheetCampos,
    sheetVistas,
    leadsRaw,
    conversionesOfflineRaw,
    weeks,
    layout,
    allLayouts: allLayoutsRes.data || [],
    tabTemplates: tabTemplatesRes.data || [],
    clienteLayoutId: clienteLayoutRes.data?.id || null,
    tabs: tabsRes.data || [],
    conversionesCatalogo: conversionesRes.data || [],
    layoutPublico: cliente.layout_publico || null,
    availablePlatforms: Array.from(availablePlatforms),
    campaignGroups: campaignGroupsRes.data || [],
    leadAnswers,
    prevLeadAnswers: previo?.leadAnswers ?? null,
    leadAnswerCatalogo,
  };
}

// ─── Client layout mutation actions ─────────────────────────────────────────

/**
 * Clone a global layout template into clientes_layouts for a specific client.
 * If the client already has a custom layout, it gets replaced.
 */
export async function cloneLayoutForCliente(clienteId: string, globalLayoutId: string) {
  const supabase = await createAdminClient();

  // Fetch the global template
  const { data: template, error: tErr } = await supabase
    .from('layouts_reporte')
    .select('*')
    .eq('id', globalLayoutId)
    .single();

  if (tErr || !template) return { error: 'Plantilla no encontrada' };

  // Upsert into clientes_layouts (one row per client)
  const { data, error } = await supabase
    .from('clientes_layouts')
    .upsert(
      {
        cliente_id: clienteId,
        base_layout_id: globalLayoutId,
        nombre: template.nombre,
        columnas: template.columnas,
        tarjetas: template.tarjetas,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'cliente_id' }
    )
    .select()
    .single();

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true, data };
}

/**
 * Save updated columns/cards for a client's personal layout.
 */
export async function saveClienteLayout(
  clienteId: string,
  payload: {
    columnas: any[];
    tarjetas: any[];
    graficos?: any[];
    text_blocks?: any[];
    custom_metrics?: any[];
    blocks_order?: string[];
    ranking_tables?: any[];
    lead_answer_blocks?: any[];
  }
) {
  const supabase = await createAdminClient();

  const { error } = await supabase
    .from('clientes_layouts')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('cliente_id', clienteId);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Remove the client-specific layout so it falls back to global/classic.
 */
export async function resetClienteLayout(clienteId: string) {
  const supabase = await createAdminClient();
  await supabase.from('clientes_layouts').delete().eq('cliente_id', clienteId);
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Save or update a client tab.
 */
export async function saveClienteTab(
  clienteId: string,
  payload: {
    id?: string;
    nombre: string;
    keyword_meta: string;
    plantilla_id?: string;
    orden?: number;
    fecha_inicio?: string;
    fecha_finalizacion?: string;
    presupuesto_objetivo?: number;
    /** Solo al crear: copia la visualización de esta plantilla de pestaña (tab_templates). */
    template_id?: string;
    hotmart_funnel?: {
      enabled?: boolean;
      principal_names?: string[];
      bump_names?: string[];
      upsell_names?: string[];
      downsell_names?: string[];
      // Códigos de oferta de Hotmart. Ganan sobre los nombres: son estables y
      // sobreviven a que alguien renombre el producto en la plataforma, que es
      // lo que rompía la clasificación en silencio.
      principal_offers?: string[];
      bump_offers?: string[];
      upsell_offers?: string[];
      downsell_offers?: string[];
      landing_page_urls?: string[];
      payment_page_url?: string;
      upsell_page_url?: string;
      principal_price_usd?: number;
    } | null;
  }
) {
  const supabase = await createAdminClient();

  // hotmart_funnel: undefined = no tocar (solo en edición); null o objeto = setear (incluyendo "deshabilitar")
  const baseFields: Record<string, any> = {
    nombre: payload.nombre,
    keyword_meta: payload.keyword_meta,
    plantilla_id: payload.plantilla_id || null,
    fecha_inicio: payload.fecha_inicio || null,
    fecha_finalizacion: payload.fecha_finalizacion || null,
    presupuesto_objetivo: payload.presupuesto_objetivo || null,
  };
  if (payload.hotmart_funnel !== undefined) {
    baseFields.hotmart_funnel = payload.hotmart_funnel;
  }

  if (payload.id) {
    const { error } = await supabase
      .from('cliente_tabs')
      .update({ ...baseFields, updated_at: new Date().toISOString() })
      .eq('id', payload.id)
      .eq('cliente_id', clienteId);
    if (error) return { error: error.message };
  } else {
    // Al crear desde plantilla, copiamos su visualización (solo layout).
    const vizFields: Record<string, any> = {};
    if (payload.template_id) {
      const { data: template } = await supabase
        .from('tab_templates')
        .select('*')
        .eq('id', payload.template_id)
        .single();
      if (template) {
        for (const f of TAB_VIZ_FIELDS) vizFields[f] = (template as any)[f] ?? null;
      }
    }
    const { error } = await supabase.from('cliente_tabs').insert({
      cliente_id: clienteId,
      ...baseFields,
      ...vizFields,
      orden: payload.orden || 0,
    });
    if (error) return { error: error.message };
  }

  // Si el embudo cambió, la clasificación de lo YA guardado queda obsoleta.
  // Se encola una reclasificación en vez de recalcularla aquí: reescribe
  // `tipo`/`tab_id` de todo el histórico leyendo `hotmart_ventas`, sin gastar
  // una sola petición a la API de Hotmart.
  if (payload.hotmart_funnel !== undefined) {
    after(async () => {
      try {
        const hoy = colombiaToday();
        await enqueueJob(supabase, {
          tipo: 'hotmart_ventas',
          clienteId,
          start: addDaysISO(hoy, -365),
          end: hoy,
          params: { reclasificar: true },
          prioridad: 5,
          triggeredBy: 'config_funnel',
        });
      } catch (e) {
        console.error('[saveClienteTab] no se pudo encolar la reclasificación', e);
      }
    });
  }

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Ofertas de Hotmart detectadas en las ventas del cliente.
 *
 * Nadie conoce de memoria un `offer.code`, así que la UI no puede pedir que se
 * escriban a mano: se descubren de las ventas ya recibidas, con su volumen, y se
 * asignan con un selector. Es la consulta que sirve `idx_hotmart_ventas_oferta`.
 */
export async function getOfertasHotmart(clienteId: string, dias = 90) {
  const supabase = await createAdminClient();
  const desde = addDaysISO(colombiaToday(), -dias);

  const { data, error } = await supabase
    .from('hotmart_ventas')
    .select('oferta_codigo, producto_nombre, bruto_usd, fecha_venta, tipo, clasificacion_origen')
    .eq('cliente_id', clienteId)
    .gte('fecha_venta', desde)
    .limit(5000);

  if (error) return { error: error.message, ofertas: [], cobertura: null };

  type Agregada = {
    oferta_codigo: string | null;
    producto_nombre: string | null;
    ventas: number;
    bruto_usd: number;
    ultima: string;
    tipo: string;
  };
  const mapa = new Map<string, Agregada>();
  let clasificadas = 0;

  for (const f of data ?? []) {
    if (f.clasificacion_origen !== 'sin_clasificar') clasificadas++;
    // Las ventas sin código de oferta se agrupan por nombre: son las que solo se
    // pueden clasificar por el mecanismo heredado.
    const clave = f.oferta_codigo ?? `sin-oferta:${f.producto_nombre ?? ''}`;
    const cur = mapa.get(clave) ?? {
      oferta_codigo: f.oferta_codigo,
      producto_nombre: f.producto_nombre,
      ventas: 0, bruto_usd: 0, ultima: f.fecha_venta, tipo: f.tipo,
    };
    cur.ventas++;
    cur.bruto_usd += Number(f.bruto_usd ?? 0);
    if (f.fecha_venta > cur.ultima) cur.ultima = f.fecha_venta;
    if (!cur.producto_nombre && f.producto_nombre) cur.producto_nombre = f.producto_nombre;
    mapa.set(clave, cur);
  }

  const total = (data ?? []).length;
  return {
    ofertas: Array.from(mapa.values()).sort((a, b) => b.ventas - a.ventas),
    cobertura: {
      total,
      clasificadas,
      // Por debajo del 95% conviene avisar antes de que nadie tome decisiones
      // con el desglose por tipo.
      pct: total === 0 ? 100 : Math.round((clasificadas / total) * 1000) / 10,
    },
  };
}

/**
 * Delete a client tab.
 */
export async function deleteClienteTab(clienteId: string, tabId: string) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('cliente_tabs')
    .delete()
    .eq('id', tabId)
    .eq('cliente_id', clienteId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Toggle the archived status of a client tab.
 */
export async function toggleTabArchived(clienteId: string, tabId: string, archived: boolean) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('cliente_tabs')
    .update({ archived })
    .eq('id', tabId)
    .eq('cliente_id', clienteId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Duplicate a client tab.
 */
export async function duplicateClienteTab(clienteId: string, tabId: string) {
  const supabase = await createAdminClient();

  const { data: source, error: fetchError } = await supabase
    .from('cliente_tabs')
    .select('*')
    .eq('id', tabId)
    .eq('cliente_id', clienteId)
    .single();

  if (fetchError || !source) return { error: fetchError?.message || 'Tab no encontrada' };

  const { data: allTabs } = await supabase
    .from('cliente_tabs')
    .select('orden')
    .eq('cliente_id', clienteId)
    .order('orden', { ascending: false })
    .limit(1);

  const maxOrden = (allTabs?.[0]?.orden ?? 0) as number;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, created_at, updated_at, public_token, ...rest } = source;

  const { error: insertError } = await supabase.from('cliente_tabs').insert({
    ...rest,
    nombre: `${source.nombre} (copia)`,
    orden: maxOrden + 1,
  });

  if (insertError) return { error: insertError.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

// ─── Tab templates (plantillas de pestañas, globales) ───────────────────────
// Guardan SOLO la visualización de una pestaña para reutilizarla en otras
// campañas. No incluyen keyword_meta / fechas / presupuesto.

const TAB_VIZ_FIELDS = [
  'columnas',
  'tarjetas',
  'graficos',
  'text_blocks',
  'custom_metrics',
  'ranking_tables',
  'lead_answer_blocks',
  'blocks_order',
] as const;

/**
 * List all global tab templates (for the "new tab" selector).
 */
export async function listTabTemplates() {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('tab_templates')
    .select('*')
    .order('nombre', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: data || [], error: null };
}

/**
 * Save the visualization of an existing tab as a reusable global template.
 * Falls back to the tab's associated layout (plantilla_id) when the tab has
 * no per-tab overrides of its own.
 */
export async function saveTabAsTemplate(
  clienteId: string,
  tabId: string,
  nombre: string,
  descripcion?: string
) {
  if (!nombre?.trim()) return { error: 'El nombre de la plantilla es obligatorio' };
  const supabase = await createAdminClient();

  const { data: tab, error: fetchError } = await supabase
    .from('cliente_tabs')
    .select('*')
    .eq('id', tabId)
    .eq('cliente_id', clienteId)
    .single();
  if (fetchError || !tab) return { error: fetchError?.message || 'Pestaña no encontrada' };

  const viz: Record<string, any> = {};
  for (const f of TAB_VIZ_FIELDS) viz[f] = (tab as any)[f] ?? null;

  // Fallback: si la pestaña no tiene overrides propios pero referencia una
  // plantilla de layout, copiamos la visualización desde ahí.
  const hasOwnViz = TAB_VIZ_FIELDS.some((f) => {
    const v = (tab as any)[f];
    return Array.isArray(v) ? v.length > 0 : v != null;
  });
  if (!hasOwnViz && tab.plantilla_id) {
    const { data: layout } = await supabase
      .from('layouts_reporte')
      .select('*')
      .eq('id', tab.plantilla_id)
      .single();
    if (layout) for (const f of TAB_VIZ_FIELDS) viz[f] = (layout as any)[f] ?? viz[f];
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from('tab_templates').insert({
    nombre: nombre.trim(),
    descripcion: descripcion?.trim() || null,
    ...viz,
    created_by: user?.id || null,
  });
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Apply a template's visualization onto an existing tab (replaces its layout).
 */
export async function applyTemplateToTab(clienteId: string, tabId: string, templateId: string) {
  const supabase = await createAdminClient();

  const { data: template, error: tErr } = await supabase
    .from('tab_templates')
    .select('*')
    .eq('id', templateId)
    .single();
  if (tErr || !template) return { error: tErr?.message || 'Plantilla no encontrada' };

  const viz: Record<string, any> = {};
  for (const f of TAB_VIZ_FIELDS) viz[f] = (template as any)[f] ?? null;

  const { error } = await supabase
    .from('cliente_tabs')
    .update({ ...viz, updated_at: new Date().toISOString() })
    .eq('id', tabId)
    .eq('cliente_id', clienteId);
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Rename / re-describe a global tab template.
 */
export async function renameTabTemplate(templateId: string, nombre: string, descripcion?: string) {
  if (!nombre?.trim()) return { error: 'El nombre es obligatorio' };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('tab_templates')
    .update({
      nombre: nombre.trim(),
      descripcion: descripcion?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId);
  if (error) return { error: error.message };
  revalidatePath('/admin/layouts');
  return { success: true };
}

/**
 * Delete a global tab template.
 */
export async function deleteTabTemplate(templateId: string) {
  const supabase = await createAdminClient();
  const { error } = await supabase.from('tab_templates').delete().eq('id', templateId);
  if (error) return { error: error.message };
  revalidatePath('/admin/layouts');
  return { success: true };
}

/**
 * Save layout overrides (columns, cards) strictly for one tab.
 */
export async function saveTabOverrides(
  clienteId: string,
  tabId: string,
  payload: {
    columnas: any[] | null;
    tarjetas: any[] | null;
    graficos?: any[] | null;
    text_blocks?: any[] | null;
    custom_metrics?: any[] | null;
    blocks_order?: string[] | null;
    ranking_tables?: any[] | null;
    lead_answer_blocks?: any[] | null;
  }
) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('cliente_tabs')
    .update({
      columnas: payload.columnas,
      tarjetas: payload.tarjetas,
      graficos: payload.graficos,
      text_blocks: payload.text_blocks,
      custom_metrics: payload.custom_metrics,
      blocks_order: payload.blocks_order,
      ranking_tables: payload.ranking_tables,
      lead_answer_blocks: payload.lead_answer_blocks,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tabId)
    .eq('cliente_id', clienteId);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

export async function updateLayoutPuzzleState(
  clienteId: string,
  tabId: string,
  payload: {
    blocks_order: string[];
    text_blocks: any[];
    tarjetas?: any[];
    graficos?: any[];
    ranking_tables?: any[];
    lead_answer_blocks?: any[];
    full_layout?: {
      nombre: string;
      columnas: any[];
      tarjetas: any[];
      graficos?: any[];
      custom_metrics?: any[];
      attribution_strategy?: string;
    };
  }
) {
  const supabase = await createAdminClient();

  if (tabId && tabId !== 'general') {
    // Tab específico: actualizar puzzle state y arrays de bloques
    const { error } = await supabase
      .from('cliente_tabs')
      .update({
        blocks_order: payload.blocks_order,
        text_blocks: payload.text_blocks,
        ...(payload.tarjetas !== undefined && { tarjetas: payload.tarjetas }),
        ...(payload.graficos !== undefined && { graficos: payload.graficos }),
        ...(payload.ranking_tables !== undefined && { ranking_tables: payload.ranking_tables }),
        ...(payload.lead_answer_blocks !== undefined && { lead_answer_blocks: payload.lead_answer_blocks }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', tabId)
      .eq('cliente_id', clienteId);
    if (error) return { error: error.message };
    revalidatePath(`/dashboard/${clienteId}`);
    return { success: true };
  } else {
    // General tab: verificar si ya existe fila en clientes_layouts
    const { data: existing } = await supabase
      .from('clientes_layouts')
      .select('id')
      .eq('cliente_id', clienteId)
      .maybeSingle();

    if (existing) {
      // Fila existe: actualizar puzzle state y arrays de bloques
      const { error } = await supabase
        .from('clientes_layouts')
        .update({
          blocks_order: payload.blocks_order,
          text_blocks: payload.text_blocks,
          ...(payload.tarjetas !== undefined && { tarjetas: payload.tarjetas }),
          ...(payload.graficos !== undefined && { graficos: payload.graficos }),
          ...(payload.ranking_tables !== undefined && { ranking_tables: payload.ranking_tables }),
          ...(payload.lead_answer_blocks !== undefined && { lead_answer_blocks: payload.lead_answer_blocks }),
          updated_at: new Date().toISOString(),
        })
        .eq('cliente_id', clienteId);
      if (error) return { error: error.message };
    } else if (payload.full_layout) {
      // No existe fila: crear una copiando el layout activo + puzzle state
      const { error } = await supabase.from('clientes_layouts').insert({
        cliente_id: clienteId,
        nombre: payload.full_layout.nombre || 'Dashboard',
        columnas: payload.full_layout.columnas || [],
        tarjetas: payload.full_layout.tarjetas || [],
        graficos: payload.full_layout.graficos || null,
        custom_metrics: payload.full_layout.custom_metrics || null,
        attribution_strategy: payload.full_layout.attribution_strategy || null,
        blocks_order: payload.blocks_order,
        text_blocks: payload.text_blocks,
      });
      if (error) return { error: error.message };
    } else {
      return { error: 'No se pudo guardar: layout base no disponible' };
    }

    revalidatePath(`/dashboard/${clienteId}`);
    return { success: true };
  }
}

/**
 * Update a manual metric value in metricas_diarias.
 */
export async function updateManualMetric(
  clienteId: string,
  fecha: string,
  key: string,
  value: number
) {
  const supabase = await createAdminClient();

  // Retrieve existing metric row for this date
  const { data: existing } = await supabase
    .from('metricas_diarias')
    .select('id, metricas_manuales')
    .eq('cliente_id', clienteId)
    .eq('fecha', fecha)
    .maybeSingle();

  const currentManuales = existing?.metricas_manuales || {};
  currentManuales[key] = value;

  if (existing) {
    await supabase
      .from('metricas_diarias')
      .update({ metricas_manuales: currentManuales })
      .eq('id', existing.id);
  } else {
    await supabase.from('metricas_diarias').insert({
      cliente_id: clienteId,
      fecha,
      metricas_manuales: currentManuales,
    });
  }

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Get total historical spend for a specific keyword filter (for budget calculations)
 */
/**
 * Gasto acumulado de una pestaña: Meta + TikTok.
 *
 * Antes solo leía `meta_campaigns`/`meta_spend`, así que en un cliente que
 * invierte en las dos plataformas la tarjeta "Gasto Acumulado" ignoraba el 100%
 * de lo gastado en TikTok. No era un desfase intermitente: era un faltante
 * sistemático en toda pestaña con keyword, y además inflaba cualquier cálculo
 * que usara esta cifra como denominador (% de presupuesto consumido).
 *
 * El criterio de filtrado es el mismo que aplica el dashboard en el resto de
 * métricas: se suman las campañas cuyo nombre contiene el keyword (ver
 * `filterCampaignList` en src/lib/campaign-filter.ts). Sin keyword se usa la
 * columna agregada.
 */
export async function getTabTotalSpend(
  clienteId: string,
  keywordFilter: string,
  fechaInicio?: string,
  fechaFin?: string
) {
  const supabase = await createAdminClient();
  let query = supabase
    .from('metricas_diarias')
    .select('meta_campaigns, meta_spend, tiktok_campaigns, tiktok_spend')
    .eq('cliente_id', clienteId);
  if (fechaInicio) query = query.gte('fecha', fechaInicio);
  if (fechaFin) query = query.lte('fecha', fechaFin);
  const { data: metrics } = await query;

  if (!metrics) return 0;

  // El keyword de la pestaña puede ser un filtro compuesto (Y/O) serializado.
  const filter = parseTabFilter(keywordFilter);
  const hasFilter = typeof filter === 'string' ? filter !== '' : filter.conditions.length > 0;
  /** Gasto de una plataforma en una fila, filtrado por el filtro de pestaña si lo hay. */
  const spendDe = (columna: any, campanas: any) => {
    if (!hasFilter || !Array.isArray(campanas)) return parseFloat(columna || '0') || 0;
    return filterCampaignList(campanas, filter)
      .reduce((s: number, c: any) => s + (parseFloat(c.spend || '0') || 0), 0);
  };

  let totalSpent = 0;
  metrics.forEach((row) => {
    totalSpent += spendDe(row.meta_spend, row.meta_campaigns);
    totalSpent += spendDe(row.tiktok_spend, row.tiktok_campaigns);
  });
  return totalSpent;
}

/**
 * Support Tickets Actions
 */

async function getCurrentRole(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 'viewer';
  const { data } = await supabase.from('user_profiles').select('role').eq('id', user.id).single();
  return data?.role ?? 'viewer';
}

async function isTeamMember(): Promise<boolean> {
  return ['superadmin', 'admin', 'trafficker'].includes(await getCurrentRole());
}

export async function getAllSoporteTickets() {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('soporte_tickets')
    .select('*, cliente:clientes(nombre)')
    .order('fecha_solicitud', { ascending: false })
    .limit(100);

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function getSoporteTickets(clienteId: string) {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('soporte_tickets')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('fecha_solicitud', { ascending: false });

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function createSoporteTicket(payload: {
  cliente_id?: string | null;
  tipo: 'bug' | 'feature' | 'mejora' | 'tarea';
  nombre_solicitante: string;
  requerimiento: string;
  observaciones?: string;
  prioridad: number;
  fecha_entrega?: string;
}) {
  if (!(await isTeamMember())) return { error: 'No autorizado' };

  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('soporte_tickets')
    .insert({
      ...payload,
      cliente_id: payload.cliente_id || null,
      estado: 'abierto',
    })
    .select()
    .single();

  if (error) return { error: error.message };

  // Notificaciones tras responder; after() evita que Vercel congele la
  // función antes de completar los inserts. In-app (campanita) + WhatsApp.
  after(async () => {
    await notifyUsers({
      db: supabase,
      type: 'ticket_created',
      severity: 'info',
      clienteId: payload.cliente_id || null,
      title: `Nuevo ticket: ${payload.requerimiento.slice(0, 80)}`,
      message: `${payload.tipo} · solicitado por ${payload.nombre_solicitante}`,
      link: '/soporte',
      metadata: { ticket_id: data.id },
    });
    await sendWhatsAppNotification({
      db: supabase,
      clienteId: payload.cliente_id || null,
      notificationType: 'roadmap_created',
      message:
        `🗺️ *Roadmap — nuevo ${payload.tipo}*\n` +
        `${payload.requerimiento}\n` +
        `Solicitante: ${payload.nombre_solicitante} · Prioridad: ${payload.prioridad}`,
    }).catch((e) => console.error('[roadmap whatsapp] create failed', e));
  });

  if (payload.cliente_id) revalidatePath(`/dashboard/${payload.cliente_id}`);
  revalidatePath('/soporte');
  return { success: true, data };
}

export async function updateSoporteTicket(
  ticketId: string,
  clienteId: string | null,
  payload: {
    responsable?: string;
    fecha_entrega?: string;
    prioridad?: number;
    estado?: string;
    observaciones?: string;
    nombre_solicitante?: string;
    requerimiento?: string;
    tipo?: 'bug' | 'feature' | 'mejora' | 'tarea';
    cliente_id?: string | null;
  }
) {
  if (!(await isTeamMember())) return { error: 'No autorizado' };

  const supabase = await createAdminClient();

  // Estado previo: solo notificamos si el estado realmente cambió
  let previousEstado: string | null = null;
  let previousRequerimiento: string | null = null;
  if (payload.estado) {
    const { data: prev } = await supabase
      .from('soporte_tickets')
      .select('estado, requerimiento')
      .eq('id', ticketId)
      .maybeSingle();
    previousEstado = prev?.estado ?? null;
    previousRequerimiento = prev?.requerimiento ?? null;
  }

  const { error } = await supabase
    .from('soporte_tickets')
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticketId);

  if (error) return { error: error.message };

  if (payload.estado && previousEstado && payload.estado !== previousEstado) {
    const requerimiento = payload.requerimiento ?? previousRequerimiento;
    const nuevoEstado = payload.estado;
    after(async () => {
      await notifyUsers({
        db: supabase,
        type: 'ticket_updated',
        severity: nuevoEstado === 'completado' ? 'success' : 'info',
        clienteId: clienteId,
        title: `Ticket actualizado: ${previousEstado} → ${nuevoEstado}`,
        message: requerimiento ? requerimiento.slice(0, 120) : undefined,
        link: '/soporte',
        metadata: { ticket_id: ticketId, estado: nuevoEstado },
      });
      await sendWhatsAppNotification({
        db: supabase,
        clienteId: clienteId,
        notificationType: 'roadmap_updated',
        message:
          `🗺️ *Roadmap actualizado* — ${previousEstado} → ${nuevoEstado}\n` +
          `${requerimiento ? requerimiento.slice(0, 160) : ''}`,
      }).catch((e) => console.error('[roadmap whatsapp] update failed', e));
    });
  }

  if (clienteId) revalidatePath(`/dashboard/${clienteId}`);
  revalidatePath('/soporte');
  return { success: true };
}

/**
 * Public Mirror Dashboard data retrieval
 */
export async function getMirrorDashboardData(token: string, from?: string, to?: string) {
  const supabase = await createAdminClient();

  // 1. Resolve token: is it a tab-specific token?
  const { data: tab } = await supabase
    .from('cliente_tabs')
    .select('*, cliente:clientes(*, global_layout:layouts_reporte(*))')
    .eq('public_token', token)
    .maybeSingle();

  let cliente: any = null;
  let activeTabObj: any = null;
  let layout: any = null;

  if (tab) {
    cliente = tab.cliente;
    activeTabObj = tab;
    // Use tab override if available
    if (tab.columnas && tab.tarjetas) {
      // Todos los arrays de bloques que puede tener una pestaña, sin excepción.
      // `ranking_tables` faltaba aquí desde la migración 018: una tabla de
      // ranking configurada en una pestaña se veía en el dashboard interno y
      // desaparecía en el enlace compartido al cliente, sin ningún error — el
      // bloque simplemente no existía en el layout que llegaba al espejo.
      layout = {
        nombre: tab.nombre,
        columnas: tab.columnas,
        tarjetas: tab.tarjetas,
        graficos: tab.graficos,
        blocks_order: tab.blocks_order,
        text_blocks: tab.text_blocks,
        custom_metrics: tab.custom_metrics,
        ranking_tables: tab.ranking_tables,
        lead_answer_blocks: tab.lead_answer_blocks,
      };
    } else if (tab.plantilla_id) {
      const { data: global } = await supabase
        .from('layouts_reporte')
        .select('*')
        .eq('id', tab.plantilla_id)
        .single();
      layout = global;
    }
  } else {
    // 2. Resolve token: is it a client-specific (general tab) token?
    const { data: c } = await supabase
      .from('clientes')
      .select('*, global_layout:layouts_reporte(*)')
      .eq('public_token', token)
      .maybeSingle();

    if (!c) return { error: 'Enlace no válido o expirado' };

    cliente = c;
    // Fetch client-specific layout
    const { data: cl } = await supabase
      .from('clientes_layouts')
      .select('*')
      .eq('cliente_id', cliente.id)
      .maybeSingle();
    layout = cl || cliente.global_layout || null;
  }

  if (!cliente) return { error: 'Cliente no encontrado' };

  // Use tab dates only if not provided in URL.
  // Mismo criterio que el dashboard interno: hora Colombia y 30 días inclusive.
  // `new Date()` era UTC en Vercel, así que a partir de las 19:00 el rango del
  // enlace público terminaba en mañana.
  const hoy = colombiaToday();
  const startStr = from || activeTabObj?.fecha_inicio || addDaysISO(hoy, -29);
  const endStr = to || activeTabObj?.fecha_finalizacion || hoy;

  // Las pestañas se piden aparte porque el enriquecimiento las necesita: en modo
  // `tab_mirror` el espejo muestra varias, y un bloque de respuestas definido en
  // la segunda saldría vacío si solo se mirara la activa. Solo el enriquecimiento
  // espera a esta consulta (una tabla pequeña); el resto sigue en paralelo.
  const tabsPromise = supabase
    .from('cliente_tabs')
    .select('*')
    .eq('cliente_id', cliente.id)
    .order('position', { ascending: true });

  // Mismo enriquecimiento que el dashboard interno: sin esto, una tarjeta con un
  // campo de Sheet salía en blanco en el enlace público del cliente.
  const [enriquecido, conversionesRes, campaignGroupsRes, tabsRes, allLayoutsRes] =
    await Promise.all([
      tabsPromise.then((r: any) =>
        cargarMetricasEnriquecidas(supabase, cliente.id, startStr, endStr, {
          leadAnswerBlocks: recolectarBloquesRespuesta(layout, r.data),
          // El espejo no conoce las plantillas globales, así que solo se miran el
          // layout de la pestaña y las pestañas visibles. Es suficiente: lo que se
          // comparte con el cliente es lo que hay en ese layout.
          leadAnswerFormulas: layoutUsaRespuestasLead(layout, r.data, null).usaTotales,
        })),
      supabase
        .from('meta_conversiones_catalogo')
        .select('conversion_key, label, field_id')
        .eq('cliente_id', cliente.id)
        .order('label', { ascending: true }),
      supabase
        .from('campaign_groups')
        .select(
          `
                *,
                campaign_group_mappings (id, campaign_id, campaign_name_pattern)
            `
        )
        .eq('cliente_id', cliente.id)
        .order('nombre', { ascending: true }),
      tabsPromise,
      supabase.from('layouts_reporte').select('*').order('nombre'),
    ]);

  const { metrics, conversionesOfflineRaw, sheetCampos, sheetVistas, leadAnswers } = enriquecido;

  const effectiveStart = startStr === 'all' ? '2020-01-01' : startStr;
  const weeks = getWeeksInRange(effectiveStart, endStr);
  const availablePlatforms = new Set<string>(['meta']);
  const cfg = (cliente.config_api as any) || {};
  if (cfg.ga_property_id) availablePlatforms.add('ga4');
  if (hotmartConectado(cfg)) availablePlatforms.add("hotmart");
  if (cfg.tiktok_access_token) availablePlatforms.add('tiktok');

  // Filter tabs by public_tab_ids if configured on client token
  let allTabs = tabsRes.data || [];
  let defaultActiveTabId: string = activeTabObj?.id || 'general';
  if (!activeTabObj) {
    const publicConfig = cliente.layout_publico as any;
    if (
      publicConfig?.type === 'tab_mirror' &&
      Array.isArray(publicConfig?.tab_ids) &&
      publicConfig.tab_ids.length > 0
    ) {
      allTabs = allTabs.filter((t: any) => publicConfig.tab_ids.includes(t.id));
      if (allTabs.length > 0) defaultActiveTabId = allTabs[0].id;
    }
  }

  return {
    data: {
      cliente,
      metrics: metrics || [],
      conversionesOfflineRaw,
      sheetCampos,
      sheetVistas,
      leadAnswers,
      // El espejo no calcula periodo anterior, así que sus bloques de respuestas
      // no muestran variación. Es coherente con el resto del enlace público, que
      // tampoco compara tarjetas.
      prevLeadAnswers: null,
      weeks,
      layout,
      tabs: allTabs,
      activeTabId: defaultActiveTabId,
      allLayouts: allLayoutsRes.data || [],
      conversionesCatalogo: conversionesRes.data || [],
      availablePlatforms: Array.from(availablePlatforms),
      campaignGroups: campaignGroupsRes.data || [],
      isMirror: true,
    },
    error: null,
  };
}

/** Personalización del link público de un cliente (logo, acento, textos). */
export interface PublicBranding {
  logo_url?: string;
  accent?: string;
  title?: string;
  welcome_text?: string;
}

/**
 * Guarda la configuración del link público, preservando lo que no se toca.
 * Todo vive en `clientes.layout_publico` (JSONB), que ya se usaba para las
 * pestañas visibles — así no hace falta una columna nueva.
 */
export async function savePublicConfig(
  clienteId: string,
  patch: { tabIds?: string[]; branding?: PublicBranding }
) {
  const supabase = await createAdminClient();

  const { data: current } = await supabase
    .from('clientes')
    .select('layout_publico')
    .eq('id', clienteId)
    .maybeSingle();

  const existing = (current?.layout_publico ?? {}) as {
    tab_ids?: string[];
    branding?: PublicBranding;
  };
  const tabIds = patch.tabIds ?? (Array.isArray(existing.tab_ids) ? existing.tab_ids : []);
  const branding: PublicBranding = { ...(existing.branding ?? {}), ...(patch.branding ?? {}) };

  // Se limpian los strings vacíos para no persistir ruido.
  for (const k of Object.keys(branding) as (keyof PublicBranding)[]) {
    if (!branding[k]) delete branding[k];
  }

  const hasBranding = Object.keys(branding).length > 0;
  const payload =
    tabIds.length > 0 || hasBranding
      ? { type: 'tab_mirror', tab_ids: tabIds, ...(hasBranding ? { branding } : {}) }
      : null;

  const { error } = await supabase
    .from('clientes')
    .update({ layout_publico: payload })
    .eq('id', clienteId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/** Compat: guarda solo las pestañas visibles, conservando el branding. */
export async function savePublicTabConfig(clienteId: string, tabIds: string[]) {
  return savePublicConfig(clienteId, { tabIds });
}

export async function getOrCreatePublicToken(id: string, type: 'client' | 'tab') {
  const supabase = await createAdminClient();
  const table = type === 'client' ? 'clientes' : 'cliente_tabs';

  // 1. Try to fetch existing
  const { data: existing } = await supabase
    .from(table)
    .select('public_token')
    .eq('id', id)
    .maybeSingle();

  if (existing?.public_token) return { token: existing.public_token };

  // 2. Generate new one
  const newToken = crypto.randomUUID();
  const { error } = await supabase.from(table).update({ public_token: newToken }).eq('id', id);

  if (error) return { error: error.message };
  return { token: newToken };
}

/**
 * Promueve una pregunta auto-detectada al catálogo de campos de lead.
 *
 * Es el camino de migración de los clientes que todavía no tienen nada
 * configurado: el bloque estrena en modo 'auto' —valores crudos, sin agrupar— y
 * cuando el analista ve que la pregunta le sirve, un botón la convierte en un
 * campo de verdad, editable desde `/report-utm/clientes/[id]` con su nombre
 * bonito, sus respuestas agrupadas y su orden.
 *
 * A partir de ahí el bloque pasa a `origen: 'catalogo'` y deja de depender del
 * escaneo. Un campo del catálogo es también lo ÚNICO que puede unir la misma
 * pregunta llegada con dos claves distintas (Meta y web).
 */
export async function promoverCampoLead(
  publicClienteId: string,
  input: { nombre: string; clavesOrigen: string[] },
): Promise<{ error?: string; clave?: string }> {
  const role = await getUserRole();
  if (!role || !['superadmin', 'admin'].includes(role)) {
    return { error: 'Solo un administrador puede crear campos de lead.' };
  }
  if (!input.nombre?.trim()) return { error: 'El campo necesita un nombre.' };
  if ((input.clavesOrigen ?? []).length === 0) return { error: 'Selecciona al menos una pregunta.' };

  const rtmClienteId = await resolveRtmClienteId(publicClienteId);
  if (!rtmClienteId) return { error: 'Este cliente no está enlazado al módulo de informes.' };

  const supabase = await createAdminClient();
  const rtm = supabase.schema('report_utm');

  // La clave se fija en el alta y no se reescribe nunca: es lo que queda
  // guardado dentro del bloque y de los widgets del BI.
  const clave = slugCampo(input.nombre);
  const { error } = await saveLeadCampo(rtm, {
    cliente_id: rtmClienteId,
    clave,
    nombre: input.nombre.trim(),
    claves_origen: input.clavesOrigen,
  });
  if (error) return { error };

  revalidatePath(`/dashboard/${publicClienteId}`);
  return { clave };
}

/**
 * Historia completa del cliente para el archivo de pestañas.
 *
 * Pasa por el mismo enriquecimiento que el dashboard: sus tarjetas evalúan las
 * mismas fórmulas, así que sin esto las que usaban campos de Sheet u offline
 * mostraban 0.
 *
 * `conFilasOffline` lo decide quien llama, mirando si alguna tarjeta archivada
 * tiene `sheetFilter`. El archivo abarca desde 2020, así que traer las filas
 * individuales siempre serían decenas de miles de objetos para nada; pero sin
 * ellas una tarjeta con filtro de Sheet mostraba aquí un número distinto al del
 * dashboard, y eso sí es un dato equivocado.
 *
 * Sin bloques de respuestas por la misma razón, y una más: su vista no los
 * pinta, así que la consulta sería un escaneo de años para algo que nadie mira.
 */
export async function getArchiveMetrics(
  clientId: string,
  conFilasOffline = false,
): Promise<{ metrics: any[] } | null> {
  const supabase = await createAdminClient();
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const { metrics } = await cargarMetricasEnriquecidas(
      supabase, clientId, '2020-01-01', hoy,
      { incluirFilasOffline: conFilasOffline, leadAnswerBlocks: [] }
    );
    return { metrics };
  } catch (err) {
    console.error('[dashboard] no se pudo cargar el archivo:', err);
    return null;
  }
}
