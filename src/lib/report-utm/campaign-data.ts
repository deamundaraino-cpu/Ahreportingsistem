import { createAdminClient } from '@/utils/supabase/server'
import type { BiQueryRow } from './bi-metadata'
import { fetchAllRows, applyOneFilter } from './bi-query'

// ============================================================
// Cruce leads/ventas ↔ campañas (gasto).
// Estrategia en cascada porque los UTMs son inconsistentes.
// Prioridad (todos los matches de aquí son EXACTOS = automáticos):
//   1. overrides manuales (report_utm.utm_campaign_map) → el trafficker manda
//   2. utm_id === campaign_id (Meta dinámico)
//   3. utm_id === ad_id (sube a su campaña)
//   4. utm_campaign normalizado === nombre de campaña
//   5. utm_content normalizado === nombre de ad (o de campaña)
//   6. utm_term normalizado === nombre de adset
//   7. sin match → "(sin campaña)"
// Lo que no cruza exacto se ofrece como SUGERENCIA por similitud
// (suggestCampaignMatches) para que el trafficker confirme — nunca se aplica solo.
// ============================================================

export type MatchMethod =
    | 'override'
    | 'utm_id_campaign'
    | 'utm_id_ad'
    | 'name'
    | 'content_ad'
    | 'term_adset'
    | 'none'

// Margen extra (días) para el índice de campañas respecto al rango de leads:
// registra campañas cuyo gasto cayó justo fuera del rango exacto, sin sumar su
// gasto al periodo (el gasto solo se acumula dentro de [dateFrom, dateTo]).
const INDEX_MARGIN_DAYS = 30

