import { createAdminClient } from '@/utils/supabase/server'
import type { BiMetric, BiDimension, DateGrouping, BiQueryParams, BiQueryRow, BiPivotRow } from './bi-metadata'
import { evaluateExpression } from './bi-metadata'

// Re-export para compatibilidad con imports existentes que apuntaban acá.
export type { BiMetric, BiDimension, DateGrouping, BiQueryParams, BiQueryRow, BiPivotRow } from './bi-metadata'
export { METRIC_META, DIMENSION_META } from './bi-metadata'

// ── Main query function ───────────────────────────────────────────────

export async function runBiQuery(params: BiQueryParams): Promise<BiQueryRow[]> {
    const supabase = await createAdminClient()

    const needsLeads = params.metrics.some(m =>
        ['leads_count', 'cpl', 'conversion_rate'].includes(m)
    )
    const needsSales = params.metrics.some(m =>
        ['sales_count', 'revenue', 'cpa', 'roas', 'conversion_rate'].includes(m)
    )
    const needsAds = params.metrics.some(m =>
        ['spend', 'cpl', 'cpa', 'roas', 'clicks', 'impressions', 'cpc', 'cpm'].includes(m)
    )

    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)
    const grouping = params.date_grouping ?? 'day'
    const lim      = Math.min(params.limit ?? 500, 5000)

    // Build dimension selector for leads/sales tables
    function dimColumn(table: 'l' | 's', dim: BiDimension): string {
        if (dim === 'none') return `'total'`
        if (dim === 'date') {
            const trunc = grouping === 'month' ? 'month' : grouping === 'week' ? 'week' : 'day'
            return `DATE_TRUNC('${trunc}', ${table}.created_at)::date::text`
        }
        if (dim === 'platform') return table === 's' ? `s.platform` : `'leads'`
        // All other dims exist on both tables
        return `${table}.${dim}`
    }

    // ── LEADS query ───────────────────────────────────────────────────
    let leadsData: Array<{ dim: string | null; count: number }> = []
    if (needsLeads) {
        const dimExpr = dimColumn('l', params.dimension)
        let sql = `
            SELECT ${dimExpr} AS dim, COUNT(*)::int AS count
            FROM report_utm.lead_events l
            WHERE l.created_at::date BETWEEN '${dateFrom}' AND '${dateTo}'
        `
        if (params.cliente_id) sql += ` AND l.cliente_id = '${params.cliente_id}'`
        if (params.filters) {
            for (const [k, v] of Object.entries(params.filters)) {
                if (v && isValidDimKey(k)) sql += ` AND l.${k} = '${v.replace(/'/g, "''")}'`
            }
        }
        if (params.dimension !== 'none') sql += ` GROUP BY 1 ORDER BY count DESC`
        sql += ` LIMIT ${lim}`

        const { data, error } = await supabase.rpc('execute_bi_query' as never, { query_sql: sql })
        if (!error && Array.isArray(data)) {
            leadsData = data as { dim: string | null; count: number }[]
        } else {
            // Fallback: use PostgREST-style query
            leadsData = await queryLeadsDirect(supabase, params, dateFrom, dateTo, lim)
        }
    }

    // ── SALES query ───────────────────────────────────────────────────
    let salesData: Array<{ dim: string | null; sales: number; revenue: number }> = []
    if (needsSales) {
        salesData = await querySalesDirect(supabase, params, dateFrom, dateTo, lim)
    }

    // ── ADS query (metricas_diarias) ──────────────────────────────────
    let adsData: Array<{ dim: string | null; spend: number; clicks: number; impressions: number }> = []
    if (needsAds) {
        adsData = await queryAdsDirect(supabase, params, dateFrom, dateTo, lim)
    }

    // ── Merge results ─────────────────────────────────────────────────
    return mergeResults(params, leadsData, salesData, adsData)
}

// ── Direct PostgREST queries (no raw SQL needed) ──────────────────────

async function queryLeadsDirect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    lim: number
): Promise<Array<{ dim: string | null; count: number }>> {
    let q = supabase
        .schema('report_utm')
        .from('lead_events')
        .select(buildLeadSelect(params.dimension))
        .gte('created_at', dateFrom + 'T00:00:00')
        .lte('created_at', dateTo + 'T23:59:59')
        .limit(lim)

    if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
    q = applyDimFilters(q, params.filters)

    const { data, error } = await q
    if (error || !data) return []
    return aggregateLeads(data as Record<string, unknown>[], params.dimension, params.date_grouping)
}

