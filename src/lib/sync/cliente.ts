/**
 * Sincronizar TODOS los canales de un cliente, bajo demanda.
 *
 * El planner (`planner.ts`) sincroniza a todos los clientes a horas fijas; el
 * dashboard y el agente necesitan además «refresca a este cliente ahora». Hasta
 * aquí eso solo encolaba un job `metricas` (Meta, TikTok, Hotmart agregado y
 * GA4 base) y se quedaban fuera los Sheets, el desglose de GA4, las ventas de
 * Hotmart y los leads del CRM.
 *
 * Tres piezas:
 *
 *   · `canalesDeCliente` — qué tiene conectado el cliente, con las MISMAS
 *     reglas que el planner (`tieneMeta`, `tieneSheets`, `tieneGa4`…), para que
 *     «conectado» signifique lo mismo en los dos sitios.
 *   · `planSyncCliente` — puro: qué jobs encolar, con la ventana de refresco de
 *     cada canal o con un rango pedido (troceado como el panel).
 *   · `frenoSync` — la instancia Micro no aguanta tormentas: si el cliente ya
 *     tiene la sincronización en curso o se lanzó hace un momento, no se duplica.
 *
 * Los jobs de leads llevan `params.rtm_cliente_id`: sus rutas filtran por el id
 * de `report_utm.clientes` (ver `clienteDeLeads` en `runner.ts`).
 */

import {
  splitRange,
  DEFAULT_CHUNK_DAYS,
  enqueueJob,
  type EnqueueInput,
  type SyncJobTipo,
} from './queue';
import {
  PRIORIDAD,
  DIAS_REFRESCO_GA4,
  tieneGa4,
  tieneMeta,
  tieneSheets,
  tieneTiktok,
} from './planner';
import { hotmartConectado, type ConfigHotmart } from '../hotmart/cliente';
import { cuentasConLeadsTikTok, TIKTOK_INTEGRATION_TIPO } from '../report-utm/tiktok-leads';
import { colombiaToday, colombiaYesterday } from '../date-utils';

/** Canales que se pueden pedir por separado. */
export const CANALES_SYNC = [
  'metricas',
  'sheets',
  'ga4',
  'hotmart',
  'meta_leads',
  'ghl',
  'tiktok_leads',
] as const;
export type CanalSync = (typeof CANALES_SYNC)[number];

export const ETIQUETA_CANAL: Record<CanalSync, string> = {
  metricas: 'Métricas de anuncios (Meta, TikTok) y agregados de Hotmart y GA4',
  sheets: 'Google Sheets (conversiones offline y campos)',
  ga4: 'GA4 desglosado por campaña',
  hotmart: 'Ventas de Hotmart',
  meta_leads: 'Leads de Meta Lead Ads',
  ghl: 'Contactos y oportunidades de GoHighLevel',
  tiktok_leads: 'Leads de formularios de TikTok',
};

/** Tipos de job que dispara cada canal. */
export const TIPOS_DE_CANAL: Record<CanalSync, SyncJobTipo[]> = {
  metricas: ['metricas'],
  sheets: ['sheets_conversiones'],
  ga4: ['ga4'],
  hotmart: ['hotmart_ventas'],
  meta_leads: ['meta_leads'],
  ghl: ['ghl_leads', 'ghl_oportunidades'],
  tiktok_leads: ['tiktok_leads'],
};

/** Rango máximo que se acepta pedir desde el agente (el resto, desde el panel). */
export const MAX_DIAS_SYNC_AGENTE = 90;
/** Ventana de ventas de Hotmart en un refresco sin fechas. */
export const DIAS_REFRESCO_HOTMART = 7;
/** Minutos durante los que un refresco lanzado por el agente frena otro igual. */
export const MINUTOS_FRENO = 10;

/** Lo que hace falta saber de un cliente para planificar su sincronización. */
export type ContextoSync = {
  publicId: string;
  /** Id en `report_utm.clientes`; null si no tiene espejo (sin leads ni CRM). */
  rtmId: string | null;
  configApi: unknown;
  /** Integraciones de `report_utm.integrations` del cliente. */
  integraciones: Array<{ tipo: string; status: string | null }>;
};

export type EstadoCanal = {
  canal: CanalSync;
  conectado: boolean;
  detalle: string;
};

function integracion(ctx: ContextoSync, tipo: string, estados: string[]): boolean {
  return ctx.integraciones.some((i) => i.tipo === tipo && estados.includes(i.status ?? ''));
}

/**
 * Qué canales tiene el cliente. Puro: se prueba con configuraciones de mentira.
 *
 * `metricas` se encola aunque solo haya Hotmart o GA4, porque el worker de
 * métricas también trae sus agregados diarios; sin nada de eso, no hay qué pedir.
 */