function shiftDate(isoDate: string, deltaDays: number): string {
    const d = new Date(isoDate + 'T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + deltaDays)
    return d.toISOString().slice(0, 10)
}

interface CampaignAgg {
    key: string
    campaign_id: string | null
    name: string
    platform: 'meta' | 'tiktok'
    spend: number
    impressions: number
    clicks: number
    platform_leads: number   // leads reportados por la plataforma (referencia)
}

interface CampaignIndex {
    campaigns: Map<string, CampaignAgg>     // key → agg
    byCampaignId: Map<string, string>        // campaign_id → key
    byAdId: Map<string, string>              // ad_id → key (de la campaña)
    byName: Map<string, string>              // nombre de campaña normalizado → key
    byAdName: Map<string, string>            // nombre de ad normalizado → key (campaña)
    byAdsetName: Map<string, string>         // nombre de adset normalizado → key (campaña)
}

interface Override {
    match_field: string
    match_value: string
    campaign_id: string | null
    campaign_name: string | null
    platform: string
}

// Normalización fuerte: minúsculas, sin acentos, _ y - como espacios, espacios
// colapsados. Convierte muchos "casi-iguales" (promo_verano vs Promo Verano) en
// matches EXACTOS reales.
function normName(s: string): string {
    return s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // quita acentos (marcas combinantes)
        .replace(/[_-]+/g, ' ')            // _ y - → espacio
        .trim()
        .replace(/\s+/g, ' ')
}

// Coeficiente de Sørensen-Dice sobre bigramas de caracteres → [0,1].
// Sin dependencias; tolera tokens reordenados/parciales razonablemente.
function diceCoefficient(a: string, b: string): number {
    if (a === b) return 1
    if (a.length < 2 || b.length < 2) return 0
    const bigrams = (s: string) => {
        const m = new Map<string, number>()
        for (let i = 0; i < s.length - 1; i++) {
            const bg = s.slice(i, i + 2)
            m.set(bg, (m.get(bg) ?? 0) + 1)
        }
        return m
    }
    const ba = bigrams(a)
    const bb = bigrams(b)
    let inter = 0
    let total = 0
    for (const c of ba.values()) total += c
    for (const [bg, c] of bb) {
        total += c
        const av = ba.get(bg)
        if (av) inter += Math.min(av, c)
    }
    return total === 0 ? 0 : (2 * inter) / total
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number {
    const n = typeof v === 'string' ? parseFloat(v) : v
    return Number.isFinite(n) ? Number(n) : 0
}

/**
 * Carga y agrega las campañas (Meta + TikTok) de metricas_diarias para
 * el cliente público en el rango, e indexa por id, ad_id y nombre.
 */
async function loadCampaignIndex(
    publicClienteId: string,
    dateFrom: string,
    dateTo: string
): Promise<CampaignIndex> {
    const supabase = await createAdminClient()
    // Ventana ampliada para registrar claves de campañas/ads/adsets que pudieron
    // gastar justo fuera del rango. El gasto solo se acumula dentro del rango exacto.
    const keyFrom = shiftDate(dateFrom, -INDEX_MARGIN_DAYS)
    const { data, error } = await supabase
        .from('metricas_diarias')
        .select('fecha,meta_campaigns,meta_ads,meta_adsets,tiktok_campaigns')
        .eq('cliente_id', publicClienteId)
        .gte('fecha', keyFrom)
        .lte('fecha', dateTo)
        .limit(2000)

    const idx: CampaignIndex = {
        campaigns: new Map(),
        byCampaignId: new Map(),
        byAdId: new Map(),
        byName: new Map(),
        byAdName: new Map(),
        byAdsetName: new Map(),
    }
    if (error || !data) return idx

    function upsert(platform: 'meta' | 'tiktok', campId: string | null, name: string, addSpend: boolean, m: { spend: number; impressions: number; clicks: number; leads: number }) {
        const key = `${platform}:${campId ?? normName(name)}`
        let agg = idx.campaigns.get(key)
        if (!agg) {
            agg = { key, campaign_id: campId, name: name || '(sin nombre)', platform, spend: 0, impressions: 0, clicks: 0, platform_leads: 0 }
            idx.campaigns.set(key, agg)
            if (campId) idx.byCampaignId.set(campId, key)
            if (name) idx.byName.set(normName(name), key)
        }
        if (addSpend) {
            agg.spend += m.spend
            agg.impressions += m.impressions
            agg.clicks += m.clicks
            agg.platform_leads += m.leads
        }
        return key
    }

    for (const row of data as Record<string, unknown>[]) {
        const inRange = typeof row.fecha === 'string' ? row.fecha >= dateFrom : true
        const metaCamps = (row.meta_campaigns as Record<string, unknown>[] | null) ?? []
        for (const c of metaCamps) {
            upsert('meta', (c.campaign_id as string) ?? null, (c.name as string) ?? '', inRange, {
                spend: num(c.spend), impressions: num(c.impressions), clicks: num(c.clicks), leads: num(c.leads),
            })
        }
        // Indexa ad_id y nombre de ad/adset → campaña (para cruzar utm_id=ad_id,
        // utm_content=ad_name, utm_term=adset_name).
        const metaAds = (row.meta_ads as Record<string, unknown>[] | null) ?? []
        for (const a of metaAds) {
            const campId = a.campaign_id as string | null
            const campKey = campId ? idx.byCampaignId.get(campId) : undefined
            if (!campKey) continue
            const adId = a.ad_id as string | null
            if (adId) idx.byAdId.set(adId, campKey)
            const adName = a.ad_name as string | null
            if (adName) idx.byAdName.set(normName(adName), campKey)
            const adsetName = a.adset_name as string | null
            if (adsetName) idx.byAdsetName.set(normName(adsetName), campKey)
        }
        const metaAdsets = (row.meta_adsets as Record<string, unknown>[] | null) ?? []
        for (const a of metaAdsets) {
            const campId = a.campaign_id as string | null
            const campKey = campId ? idx.byCampaignId.get(campId) : undefined
            if (!campKey) continue
            const adsetName = a.adset_name as string | null
            if (adsetName) idx.byAdsetName.set(normName(adsetName), campKey)
        }
        const ttCamps = (row.tiktok_campaigns as Record<string, unknown>[] | null) ?? []
        for (const c of ttCamps) {
            upsert('tiktok', (c.campaign_id as string) ?? null, (c.name as string) ?? '', inRange, {
                spend: num(c.spend), impressions: num(c.impressions), clicks: num(c.clicks), leads: num(c.conversions),
            })
        }
    }

    return idx
}

/** Lista las campañas disponibles (para poblar selectores de mapeo). */
export async function listCampaigns(
    clienteId: string,
    dateFrom?: string,
    dateTo?: string
): Promise<{ campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[]> {
    const supabase = await createAdminClient()
    const from = dateFrom ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
    const to   = dateTo   ?? new Date().toISOString().slice(0, 10)

    const { data: rtmCliente } = await supabase
        .schema('report_utm')
        .from('clientes')
        .select('public_cliente_id')
        .eq('id', clienteId)
        .maybeSingle()
    const publicClienteId = rtmCliente?.public_cliente_id as string | undefined
    if (!publicClienteId) return []

    const idx = await loadCampaignIndex(publicClienteId, from, to)
    return campaignsFromIndex(idx)
}

/** Cascada de matching de un registro (lead/venta) a una campaña. */
function matchToCampaign(
    rec: { utm_id?: string | null; utm_campaign?: string | null; utm_content?: string | null; utm_term?: string | null; utm_source?: string | null },
    idx: CampaignIndex,
    overrides: Override[]
): { key: string | null; method: MatchMethod } {
    // 1. overrides manuales → máxima prioridad (el trafficker corrige el motor)
    for (const ov of overrides) {
        const val = (rec as Record<string, unknown>)[ov.match_field] as string | undefined
        if (val && normName(val) === normName(ov.match_value)) {
            const key = ov.campaign_id
                ? `${ov.platform}:${ov.campaign_id}`
                : ov.campaign_name ? `${ov.platform}:${normName(ov.campaign_name)}` : null
            if (key) return { key, method: 'override' }
        }
    }
    // 2. utm_id === campaign_id
    if (rec.utm_id && idx.byCampaignId.has(rec.utm_id)) {
        return { key: idx.byCampaignId.get(rec.utm_id)!, method: 'utm_id_campaign' }
    }
    // 3. utm_id === ad_id → su campaña
    if (rec.utm_id && idx.byAdId.has(rec.utm_id)) {
        return { key: idx.byAdId.get(rec.utm_id)!, method: 'utm_id_ad' }
    }
    // 4. utm_campaign === nombre de campaña (normalizado)
    if (rec.utm_campaign) {
        const k = idx.byName.get(normName(rec.utm_campaign))
        if (k) return { key: k, method: 'name' }
    }
    // 5. utm_content === nombre de ad (o de campaña) → su campaña
    if (rec.utm_content) {
        const n = normName(rec.utm_content)
        const k = idx.byAdName.get(n) ?? idx.byName.get(n)
        if (k) return { key: k, method: 'content_ad' }
    }
    // 6. utm_term === nombre de adset → su campaña
    if (rec.utm_term) {
        const k = idx.byAdsetName.get(normName(rec.utm_term))
        if (k) return { key: k, method: 'term_adset' }
    }
    return { key: null, method: 'none' }
}

async function loadOverrides(clienteId: string): Promise<Override[]> {
    const supabase = await createAdminClient()
    const { data } = await supabase
        .schema('report_utm')
        .from('utm_campaign_map')
        .select('match_field,match_value,campaign_id,campaign_name,platform')
        .eq('cliente_id', clienteId)
        .limit(2000)
    return (data as Override[] | null) ?? []
}

export interface CampaignCrossParams {
    cliente_id: string          // report_utm cliente id (requerido)
    date_from?: string
    date_to?: string
    filters?: Record<string, string>
    limit?: number
}

/**
 * Cruce principal: devuelve filas por campaña con gasto real + leads/ventas
 * cruzados + métricas derivadas (CPL, CPA, ROAS). Formato BiQueryRow para
 * encajar directamente en tablas/gráficas del BI.
 */
export async function runCampaignQuery(params: CampaignCrossParams): Promise<BiQueryRow[]> {
    const supabase = await createAdminClient()
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    // Resolver el cliente público (para metricas_diarias)
    const { data: rtmCliente } = await supabase
        .schema('report_utm')
        .from('clientes')
        .select('public_cliente_id')
        .eq('id', params.cliente_id)
        .maybeSingle()
    const publicClienteId = rtmCliente?.public_cliente_id as string | undefined
    if (!publicClienteId) return []   // sin link al cliente de campañas no hay cruce

    const [idx, overrides] = await Promise.all([
        loadCampaignIndex(publicClienteId, dateFrom, dateTo),
        loadOverrides(params.cliente_id),
    ])

    // Acumulador por campaña
    type Acc = { name: string; spend: number; impressions: number; clicks: number; leads: number; sales: number; revenue: number; methods: Record<string, number> }
    const acc = new Map<string, Acc>()
    function ensure(key: string, name: string): Acc {
        let a = acc.get(key)
        if (!a) { a = { name, spend: 0, impressions: 0, clicks: 0, leads: 0, sales: 0, revenue: 0, methods: {} }; acc.set(key, a) }
        return a
    }
    // Sembrar con todas las campañas conocidas (para que aparezcan aunque no tengan leads)
    for (const c of idx.campaigns.values()) {
        const a = ensure(c.key, c.name)
        a.spend += c.spend; a.impressions += c.impressions; a.clicks += c.clicks
    }
    const UNMATCHED = '__none__'

    // Leads (paginado completo para no toparse con el límite de PostgREST)
    const leads = await fetchAllRows(() => applyFilters(
        supabase.schema('report_utm').from('lead_events')
            .select('utm_id,utm_campaign,utm_content,utm_term,utm_source')
            .gte('created_at', dateFrom + 'T00:00:00')
            .lte('created_at', dateTo + 'T23:59:59')
            .eq('cliente_id', params.cliente_id),
        params.filters,
    ))
    for (const l of leads) {
        const m = matchToCampaign(l, idx, overrides)
        const key = m.key ?? UNMATCHED
        const a = ensure(key, m.key ? (idx.campaigns.get(m.key)?.name ?? key) : '(sin campaña)')
        a.leads += 1
        a.methods[m.method] = (a.methods[m.method] ?? 0) + 1
    }

    // Ventas (aprobadas, paginado completo)
    const sales = await fetchAllRows(() => applyFilters(
        supabase.schema('report_utm').from('sales_events')
            .select('utm_id,utm_campaign,utm_content,utm_term,utm_source,amount,status')
            .gte('created_at', dateFrom + 'T00:00:00')
            .lte('created_at', dateTo + 'T23:59:59')
            .eq('cliente_id', params.cliente_id)
            .eq('status', 'approved'),
        params.filters,
    ))
    for (const s of sales) {
        const m = matchToCampaign(s, idx, overrides)
        const key = m.key ?? UNMATCHED
        const a = ensure(key, m.key ? (idx.campaigns.get(m.key)?.name ?? key) : '(sin campaña)')
        a.sales += 1
        a.revenue += num(s.amount)
    }

    // Construir filas BiQueryRow
    const rows: BiQueryRow[] = Array.from(acc.entries()).map(([, a]) => {
        const spend = round2(a.spend)
        const revenue = round2(a.revenue)
        return {
            dimension_value: a.name,
            spend,
            impressions: a.impressions,
            clicks: a.clicks,
            leads_count: a.leads,
            sales_count: a.sales,
            revenue,
            cpl: a.leads > 0 && spend > 0 ? round2(spend / a.leads) : null,
            cpa: a.sales > 0 && spend > 0 ? round2(spend / a.sales) : null,
            roas: spend > 0 ? round2(revenue / spend) : null,
            conversion_rate: a.leads > 0 ? round2((a.sales / a.leads) * 100) : null,
            cpc: a.clicks > 0 && spend > 0 ? round2(spend / a.clicks) : null,
            cpm: a.impressions > 0 && spend > 0 ? round2((spend / a.impressions) * 1000) : null,
        }
    })

    rows.sort((x, y) => Number(y.spend ?? 0) - Number(x.spend ?? 0))
    return params.limit ? rows.slice(0, params.limit) : rows
}

const VALID = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'])
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(q: any, filters?: Record<string, string>): any {
    if (!filters) return q
    for (const [k, raw] of Object.entries(filters)) {
        if (!raw || !VALID.has(k)) continue
        q = applyOneFilter(q, k, raw)
    }
    return q
}

function round2(n: number): number {
    return Math.round(n * 100) / 100
}

// Umbral mínimo de similitud para ofrecer una sugerencia (no autoaplicar).
const SUGGEST_THRESHOLD = 0.45

export type InvalidUtmReason = 'macro_no_renderizado' | 'sin_utm'

// Valores vacíos/centinela que no representan ninguna campaña.
const EMPTY_UTM = new Set(['', '(vacío)', '(vacio)', '(empty)', '(none)', '(not set)', 'not set', 'null', 'undefined', 'n/a', 'na'])

/**
 * Detecta UTMs que NO son atribuibles a una campaña concreta:
 *  - macros sin renderizar de Meta/TikTok: {{campaign.name}}, {{ad.name}},
 *    {campaign.name}, __CAMPAIGN_NAME__, %campaign_name%…
 *  - valores vacíos o centinela.
 * Estas no deben ofrecerse para mapeo manual (un macro abarca muchas campañas).
 */
function classifyInvalidUtm(value: string): InvalidUtmReason | null {
    const v = value.trim()
    if (EMPTY_UTM.has(v.toLowerCase())) return 'sin_utm'
    // Macros sin sustituir en cualquiera de las sintaxis habituales.
    if (/\{\{.*?\}\}|\{[a-z0-9_.]+\}|__[A-Z0-9_]+__|%[a-z0-9_]+%/i.test(v)) return 'macro_no_renderizado'
    return null
}

interface CrossContext {
    idx: CampaignIndex
    overrides: Override[]
    leads: Record<string, unknown>[]
}

/** Resuelve cliente público, carga índice+overrides y los leads del rango. */
async function loadCrossContext(params: CampaignCrossParams): Promise<CrossContext | null> {
    const supabase = await createAdminClient()
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    const { data: rtmCliente } = await supabase
        .schema('report_utm')
        .from('clientes')
        .select('public_cliente_id')
        .eq('id', params.cliente_id)
        .maybeSingle()
    const publicClienteId = rtmCliente?.public_cliente_id as string | undefined
    if (!publicClienteId) return null

    const [idx, overrides] = await Promise.all([
        loadCampaignIndex(publicClienteId, dateFrom, dateTo),
        loadOverrides(params.cliente_id),
    ])

    const leads = await fetchAllRows(() =>
        supabase.schema('report_utm').from('lead_events')
            .select('utm_id,utm_campaign,utm_content,utm_term,utm_source')
            .gte('created_at', dateFrom + 'T00:00:00')
            .lte('created_at', dateTo + 'T23:59:59')
            .eq('cliente_id', params.cliente_id)
    ) as Record<string, unknown>[]

    return { idx, overrides, leads }
}

export interface CampaignSuggestion {
    campaign_id: string | null
    campaign_name: string
    platform: 'meta' | 'tiktok'
    confidence: number   // 0-100
}

export interface UnmatchedRow {
    field: string
    value: string
    count: number
    suggestion: CampaignSuggestion | null
}

/** Mejor campaña candidata para un valor UTM por similitud de nombre. */
function bestSuggestion(value: string, idx: CampaignIndex): CampaignSuggestion | null {
    const v = normName(value)
    if (!v) return null
    let best: CampaignSuggestion | null = null
    let bestScore = 0
    for (const c of idx.campaigns.values()) {
        const score = diceCoefficient(v, normName(c.name))
        if (score > bestScore) {
            bestScore = score
            best = { campaign_id: c.campaign_id, campaign_name: c.name, platform: c.platform, confidence: Math.round(score * 100) }
        }
    }
    return best && bestScore >= SUGGEST_THRESHOLD ? best : null
}

export interface MatchCoverage {
    total: number
    methods: Record<MatchMethod, number>
}

export interface InvalidUtmRow {
    field: string
    value: string
    count: number
    reason: InvalidUtmReason
}

/**
 * (Puro) valores UTM de leads que NO cruzaron exacto, separados en:
 *  - `suggestions`: valores reales mapeables (con mejor candidato por similitud)
 *  - `invalid`: macros sin renderizar / vacíos (no mapeables, problema de datos)
 */
function computeUnmatched(ctx: CrossContext): { suggestions: UnmatchedRow[]; invalid: InvalidUtmRow[] } {
    const { idx, overrides, leads } = ctx
    const counts = new Map<string, number>()
    for (const l of leads) {
        const m = matchToCampaign(l, idx, overrides)
        if (m.key) continue
        const v = (l.utm_campaign as string) || (l.utm_id as string) || (l.utm_source as string) || '(vacío)'
        const field = l.utm_campaign ? 'utm_campaign' : l.utm_id ? 'utm_id' : 'utm_source'
        const k = `${field}||${v}`
        counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const suggestions: UnmatchedRow[] = []
    const invalid: InvalidUtmRow[] = []
    for (const [k, count] of counts) {
        const field = k.split('||')[0]
        const value = k.slice(field.length + 2)
        const bad = classifyInvalidUtm(value)
        if (bad) invalid.push({ field, value, count, reason: bad })
        else suggestions.push({ field, value, count, suggestion: bestSuggestion(value, idx) })
    }
    suggestions.sort((a, b) => b.count - a.count)
    invalid.sort((a, b) => b.count - a.count)
    return { suggestions: suggestions.slice(0, 200), invalid: invalid.slice(0, 50) }
}

export interface UtmCampaignRow {
    value: string                       // valor de utm_campaign (o '(vacío)')
    count: number                       // leads con ese utm_campaign
    matched_campaign: string | null     // campaña a la que cruzó (dominante)
    distinct_campaigns: number          // nº de campañas distintas a las que cruzó
    method: MatchMethod                 // método de match dominante
    invalid_reason: InvalidUtmReason | null
    suggestion: CampaignSuggestion | null   // solo si no cruzó y es mapeable
}

const ZERO_METHODS = (): Record<MatchMethod, number> => ({
    override: 0, utm_id_campaign: 0, utm_id_ad: 0, name: 0, content_ad: 0, term_adset: 0, none: 0,
})

function topEntry<T extends string>(m: Record<T, number> | Map<T, number>): T | null {
    const entries = m instanceof Map ? Array.from(m.entries()) : (Object.entries(m) as [T, number][])
    let best: T | null = null
    let bestC = -1
    for (const [k, c] of entries) { if (c > bestC) { bestC = c; best = k } }
    return best
}

/**
 * (Puro) desglose de TODOS los valores de utm_campaign de los leads con su estado
 * de cruce (a qué campaña, por qué método) — para que el trafficker confirme que
 * cada UTM de los leads se visualiza y, si no cruzó, lo pueda mapear.
 */
function computeUtmBreakdown(ctx: CrossContext): UtmCampaignRow[] {
    const { idx, overrides, leads } = ctx
    type G = { count: number; methods: Record<MatchMethod, number>; campaigns: Map<string, number> }
    const groups = new Map<string, G>()
    for (const l of leads) {
        const value = ((l.utm_campaign as string) || '').trim() || '(vacío)'
        const m = matchToCampaign(l, idx, overrides)
        const campName = m.key ? (idx.campaigns.get(m.key)?.name ?? null) : null
        let g = groups.get(value)
        if (!g) { g = { count: 0, methods: ZERO_METHODS(), campaigns: new Map() }; groups.set(value, g) }
        g.count += 1
        g.methods[m.method] += 1
        if (campName) g.campaigns.set(campName, (g.campaigns.get(campName) ?? 0) + 1)
    }
    return Array.from(groups.entries())
        .map(([value, g]) => {
            const crossed = g.count - g.methods.none
            const matched_campaign = crossed > 0 ? topEntry(g.campaigns) : null
            // Método dominante; si cruzó, excluye 'none' para no mostrar un badge contradictorio.
            const methodPool = crossed > 0 ? { ...g.methods, none: 0 } : g.methods
            const method = (topEntry(methodPool) ?? 'none') as MatchMethod
            const invalid_reason = crossed === 0 ? classifyInvalidUtm(value) : null
            const suggestion = crossed === 0 && !invalid_reason ? bestSuggestion(value, idx) : null
            return { value, count: g.count, matched_campaign, distinct_campaigns: g.campaigns.size, method, invalid_reason, suggestion }
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 500)
}

/** (Puro) cobertura del cruce: total de leads y conteo por método de match. */
function computeCoverage(ctx: CrossContext): MatchCoverage {
    const methods = ZERO_METHODS()
    for (const l of ctx.leads) {
        const m = matchToCampaign(l, ctx.idx, ctx.overrides)
        methods[m.method] += 1
    }
    return { total: ctx.leads.length, methods }
}

/** (Puro) lista de campañas conocidas (para poblar selectores de mapeo). */
function campaignsFromIndex(idx: CampaignIndex): { campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[] {
    return Array.from(idx.campaigns.values())
        .map(c => ({ campaign_id: c.campaign_id, name: c.name, platform: c.platform, spend: round2(c.spend) }))
        .sort((a, b) => b.spend - a.spend)
}

export interface CrossDiagnostics {
    campaigns: { campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }[]
    suggestions: UnmatchedRow[]
    invalid: InvalidUtmRow[]
    breakdown: UtmCampaignRow[]
    coverage: MatchCoverage
}

/**
 * Diagnóstico combinado para la UI de cruce: campañas, desglose de TODOS los
 * utm_campaign con su estado de match, sugerencias (no cruzados mapeables), UTMs
 * inválidas (macros/vacíos) y cobertura por método. Carga los leads y el índice
 * UNA sola vez.
 */
export async function getCrossDiagnostics(params: CampaignCrossParams): Promise<CrossDiagnostics> {
    const ctx = await loadCrossContext(params)
    if (!ctx) return { campaigns: [], suggestions: [], invalid: [], breakdown: [], coverage: { total: 0, methods: ZERO_METHODS() } }
    const { suggestions, invalid } = computeUnmatched(ctx)
    return {
        campaigns: campaignsFromIndex(ctx.idx),
        suggestions,
        invalid,
        breakdown: computeUtmBreakdown(ctx),
        coverage: computeCoverage(ctx),
    }
}
