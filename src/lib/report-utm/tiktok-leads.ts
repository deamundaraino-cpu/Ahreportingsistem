// Las respuestas de TikTok y `config_api` son JSON sin esquema: se leen con
// `any` y se validan campo a campo, como en `ghl-client.ts` y el worker.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SupabaseClient } from '@supabase/supabase-js';
import { aplicarExclusion, cargarReglaExclusion } from './lead-exclusion';
import { excluirDuplicadosLote } from './lead-duplicados';
import { adaptarIds, columnasIdDisponibles, idsPublicitarios, insertarLeads } from './lead-ids';
import { tiktokFetch } from '@/lib/rate-limit';
import { cuentasTikTokDe } from '@/lib/tiktok/cuenta';

/**
 * Núcleo para ingerir leads de **TikTok Lead Generation** (formularios
 * instantáneos, «Instant Forms») en `report_utm.lead_events`.
 *
 * Hasta aquí de TikTok solo entraba la métrica agregada `conversion` del
 * informe: sabíamos CUÁNTOS leads hubo, no QUIÉNES, ni qué respondieron, ni
 * podían cruzarse con una venta. Al escribir en `lead_events` un lead de TikTok
 * hereda gratis lo mismo que Meta Lead Ads y GoHighLevel: `leads.count`, el CPL,
 * los campos y segmentos de lead y las RPC `bi_leads_por_dia` /
 * `bi_respuestas_por_dia`.
 *
 * ── Cómo entrega TikTok los leads ────────────────────────────────
 * No hay un listado paginado en JSON como el `/{form}/leads` de Meta. La
 * Business API v1.3 trabaja con TAREAS de descarga por formulario:
 *
 *   1. `GET  /page/get/?business_type=LEAD_GEN`   → los formularios (page_id).
 *   2. `POST /page/lead/task/ {page_id}`           → crea la tarea (task_id).
 *   3. `POST /page/lead/task/ {page_id, task_id}`  → sondea hasta `SUCCEED`.
 *   4. `GET  /page/lead/task/download/?task_id=`   → CSV (≤10 MB) o ZIP (>10 MB).
 *
 * La descarga trae TODOS los leads del formulario que TikTok conserva (90 días),
 * con horas en UTC+0, y sin filtro por fecha. El cursor (`sync_cursor`, unix del
 * lead más reciente visto) sirve para no reconstruir ni deduplicar miles de filas
 * ya guardadas en cada corrida; la dedup por `(cliente_id, external_id)` hace
 * inocua cualquier relectura.
 *
 * ── Qué columnas trae el CSV ─────────────────────────────────────
 * TikTok no publica un esquema fijo del CSV: las cabeceras de estructura
 * (lead_id, ad_id, campaign_name…) varían de nombre entre cuentas y versiones,
 * y detrás van las preguntas del formulario con su texto. Por eso las cabeceras
 * se normalizan y se buscan por alias (`COLUMNAS_ESTRUCTURA`); todo lo que no es
 * estructura se trata como respuesta y va a `raw_fields`, que es de donde leen
 * los campos de lead (`lead-campos.ts`), igual que con Meta.
 *
 * ── Qué activa la ingesta ────────────────────────────────────────
 * `tiktok_leads: true` en la entrada de la cuenta dentro de
 * `public.clientes.config_api.tiktok_accounts[]` (o en la raíz de `config_api`
 * para la config legacy de una sola cuenta). El estado —cursor, formularios
 * vistos, último error— vive en `report_utm.integrations` con
 * `tipo = 'tiktok_lead_ads'` (TEXT libre, sin CHECK), que el cron crea la primera
 * vez que ve el flag. Ver docs/08-integraciones.md.
 */

const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';

/** Prefijo del `external_id`: imposible colisionar con los leadgen_id de Meta ni con `ghl:`. */
export const TIKTOK_EXTERNAL_PREFIX = 'tiktok:';

/** Valor de `source` y `form_plugin` en `lead_events` (ambas TEXT libre). */
export const TIKTOK_SOURCE = 'tiktok_lead_ads';

/** Valor de `report_utm.integrations.tipo`. */
export const TIKTOK_INTEGRATION_TIPO = 'tiktok_lead_ads';

type ReportUtmDb = ReturnType<SupabaseClient['schema']>;

// ── Tipos ─────────────────────────────────────────────────────────────