export function canalesDeCliente(ctx: ContextoSync): EstadoCanal[] {
  const cfg = ctx.configApi;
  const plataformas = [
    tieneMeta(cfg) && 'Meta',
    tieneTiktok(cfg) && 'TikTok',
    hotmartConectado(cfg as ConfigHotmart) && 'Hotmart',
    tieneGa4(cfg) && 'GA4',
  ].filter(Boolean) as string[];
  const sinEspejo = 'El cliente no tiene espejo en Report-UTM: no hay integraciones de leads.';

  const out: EstadoCanal[] = [
    {
      canal: 'metricas',
      conectado: plataformas.length > 0,
      detalle: plataformas.length
        ? plataformas.join(', ')
        : 'Sin cuentas de Meta ni TikTok, ni Hotmart ni GA4.',
    },
    {
      canal: 'sheets',
      conectado: tieneSheets(cfg),
      detalle: tieneSheets(cfg) ? 'Hoja habilitada' : 'Sin Google Sheet habilitado.',
    },
    {
      canal: 'ga4',
      conectado: tieneGa4(cfg),
      detalle: tieneGa4(cfg) ? 'Propiedad configurada' : 'Sin propiedad de GA4.',
    },
    {
      canal: 'hotmart',
      conectado: hotmartConectado(cfg as ConfigHotmart),
      detalle: hotmartConectado(cfg as ConfigHotmart) ? 'Conectado' : 'Sin Hotmart conectado.',
    },
  ];

  const metaLeads = integracion(ctx, 'meta_lead_ads', ['active', 'error']);
  const ghl = integracion(ctx, 'gohighlevel', ['active']);
  const tiktokLeads =
    cuentasConLeadsTikTok(cfg as Record<string, unknown>).length > 0 &&
    // Como `objetivosTikTokLeads`: si alguien puso la integración en `inactive`,
    // se salta aunque la cuenta siga marcada.
    !integracion(ctx, TIKTOK_INTEGRATION_TIPO, ['inactive']);
  out.push(
    {
      canal: 'meta_leads',
      conectado: Boolean(ctx.rtmId) && metaLeads,
      detalle: !ctx.rtmId ? sinEspejo : metaLeads ? 'Integración activa' : 'Sin Meta Lead Ads.',
    },
    {
      canal: 'ghl',
      conectado: Boolean(ctx.rtmId) && ghl,
      detalle: !ctx.rtmId ? sinEspejo : ghl ? 'Integración activa' : 'Sin GoHighLevel.',
    },
    {
      canal: 'tiktok_leads',
      conectado: Boolean(ctx.rtmId) && tiktokLeads,
      detalle: !ctx.rtmId
        ? sinEspejo
        : tiktokLeads
          ? 'Cuenta con leads marcada'
          : 'Sin cuentas de TikTok con leads.',
    }
  );
  return out;
}

/** `YYYY-MM-DD` + n días (UTC, sin hora: no depende de la zona). */
function sumarDias(fecha: string, n: number): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diasDeRango(desde: string, hasta: string): number {
  return (
    Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000) +
    1
  );
}

export type OpcionesPlan = {
  /** Rango pedido. Sin él, la ventana de refresco de cada canal. */
  rango?: { desde: string; hasta: string } | null;
  /** Solo estos canales (por defecto, todos los conectados). */
  canales?: CanalSync[];
  /** Tipos que ya están en curso: no se vuelven a encolar. */
  omitirTipos?: SyncJobTipo[];
  triggeredBy?: string;
  /** Inyectables para los tests. */
  hoy?: string;
  ayer?: string;
};

/**
 * Los jobs que hay que encolar. Puro.
 *
 * Sin rango, las ventanas son las del planner diario (métricas ayer-hoy, GA4
 * los últimos días, la hoja entera), así que un job del planner aún pendiente
 * deduplica con este en vez de repetirse. Con rango, métricas y ventas de
 * Hotmart se trocean en tramos de 14 días (como el panel) y GA4 en tramos de 90
 * (como su backfill); los leads van por cursor y no usan fechas.
 */
export function planSyncCliente(
  ctx: ContextoSync,
  estados: EstadoCanal[],
  opts: OpcionesPlan = {}
): EnqueueInput[] {
  const hoy = opts.hoy ?? colombiaToday();
  const ayer = opts.ayer ?? colombiaYesterday();
  const rango = opts.rango ?? null;
  const pedidos = new Set(opts.canales?.length ? opts.canales : CANALES_SYNC);
  const omitir = new Set(opts.omitirTipos ?? []);
  const base = {
    clienteId: ctx.publicId,
    prioridad: PRIORIDAD.manual,
    triggeredBy: opts.triggeredBy ?? 'agente',
  };
  const out: EnqueueInput[] = [];

  const tramos = (dias: number, defecto: { start: string; end: string }) =>
    rango ? splitRange(rango.desde, rango.hasta, dias) : [defecto];

  for (const e of estados) {
    if (!e.conectado || !pedidos.has(e.canal)) continue;
    const añadir = (tipo: SyncJobTipo, extra: Partial<EnqueueInput> = {}) => {
      if (!omitir.has(tipo)) out.push({ ...base, tipo, ...extra });
    };

    switch (e.canal) {
      case 'metricas':
        for (const t of tramos(DEFAULT_CHUNK_DAYS, { start: ayer, end: hoy })) {
          // Con rango, `force`: sin él el worker salta los días viejos que ya
          // tienen datos, que es justo lo que se pide volver a traer.
          añadir('metricas', {
            start: t.start,
            end: t.end,
            ...(rango ? { params: { force: true } } : {}),
          });
        }
        break;
      case 'sheets':
        // La hoja se lee entera: el rango no aplica. Mismas fechas que el planner
        // para deduplicar con su job si sigue pendiente.
        añadir('sheets_conversiones', { start: ayer, end: hoy });
        break;
      case 'ga4':
        for (const t of tramos(90, { start: sumarDias(hoy, -DIAS_REFRESCO_GA4), end: hoy })) {
          añadir('ga4', { start: t.start, end: t.end });
        }
        break;
      case 'hotmart':
        for (const t of tramos(DEFAULT_CHUNK_DAYS, {
          start: sumarDias(hoy, -DIAS_REFRESCO_HOTMART),
          end: hoy,
        })) {
          añadir('hotmart_ventas', { start: t.start, end: t.end });
        }
        break;
      case 'meta_leads':
      case 'ghl':
      case 'tiktok_leads':
        for (const tipo of TIPOS_DE_CANAL[e.canal]) {
          añadir(tipo, { params: { rtm_cliente_id: ctx.rtmId } });
        }
        break;
    }
  }
  return out;
}

