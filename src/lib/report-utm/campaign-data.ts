// ── Diagnóstico del cruce UTM ↔ campañas ──────────────────────────────
//
// Alimenta /report-utm/cruce-campanas: qué UTM de los leads cruzan con una
// campaña real, por qué método, cuáles no cruzan y qué campaña se les parece.
//
// El CRUCE en sí (índice de campañas, cascada de matching, overrides) vive en
// `campaign-resolver.ts`, que también usa el motor del BI. Aquí queda solo lo
// específico del diagnóstico: similitud por Dice, detección de UTM inválidos y
// los agregados que consume la UI.
//
// Este módulo tuvo además un motor de consulta propio (`runCampaignQuery`) para
// la dimensión "Campaña (cruzada)". Se eliminó: solo sabía emitir ~20 de las 72
// métricas del catálogo e ignoraba por completo los campos calculados. Hoy la
// dimensión "Campaña" del motor principal (`bi-query.ts`) hace el mismo cruce
// con todas las métricas.

import { createAdminClient } from '@/utils/supabase/server';
import type { AdvancedFilter } from './bi-metadata';
import { normLabel, round2 } from './bi-metadata';
import { fetchAllRows } from './bi-query';
import {
  buildResolver,
  esIdMeta,
  loadCampaignIndex,
  loadOverrides,
  matchToCampaign,
  resolvePublicClienteId,
} from './campaign-resolver';
import type {
  CampaignIndex,
  CampaignResolver,
  MatchMethod,
  NivelEntidad,
  Override,
} from './campaign-resolver';
import { colombiaRangeBounds } from '@/lib/colombia-date';
import { columnaExcluidoDisponible } from './lead-exclusion';
import { COLUMNAS_ID, columnasIdDisponibles, idPublicitario } from './lead-ids';

export type { MatchMethod } from './campaign-resolver';

// Coeficiente de Sørensen-Dice sobre bigramas de caracteres → [0,1].
// Sin dependencias; tolera tokens reordenados/parciales razonablemente.
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const ba = bigrams(a);
  const bb = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const c of ba.values()) total += c;
  for (const [bg, c] of bb) {
    total += c;
    const av = ba.get(bg);
    if (av) inter += Math.min(av, c);
  }
  return total === 0 ? 0 : (2 * inter) / total;
}

export interface CampaignCrossParams {
  cliente_id: string; // report_utm cliente id (requerido)
  date_from?: string;
  date_to?: string;
  filters?: Record<string, string>;
  advancedFilter?: AdvancedFilter;
  limit?: number;
}