function buildLeadSelect(dimension: BiDimension): string {
    const cols = ['id', 'created_at']
    if (dimension !== 'none' && dimension !== 'date') cols.push(dimension)
    return cols.join(',')
}

function aggregateLeads(
    rows: Record<string, unknown>[],
    dimension: BiDimension,
    grouping?: DateGrouping
): Array<{ dim: string | null; count: number }> {
    const map = new Map<string, number>()
    for (const r of rows) {
        const dim = getDimValue(r, dimension, grouping)
        map.set(dim, (map.get(dim) ?? 0) + 1)
    }
    return Array.from(map.entries())
        .map(([dim, count]) => ({ dim, count }))
        .sort((a, b) => b.count - a.count)
}

async function querySalesDirect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    lim: number
): Promise<Array<{ dim: string | null; sales: number; revenue: number }>> {
    const dimCols = params.dimension !== 'none' && params.dimension !== 'date' ? `,${params.dimension}` : ''
    let q = supabase
        .schema('report_utm')
        .from('sales_events')
        .select(`id,created_at,amount,status,platform${dimCols}`)
        .gte('created_at', dateFrom + 'T00:00:00')
        .lte('created_at', dateTo + 'T23:59:59')
        .eq('status', 'approved')
        .limit(lim)

    if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
    q = applyDimFilters(q, params.filters)

    const { data, error } = await q
    if (error || !data) return []

    const map = new Map<string, { sales: number; revenue: number }>()
    for (const r of data as Record<string, unknown>[]) {
        let dim = getDimValue(r, params.dimension, params.date_grouping)
        if (params.dimension === 'platform') dim = String(r.platform ?? 'otro')
        const entry = map.get(dim) ?? { sales: 0, revenue: 0 }
        entry.sales += 1
        entry.revenue += Number(r.amount ?? 0)
        map.set(dim, entry)
    }
    return Array.from(map.entries())
        .map(([dim, v]) => ({ dim, ...v }))
        .sort((a, b) => b.revenue - a.revenue)
}

async function queryAdsDirect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    lim: number
): Promise<Array<{ dim: string | null; spend: number; clicks: number; impressions: number }>> {
    // metricas_diarias lives in the public schema
    let q = (await (await import('@/utils/supabase/server')).createAdminClient())
        .from('metricas_diarias')
        .select('fecha,meta_spend,tiktok_spend,meta_clicks,tiktok_clicks,meta_impressions,tiktok_impressions')
        .gte('fecha', dateFrom)
        .lte('fecha', dateTo)
        .limit(lim)

    if (params.cliente_id) {
        // Join metricas_diarias by public cliente through report_utm clientes link
        // For now filter by matching public.clientes linked to report_utm cliente
        const adminSupa = await createAdminClient()
        const { data: rtmCliente } = await adminSupa
            .schema('report_utm')
            .from('clientes')
            .select('public_cliente_id')
            .eq('id', params.cliente_id)
            .maybeSingle()
        if (rtmCliente?.public_cliente_id) {
            q = q.eq('cliente_id', rtmCliente.public_cliente_id)
        } else {
            return []
        }
    }

    const { data, error } = await q
    if (error || !data) return []

    const grouping = params.date_grouping ?? 'day'
    const map = new Map<string, { spend: number; clicks: number; impressions: number }>()

    for (const r of data as Record<string, unknown>[]) {
        let dim = 'total'
        if (params.dimension === 'date') {
            const fecha = String(r.fecha ?? '')
            dim = truncateDate(fecha, grouping)
        }
        const entry = map.get(dim) ?? { spend: 0, clicks: 0, impressions: 0 }
        entry.spend       += Number(r.meta_spend ?? 0) + Number(r.tiktok_spend ?? 0)
        entry.clicks      += Number(r.meta_clicks ?? 0) + Number(r.tiktok_clicks ?? 0)
        entry.impressions += Number(r.meta_impressions ?? 0) + Number(r.tiktok_impressions ?? 0)
        map.set(dim, entry)
    }

    return Array.from(map.entries()).map(([dim, v]) => ({ dim, ...v }))
}

