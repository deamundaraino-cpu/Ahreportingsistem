import { createAdminClient } from '@/utils/supabase/server'
import type { BiQueryRow } from './bi-metadata'
import { fetchAllRows, applyOneFilter } from './bi-query'

// ============================================================
// Cruce leads/ventas ↔ campañas (gasto).
// Estrategia en cascada porque los UTMs son inconsistentes:
//   1. utm_id === campaign_id (Meta dinámico)  → exacto
//   2. utm_id === ad_id (sube a su campaña)     → exacto
//   3. nombre normalizado de utm_campaign === nombre de campaña
//   4. tabla de overrides report_utm.utm_campaign_map
//   5. sin match → "(sin campaña)"
// ============================================================

export type MatchMethod = 'utm_id_campaign' | 'utm_id_ad' | 'name' | 'override' | 'none'

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
    byName: Map<string, string>              // nombre normalizado → key
}

interface Override {
    match_field: string
    match_value: string
    campaign_id: string | null
    campaign_name: string | null
    platform: string
}

function normName(s: string): string {
    return s.toLowerCase().trim().replace(/\s+/g, ' ')
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
    const { data, error } = await supabase
        .from('metricas_diarias')
        .select('meta_campaigns,meta_ads,tiktok_campaigns')
        .eq('cliente_id', publicClienteId)
        .gte('fecha', dateFrom)
        .lte('fecha', dateTo)
        .limit(2000)

    const idx: CampaignIndex = {
        campaigns: new Map(),
        byCampaignId: new Map(),
        byAdId: new Map(),
        byName: new Map(),
    }
    if (error || !data) return idx

    function upsert(platform: 'meta' | 'tiktok', campId: string | null, name: string, m: { spend: number; impressions: number; clicks: number; leads: number }) {
        const key = `${platform}:${campId ?? normName(name)}`
        let agg = idx.campaigns.get(key)
        if (!agg) {
            agg = { key, campaign_id: campId, name: name || '(sin nombre)', platform, spend: 0, impressions: 0, clicks: 0, platform_leads: 0 }
            idx.campaigns.set(key, agg)
            if (campId) idx.byCampaignId.set(campId, key)
            if (name) idx.byName.set(normName(name), key)
        }
        agg.spend += m.spend
        agg.impressions += m.impressions
        agg.clicks += m.clicks
        agg.platform_leads += m.leads
    }

    for (const row of data as Record<string, unknown>[]) {
        const metaCamps = (row.meta_campaigns as Record<string, unknown>[] | null) ?? []
        for (const c of metaCamps) {
            upsert('meta', (c.campaign_id as string) ?? null, (c.name as string) ?? '', {
                spend: num(c.spend), impressions: num(c.impressions), clicks: num(c.clicks), leads: num(c.leads),
            })
        }
        // Indexa ad_id → campaña (para cruzar utm_id que sea un ad id)
        const metaAds = (row.meta_ads as Record<string, unknown>[] | null) ?? []
        for (const a of metaAds) {
            const adId = a.ad_id as string | null
            const campId = a.campaign_id as string | null
            if (adId && campId && idx.byCampaignId.has(campId)) {
                idx.byAdId.set(adId, idx.byCampaignId.get(campId)!)
            }
        }
        const ttCamps = (row.tiktok_campaigns as Record<string, unknown>[] | null) ?? []
        for (const c of ttCamps) {
            upsert('tiktok', (c.campaign_id as string) ?? null, (c.name as string) ?? '', {
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
    return Array.from(idx.campaigns.values())
        .map(c => ({ campaign_id: c.campaign_id, name: c.name, platform: c.platform, spend: round2(c.spend) }))
        .sort((a, b) => b.spend - a.spend)
}

/** Cascada de matching de un registro (lead/venta) a una campaña. */
function matchToCampaign(
    rec: { utm_id?: string | null; utm_campaign?: string | null; utm_content?: string | null; utm_source?: string | null },
    idx: CampaignIndex,
    overrides: Override[]
): { key: string | null; method: MatchMethod } {
    // 1. utm_id === campaign_id
    if (rec.utm_id && idx.byCampaignId.has(rec.utm_id)) {
        return { key: idx.byCampaignId.get(rec.utm_id)!, method: 'utm_id_campaign' }
    }
    // 2. utm_id === ad_id → su campaña
    if (rec.utm_id && idx.byAdId.has(rec.utm_id)) {
        return { key: idx.byAdId.get(rec.utm_id)!, method: 'utm_id_ad' }
    }
    // 3. nombre normalizado
    if (rec.utm_campaign) {
        const k = idx.byName.get(normName(rec.utm_campaign))
        if (k) return { key: k, method: 'name' }
    }
    // 4. overrides
    for (const ov of overrides) {
        const val = (rec as Record<string, unknown>)[ov.match_field] as string | undefined
        if (val && normName(val) === normName(ov.match_value)) {
            const key = ov.campaign_id
                ? `${ov.platform}:${ov.campaign_id}`
                : ov.campaign_name ? `${ov.platform}:${normName(ov.campaign_name)}` : null
            if (key) return { key, method: 'override' }
        }
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
            .select('utm_id,utm_campaign,utm_content,utm_source')
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
            .select('utm_id,utm_campaign,utm_content,utm_source,amount,status')
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

/** Diagnóstico: valores UTM de leads que NO cruzaron a ninguna campaña. */
export async function runUnmatchedUtms(params: CampaignCrossParams): Promise<{ value: string; field: string; count: number }[]> {
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
    if (!publicClienteId) return []

    const [idx, overrides] = await Promise.all([
        loadCampaignIndex(publicClienteId, dateFrom, dateTo),
        loadOverrides(params.cliente_id),
    ])

    const leads = await fetchAllRows(() =>
        supabase.schema('report_utm').from('lead_events')
            .select('utm_id,utm_campaign,utm_content,utm_source')
            .gte('created_at', dateFrom + 'T00:00:00')
            .lte('created_at', dateTo + 'T23:59:59')
            .eq('cliente_id', params.cliente_id)
    )

    const counts = new Map<string, number>()
    for (const l of leads) {
        const m = matchToCampaign(l, idx, overrides)
        if (m.key) continue
        const v = (l.utm_campaign as string) || (l.utm_id as string) || (l.utm_source as string) || '(vacío)'
        const field = l.utm_campaign ? 'utm_campaign' : l.utm_id ? 'utm_id' : 'utm_source'
        const k = `${field}||${v}`
        counts.set(k, (counts.get(k) ?? 0) + 1)
    }

    return Array.from(counts.entries())
        .map(([k, count]) => ({ field: k.split('||')[0], value: k.split('||')[1], count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 200)
}