/** Lista las campañas disponibles (para poblar selectores de mapeo). */
export async function listCampaigns(
  clienteId: string,
  dateFrom?: string,
  dateTo?: string
): Promise<
  { campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[]
> {
  const from = dateFrom ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const to = dateTo ?? new Date().toISOString().slice(0, 10);

  const publicClienteId = await resolvePublicClienteId(clienteId);
  if (!publicClienteId) return [];

  const idx = await loadCampaignIndex(publicClienteId, from, to);
  return idx ? campaignsFromIndex(idx) : [];
}

// Umbral mínimo de similitud para ofrecer una sugerencia (no autoaplicar).
const SUGGEST_THRESHOLD = 0.45;

export type InvalidUtmReason = 'macro_no_renderizado' | 'sin_utm';

// Valores vacíos/centinela que no representan ninguna campaña.
const EMPTY_UTM = new Set([
  '',
  '(vacío)',
  '(vacio)',
  '(empty)',
  '(none)',
  '(not set)',
  'not set',
  'null',
  'undefined',
  'n/a',
  'na',
]);

/**
 * Detecta UTMs que NO son atribuibles a una campaña concreta:
 *  - macros sin renderizar de Meta/TikTok: {{campaign.name}}, {{ad.name}},
 *    {campaign.name}, __CAMPAIGN_NAME__, %campaign_name%…
 *  - valores vacíos o centinela.
 * Estas no deben ofrecerse para mapeo manual (un macro abarca muchas campañas).
 */
function classifyInvalidUtm(value: string): InvalidUtmReason | null {
  const v = value.trim();
  if (EMPTY_UTM.has(v.toLowerCase())) return 'sin_utm';
  // Macros sin sustituir en cualquiera de las sintaxis habituales.
  if (/\{\{.*?\}\}|\{[a-z0-9_.]+\}|__[A-Z0-9_]+__|%[a-z0-9_]+%/i.test(v))
    return 'macro_no_renderizado';
  return null;
}

interface CrossContext {
  idx: CampaignIndex;
  overrides: Override[];
  leads: Record<string, unknown>[];
  /** Leads del rango marcados como excluidos. `null` sin la migración 079. */
  excluidos: number | null;
  /** ¿Están las columnas de ID de la migración 082? */
  conIds: boolean;
}

/** Lo que el diagnóstico lee de cada lead: los UTM de la cascada y su fuente. */
const COLUMNAS_LEAD_CRUCE = [
  'id',
  'utm_id',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'utm_source',
];

/** Resuelve cliente público, carga índice+overrides y los leads del rango. */
async function loadCrossContext(params: CampaignCrossParams): Promise<CrossContext | null> {
  const supabase = await createAdminClient();
  const dateFrom =
    params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const dateTo = params.date_to ?? new Date().toISOString().slice(0, 10);

  const publicClienteId = await resolvePublicClienteId(params.cliente_id);
  if (!publicClienteId) return null;

  const [idx, overrides] = await Promise.all([
    loadCampaignIndex(publicClienteId, dateFrom, dateTo),
    loadOverrides(params.cliente_id),
  ]);
  // Sin índice completo el diagnóstico mentiría: mostraría como "no cruza"
  // justo lo que no se pudo leer. Mejor no mostrar nada.
  if (!idx) return null;

  // Los excluidos no entran en el diagnóstico: el % de cruce se mide sobre los
  // leads que CUENTAN. Si se midiera sobre todos, excluir los que no cruzan
  // haría subir el porcentaje sin que nada hubiera mejorado.
  const filtrarExcluidos = await columnaExcluidoDisponible(supabase);
  const conIds = await columnasIdDisponibles(supabase);
  const cols = conIds ? [...COLUMNAS_LEAD_CRUCE, ...COLUMNAS_ID] : COLUMNAS_LEAD_CRUCE;
  const bounds = colombiaRangeBounds(dateFrom, dateTo);
  const leads = (await fetchAllRows(() => {
    let q = supabase
      .schema('report_utm')
      .from('lead_events')
      .select(cols.join(','))
      .gte('created_at', bounds.gte)
      .lt('created_at', bounds.lt)
      .eq('cliente_id', params.cliente_id);
    if (filtrarExcluidos) q = q.eq('excluido', false);
    return q;
  })) as Record<string, unknown>[];

  let excluidos: number | null = null;
  if (filtrarExcluidos) {
    const { count } = await supabase
      .schema('report_utm')
      .from('lead_events')
      .select('id', { count: 'exact', head: true })
      .eq('cliente_id', params.cliente_id)
      .eq('excluido', true)
      .gte('created_at', bounds.gte)
      .lt('created_at', bounds.lt);
    excluidos = count ?? 0;
  }

  return { idx, overrides, leads, excluidos, conIds };
}

export interface CampaignSuggestion {
  campaign_id: string | null;
  campaign_name: string;
  platform: 'meta' | 'tiktok';
  confidence: number; // 0-100
}

export interface UnmatchedRow {
  field: string;
  value: string;
  count: number;
  suggestion: CampaignSuggestion | null;
}

/** Mejor campaña candidata para un valor UTM por similitud de nombre. */
function bestSuggestion(value: string, idx: CampaignIndex): CampaignSuggestion | null {
  const v = normLabel(value);
  if (!v) return null;
  let best: CampaignSuggestion | null = null;
  let bestScore = 0;
  for (const c of idx.campaigns.values()) {
    const score = diceCoefficient(v, normLabel(c.name));
    if (score > bestScore) {
      bestScore = score;
      best = {
        campaign_id: c.campaign_id,
        campaign_name: c.name,
        platform: c.platform,
        confidence: Math.round(score * 100),
      };
    }
  }
  return best && bestScore >= SUGGEST_THRESHOLD ? best : null;
}

export interface MatchCoverage {
  total: number;
  methods: Record<MatchMethod, number>;
}

export interface InvalidUtmRow {
  field: string;
  value: string;
  count: number;
  reason: InvalidUtmReason;
}

/**
 * (Puro) valores UTM de leads que NO cruzaron exacto, separados en:
 *  - `suggestions`: valores reales mapeables (con mejor candidato por similitud)
 *  - `invalid`: macros sin renderizar / vacíos (no mapeables, problema de datos)
 */
function computeUnmatched(ctx: CrossContext): {
  suggestions: UnmatchedRow[];
  invalid: InvalidUtmRow[];
} {
  const { idx, overrides, leads } = ctx;
  const counts = new Map<string, number>();
  for (const l of leads) {
    const m = matchToCampaign(l, idx, overrides);
    if (m.key) continue;
    const v =
      (l.utm_campaign as string) || (l.utm_id as string) || (l.utm_source as string) || '(vacío)';
    const field = l.utm_campaign ? 'utm_campaign' : l.utm_id ? 'utm_id' : 'utm_source';
    const k = `${field}||${v}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const suggestions: UnmatchedRow[] = [];
  const invalid: InvalidUtmRow[] = [];
  for (const [k, count] of counts) {
    const field = k.split('||')[0];
    const value = k.slice(field.length + 2);
    const bad = classifyInvalidUtm(value);
    if (bad) invalid.push({ field, value, count, reason: bad });
    else suggestions.push({ field, value, count, suggestion: bestSuggestion(value, idx) });
  }
  suggestions.sort((a, b) => b.count - a.count);
  invalid.sort((a, b) => b.count - a.count);
  return { suggestions: suggestions.slice(0, 200), invalid: invalid.slice(0, 50) };
}

export interface UtmCampaignRow {
  value: string; // valor de utm_campaign (o '(vacío)')
  count: number; // leads con ese utm_campaign
  matched_campaign: string | null; // campaña a la que cruzó (dominante)
  distinct_campaigns: number; // nº de campañas distintas a las que cruzó
  method: MatchMethod; // método de match dominante
  invalid_reason: InvalidUtmReason | null;
  suggestion: CampaignSuggestion | null; // solo si no cruzó y es mapeable
}

const ZERO_METHODS = (): Record<MatchMethod, number> => ({
  override: 0,
  ad_id: 0,
  adset_id: 0,
  campaign_id: 0,
  utm_id_campaign: 0,
  utm_id_ad: 0,
  utm_id_adset: 0,
  campaign_id_field: 0,
  content_ad_id: 0,
  term_adset_id: 0,
  name: 0,
  content_ad: 0,
  term_adset: 0,
  ambiguous: 0,
  none: 0,
});

function topEntry<T extends string>(m: Record<T, number> | Map<T, number>): T | null {
  const entries = m instanceof Map ? Array.from(m.entries()) : (Object.entries(m) as [T, number][]);
  let best: T | null = null;
  let bestC = -1;
  for (const [k, c] of entries) {
    if (c > bestC) {
      bestC = c;
      best = k;
    }
  }
  return best;
}

/**
 * (Puro) desglose de TODOS los valores de utm_campaign de los leads con su estado
 * de cruce (a qué campaña, por qué método) — para que el trafficker confirme que
 * cada UTM de los leads se visualiza y, si no cruzó, lo pueda mapear.
 */
function computeUtmBreakdown(ctx: CrossContext): UtmCampaignRow[] {
  const { idx, overrides, leads } = ctx;
  type G = { count: number; methods: Record<MatchMethod, number>; campaigns: Map<string, number> };
  const groups = new Map<string, G>();
  for (const l of leads) {
    const value = ((l.utm_campaign as string) || '').trim() || '(vacío)';
    const m = matchToCampaign(l, idx, overrides);
    const campName = m.key ? (idx.campaigns.get(m.key)?.name ?? null) : null;
    let g = groups.get(value);
    if (!g) {
      g = { count: 0, methods: ZERO_METHODS(), campaigns: new Map() };
      groups.set(value, g);
    }
    g.count += 1;
    g.methods[m.method] += 1;
    if (campName) g.campaigns.set(campName, (g.campaigns.get(campName) ?? 0) + 1);
  }
  return Array.from(groups.entries())
    .map(([value, g]) => {
      // Un lead ambiguo no cruzó: no se sabe a qué campaña pertenece.
      const crossed = g.count - g.methods.none - g.methods.ambiguous;
      const matched_campaign = crossed > 0 ? topEntry(g.campaigns) : null;
      // Método dominante; si cruzó, excluye los que no cruzan para no mostrar un
      // badge contradictorio.
      const methodPool = crossed > 0 ? { ...g.methods, none: 0, ambiguous: 0 } : g.methods;
      const method = (topEntry(methodPool) ?? 'none') as MatchMethod;
      const invalid_reason = crossed === 0 ? classifyInvalidUtm(value) : null;
      const suggestion = crossed === 0 && !invalid_reason ? bestSuggestion(value, idx) : null;
      return {
        value,
        count: g.count,
        matched_campaign,
        distinct_campaigns: g.campaigns.size,
        method,
        invalid_reason,
        suggestion,
      };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 500);
}

/** (Puro) cobertura del cruce: total de leads y conteo por método de match. */
function computeCoverage(ctx: CrossContext): MatchCoverage {
  const methods = ZERO_METHODS();
  for (const l of ctx.leads) {
    const m = matchToCampaign(l, ctx.idx, ctx.overrides);
    methods[m.method] += 1;
  }
  return { total: ctx.leads.length, methods };
}

/**
 * Cobertura del cruce por el lado del GASTO.
 *
 * `MatchCoverage` cuenta leads: dice qué proporción de los contactos encontró su
 * campaña. Pero la pregunta que se hace el trafficker es la de al lado —
 * «¿cuánto de lo que invertí tiene leads atribuidos?»— y esa no se calculaba en
 * ninguna parte.
 *
 * Son dos números distintos y los dos importan:
 *
 *  - 100% de leads cruzados y 40% de gasto cruzado ⇒ los leads están bien
 *    etiquetados, pero el 60% de la inversión no produjo ni un contacto
 *    (campañas de tráfico, alcance… o dinero tirado).
 *  - 100% de gasto cruzado y 40% de leads cruzados ⇒ hay leads con UTM roto.
 *
 * `orphans` son las campañas con gasto a las que NINGÚN lead resolvió: es la
 * mitad de la historia que hoy se pierde dentro de la fila «(sin campaña)».
 */
export interface SpendCoverage {
  /** Gasto de campañas con al menos un lead cruzado. */
  matched: number;
  /** Gasto total del período según el índice. */
  total: number;
  /** 0-100, o `null` si no hubo gasto (no es 0%: es que no aplica). */
  pct: number | null;
  /** Campañas con gasto y sin ningún lead, de mayor a menor. */
  orphans: { name: string; platform: 'meta' | 'tiktok'; spend: number }[];
}

function computeSpendCoverage(ctx: CrossContext): SpendCoverage {
  // Claves de campaña a las que resolvió al menos un lead.
  const conLeads = new Set<string>();
  for (const l of ctx.leads) {
    const m = matchToCampaign(l, ctx.idx, ctx.overrides);
    if (m.key) conLeads.add(m.key);
  }

  let matched = 0;
  let total = 0;
  const orphans: { name: string; platform: 'meta' | 'tiktok'; spend: number }[] = [];
  for (const c of ctx.idx.campaigns.values()) {
    total += c.spend;
    if (conLeads.has(c.key)) matched += c.spend;
    else if (c.spend > 0)
      orphans.push({ name: c.name, platform: c.platform, spend: round2(c.spend) });
  }
  orphans.sort((a, b) => b.spend - a.spend);

  return {
    matched: round2(matched),
    total: round2(total),
    // Sin gasto no se dice «0% cruzado», que sonaría a fallo: se dice que no
    // aplica. Es el mismo criterio de `lib/fx.ts`: cero ≠ desconocido.
    pct: total > 0 ? round2((matched / total) * 100) : null,
    orphans: orphans.slice(0, 20),
  };
}

/** (Puro) lista de campañas conocidas (para poblar selectores de mapeo). */
function campaignsFromIndex(
  idx: CampaignIndex
): { campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[] {
  return Array.from(idx.campaigns.values())
    .map((c) => ({
      campaign_id: c.campaign_id,
      name: c.name,
      platform: c.platform,
      spend: round2(c.spend),
    }))
    .sort((a, b) => b.spend - a.spend);
}

// ── Diagnóstico por NIVEL (conjunto y anuncio) ────────────────────────
//
// El desglose de arriba solo mira `utm_campaign`. La reunión del 2026-09-08 vio
// que el problema de Cris Tributario estaba un nivel más abajo: el conjunto y el
// anuncio llegaban como IDs (`120212…`) y no había dónde corregirlos. Esto es la
// misma idea —cada valor, cuántos leads, a qué entidad real resolvió— para
// `utm_term` (conjunto) y `utm_content` (anuncio).

type NivelDiagnostico = Exclude<NivelEntidad, 'campaign'>;

/** Campo UTM que identifica cada nivel. */
const CAMPO_DE_NIVEL: Record<NivelDiagnostico, 'utm_term' | 'utm_content'> = {
  adset: 'utm_term',
  ad: 'utm_content',
};

export interface NivelRow {
  field: 'utm_term' | 'utm_content';
  value: string;
  count: number;
  /** Nombre real de la entidad, si resolvió. */
  resolved: string | null;
  /** Cómo resolvió: por la cascada automática o por una corrección manual. */
  via: 'automatico' | 'manual' | null;
  /** El valor es un ID de Meta y no un nombre. */
  es_id: boolean;
  /** Mejor entidad candidata por similitud (solo nombres sin resolver). */
  suggestion: { id: string; name: string; confidence: number } | null;
}

export interface NivelCobertura {
  /** Leads con algún valor en el campo del nivel. */
  total: number;
  /** De esos, cuántos resolvieron a una entidad real. */
  resueltos: number;
  /** Cuántos traían un ID en vez de un nombre. */
  conId: number;
  /** Cuántos resolvieron gracias a una corrección manual. */
  manual: number;
}

export interface EntidadOpcion {
  id: string;
  name: string;
  campaign_name: string | null;
  adset_name: string | null;
  activo: boolean;
}

function catalogoComoOpciones(idx: CampaignIndex, nivel: NivelDiagnostico): EntidadOpcion[] {
  const cat = nivel === 'ad' ? idx.adCatalog : idx.adsetCatalog;
  return Array.from(cat.values())
    .map((e) => ({
      id: e.id,
      name: e.name,
      campaign_name: e.campaignKey ? (idx.campaigns.get(e.campaignKey)?.name ?? null) : null,
      adset_name: e.adsetName,
      activo: e.activo,
    }))
    .sort((a, b) => Number(b.activo) - Number(a.activo) || a.name.localeCompare(b.name))
    .slice(0, 800);
}

function mejorEntidad(value: string, opciones: EntidadOpcion[]): NivelRow['suggestion'] {
  const v = normLabel(value);
  if (!v) return null;
  let best: NivelRow['suggestion'] = null;
  let bestScore = 0;
  for (const o of opciones) {
    const score = diceCoefficient(v, normLabel(o.name));
    if (score > bestScore) {
      bestScore = score;
      best = { id: o.id, name: o.name, confidence: Math.round(score * 100) };
    }
  }
  return best && bestScore >= SUGGEST_THRESHOLD ? best : null;
}

/** (Puro) cobertura y desglose de un nivel. */
function computeNivel(
  ctx: CrossContext,
  resolver: CampaignResolver,
  nivel: NivelDiagnostico,
  opciones: EntidadOpcion[]
): { cobertura: NivelCobertura; rows: NivelRow[] } {
  const field = CAMPO_DE_NIVEL[nivel];
  const cobertura: NivelCobertura = { total: 0, resueltos: 0, conId: 0, manual: 0 };
  type G = { count: number; resolved: Map<string, number>; manual: number };
  const grupos = new Map<string, G>();

  const esManual = (raw: string) =>
    ctx.overrides.some(
      (o) =>
        (o.nivel ?? 'campaign') === nivel &&
        o.match_field === field &&
        normLabel(o.match_value) === normLabel(raw)
    );

  for (const l of ctx.leads) {
    const raw = String(l[field] ?? '').trim();
    if (!raw) continue;
    cobertura.total++;
    if (esIdMeta(raw)) cobertura.conId++;

    const r = nivel === 'ad' ? resolver.adOf(l) : resolver.adsetOf(l);
    const manual = r.matched && esManual(raw);
    if (r.matched) cobertura.resueltos++;
    if (manual) cobertura.manual++;

    let g = grupos.get(raw);
    if (!g) {
      g = { count: 0, resolved: new Map(), manual: 0 };
      grupos.set(raw, g);
    }
    g.count++;
    if (r.matched) g.resolved.set(r.label, (g.resolved.get(r.label) ?? 0) + 1);
    if (manual) g.manual++;
  }

  const rows: NivelRow[] = Array.from(grupos.entries())
    .map(([value, g]) => {
      const resolved = topEntry(g.resolved);
      const es_id = esIdMeta(value);
      return {
        field,
        value,
        count: g.count,
        resolved,
        via: resolved ? (g.manual > 0 ? 'manual' : 'automatico') : null,
        es_id,
        // Un ID que no está en el índice no se parece a ningún nombre: sugerir
        // por similitud de texto ahí sería inventar.
        suggestion: !resolved && !es_id ? mejorEntidad(value, opciones) : null,
      } satisfies NivelRow;
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 300);

  return { cobertura, rows };
}

// ── Nombres ambiguos ──────────────────────────────────────────────────
//
// Un nombre de anuncio o conjunto que existe en varias campañas no dice a cuál
// pertenece el lead. El resolver ya no elige una al azar (`ambiguous`); aquí se
// listan para que el trafficker los resuelva con la corrección por nivel, o
// —mejor— añadiendo `ad_id={{ad.id}}` a los enlaces para que no vuelva a pasar.

export interface AmbiguoRow {
  field: 'utm_content' | 'utm_term';
  value: string;
  count: number;
  /** Campañas donde existe ese nombre, de más a menos gasto. */
  candidates: { name: string; platform: 'meta' | 'tiktok'; spend: number }[];
}

/** (Puro) valores que cruzarían por nombre si el nombre no se repitiera. */
function computeAmbiguos(ctx: CrossContext): AmbiguoRow[] {
  type G = { field: AmbiguoRow['field']; value: string; count: number; keys: Set<string> };
  const grupos = new Map<string, G>();
  for (const l of ctx.leads) {
    const m = matchToCampaign(l, ctx.idx, ctx.overrides);
    if (m.method !== 'ambiguous') continue;
    const field = m.campo ?? 'utm_content';
    const value = String(l[field] ?? '').trim();
    const k = `${field}||${value}`;
    let g = grupos.get(k);
    if (!g) {
      g = { field, value, count: 0, keys: new Set() };
      grupos.set(k, g);
    }
    g.count++;
    for (const c of m.candidates ?? []) g.keys.add(c);
  }
  return Array.from(grupos.values())
    .map((g) => ({
      field: g.field,
      value: g.value,
      count: g.count,
      candidates: Array.from(g.keys)
        .map((k) => ctx.idx.campaigns.get(k))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => ({ name: c.name, platform: c.platform, spend: round2(c.spend) }))
        .sort((a, b) => b.spend - a.spend),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);
}

/**
 * Cuántos leads traen IDs dedicados (migración 082). Es el número que dice si
 * los enlaces ya llevan `{{ad.id}}` / `{{adset.id}}` y si el cruce por ID está
 * sosteniendo el informe o todavía se apoya en nombres.
 */
export interface CoberturaIds {
  /** La migración 082 está aplicada. Sin ella, los contadores valen 0. */
  columnas: boolean;
  total: number;
  campaign: number;
  adset: number;
  ad: number;
}

function computeIds(ctx: CrossContext): CoberturaIds {
  const c: CoberturaIds = {
    columnas: ctx.conIds,
    total: ctx.leads.length,
    campaign: 0,
    adset: 0,
    ad: 0,
  };
  if (!ctx.conIds) return c;
  for (const l of ctx.leads) {
    if (idPublicitario(l.campaign_id)) c.campaign++;
    if (idPublicitario(l.adset_id)) c.adset++;
    if (idPublicitario(l.ad_id)) c.ad++;
  }
  return c;
}

export interface CrossDiagnostics {
  campaigns: {
    campaign_id: string | null;
    name: string;
    platform: 'meta' | 'tiktok';
    spend: number;
  }[];
  suggestions: UnmatchedRow[];
  invalid: InvalidUtmRow[];
  breakdown: UtmCampaignRow[];
  coverage: MatchCoverage;
  /** Cobertura por el lado del gasto. `null` si no hay índice (sin enlace). */
  spend: SpendCoverage | null;
  /** Leads del rango excluidos por la regla del cliente (fuera de todo lo de arriba). */
  excluidos: number | null;
  /** Diagnóstico de conjunto y anuncio. */
  niveles: Record<NivelDiagnostico, { cobertura: NivelCobertura; rows: NivelRow[] }>;
  /** Entidades reales para corregir a mano por nivel. */
  entidades: Record<NivelDiagnostico, EntidadOpcion[]>;
  /** Nombres de anuncio/conjunto repetidos en varias campañas. */
  ambiguos: AmbiguoRow[];
  /** Leads con IDs dedicados. */
  ids: CoberturaIds;
}

const NIVEL_VACIO = (): { cobertura: NivelCobertura; rows: NivelRow[] } => ({
  cobertura: { total: 0, resueltos: 0, conId: 0, manual: 0 },
  rows: [],
});

/**
 * Diagnóstico combinado para la UI de cruce: campañas, desglose de TODOS los
 * utm_campaign con su estado de match, sugerencias (no cruzados mapeables), UTMs
 * inválidas (macros/vacíos) y cobertura por método. Carga los leads y el índice
 * UNA sola vez.
 */
export async function getCrossDiagnostics(params: CampaignCrossParams): Promise<CrossDiagnostics> {
  const ctx = await loadCrossContext(params);
  // `spend: null` y no un 0%: sin índice (cliente sin enlace, o lectura
  // incompleta) no se sabe la cobertura. Decir «0% cruzado» sería inventar.
  if (!ctx) {
    return {
      campaigns: [],
      suggestions: [],
      invalid: [],
      breakdown: [],
      coverage: { total: 0, methods: ZERO_METHODS() },
      spend: null,
      excluidos: null,
      niveles: { adset: NIVEL_VACIO(), ad: NIVEL_VACIO() },
      entidades: { adset: [], ad: [] },
      ambiguos: [],
      ids: { columnas: false, total: 0, campaign: 0, adset: 0, ad: 0 },
    };
  }
  const { suggestions, invalid } = computeUnmatched(ctx);
  // El mismo resolver que usa el motor del BI: si el diagnóstico resolviera
  // distinto, esta pantalla diría «resuelto» y el informe mostraría el ID.
  const resolver = buildResolver(ctx.idx, ctx.overrides);
  const entidades = {
    adset: catalogoComoOpciones(ctx.idx, 'adset'),
    ad: catalogoComoOpciones(ctx.idx, 'ad'),
  };
  return {
    campaigns: campaignsFromIndex(ctx.idx),
    suggestions,
    invalid,
    breakdown: computeUtmBreakdown(ctx),
    coverage: computeCoverage(ctx),
    spend: computeSpendCoverage(ctx),
    excluidos: ctx.excluidos,
    niveles: {
      adset: computeNivel(ctx, resolver, 'adset', entidades.adset),
      ad: computeNivel(ctx, resolver, 'ad', entidades.ad),
    },
    entidades,
    ambiguos: computeAmbiguos(ctx),
    ids: computeIds(ctx),
  };
}