// ── Merge ─────────────────────────────────────────────────────────────

function mergeResults(
    params: BiQueryParams,
    leadsData: Array<{ dim: string | null; count: number }>,
    salesData: Array<{ dim: string | null; sales: number; revenue: number }>,
    adsData:   Array<{ dim: string | null; spend: number; clicks: number; impressions: number }>
): BiQueryRow[] {
    const keys = new Set<string>()
    leadsData.forEach(r => keys.add(r.dim ?? 'total'))
    salesData.forEach(r => keys.add(r.dim ?? 'total'))
    adsData.forEach(r => keys.add(r.dim ?? 'total'))

    if (keys.size === 0) {
        if (params.dimension === 'none') keys.add('total')
        else return []
    }

    const rows: BiQueryRow[] = []
    for (const key of keys) {
        const lead  = leadsData.find(r => (r.dim ?? 'total') === key)
        const sale  = salesData.find(r => (r.dim ?? 'total') === key)
        const ad    = adsData.find(r => (r.dim ?? 'total') === key)

        const leads_count = lead?.count ?? 0
        const sales_count = sale?.sales ?? 0
        const revenue     = Number((sale?.revenue ?? 0).toFixed(2))
        const spend       = Number((ad?.spend ?? 0).toFixed(2))
        const clicks      = ad?.clicks ?? 0
        const impressions = ad?.impressions ?? 0

        const row: BiQueryRow = { dimension_value: key === 'total' ? null : key }

        if (params.metrics.includes('leads_count'))     row.leads_count     = leads_count
        if (params.metrics.includes('sales_count'))     row.sales_count     = sales_count
        if (params.metrics.includes('revenue'))         row.revenue         = revenue
        if (params.metrics.includes('spend'))           row.spend           = spend
        if (params.metrics.includes('clicks'))          row.clicks          = clicks
        if (params.metrics.includes('impressions'))     row.impressions     = impressions
        if (params.metrics.includes('cpl'))             row.cpl             = leads_count > 0 && spend > 0 ? round2(spend / leads_count) : null
        if (params.metrics.includes('cpa'))             row.cpa             = sales_count > 0 && spend > 0 ? round2(spend / sales_count) : null
        if (params.metrics.includes('roas'))            row.roas            = spend > 0 ? round2(revenue / spend) : null
        if (params.metrics.includes('conversion_rate')) row.conversion_rate = leads_count > 0 ? round2((sales_count / leads_count) * 100) : null
        if (params.metrics.includes('cpc'))             row.cpc             = clicks > 0 && spend > 0 ? round2(spend / clicks) : null
        if (params.metrics.includes('cpm'))             row.cpm             = impressions > 0 && spend > 0 ? round2((spend / impressions) * 1000) : null

        // Campos calculados: se evalúan sobre las métricas base de la fila.
        if (params.calculated?.length) {
            const baseValues: Record<string, number> = {
                leads_count, sales_count, revenue, spend, clicks, impressions,
                cpl: Number(row.cpl ?? 0),
                cpa: Number(row.cpa ?? 0),
                roas: Number(row.roas ?? 0),
                conversion_rate: Number(row.conversion_rate ?? 0),
                cpc: Number(row.cpc ?? 0),
                cpm: Number(row.cpm ?? 0),
            }
            for (const cf of params.calculated) {
                row[cf.name] = evaluateExpression(cf.expression, baseValues)
            }
        }

        rows.push(row)
    }

    // Orden: por la primera métrica solicitada (o el campo de orden).
    const sortMetric = params.metrics[0]
    const dir = params.sort === 'asc' ? 1 : -1
    rows.sort((a, b) => {
        const av = Number(a[sortMetric as keyof BiQueryRow] ?? 0)
        const bv = Number(b[sortMetric as keyof BiQueryRow] ?? 0)
        return (bv - av) * (dir === 1 ? -1 : 1)
    })

    // Top-N: si hay dimensión y límite, recortar tras ordenar.
    if (params.dimension !== 'none' && params.limit && rows.length > params.limit) {
        return rows.slice(0, params.limit)
    }
    return rows
}

// ── Comparación de períodos ───────────────────────────────────────────

export interface ComparisonResult {
    current: BiQueryRow[]
    previous: BiQueryRow[]
}

