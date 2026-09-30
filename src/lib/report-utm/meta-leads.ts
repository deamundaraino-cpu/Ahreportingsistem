import type { SupabaseClient } from '@supabase/supabase-js';
import { aplicarExclusion, cargarReglaExclusion } from './lead-exclusion';
import { excluirDuplicadosLote } from './lead-duplicados';
import { adaptarIds, columnasIdDisponibles, idsPublicitarios, insertarLeads } from './lead-ids';
import { guardarPreguntas, sincronizarOpcionesEnCampos } from '@/lib/leads/respuestas/preguntas-db';
import type { PreguntaPlataforma, TipoPlataforma } from '@/lib/leads/respuestas/preguntas-db';

/**
 * Núcleo compartido para ingerir leads de **Meta Lead Ads** (formularios
 * instantáneos / "meta forms") en `report_utm.lead_events`.
 *
 * Lo usan dos caminos:
 *   · Polling   → /api/cron/sync-meta-leads        (red de seguridad + backfill)
 *   · Webhook   → /api/report-utm/webhooks/meta     (tiempo real)
 *
 * Los formularios instantáneos NO llevan UTMs reales (no hay navegación a una
 * landing). Por eso sintetizamos las UTMs desde la estructura de campaña, con
 * `utm_id = campaign_id` para que el lead cruce de forma exacta con el gasto en
 * el BI Builder (ver src/lib/report-utm/campaign-data.ts).
 *
 * El token de Meta y las cuentas viven en `public.clientes.config_api`; el
 * puente es `report_utm.clientes.public_cliente_id`.
 */

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? 'v19.0'}`;

// Campos que pedimos en el nodo del lead: traen el registro + la estructura de campaña.
const LEAD_FIELDS =
  'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic,field_data';

export type MetaAccount = { account_id: string; token: string };
export type MetaLeadForm = { id: string; name: string };

export type MetaLeadRecord = {
  id: string;
  created_time?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  form_id?: string;
  platform?: string;
  is_organic?: boolean;
  field_data?: Array<{ name: string; values?: string[] }>;
};

type ReportUtmDb = ReturnType<SupabaseClient['schema']>;
type GraphRow = Record<string, unknown>;
type GraphResponse = {
  data?: GraphRow[];
  paging?: { next?: string };
  error?: { message?: string };
};

/**
 * Resuelve las cuentas + tokens de Meta de un cliente del módulo report_utm.
 * Misma lógica multi-cuenta / legacy que el worker (`fetchMeta`).
 */
export async function getMetaAccountsForCliente(
  supabase: SupabaseClient,
  reportClienteId: string
): Promise<{ accounts: MetaAccount[]; error?: string }> {
  const { data: rc } = await supabase
    .schema('report_utm')
    .from('clientes')
    .select('public_cliente_id')
    .eq('id', reportClienteId)
    .maybeSingle();

  if (!rc?.public_cliente_id) {
    return {
      accounts: [],
      error:
        'Cliente sin vínculo a un cliente del reporting (public_cliente_id). Conectá Meta primero.',
    };
  }

  const { data: pc } = await supabase
    .from('clientes')
    .select('config_api')
    .eq('id', rc.public_cliente_id)
    .maybeSingle();

  const config = (pc?.config_api ?? {}) as Record<string, unknown>;
  let accounts: MetaAccount[] = [];

  const metaAccounts = config.meta_accounts;
  if (Array.isArray(metaAccounts) && metaAccounts.length > 0) {
    accounts = (metaAccounts as GraphRow[])
      .filter((a) => a?.account_id)
      .map((a) => ({
        account_id: String(a.account_id),
        token: String(a.token || config.meta_token || ''),
      }));
  } else if (config.meta_token && config.meta_account_id) {
    accounts = [{ account_id: String(config.meta_account_id), token: String(config.meta_token) }];
  }

  accounts = accounts.filter((a) => a.account_id && a.token);
  if (accounts.length === 0) {
    return { accounts: [], error: 'Cliente sin Meta conectado (sin token/cuenta publicitaria).' };
  }
  return { accounts };
}

/** Paginación genérica del Graph API siguiendo `paging.next`. */
async function fetchAllPages(firstUrl: string): Promise<GraphRow[]> {
  const out: GraphRow[] = [];
  let next: string | null = firstUrl;
  let guard = 0;
  while (next && guard < 50) {
    guard++;
    const res: Response = await fetch(next);
    const data = (await res.json()) as GraphResponse;
    if (data.error) {
      throw new Error(`Graph API: ${data.error.message ?? JSON.stringify(data.error)}`);
    }
    if (Array.isArray(data.data)) out.push(...data.data);
    next = data.paging?.next ?? null;
  }
  return out;
}

/**
 * Lista los formularios de leads de una Página.
 * `leadgen_forms` es un edge de la **Página** (no del ad account), por eso se
 * consulta con el page_id + page token.
 */
export async function listLeadForms(page: MetaPage): Promise<MetaLeadForm[]> {
  const url = new URL(`${GRAPH}/${page.page_id}/leadgen_forms`);
  url.searchParams.append('access_token', page.page_token);
  url.searchParams.append('fields', 'id,name');
  url.searchParams.append('limit', '200');
  const rows = await fetchAllPages(url.toString());
  return rows.filter((f) => f.id).map((f) => ({ id: String(f.id), name: String(f.name ?? f.id) }));
}

// ── Preguntas del formulario (migración 091) ──────────────────────────

/** Pregunta de un formulario instantáneo, tal como la devuelve Graph. */
export interface MetaFormQuestion {
  key?: string;
  label?: string;
  type?: string;
  options?: { key?: string; value?: string }[];
}

/** Tipos de Graph que son datos de contacto, no preguntas medibles. */
const TIPOS_CONTACTO: Record<string, TipoPlataforma> = {
  EMAIL: 'email',
  PHONE: 'telefono',
  FULL_NAME: 'texto',
  FIRST_NAME: 'texto',
  LAST_NAME: 'texto',
  DATE_OF_BIRTH: 'fecha',
  DATE_TIME: 'fecha',
};

/**
 * Preguntas de un formulario de Meta → el formato de `lead_preguntas`.
 *
 * La respuesta de una opción llega a `field_data` con la CLAVE de la opción
 * («entre_$2.000.000_y_$4.000.000»), no con su texto: por eso se guarda la
 * pareja {valor: key, etiqueta: value}, y la activación usa la etiqueta como
 * nombre de la respuesta. Meta no distingue selección múltiple en `type`
 * (llega como `CUSTOM` con opciones): se trata como desplegable.
 */
export function preguntasDeFormularioMeta(
  form: { id: string; name: string },
  questions: MetaFormQuestion[]
): PreguntaPlataforma[] {
  return (questions ?? [])
    .filter((q) => q?.key)
    .map((q) => {
      const opciones = (q.options ?? [])
        .filter((o) => o?.key || o?.value)
        .map((o) => ({ valor: String(o.key ?? o.value), etiqueta: o.value ?? null }));
      const tipoGraph = String(q.type ?? '').toUpperCase();
      const tipo: TipoPlataforma =
        opciones.length > 0 ? 'opcion' : (TIPOS_CONTACTO[tipoGraph] ?? 'texto');
      return {
        form_id: form.id,
        form_name: form.name,
        clave_origen: String(q.key),
        etiqueta: q.label ?? null,
        tipo,
        opciones,
      };
    });
}

/** Lee las preguntas de un formulario. null si Graph no las da (permisos). */
export async function fetchFormQuestions(
  formId: string,
  token: string
): Promise<MetaFormQuestion[] | null> {
  const url = new URL(`${GRAPH}/${formId}`);
  url.searchParams.append('access_token', token);
  url.searchParams.append('fields', 'questions');
  try {
    const res = await fetch(url.toString());
    const data = (await res.json()) as { questions?: MetaFormQuestion[]; error?: unknown };
    if (data.error || !Array.isArray(data.questions)) return null;
    return data.questions;
  } catch {
    return null;
  }
}

/** Cada cuánto se releen las preguntas de los formularios de un cliente. */
const PREGUNTAS_CADA_MS = 6 * 3600_000;

/**
 * Trae los leads de un formulario. Si `sinceUnix` se pasa, solo los creados
 * después de ese timestamp (cursor incremental); si no, todos los que Meta
 * conserve (~90 días) para el backfill.
 */
export async function fetchFormLeads(
  formId: string,
  token: string,
  sinceUnix?: number | null
): Promise<MetaLeadRecord[]> {
  const url = new URL(`${GRAPH}/${formId}/leads`);
  url.searchParams.append('access_token', token);
  url.searchParams.append('fields', LEAD_FIELDS);
  url.searchParams.append('limit', '200');
  if (sinceUnix && sinceUnix > 0) {
    url.searchParams.append(
      'filtering',
      JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }])
    );
  }
  return (await fetchAllPages(url.toString())) as MetaLeadRecord[];
}

/**
 * Igual que `fetchFormLeads` pero en **streaming**: invoca `onBatch` por cada
 * página de resultados (≤200 leads), sin acumular todo en memoria. Lo usa el
 * polling para ingerir por lotes y no cargar miles de leads de golpe.
 */
export async function fetchFormLeadsPaged(
  formId: string,
  token: string,
  sinceUnix: number | null | undefined,
  onBatch: (leads: MetaLeadRecord[]) => Promise<void>
): Promise<void> {
  const url = new URL(`${GRAPH}/${formId}/leads`);
  url.searchParams.append('access_token', token);
  url.searchParams.append('fields', LEAD_FIELDS);
  url.searchParams.append('limit', '200');
  if (sinceUnix && sinceUnix > 0) {
    url.searchParams.append(
      'filtering',
      JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }])
    );
  }

  let next: string | null = url.toString();
  let guard = 0;
  while (next && guard < 200) {
    guard++;
    const res: Response = await fetch(next);
    const data = (await res.json()) as GraphResponse;
    if (data.error) {
      throw new Error(`Graph API: ${data.error.message ?? JSON.stringify(data.error)}`);
    }
    if (Array.isArray(data.data) && data.data.length > 0) {
      await onBatch(data.data as MetaLeadRecord[]);
    }
    next = data.paging?.next ?? null;
  }
}

export type MetaPage = { page_id: string; page_token: string; name?: string };

/**
 * Descubre las Páginas de Facebook accesibles con los tokens del cliente
 * (vía `/me/accounts`), con su page token. El token de la Página es el que
 * permite listar formularios y leer leads.
 *
 * Si el token no tiene permiso de Páginas, devuelve lista vacía + un error
 * explicativo; en ese caso el cliente debe reconectar Meta concediendo acceso
 * a Páginas (pages_show_list / leads_retrieval a nivel Página).
 */
export async function getClientePages(
  supabase: SupabaseClient,
  clienteId: string
): Promise<{ pages: MetaPage[]; error?: string }> {
  const { accounts, error } = await getMetaAccountsForCliente(supabase, clienteId);
  if (error) return { pages: [], error };

  const pagesMap = new Map<string, MetaPage>();
  let lastError: string | undefined;
  for (const account of accounts) {
    try {
      const url = new URL(`${GRAPH}/me/accounts`);
      url.searchParams.append('access_token', account.token);
      url.searchParams.append('fields', 'id,name,access_token');
      url.searchParams.append('limit', '200');
      const rows = await fetchAllPages(url.toString());
      for (const p of rows) {
        if (p.id && p.access_token) {
          pagesMap.set(String(p.id), {
            page_id: String(p.id),
            page_token: String(p.access_token),
            name: p.name ? String(p.name) : undefined,
          });
        }
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  const pages = Array.from(pagesMap.values());
  if (pages.length === 0) {
    return {
      pages,
      error:
        lastError ??
        'No se encontraron Páginas accesibles con el token de Meta. Reconectá Meta concediendo permiso de Páginas (pages_show_list / leads_retrieval).',
    };
  }
  return { pages };
}

/**
 * Page ids asociados a UNA cuenta publicitaria (`promote_pages`).
 * Es el vínculo cuenta→Página por cliente: cada cliente tiene su propia cuenta
 * y su propia Página, así que las Páginas que esa cuenta puede promocionar son
 * las del cliente. No depende del spend.
 */
export async function fetchAdAccountPageIds(account: MetaAccount): Promise<Set<string>> {
  const actId = account.account_id.startsWith('act_')
    ? account.account_id
    : `act_${account.account_id}`;
  const ids = new Set<string>();

  // 1) Vía promote_pages (directo).
  try {
    const url = new URL(`${GRAPH}/${actId}/promote_pages`);
    url.searchParams.append('access_token', account.token);
    url.searchParams.append('fields', 'id,name');
    url.searchParams.append('limit', '200');
    const rows = await fetchAllPages(url.toString());
    for (const r of rows) {
      if (r.id) ids.add(String(r.id));
    }
  } catch {
    /* fallback abajo */
  }

  if (ids.size > 0) return ids;

  // 2) Fallback: deducir la(s) Página(s) desde los anuncios de la cuenta.
  try {
    const url = new URL(`${GRAPH}/${actId}/ads`);
    url.searchParams.append('access_token', account.token);
    url.searchParams.append(
      'fields',
      'creative{object_story_spec{page_id},effective_object_story_id}'
    );
    url.searchParams.append('limit', '200');
    const rows = await fetchAllPages(url.toString());
    for (const r of rows) {
      const creative = r.creative as
        | { object_story_spec?: { page_id?: string }; effective_object_story_id?: string }
        | undefined;
      const pageId = creative?.object_story_spec?.page_id;
      if (pageId) {
        ids.add(String(pageId));
        continue;
      }
      // effective_object_story_id viene como "{page_id}_{post_id}"
      const eosi = creative?.effective_object_story_id;
      if (typeof eosi === 'string' && eosi.includes('_')) ids.add(eosi.split('_')[0]);
    }
  } catch {
    /* sin Páginas deducibles */
  }

  return ids;
}

export type ScopedTargets = {
  scopedPages: MetaPage[];
  matchedForms: Array<{ form: MetaLeadForm; page: MetaPage }>;
  error?: string;
};

/**
 * Resuelve QUÉ formularios y Páginas pertenecen a un cliente, acotando por las
 * cuentas publicitarias del cliente (no por todas las Páginas que administra la
 * agencia). Evita que los leads de un cliente aparezcan en otro.
 *
 *  1. Por cada cuenta del cliente → sus Páginas (`promote_pages`).
 *  2. Descubre las Páginas accesibles + tokens (`/me/accounts`).
 *  3. Se queda solo con las Páginas del cliente (intersección) y lista TODOS sus
 *     formularios (cada cliente tiene su propia Página, así que todos son suyos).
 */
export async function getClienteScopedTargets(
  supabase: SupabaseClient,
  clienteId: string
): Promise<ScopedTargets> {
  const { accounts, error: accError } = await getMetaAccountsForCliente(supabase, clienteId);
  if (accError) return { scopedPages: [], matchedForms: [], error: accError };

  // 1) Páginas asociadas a las cuentas publicitarias del cliente.
  const clientPageIds = new Set<string>();
  let ppError: string | undefined;
  for (const account of accounts) {
    try {
      const ids = await fetchAdAccountPageIds(account);
      ids.forEach((id) => clientPageIds.add(id));
    } catch (e) {
      ppError = e instanceof Error ? e.message : String(e);
    }
  }
  if (clientPageIds.size === 0) {
    return {
      scopedPages: [],
      matchedForms: [],
      error:
        ppError ??
        'Las cuentas publicitarias del cliente no tienen Páginas asociadas (promote_pages).',
    };
  }

  // 2) Páginas accesibles + tokens.
  const { pages, error: pagesError } = await getClientePages(supabase, clienteId);
  if (pages.length === 0) return { scopedPages: [], matchedForms: [], error: pagesError };

  // 3) Intersección: solo las Páginas del cliente. Todos sus formularios son suyos.
  const scopedPages = pages.filter((p) => clientPageIds.has(p.page_id));
  if (scopedPages.length === 0) {
    return {
      scopedPages: [],
      matchedForms: [],
      error:
        'Las Páginas de las cuentas del cliente no están entre las accesibles con el token. Reconectá Meta administrando esa Página.',
    };
  }

  const matchedForms: Array<{ form: MetaLeadForm; page: MetaPage }> = [];
  for (const page of scopedPages) {
    let forms: MetaLeadForm[] = [];
    try {
      forms = await listLeadForms(page);
    } catch {
      continue;
    }
    for (const form of forms) {
      matchedForms.push({ form, page });
    }
  }

  return { scopedPages, matchedForms };
}

/**
 * Descubre las Páginas **del cliente** (acotadas por sus cuentas publicitarias)
 * y las suscribe al campo `leadgen` de la app (webhook en tiempo real).
 * Best-effort. Devuelve solo las Páginas del cliente para guardarlas en
 * `config.pages` (mapeo page_id→cliente del webhook).
 */
export async function discoverAndSubscribePages(
  supabase: SupabaseClient,
  clienteId: string
): Promise<{ pages: MetaPage[]; error?: string }> {
  const { scopedPages, error } = await getClienteScopedTargets(supabase, clienteId);
  if (scopedPages.length === 0) return { pages: [], error };

  for (const page of scopedPages) {
    try {
      await fetch(`${GRAPH}/${page.page_id}/subscribed_apps`, {
        method: 'POST',
        body: new URLSearchParams({ subscribed_fields: 'leadgen', access_token: page.page_token }),
      });
    } catch {
      /* no fatal — el polling cubre */
    }
  }

  return { pages: scopedPages };
}

/** Trae un lead puntual por su leadgen_id (usado por el webhook en tiempo real). */
export async function fetchLeadById(
  leadgenId: string,
  token: string
): Promise<MetaLeadRecord | null> {
  const url = new URL(`${GRAPH}/${leadgenId}`);
  url.searchParams.append('access_token', token);
  url.searchParams.append('fields', LEAD_FIELDS);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data.error || !data.id) return null;
  return data as MetaLeadRecord;
}

/**
 * Extrae datos de contacto + todos los campos del registro.
 * `raw_fields` queda como objeto plano {campo: valor} (lo que consume el export CSV).
 */
export function normalizeLeadFields(fieldData: MetaLeadRecord['field_data']): {
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  raw_fields: Record<string, string>;
} {
  const raw: Record<string, string> = {};
  const byName: Record<string, string> = {};
  for (const f of fieldData ?? []) {
    if (!f?.name) continue;
    const value = Array.isArray(f.values) ? f.values.join(', ') : '';
    raw[f.name] = value;
    byName[f.name.toLowerCase()] = value;
  }

  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      if (byName[k]) return byName[k];
    }
    return null;
  };

  let name = pick('full_name', 'name', 'nombre', 'nombre_completo');
  if (!name) {
    const first = pick('first_name', 'nombre');
    const last = pick('last_name', 'apellido', 'apellidos');
    const joined = [first, last].filter(Boolean).join(' ').trim();
    name = joined || null;
  }

  return {
    lead_name: name,
    lead_email: pick('email', 'correo', 'correo_electronico', 'e-mail'),
    lead_phone: pick('phone_number', 'phone', 'telefono', 'celular', 'whatsapp_number'),
    raw_fields: raw,
  };
}

const PLATFORM_SOURCE: Record<string, string> = {
  fb: 'facebook',
  facebook: 'facebook',
  ig: 'instagram',
  instagram: 'instagram',
  an: 'audience_network',
  msg: 'messenger',
  messenger: 'messenger',
};

/**
 * Sintetiza UTMs desde la estructura de campaña del lead.
 * `utm_id = campaign_id` → cruza exacto con el gasto en el BI (cascada de campaign-data.ts).
 */
export function synthesizeUtms(lead: MetaLeadRecord) {
  const source = lead.platform
    ? (PLATFORM_SOURCE[lead.platform.toLowerCase()] ?? lead.platform)
    : 'facebook';
  return {
    utm_source: source,
    utm_medium: lead.is_organic ? 'social' : 'paid_social',
    utm_campaign: lead.campaign_name ?? null,
    utm_content: lead.ad_name ?? null,
    utm_term: lead.adset_name ?? null,
    utm_id: lead.campaign_id ?? null,
    click_id: null as string | null,
  };
}

/** Timestamp unix (segundos) del lead, a partir de created_time. */
export function leadCreatedUnix(lead: MetaLeadRecord): number | null {
  if (!lead.created_time) return null;
  const ms = new Date(lead.created_time).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/**
 * Construye la fila de `lead_events` para un lead de Meta, con la atribución
 * resuelta **inline**: los leads de formularios instantáneos no tienen click_id
 * ni historia de pixel, así que la atribución es siempre `utm_only` con las UTMs
 * sintetizadas (no hace falta `resolveAttribution` ni un UPDATE extra).
 */
function buildLeadRow(
  clienteId: string,
  lead: MetaLeadRecord,
  formName?: string | null
): Record<string, unknown> {
  const utm = synthesizeUtms(lead);
  const { lead_name, lead_email, lead_phone, raw_fields } = normalizeLeadFields(lead.field_data);

  const createdAt =
    lead.created_time && !Number.isNaN(new Date(lead.created_time).getTime())
      ? new Date(lead.created_time).toISOString()
      : undefined;
  const hasSignal = Boolean(utm.utm_source || utm.utm_campaign);

  const row: Record<string, unknown> = {
    cliente_id: clienteId,
    external_id: lead.id,
    form_name: formName ?? null,
    form_id: lead.form_id ?? null,
    form_plugin: 'meta_lead_ads',
    lead_name,
    lead_email,
    lead_phone,
    utm_source: utm.utm_source,
    utm_medium: utm.utm_medium,
    utm_campaign: utm.utm_campaign,
    utm_content: utm.utm_content,
    utm_term: utm.utm_term,
    utm_id: utm.utm_id,
    // Los tres IDs que Meta manda con cada lead. Hasta la 082 solo se guardaba
    // el de campaña (en `utm_id`) y el anuncio y el conjunto cruzaban por un
    // nombre que puede repetirse entre campañas o cambiar.
    ...idsPublicitarios(lead.campaign_id, lead.adset_id, lead.ad_id),
    click_id: utm.click_id,
    raw_fields,
    source: 'meta_lead_ads',
    attribution_method: hasSignal ? 'utm_only' : 'none',
    attribution_resolved_at: new Date().toISOString(),
  };
  if (createdAt) row.created_at = createdAt;
  return row;
}

/**
 * Inserta UN lead de Meta (dedup por external_id). Usado por el webhook.
 */
export async function ingestMetaLead(
  db: ReportUtmDb,
  clienteId: string,
  lead: MetaLeadRecord,
  formName?: string | null
): Promise<{ inserted: boolean; error?: string }> {
  // Un lead de Meta casi siempre trae `utm_id`, pero la regla del cliente puede
  // excluir por fuente o formulario: se evalúa igual que en GHL y S2S.
  const regla = await cargarReglaExclusion(db, clienteId);
  const [row] = await excluirDuplicadosLote(
    db,
    clienteId,
    [
      adaptarIds(
        aplicarExclusion(buildLeadRow(clienteId, lead, formName), regla),
        await columnasIdDisponibles(db)
      ),
    ],
    regla
  );
  const { error } = await insertarLeads(db, row);
  if (error) {
    // 23505 = unique_violation → ya existía (webhook/poll lo metió antes). No es error.
    if ((error as { code?: string }).code === '23505') return { inserted: false };
    return { inserted: false, error: error.message };
  }
  return { inserted: true };
}

/**
 * Inserta un LOTE de leads de Meta de forma eficiente (usado por el polling):
 *  1. Construye las filas (atribución inline, sin queries por lead).
 *  2. Una sola consulta para saber cuáles external_id ya existen (dedup).
 *  3. Un solo INSERT con los nuevos. Si falla (carrera rara con el webhook),
 *     cae a inserción fila por fila tolerando duplicados.
 * Devuelve cuántos se insertaron.
 */
export async function ingestMetaLeadsBatch(
  db: ReportUtmDb,
  clienteId: string,
  leads: MetaLeadRecord[],
  formName?: string | null
): Promise<number> {
  if (leads.length === 0) return 0;

  // Una lectura de la regla por lote, no por lead.
  const regla = await cargarReglaExclusion(db, clienteId);
  const conIds = await columnasIdDisponibles(db);
  const ahora = new Date().toISOString();
  // Dedup dentro del propio lote por external_id.
  const byId = new Map<string, Record<string, unknown>>();
  for (const lead of leads) {
    if (!lead.id) continue;
    byId.set(
      lead.id,
      adaptarIds(aplicarExclusion(buildLeadRow(clienteId, lead, formName), regla, ahora), conIds)
    );
  }
  const rows = Array.from(byId.values());
  if (rows.length === 0) return 0;

  // Filtrar los que ya existen en BD (una sola query).
  const ids = Array.from(byId.keys());
  const { data: existing } = await db
    .from('lead_events')
    .select('external_id')
    .eq('cliente_id', clienteId)
    .in('external_id', ids);
  const existingSet = new Set((existing ?? []).map((e: { external_id: string }) => e.external_id));
  // Duplicados después de quitar los ya guardados: un lead que el polling
  // vuelve a traer no es un duplicado, es el mismo lead.
  const toInsert = await excluirDuplicadosLote(
    db,
    clienteId,
    rows.filter((r) => !existingSet.has(r.external_id as string)),
    regla,
    ahora
  );
  if (toInsert.length === 0) return 0;

  const { error } = await insertarLeads(db, toInsert);
  if (!error) return toInsert.length;

  // Fallback fila por fila (tolera 23505 por carrera con el webhook).
  let n = 0;
  for (const r of toInsert) {
    const { error: e } = await insertarLeads(db, r);
    if (!e) n++;
    else if ((e as { code?: string }).code !== '23505') {
      console.error('[meta-leads] batch fallback insert error', e.message);
    }
  }
  return n;
}

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;
/** Cada cuánto se vuelve a descubrir la lista de formularios de un cliente. */
const REDESCUBRIR_FORMULARIOS_MS = 24 * 3600_000;

export type MetaLeadsSyncSummary = {
  imported: number;
  scanned: number;
  forms: number;
  backfill: boolean;
  error?: string;
};

/**
 * Sincroniza (vía polling) los leads de Meta de UN cliente y persiste el cursor
 * incremental en la integración. Reutilizado por el cron y por el botón
 * "Sincronizar ahora" de la UI. La dedup por external_id evita duplicar leads
 * que el webhook ya haya insertado.
 *
 * `integration` es la fila `report_utm.integrations` (tipo='meta_lead_ads').
 */
export async function syncMetaLeadsForCliente(
  supabase: SupabaseClient,
  integration: { id: string; cliente_id: string; config: Record<string, unknown> | null }
): Promise<MetaLeadsSyncSummary> {
  const db = supabase.schema('report_utm');
  const clienteId = integration.cliente_id;
  const config = (integration.config ?? {}) as Record<string, unknown>;
  const isBackfill = config.backfill_done !== true;
  const cursor: number | null = typeof config.sync_cursor === 'number' ? config.sync_cursor : null;
  const nowUnix = Math.floor(Date.now() / 1000);
  // Desde el cursor incremental; si no hay (primera corrida/backfill), lo máximo que Meta conserva (~90d).
  const sinceUnix = cursor ?? nowUnix - NINETY_DAYS_SECONDS;

  let imported = 0;
  let scanned = 0;
  let maxSeen = cursor ?? 0;
  let formCount = 0;
  const startedAt = Date.now();
  // Presupuesto por tanda, bajo el timeout de quien llama. El cursor se persiste al
  // cortar, así que el backfill continúa en la siguiente corrida sin perder nada.
  const BUDGET_MS = Number(process.env.META_LEADS_BUDGET_MS) || 40_000;

  try {
    // Resolver los formularios/Páginas del cliente. En corridas incrementales
    // reutilizamos el descubrimiento cacheado (evita llamadas a Graph); en el
    // backfill (o sin caché) se vuelve a descubrir acotando por cuenta.
    type ScopedForm = { form_id: string; form_name: string; page_id: string; page_token: string };
    let scopedForms: ScopedForm[];
    let scopedPages: MetaPage[];

    const cached = Array.isArray(config.scoped_forms)
      ? (config.scoped_forms as ScopedForm[])
      : null;
    // La caché se renueva una vez al día. Antes solo se redescubría tras un
    // error, así que un formulario creado después del primer backfill no se
    // sondeaba nunca: sus leads dependían del webhook y nada más.
    const cacheAt = Number(config.scoped_forms_at ?? 0);
    const cacheVigente = Date.now() - cacheAt < REDESCUBRIR_FORMULARIOS_MS;
    let formsAt = cacheAt;
    if (!isBackfill && cached && cached.length > 0 && cacheVigente) {
      scopedForms = cached;
      scopedPages = Array.isArray(config.pages) ? (config.pages as MetaPage[]) : [];
    } else {
      const targets = await getClienteScopedTargets(supabase, clienteId);
      if (targets.matchedForms.length === 0 && !isBackfill && cached && cached.length > 0) {
        // La renovación diaria falló (Graph caído, un límite): se sigue con la
        // caché y se reintenta en la próxima corrida, en vez de parar la ingesta.
        console.warn('[meta-leads] no se pudo renovar la lista de formularios:', targets.error);
        scopedForms = cached;
        scopedPages = Array.isArray(config.pages) ? (config.pages as MetaPage[]) : [];
      } else if (targets.matchedForms.length === 0) {
        const msg = targets.error ?? 'Sin formularios para este cliente';
        await db
          .from('integrations')
          .update({ status: 'error', last_error: msg, last_sync_at: new Date().toISOString() })
          .eq('id', integration.id);
        return { imported, scanned, forms: 0, backfill: isBackfill, error: msg };
      } else {
        scopedForms = targets.matchedForms.map(({ form, page }) => ({
          form_id: form.id,
          form_name: form.name,
          page_id: page.page_id,
          page_token: page.page_token,
        }));
        scopedPages = targets.scopedPages;
        formsAt = Date.now();
      }
    }
    formCount = scopedForms.length;
    // Formularios aún no leídos completos (los aparecidos tras el backfill): el
    // cursor del cliente ya pasó por delante de sus primeros leads, así que se
    // leen desde el máximo que Meta conserva, y solo se dan por leídos cuando la
    // lectura termina (si la pasada corta antes, se repite). La dedup por
    // external_id hace inocua la relectura. Sin la lista (integraciones de antes
    // de este cambio), los formularios de la caché cuentan como leídos.
    const leidos = new Set<string>(
      Array.isArray(config.forms_leidos)
        ? (config.forms_leidos as string[])
        : (cached ?? []).map((f) => f.form_id)
    );
    const esNuevo = (f: ScopedForm) => !isBackfill && !leidos.has(f.form_id);

    // Recorrer formularios en streaming + insertar por lotes. Checkpoint de
    // tiempo entre formularios para no exceder el límite del runtime.
    //
    // Se empieza donde cortó la pasada anterior: con un orden fijo, un cliente
    // con muchos formularios agotaba el presupuesto siempre en los mismos y los
    // últimos no se leían nunca.
    const offsetPrevio = Number(config.form_offset ?? 0);
    const inicio = offsetPrevio > 0 && offsetPrevio < scopedForms.length ? offsetPrevio : 0;
    const ordenados = [...scopedForms.slice(inicio), ...scopedForms.slice(0, inicio)];
    let partial = false;
    let siguienteOffset = 0;
    for (let i = 0; i < ordenados.length; i++) {
      const sf = ordenados[i];
      const desde = esNuevo(sf) ? nowUnix - NINETY_DAYS_SECONDS : sinceUnix;
      await fetchFormLeadsPaged(sf.form_id, sf.page_token, desde, async (batch) => {
        scanned += batch.length;
        imported += await ingestMetaLeadsBatch(db, clienteId, batch, sf.form_name);
        for (const lead of batch) {
          const u = leadCreatedUnix(lead);
          if (u && u > maxSeen) maxSeen = u;
        }
      });
      leidos.add(sf.form_id);
      if (Date.now() - startedAt > BUDGET_MS) {
        partial = i < ordenados.length - 1;
        siguienteOffset = partial ? (inicio + i + 1) % scopedForms.length : 0;
        break;
      }
    }

    // Preguntas de los formularios (tipo y opciones), como mucho cada 6 h y
    // solo si sobra presupuesto: es lo que permite activar una pregunta en la
    // pantalla de Leads con sus respuestas reales ya nombradas. Best-effort: un
    // fallo aquí no toca la ingesta de leads.
    const ultimaPreguntas = Number(config.preguntas_sync_at ?? 0);
    let preguntasSyncAt = ultimaPreguntas;
    if (!partial && Date.now() - ultimaPreguntas > PREGUNTAS_CADA_MS) {
      const preguntas: PreguntaPlataforma[] = [];
      for (const sf of scopedForms) {
        if (Date.now() - startedAt > BUDGET_MS) break;
        const qs = await fetchFormQuestions(sf.form_id, sf.page_token);
        if (qs)
          preguntas.push(...preguntasDeFormularioMeta({ id: sf.form_id, name: sf.form_name }, qs));
      }
      if (preguntas.length > 0) {
        await guardarPreguntas(db, clienteId, 'meta', preguntas);
        await sincronizarOpcionesEnCampos(db, clienteId);
      }
      preguntasSyncAt = Date.now();
    }

    // Cursor: solo avanza cuando la pasada terminó completa. Si quedó parcial,
    // se mantiene el cursor previo para re-escanear (la dedup evita duplicar)
    // y NO se marca backfill como completo.
    const nextCursor = partial ? cursor : maxSeen > 0 ? maxSeen : (cursor ?? nowUnix);

    await db
      .from('integrations')
      .update({
        status: 'active',
        last_error: partial
          ? 'Sincronización parcial por límite de tiempo; continúa en la próxima corrida.'
          : null,
        last_sync_at: new Date().toISOString(),
        config: {
          ...config,
          backfill_done: partial ? config.backfill_done === true : true,
          sync_cursor: nextCursor,
          last_imported: imported,
          last_forms_detected: formCount,
          pages: scopedPages,
          scoped_forms: scopedForms,
          scoped_forms_at: formsAt,
          form_offset: siguienteOffset,
          forms_leidos: [...leidos],
          preguntas_sync_at: preguntasSyncAt,
        },
      })
      .eq('id', integration.id);

    return { imported, scanned, forms: formCount, backfill: isBackfill };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Limpiar la caché de formularios para forzar re-descubrimiento (auto-sana
    // tokens de Página vencidos / cambios de formularios) en la próxima corrida.
    await db
      .from('integrations')
      .update({
        status: 'error',
        last_error: msg.slice(0, 500),
        last_sync_at: new Date().toISOString(),
        config: { ...config, scoped_forms: null },
      })
      .eq('id', integration.id);
    return { imported, scanned, forms: formCount, backfill: isBackfill, error: msg };
  }
}