export type TikTokCuentaLeads = {
  advertiser_id: string;
  token: string;
  /** `eu` para leads de EEE/Suiza/Reino Unido: TikTok exige la cabecera `x-lead-region`. */
  lead_region?: string | null;
};

export type TikTokFormulario = { page_id: string; name: string; advertiser_id: string };

/** Un lead ya leído del CSV, con la estructura separada de las respuestas. */
export type TikTokLeadRecord = {
  lead_id: string;
  created_time?: string | null;
  ad_id?: string | null;
  ad_name?: string | null;
  adgroup_id?: string | null;
  adgroup_name?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  form_id?: string | null;
  form_name?: string | null;
  advertiser_id?: string | null;
  is_test?: boolean;
  /** Respuestas del formulario: {cabecera original: valor}. */
  campos: Record<string, string>;
};

// ── CSV ───────────────────────────────────────────────────────────────

/**
 * Parser CSV RFC 4180: comillas dobles, comillas escapadas (`""`), saltos de
 * línea dentro de un campo y CRLF. Una respuesta de texto libre con coma o
 * salto de línea es lo normal en un formulario, así que un `split(',')` no vale.
 */
export function parseCsv(texto: string): string[][] {
  const s = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let enComillas = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (enComillas) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          campo += '"';
          i++;
        } else enComillas = false;
      } else campo += ch;
      continue;
    }
    if (ch === '"' && campo === '') enComillas = true;
    else if (ch === ',') {
      fila.push(campo);
      campo = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      fila.push(campo);
      campo = '';
      if (fila.some((c) => c !== '')) filas.push(fila);
      fila = [];
    } else campo += ch;
  }
  fila.push(campo);
  if (fila.some((c) => c !== '')) filas.push(fila);
  return filas;
}

/** «Ad Group Name» → «ad_group_name». */
export function normalizarCabecera(h: string): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Columnas de estructura, por alias normalizados. Lo que no esté aquí es una
 * respuesta del formulario.
 */
export const COLUMNAS_ESTRUCTURA = {
  lead_id: ['lead_id', 'leadid', 'id'],
  created_time: [
    'created_time',
    'create_time',
    'created_at',
    'submit_time',
    'submitted_time',
    'lead_create_time',
    'lead_created_time',
    'time',
  ],
  ad_id: ['ad_id'],
  ad_name: ['ad_name'],
  adgroup_id: ['adgroup_id', 'ad_group_id'],
  adgroup_name: ['adgroup_name', 'ad_group_name'],
  campaign_id: ['campaign_id'],
  campaign_name: ['campaign_name'],
  form_id: ['page_id', 'form_id', 'instant_form_id', 'instant_page_id'],
  form_name: ['page_name', 'form_name', 'instant_form_name', 'instant_page_name'],
  advertiser_id: ['advertiser_id', 'ad_account_id'],
  is_test: ['is_test', 'test_lead', 'is_test_lead'],
} as const;

type ClaveEstructura = keyof typeof COLUMNAS_ESTRUCTURA;

/** Columnas que TikTok añade y no son ni estructura útil ni respuesta. */
const COLUMNAS_IGNORADAS = new Set(['advertiser_name', 'lead_source', 'source', 'region']);

/**
 * Los exports de TikTok a veces protegen los IDs largos de Excel con un
 * apóstrofo, una tabulación o `="…"`. Sin limpiar, `idsPublicitarios` no los
 * reconoce como ID y el lead pierde el cruce exacto.
 */