/**
 * Ejecuta la query para el período actual y el inmediatamente anterior
 * (mismo número de días, desplazado hacia atrás). Útil para scorecards
 * con delta % vs período anterior (estilo Looker Studio).
 */
export async function runComparison(params: BiQueryParams): Promise<ComparisonResult> {
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    const from = new Date(dateFrom + 'T00:00:00Z')
    const to   = new Date(dateTo + 'T00:00:00Z')
    const spanDays = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400_000) + 1)

    const prevTo   = new Date(from.getTime() - 86400_000)
    const prevFrom = new Date(prevTo.getTime() - (spanDays - 1) * 86400_000)

    const [current, previous] = await Promise.all([
        runBiQuery(params),
        runBiQuery({
            ...params,
            date_from: prevFrom.toISOString().slice(0, 10),
            date_to:   prevTo.toISOString().slice(0, 10),
        }),
    ])

    return { current, previous }
}

// ── Pivot query (dimensión secundaria) ────────────────────────────────

/**
 * Agrupa por una dimensión primaria y abre series por una secundaria,
 * para gráficas apiladas / combo. Soporta métricas de leads y ventas
 * (que tienen las columnas UTM). Devuelve filas pivoteadas.
 */
export async function runPivotQuery(
    params: BiQueryParams,
    metric: BiMetric
): Promise<{ rows: BiPivotRow[]; seriesKeys: string[] }> {
    const supabase = await createAdminClient()
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)
    const dim1 = params.dimension
    const dim2 = params.dimension2!
    const lim  = Math.min(params.limit ?? 1000, 5000)

    const isSales = metric === 'sales_count' || metric === 'revenue'
    const table = isSales ? 'sales_events' : 'lead_events'

    const cols = new Set<string>(['id', 'created_at'])
    if (isSales) { cols.add('amount'); cols.add('status'); cols.add('platform') }
    if (dim1 !== 'none' && dim1 !== 'date' && dim1 !== 'platform') cols.add(dim1)
    if (dim2 !== 'none' && dim2 !== 'date' && dim2 !== 'platform') cols.add(dim2)

    let q = supabase
        .schema('report_utm')
        .from(table)
        .select(Array.from(cols).join(','))
        .gte('created_at', dateFrom + 'T00:00:00')
        .lte('created_at', dateTo + 'T23:59:59')
        .limit(lim)

    if (isSales) q = q.eq('status', 'approved')
    if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
    q = applyDimFilters(q, params.filters)

    const { data, error } = await q
    if (error || !data) return { rows: [], seriesKeys: [] }

    const grouping = params.date_grouping ?? 'day'
    const pivot = new Map<string, Map<string, number>>()
    const seriesSet = new Set<string>()

    for (const r of data as unknown as Record<string, unknown>[]) {
        const k1 = getDimValue(r, dim1, grouping)
        const k2 = getDimValue(r, dim2, grouping)
        seriesSet.add(k2)
        if (!pivot.has(k1)) pivot.set(k1, new Map())
        const inner = pivot.get(k1)!
        const add = metric === 'revenue' ? Number(r.amount ?? 0) : 1
        inner.set(k2, (inner.get(k2) ?? 0) + add)
    }

    // Top-N series (por total) para no saturar el gráfico
    const seriesTotals = new Map<string, number>()
    for (const inner of pivot.values()) {
        for (const [k2, v] of inner) seriesTotals.set(k2, (seriesTotals.get(k2) ?? 0) + v)
    }
    const seriesKeys = Array.from(seriesTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k]) => k)

    const rows: BiPivotRow[] = Array.from(pivot.entries()).map(([dimension_value, inner]) => {
        const series: Record<string, number> = {}
        for (const k of seriesKeys) series[k] = Number((inner.get(k) ?? 0).toFixed(2))
        return { dimension_value, series }
    })

    // Orden por total de la fila, recorta a límite de filas
    rows.sort((a, b) => {
        const at = Object.values(a.series).reduce((s, v) => s + v, 0)
        const bt = Object.values(b.series).reduce((s, v) => s + v, 0)
        return bt - at
    })

    return { rows: rows.slice(0, params.limit ?? 15), seriesKeys }
}

// ── Helpers ───────────────────────────────────────────────────────────