// ── Base de datos ─────────────────────────────────────────────────────────

/** Cliente de Supabase (admin). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

/** Lee config, espejo e integraciones de un cliente público. null si no existe. */
export async function leerContextoSync(db: Db, publicId: string): Promise<ContextoSync | null> {
  const { data: cli, error } = await db
    .from('clientes')
    .select('id, config_api')
    .eq('id', publicId)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer el cliente: ${error.message}`);
  if (!cli) return null;

  const rtm = db.schema('report_utm');
  const { data: espejos, error: e2 } = await rtm
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId)
    .order('created_at', { ascending: true })
    .limit(1);
  if (e2) throw new Error(`No se pudo leer el cliente de Report-UTM: ${e2.message}`);
  const rtmId = ((espejos ?? []) as Array<{ id: string }>)[0]?.id ?? null;

  let integraciones: ContextoSync['integraciones'] = [];
  if (rtmId) {
    const { data, error: e3 } = await rtm
      .from('integrations')
      .select('tipo, status')
      .eq('cliente_id', rtmId);
    if (e3) throw new Error(`No se pudieron leer las integraciones: ${e3.message}`);
    integraciones = (data ?? []) as ContextoSync['integraciones'];
  }
  return { publicId, rtmId, configApi: (cli as { config_api: unknown }).config_api, integraciones };
}

export type JobResumen = {
  id: string;
  tipo: string;
  estado: string;
  triggered_by: string | null;
  created_at: string;
};

/**
 * Lo que frena un refresco: jobs del cliente en curso y lanzados por el agente
 * en los últimos `MINUTOS_FRENO` minutos.
 */
export async function frenoSync(
  db: Db,
  publicId: string,
  ahora = Date.now()
): Promise<{ enCurso: JobResumen[]; recientesAgente: JobResumen[] }> {
  const cols = 'id, tipo, estado, triggered_by, created_at';
  const desde = new Date(ahora - MINUTOS_FRENO * 60_000).toISOString();
  const [curso, recientes] = await Promise.all([
    db
      .from('sync_jobs')
      .select(cols)
      .eq('cliente_id', publicId)
      .in('estado', ['pending', 'running']),
    db
      .from('sync_jobs')
      .select(cols)
      .eq('cliente_id', publicId)
      .eq('triggered_by', 'agente')
      .gte('created_at', desde)
      .order('created_at', { ascending: false }),
  ]);
  if (curso.error) throw new Error(`No se pudo leer la cola: ${curso.error.message}`);
  if (recientes.error) throw new Error(`No se pudo leer la cola: ${recientes.error.message}`);
  return {
    enCurso: (curso.data ?? []) as JobResumen[],
    recientesAgente: (recientes.data ?? []) as JobResumen[],
  };
}

export type ResultadoEncolado = {
  encolados: Array<{ tipo: string; job_id: string; desde: string | null; hasta: string | null }>;
  /** Ya había uno igual pendiente o corriendo (o el rango era futuro). */
  duplicados: Array<{ tipo: string; desde: string | null; hasta: string | null }>;
  errores: Array<{ tipo: string; error: string }>;
};

/** Encola la lista; un tipo que falla no impide los demás. */
export async function encolarSyncCliente(db: Db, jobs: EnqueueInput[]): Promise<ResultadoEncolado> {
  const out: ResultadoEncolado = { encolados: [], duplicados: [], errores: [] };
  for (const j of jobs) {
    try {
      const creado = await enqueueJob(db, j);
      if (creado) {
        out.encolados.push({
          tipo: j.tipo,
          job_id: creado.id,
          desde: creado.fecha_inicio,
          hasta: creado.fecha_fin,
        });
      } else {
        out.duplicados.push({ tipo: j.tipo, desde: j.start ?? null, hasta: j.end ?? null });
      }
    } catch (e) {
      out.errores.push({ tipo: j.tipo, error: (e as Error).message });
    }
  }
  return out;
}