export function limpiarId(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  const formula = /^="?(.*?)"?$/.exec(s);
  if (formula && s.startsWith('=')) s = formula[1];
  s = s.replace(/^['\t]+/, '').trim();
  return s && s !== '-' && s !== '--' ? s : null;
}

function texto(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== '-' && s !== '--' ? s : null;
}

/** «true»/«1»/«yes»/«sí» → true. */
function verdadero(v: unknown): boolean {
  return /^(true|1|yes|si|sí|y)$/i.test(String(v ?? '').trim());
}

/**
 * CSV de una tarea de descarga → leads. `form` rellena el formulario cuando el
 * CSV no trae su columna (la tarea ya es de un único formulario).
 */
export function leadsDesdeCsv(
  csv: string,
  form?: { page_id: string; name?: string | null; advertiser_id?: string | null }
): TikTokLeadRecord[] {
  const filas = parseCsv(csv);
  if (filas.length < 2) return [];
  const cabeceras = filas[0];
  const norm = cabeceras.map(normalizarCabecera);

  // Índice de cada columna de estructura (primer alias que aparezca).
  const idx: Partial<Record<ClaveEstructura, number>> = {};
  for (const clave of Object.keys(COLUMNAS_ESTRUCTURA) as ClaveEstructura[]) {
    for (const alias of COLUMNAS_ESTRUCTURA[clave]) {
      const i = norm.indexOf(alias);
      if (i >= 0) {
        idx[clave] = i;
        break;
      }
    }
  }
  if (idx.lead_id === undefined) {
    throw new Error(
      `CSV de leads de TikTok sin columna de ID de lead. Cabeceras: ${cabeceras.slice(0, 20).join(' | ')}`
    );
  }
  const deEstructura = new Set(Object.values(idx));

  const out: TikTokLeadRecord[] = [];
  for (const f of filas.slice(1)) {
    const val = (k: ClaveEstructura) => (idx[k] === undefined ? null : (f[idx[k]!] ?? null));
    const leadId = limpiarId(val('lead_id'));
    if (!leadId) continue;
    const campos: Record<string, string> = {};
    cabeceras.forEach((h, i) => {
      if (deEstructura.has(i) || COLUMNAS_IGNORADAS.has(norm[i])) return;
      const nombre = String(h ?? '').trim();
      const v = f[i];
      if (!nombre || v === undefined) return;
      campos[nombre] = String(v).trim();
    });
    out.push({
      lead_id: leadId,
      created_time: texto(val('created_time')),
      ad_id: limpiarId(val('ad_id')),
      ad_name: texto(val('ad_name')),
      adgroup_id: limpiarId(val('adgroup_id')),
      adgroup_name: texto(val('adgroup_name')),
      campaign_id: limpiarId(val('campaign_id')),
      campaign_name: texto(val('campaign_name')),
      form_id: limpiarId(val('form_id')) ?? form?.page_id ?? null,
      form_name: texto(val('form_name')) ?? form?.name ?? null,
      advertiser_id: limpiarId(val('advertiser_id')) ?? form?.advertiser_id ?? null,
      is_test: idx.is_test !== undefined ? verdadero(val('is_test')) : false,
      campos,
    });
  }
  return out;
}

// ── Mapeo a lead_events ───────────────────────────────────────────────

/**
 * Fecha del lead en ISO UTC. TikTok entrega la descarga en UTC+0; una fecha sin
 * zona («2026-09-20 14:03:11») se lee como UTC, nunca como hora local del
 * servidor. También acepta epoch en segundos o milisegundos.
 */
export function parseTikTokTime(v: unknown): string | null {
  const s = texto(v);
  if (!s) return null;
  let ms: number;
  if (/^\d{10}$/.test(s)) ms = Number(s) * 1000;
  else if (/^\d{13}$/.test(s)) ms = Number(s);
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s))
    ms = Date.parse(`${s.replace(' ', 'T')}Z`);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ms = Date.parse(`${s}T00:00:00Z`);
  else ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Unix (segundos) del lead, o null. */
export function tiktokLeadUnix(lead: TikTokLeadRecord): number | null {
  const iso = parseTikTokTime(lead.created_time);
  return iso ? Math.floor(Date.parse(iso) / 1000) : null;
}

/**
 * UTMs sintetizadas desde la estructura de campaña, como Meta Lead Ads: un
 * formulario instantáneo no navega a ninguna landing, así que no hay UTMs
 * reales. `utm_id = campaign_id` es lo que hace cruzar el lead con el gasto.
 */
export function synthesizeTikTokUtms(lead: TikTokLeadRecord) {
  return {
    utm_source: 'tiktok',
    utm_medium: 'paid_social',
    utm_campaign: lead.campaign_name ?? null,
    utm_content: lead.ad_name ?? null,
    utm_term: lead.adgroup_name ?? null,
    utm_id: lead.campaign_id ?? null,
    click_id: null as string | null,
  };
}

/** Datos de contacto desde las respuestas. Las cabeceras de TikTok varían de idioma. */
export function normalizeTikTokFields(campos: Record<string, string>): {
  lead_name: string | null;
  lead_email: string | null;
  lead_phone: string | null;
  raw_fields: Record<string, string>;
} {
  const porClave: Record<string, string> = {};
  for (const [k, v] of Object.entries(campos)) {
    const n = normalizarCabecera(k);
    if (v && !(n in porClave)) porClave[n] = v;
  }
  const pick = (...claves: string[]): string | null => {
    for (const c of claves) if (porClave[c]) return porClave[c];
    return null;
  };
  let nombre = pick('name', 'full_name', 'nombre', 'nombre_completo', 'nombre_y_apellido');
  if (!nombre) {
    const partes = [pick('first_name', 'nombre'), pick('last_name', 'apellido', 'apellidos')];
    nombre = partes.filter(Boolean).join(' ').trim() || null;
  }
  return {
    lead_name: nombre,
    lead_email: pick('email', 'e_mail', 'correo', 'correo_electronico', 'email_address'),
    lead_phone: pick(
      'phone_number',
      'phone',
      'telefono',
      'numero_de_telefono',
      'celular',
      'whatsapp',
      'whatsapp_number'
    ),
    raw_fields: { ...campos },
  };
}

/**
 * Fila de `lead_events` de un lead de TikTok. Pura (la prueban las
 * comprobaciones): la regla de exclusión y la disponibilidad de las columnas de
 * ID se aplican al insertar, igual que en `meta-leads.ts`.
 */
export function buildTikTokLeadRow(
  clienteId: string,
  lead: TikTokLeadRecord
): Record<string, unknown> {
  const utm = synthesizeTikTokUtms(lead);
  const { lead_name, lead_email, lead_phone, raw_fields } = normalizeTikTokFields(lead.campos);
  // La hora del lead, nunca `now()`: `bi_leads_por_dia` agrupa por día en
  // America/Bogota y la hora de ingesta movería el lead de día.
  const createdAt = parseTikTokTime(lead.created_time);
  const hasSignal = Boolean(utm.utm_source || utm.utm_campaign);

  const row: Record<string, unknown> = {
    cliente_id: clienteId,
    external_id: `${TIKTOK_EXTERNAL_PREFIX}${lead.lead_id}`,
    form_name: lead.form_name ?? null,
    form_id: lead.form_id ?? null,
    form_plugin: TIKTOK_SOURCE,
    lead_name,
    lead_email,
    lead_phone,
    utm_source: utm.utm_source,
    utm_medium: utm.utm_medium,
    utm_campaign: utm.utm_campaign,
    utm_content: utm.utm_content,
    utm_term: utm.utm_term,
    utm_id: utm.utm_id,
    // TikTok manda los tres IDs en cada lead: campaña, conjunto y anuncio.
    ...idsPublicitarios(lead.campaign_id, lead.adgroup_id, lead.ad_id),
    click_id: utm.click_id,
    raw_fields,
    source: TIKTOK_SOURCE,
    attribution_method: hasSignal ? 'utm_only' : 'none',
    attribution_resolved_at: new Date().toISOString(),
    custom_data: {
      tiktok_lead_id: lead.lead_id,
      advertiser_id: lead.advertiser_id ?? null,
    },
  };
  if (createdAt) row.created_at = createdAt;
  return row;
}

// ── API de TikTok ─────────────────────────────────────────────────────

type TikTokJson = { code?: number; message?: string; data?: any; request_id?: string };

function cabeceras(cuenta: TikTokCuentaLeads, json = false): Record<string, string> {
  const h: Record<string, string> = { 'Access-Token': cuenta.token };
  if (json) h['Content-Type'] = 'application/json';
  if (cuenta.lead_region) h['x-lead-region'] = String(cuenta.lead_region);
  return h;
}

/**
 * Error legible de TikTok. Los códigos de permisos son los que más se van a ver
 * al activar la ingesta en una cuenta nueva, así que se explican.
 */
export function errorTikTok(contexto: string, json: TikTokJson | null | undefined): Error {
  const code = json?.code;
  const msg = json?.message ?? JSON.stringify(json ?? {});
  const pista =
    code === 40001 || code === 40002 || /permission|scope|authoriz/i.test(msg)
      ? ' — el token no tiene permiso de «Lead management»/«Instant Page»: reconectá TikTok concediendo ese alcance, con un usuario Admin del anunciante.'
      : code === 40105 || /access.?token/i.test(msg)
        ? ' — token de TikTok inválido o vencido: reconectá TikTok.'
        : '';
  return new Error(`TikTok ${contexto}: [${code ?? 'sin código'}] ${msg}${pista}`);
}

/** Formularios instantáneos (Instant Forms) del anunciante. */
export async function listarFormulariosTikTok(
  cuenta: TikTokCuentaLeads
): Promise<TikTokFormulario[]> {
  const out: TikTokFormulario[] = [];
  let page = 1;
  let totalPage = 1;
  do {
    const url = new URL(`${TIKTOK_API}/page/get/`);
    url.searchParams.set('advertiser_id', cuenta.advertiser_id);
    url.searchParams.set('business_type', 'LEAD_GEN');
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', '100');
    const res = await tiktokFetch(url.toString(), { headers: cabeceras(cuenta) });
    const json = (await res.json()) as TikTokJson | null;
    if (json?.code !== 0) throw errorTikTok('listar formularios (/page/get/)', json);
    for (const p of json?.data?.list ?? []) {
      const id = limpiarId(p?.page_id ?? p?.id);
      if (!id) continue;
      out.push({
        page_id: id,
        name: String(p?.title ?? p?.page_name ?? p?.name ?? id),
        advertiser_id: cuenta.advertiser_id,
      });
    }
    totalPage = Number(json?.data?.page_info?.total_page) || 1;
    page++;
  } while (page <= totalPage && page <= 50);
  return out;
}

type TareaLeads = { task_id: string; status: string; file_type?: string | null };

/** Crea (sin `taskId`) o sondea (con `taskId`) la tarea de descarga de un formulario. */
async function tareaLeads(
  cuenta: TikTokCuentaLeads,
  pageId: string,
  taskId?: string
): Promise<TareaLeads> {
  const body: Record<string, string> = { advertiser_id: cuenta.advertiser_id, page_id: pageId };
  if (taskId) body.task_id = taskId;
  const res = await tiktokFetch(`${TIKTOK_API}/page/lead/task/`, {
    method: 'POST',
    headers: cabeceras(cuenta, true),
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as TikTokJson | null;
  if (json?.code !== 0) {
    throw errorTikTok(`tarea de leads del formulario ${pageId} (/page/lead/task/)`, json);
  }
  return {
    task_id: String(json?.data?.task_id ?? taskId ?? ''),
    status: String(json?.data?.status ?? '').toUpperCase(),
    file_type: json?.data?.file_type ?? null,
  };
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * CSV con todos los leads de un formulario. Crea la tarea, la sondea hasta
 * `SUCCEED` sin pasar de `plazoMs` y descarga. `null` si la tarea no terminó a
 * tiempo (se reintenta en la próxima corrida, sin perder nada).
 */
export async function descargarLeadsFormulario(
  cuenta: TikTokCuentaLeads,
  pageId: string,
  plazoMs: number
): Promise<string | null> {
  const limite = Date.now() + Math.max(0, plazoMs);
  let tarea = await tareaLeads(cuenta, pageId);
  if (!tarea.task_id) throw new Error(`TikTok no devolvió task_id para el formulario ${pageId}`);
  let espera = 1_000;
  while (tarea.status !== 'SUCCEED') {
    if (tarea.status === 'FAILED') {
      throw new Error(`TikTok: la tarea de descarga del formulario ${pageId} falló (FAILED)`);
    }
    if (Date.now() + espera > limite) return null;
    await esperar(espera);
    espera = Math.min(espera * 2, 4_000);
    tarea = await tareaLeads(cuenta, pageId, tarea.task_id);
  }
  if (String(tarea.file_type ?? 'csv').toLowerCase() === 'zip') {
    // TikTok comprime cuando el CSV pasa de 10 MB. Descomprimir exige una
    // dependencia que el proyecto no declara; con la retención de 90 días de
    // TikTok, un formulario de ese tamaño son decenas de miles de leads.
    throw new Error(
      `TikTok entregó los leads del formulario ${pageId} en ZIP (>10 MB); este importador solo lee CSV. Descargalos desde el Leads Center o pedí soporte de ZIP.`
    );
  }

  const url = new URL(`${TIKTOK_API}/page/lead/task/download/`);
  url.searchParams.set('advertiser_id', cuenta.advertiser_id);
  url.searchParams.set('task_id', tarea.task_id);
  const res = await tiktokFetch(url.toString(), { headers: cabeceras(cuenta) });
  const cuerpo = await res.text();
  // Si algo falla, TikTok responde JSON en vez de CSV.
  const parsed = res.parsed as TikTokJson | null;
  if (parsed && typeof parsed === 'object' && 'code' in parsed) {
    if (parsed.code !== 0) throw errorTikTok(`descarga de leads del formulario ${pageId}`, parsed);
    return '';
  }
  if (!res.ok)
    throw new Error(`TikTok descarga de leads del formulario ${pageId}: HTTP ${res.status}`);
  if (cuerpo.startsWith('PK')) {
    throw new Error(`TikTok entregó un ZIP para el formulario ${pageId}; solo se admite CSV.`);
  }
  return cuerpo;
}

// ── Persistencia ──────────────────────────────────────────────────────

/**
 * Inserta un LOTE de leads de TikTok con la misma estrategia que Meta:
 * regla de exclusión, dedup contra la base en una sola consulta, duplicados de
 * contacto, un INSERT y, si falla, fila por fila tolerando 23505.
 */
export async function ingestTikTokLeadsBatch(
  db: ReportUtmDb,
  clienteId: string,
  leads: TikTokLeadRecord[]
): Promise<number> {
  if (leads.length === 0) return 0;
  const regla = await cargarReglaExclusion(db, clienteId);
  const conIds = await columnasIdDisponibles(db);
  const ahora = new Date().toISOString();

  const byId = new Map<string, Record<string, unknown>>();
  for (const lead of leads) {
    if (!lead.lead_id || lead.is_test) continue;
    byId.set(
      `${TIKTOK_EXTERNAL_PREFIX}${lead.lead_id}`,
      adaptarIds(aplicarExclusion(buildTikTokLeadRow(clienteId, lead), regla, ahora), conIds)
    );
  }
  if (byId.size === 0) return 0;

  const ids = Array.from(byId.keys());
  const { data: existing } = await db
    .from('lead_events')
    .select('external_id')
    .eq('cliente_id', clienteId)
    .in('external_id', ids);
  const existentes = new Set((existing ?? []).map((e: { external_id: string }) => e.external_id));
  const toInsert = await excluirDuplicadosLote(
    db,
    clienteId,
    Array.from(byId.values()).filter((r) => !existentes.has(r.external_id as string)),
    regla,
    ahora
  );
  if (toInsert.length === 0) return 0;

  const { error } = await insertarLeads(db, toInsert);
  if (!error) return toInsert.length;

  let n = 0;
  for (const r of toInsert) {
    const { error: e } = await insertarLeads(db, r);
    if (!e) n++;
    else if ((e as { code?: string }).code !== '23505') {
      console.error('[tiktok-leads] batch fallback insert error', e.message);
    }
  }
  return n;
}

// ── Activación ────────────────────────────────────────────────────────

/**
 * Cuentas del cliente con la ingesta de leads activada. `tiktok_leads: true` en
 * la cuenta, o en la raíz de `config_api` (config legacy o «todas las cuentas»).
 */
export function cuentasConLeadsTikTok(
  config: Record<string, any> | null | undefined
): TikTokCuentaLeads[] {
  const todas = config?.tiktok_leads === true;
  return cuentasTikTokDe(config)
    .filter((c) => todas || c.raw?.tiktok_leads === true)
    .map((c) => ({
      advertiser_id: c.advertiser_id,
      token: c.token,
      lead_region: texto(c.raw?.lead_region ?? config?.tiktok_lead_region),
    }));
}

export type TikTokIntegrationRow = {
  id: string;
  cliente_id: string;
  config: Record<string, unknown> | null;
  status?: string | null;
  last_sync_at?: string | null;
};

export type TikTokLeadsObjetivo = {
  integration: TikTokIntegrationRow;
  cuentas: TikTokCuentaLeads[];
};

/**
 * Qué clientes sincronizar: los de `public.clientes` con alguna cuenta marcada,
 * resueltos a su cliente de `report_utm` por `public_cliente_id`. La integración
 * se crea la primera vez (sin pisar una existente); si alguien la pone en
 * `inactive`, el cliente se salta aunque el flag siga puesto.
 */
export async function objetivosTikTokLeads(
  supabase: SupabaseClient,
  opts?: { reportClienteId?: string | null }
): Promise<{ objetivos: TikTokLeadsObjetivo[]; error?: string }> {
  const { data: publicos, error } = await supabase.from('clientes').select('id, config_api');
  if (error) return { objetivos: [], error: error.message };

  const conFlag = ((publicos ?? []) as Array<{ id: string; config_api: any }>)
    .map((c) => ({ id: c.id, cuentas: cuentasConLeadsTikTok(c.config_api) }))
    .filter((c) => c.cuentas.length > 0);
  if (conFlag.length === 0) return { objetivos: [] };

  const db = supabase.schema('report_utm');
  let q = db
    .from('clientes')
    .select('id, public_cliente_id')
    .in(
      'public_cliente_id',
      conFlag.map((c) => c.id)
    );
  if (opts?.reportClienteId) q = q.eq('id', opts.reportClienteId);
  const { data: rc, error: rcError } = await q;
  if (rcError) return { objetivos: [], error: rcError.message };

  const cuentasPorPublico = new Map(conFlag.map((c) => [c.id, c.cuentas]));
  const objetivos: TikTokLeadsObjetivo[] = [];
  for (const r of (rc ?? []) as Array<{ id: string; public_cliente_id: string }>) {
    const cuentas = cuentasPorPublico.get(r.public_cliente_id) ?? [];
    if (cuentas.length === 0) continue;
    // Crear si falta; `ignoreDuplicates` no toca una fila existente (ni su
    // cursor ni un `inactive` puesto a mano).
    await db.from('integrations').upsert(
      {
        cliente_id: r.id,
        tipo: TIKTOK_INTEGRATION_TIPO,
        status: 'active',
        config: { backfill_done: false },
      },
      { onConflict: 'cliente_id,tipo', ignoreDuplicates: true }
    );
    const { data: integ } = await db
      .from('integrations')
      .select('id, cliente_id, config, status, last_sync_at')
      .eq('cliente_id', r.id)
      .eq('tipo', TIKTOK_INTEGRATION_TIPO)
      .maybeSingle();
    if (!integ || integ.status === 'inactive') continue;
    objetivos.push({ integration: integ as TikTokIntegrationRow, cuentas });
  }
  // La más atrasada primero: con el presupuesto agotado, los saltados rotan.
  objetivos.sort((a, b) =>
    String(a.integration.last_sync_at ?? '').localeCompare(String(b.integration.last_sync_at ?? ''))
  );
  return { objetivos };
}

// ── Sincronización de un cliente ──────────────────────────────────────

/** Cada cuánto se vuelve a listar los formularios de las cuentas. */
const REDESCUBRIR_FORMULARIOS_MS = 6 * 3600_000;
/**
 * Margen hacia atrás sobre el cursor: un lead puede aparecer en la descarga
 * algo después de su hora de creación. La dedup hace inocua la relectura.
 */
const MARGEN_CURSOR_S = 2 * 86_400;
const LOTE = 200;

export type TikTokLeadsSyncSummary = {
  imported: number;
  scanned: number;
  forms: number;
  backfill: boolean;
  error?: string;
};

export async function syncTikTokLeadsForCliente(
  supabase: SupabaseClient,
  integration: TikTokIntegrationRow,
  cuentas: TikTokCuentaLeads[],
  opts?: { budgetMs?: number }
): Promise<TikTokLeadsSyncSummary> {
  const db = supabase.schema('report_utm');
  const clienteId = integration.cliente_id;
  const config = (integration.config ?? {}) as Record<string, unknown>;
  const isBackfill = config.backfill_done !== true;
  const cursor = typeof config.sync_cursor === 'number' ? config.sync_cursor : null;
  const startedAt = Date.now();
  const BUDGET_MS = opts?.budgetMs ?? (Number(process.env.TIKTOK_LEADS_BUDGET_MS) || 40_000);

  let imported = 0;
  let scanned = 0;
  let maxSeen = cursor ?? 0;
  let formularios: TikTokFormulario[] = [];

  const guardar = async (patch: Record<string, unknown>) => {
    await db.from('integrations').update(patch).eq('id', integration.id);
  };

  try {
    // 1) Formularios: caché de 6 h; en el backfill siempre se redescubre.
    const cache = Array.isArray(config.forms) ? (config.forms as TikTokFormulario[]) : null;
    const cacheAt = Number(config.forms_at ?? 0);
    const cuentasIds = new Set(cuentas.map((c) => c.advertiser_id));
    let formsAt = cacheAt;
    if (!isBackfill && cache && Date.now() - cacheAt < REDESCUBRIR_FORMULARIOS_MS) {
      formularios = cache.filter((f) => cuentasIds.has(f.advertiser_id));
    } else {
      const errores: string[] = [];
      for (const cuenta of cuentas) {
        try {
          formularios.push(...(await listarFormulariosTikTok(cuenta)));
        } catch (e) {
          errores.push(e instanceof Error ? e.message : String(e));
        }
      }
      if (formularios.length === 0 && errores.length > 0) {
        if (cache && cache.length > 0) {
          // Renovación fallida con caché previa: se sigue con ella.
          formularios = cache.filter((f) => cuentasIds.has(f.advertiser_id));
        } else {
          throw new Error(errores.join(' · '));
        }
      } else {
        formsAt = Date.now();
      }
    }

    // 2) Descargar y cargar cada formulario. Se empieza donde cortó la pasada
    //    anterior para que los últimos no queden siempre fuera del presupuesto.
    const leidos = new Set<string>(
      Array.isArray(config.forms_leidos) ? (config.forms_leidos as string[]) : []
    );
    const offsetPrevio = Number(config.form_offset ?? 0);
    const inicio = offsetPrevio > 0 && offsetPrevio < formularios.length ? offsetPrevio : 0;
    const ordenados = [...formularios.slice(inicio), ...formularios.slice(0, inicio)];
    const porCuenta = new Map(cuentas.map((c) => [c.advertiser_id, c]));
    const desdeCursor = cursor !== null ? cursor - MARGEN_CURSOR_S : null;

    let partial = false;
    let siguienteOffset = 0;
    const erroresForm: string[] = [];
    for (let i = 0; i < ordenados.length; i++) {
      const f = ordenados[i];
      const restante = BUDGET_MS - (Date.now() - startedAt);
      if (restante < 5_000) {
        partial = true;
        siguienteOffset = (inicio + i) % formularios.length;
        break;
      }
      const cuenta = porCuenta.get(f.advertiser_id);
      if (!cuenta) continue;
      let csv: string | null;
      try {
        csv = await descargarLeadsFormulario(cuenta, f.page_id, restante - 3_000);
      } catch (e) {
        // Un formulario roto (ZIP, permisos de ese formulario) no para al resto.
        erroresForm.push(e instanceof Error ? e.message : String(e));
        continue;
      }
      if (csv === null) {
        partial = true;
        siguienteOffset = (inicio + i) % formularios.length;
        break;
      }
      const leads = csv ? leadsDesdeCsv(csv, f) : [];
      // Un formulario nuevo (o el backfill) se lee entero; el resto, desde el cursor.
      const completo = isBackfill || !leidos.has(f.page_id) || desdeCursor === null;
      const aCargar = completo
        ? leads
        : leads.filter((l) => {
            const u = tiktokLeadUnix(l);
            return u === null || u >= desdeCursor;
          });
      scanned += leads.length;
      for (let j = 0; j < aCargar.length; j += LOTE) {
        imported += await ingestTikTokLeadsBatch(db, clienteId, aCargar.slice(j, j + LOTE));
      }
      for (const l of leads) {
        const u = tiktokLeadUnix(l);
        if (u && u > maxSeen) maxSeen = u;
      }
      leidos.add(f.page_id);
    }

    // 3) Cursor: solo avanza con la pasada completa (igual que Meta).
    const nowUnix = Math.floor(Date.now() / 1000);
    const nextCursor = partial ? cursor : maxSeen > 0 ? maxSeen : (cursor ?? nowUnix);
    const lastError = erroresForm.length
      ? erroresForm.join(' · ').slice(0, 500)
      : partial
        ? 'Sincronización parcial por límite de tiempo; continúa en la próxima corrida.'
        : null;
    await guardar({
      status: erroresForm.length > 0 && imported === 0 && leidos.size === 0 ? 'error' : 'active',
      last_error: lastError,
      last_sync_at: new Date().toISOString(),
      config: {
        ...config,
        backfill_done: partial ? config.backfill_done === true : true,
        sync_cursor: nextCursor,
        last_imported: imported,
        last_forms_detected: formularios.length,
        forms: formularios,
        forms_at: formsAt,
        forms_leidos: Array.from(leidos),
        form_offset: partial ? siguienteOffset : 0,
      },
    });
    return {
      imported,
      scanned,
      forms: formularios.length,
      backfill: isBackfill,
      ...(erroresForm.length ? { error: erroresForm.join(' · ') } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await guardar({
      status: 'error',
      last_error: msg.slice(0, 500),
      last_sync_at: new Date().toISOString(),
      // Forzar el redescubrimiento de formularios en la próxima corrida.
      config: { ...config, forms_at: 0 },
    });
    return { imported, scanned, forms: formularios.length, backfill: isBackfill, error: msg };
  }
}