function getDimValue(row: Record<string, unknown>, dimension: BiDimension, grouping?: DateGrouping): string {
    if (dimension === 'none') return 'total'
    if (dimension === 'date') {
        const dateStr = String(row.created_at ?? '')
        return truncateDate(dateStr.slice(0, 10), grouping ?? 'day')
    }
    return String(row[dimension] ?? '(sin valor)')
}

function truncateDate(dateStr: string, grouping: DateGrouping): string {
    if (!dateStr || dateStr.length < 10) return dateStr
    const d = new Date(dateStr + 'T12:00:00Z')
    if (grouping === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    if (grouping === 'week') {
        const day = d.getUTCDay()
        const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1)
        const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff))
        return mon.toISOString().slice(0, 10)
    }
    return dateStr.slice(0, 10)
}

function round2(n: number): number {
    return Math.round(n * 100) / 100
}

const VALID_DIM_KEYS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'ip_country', 'form_name', 'form_plugin', 'attribution_method', 'platform',
])
function isValidDimKey(key: string): boolean {
    return VALID_DIM_KEYS.has(key)
}

/**
 * Aplica filtros de dimensión a una query PostgREST. Soporta multi-valor:
 * si el valor trae comas (ej. "facebook,instagram") usa IN (...); si no, igualdad.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyDimFilters(q: any, filters?: Record<string, string>): any {
    if (!filters) return q
    for (const [k, v] of Object.entries(filters)) {
        if (!v || !isValidDimKey(k)) continue
        if (v.includes(',')) {
            const vals = v.split(',').map(s => s.trim()).filter(Boolean)
            if (vals.length) q = q.in(k, vals)
        } else {
            q = q.eq(k, v)
        }
    }
    return q
}

// ── Valores distintos de una dimensión (para slicers) ─────────────────

export async function runDistinctValues(params: {
    cliente_id?: string
    dimension: BiDimension
    date_from?: string
    date_to?: string
    filters?: Record<string, string>
    source?: 'leads' | 'sales'
    limit?: number
}): Promise<string[]> {
    const dim = params.dimension
    if (dim === 'none' || dim === 'date') return []

    const supabase = await createAdminClient()
    const dateFrom = params.date_from ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)
    const table = params.source === 'sales' ? 'sales_events' : 'lead_events'
    const col = dim === 'platform' ? 'platform' : dim

    let q = supabase
        .schema('report_utm')
        .from(table)
        .select(col)
        .gte('created_at', dateFrom + 'T00:00:00')
        .lte('created_at', dateTo + 'T23:59:59')
        .not(col, 'is', null)
        .limit(params.limit ?? 5000)

    if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
    q = applyDimFilters(q, params.filters)

    const { data, error } = await q
    if (error || !data) return []

    const set = new Set<string>()
    for (const r of data as Record<string, unknown>[]) {
        const v = r[col]
        if (v !== null && v !== undefined && String(v).trim()) set.add(String(v))
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, 500)
}

// ── Funnel query (special: returns ordered stages) ────────────────────

export async function runFunnelQuery(params: {
    cliente_id?: string
    date_from?: string
    date_to?: string
    filters?: Record<string, string>
}): Promise<{ stage: string; value: number; label: string }[]> {
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    const [adsResult, leadsResult, salesResult] = await Promise.all([
        runBiQuery({ metrics: ['impressions', 'clicks', 'spend'], dimension: 'none', ...params, date_from: dateFrom, date_to: dateTo }),
        runBiQuery({ metrics: ['leads_count'], dimension: 'none', ...params, date_from: dateFrom, date_to: dateTo }),
        runBiQuery({ metrics: ['sales_count'], dimension: 'none', ...params, date_from: dateFrom, date_to: dateTo }),
    ])

    const impressions = adsResult[0]?.impressions ?? 0
    const clicks      = adsResult[0]?.clicks      ?? 0
    const leads       = leadsResult[0]?.leads_count ?? 0
    const sales       = salesResult[0]?.sales_count ?? 0

    return [
        { stage: 'impressions', value: impressions, label: 'Impresiones' },
        { stage: 'clicks',      value: clicks,      label: 'Clics' },
        { stage: 'leads',       value: leads,       label: 'Leads' },
        { stage: 'sales',       value: sales,       label: 'Ventas' },
    ]
}
