import { createAdminClient } from '@/utils/supabase/server'
import { fetchAllRows } from '@/lib/supabase-paginate'
import type { BiMetric, BiDimension, DateGrouping, BiQueryParams, BiQueryRow, BiPivotRow, FieldAgg, AdvancedFilter } from './bi-metadata'
import {
    evaluateExpression, parseFilterValue, AD_JSONB_METRICS, AD_SCALAR_METRICS, AD_RATE_METRICS,
    MANUAL_JSONB_METRICS, OFFLINE_METRICS, SUBS_METRICS,
    METRIC_META, FUNNEL_STAGE_METRICS, DEFAULT_FUNNEL_STAGES,
    isFieldDim, parseFieldDim, parseFieldMetric,
    extractFieldMetricAliases, parseFieldNumber,
    parseOfflineFieldMetric, extractOfflineFieldAliases,
    advancedFilterHasConditions, matchFilterCondition,
    campaignNameFilterPredicate, hasCampaignFilter, hasNonAttributableFilter,
} from './bi-metadata'

// Dimensiones que SOLO existen en sales_events (no en lead_events). Al agrupar
// por ellas, la query de leads se omite (no tienen esas columnas).
const SALES_ONLY_DIMS = new Set(['product_name', 'transaction_type', 'customer_country'])
// Dimensiones que SOLO desglosan gasto/métricas de campaña por nivel de anuncio
// (del JSONB meta_ads/meta_adsets). Leads/ventas no cruzan a ese nivel.
const ADS_ONLY_DIMS = new Set(['ad', 'adset'])

// Re-export para compatibilidad con imports existentes que apuntaban acá.
export type { BiMetric, BiDimension, DateGrouping, BiQueryParams, BiQueryRow, BiPivotRow } from './bi-metadata'
export { METRIC_META, DIMENSION_META } from './bi-metadata'

// ── Main query function ───────────────────────────────────────────────

export async function runBiQuery(params: BiQueryParams): Promise<BiQueryRow[]> {
    const supabase = await createAdminClient()

    // Tokens requeridos = métricas pedidas ∪ identificadores referenciados en las
    // expresiones de campos calculados. Así un scorecard/gráfica cuyo único "metric"
    // es un campo calculado (ej. "spend / leads_count") dispara el fetch correcto.
    const required = new Set<string>(params.metrics)
    for (const cf of params.calculated ?? []) {
        for (const id of cf.expression.match(/[a-z_][a-z0-9_]*/gi) ?? []) required.add(id)
    }
    const requires = (keys: string[]) => keys.some(k => required.has(k))

    // ── Campos de formulario (raw_fields JSONB) ───────────────────────
    // Dimensión de campo (agrupar por raw_fields.<clave>) + métricas de campo
    // (sum/avg/… de un campo). Las métricas de campo pueden venir directamente
    // en params.metrics o referenciadas por alias en expresiones calculadas.
    const fieldDimKey = isFieldDim(params.dimension) ? parseFieldDim(params.dimension) : null
    const fieldMetricReqs = new Map<string, FieldMetricReq>()
    for (const m of params.metrics) {
        const p = parseFieldMetric(m)
        if (p) fieldMetricReqs.set(m, { agg: p.agg, key: p.key, outKey: m })
    }
    for (const cf of params.calculated ?? []) {
        for (const fm of extractFieldMetricAliases(cf.expression)) {
            if (!fieldMetricReqs.has(fm.alias)) {
                fieldMetricReqs.set(fm.alias, { agg: fm.agg, key: fm.key, outKey: fm.alias })
            }
        }
    }
    const fieldMetrics = Array.from(fieldMetricReqs.values())
    const isFieldDimQuery = fieldDimKey !== null

    // ── Columnas adicionales de Sheets offline (custom_fields JSONB) ───
    // Mismo patrón que los campos de formulario: token "offfield:<clave>" en
    // params.metrics o alias "off__<clave>" dentro de un campo calculado.
    const offlineFieldReqs = new Map<string, OfflineFieldReq>()
    for (const m of params.metrics) {
        const parsed = parseOfflineFieldMetric(m)
        if (parsed) offlineFieldReqs.set(m, { key: parsed.key, outKey: m, type: parsed.type })
    }
    for (const cf of params.calculated ?? []) {
        for (const of of extractOfflineFieldAliases(cf.expression)) {
            if (!offlineFieldReqs.has(of.alias)) {
                offlineFieldReqs.set(of.alias, { key: of.key, outKey: of.alias, type: 'count' })
            }
        }
    }
    const offlineFields = Array.from(offlineFieldReqs.values())

    const isSalesOnlyDim = SALES_ONLY_DIMS.has(params.dimension)
    const isAdsOnlyDim   = ADS_ONLY_DIMS.has(params.dimension)
    // Los leads no tienen columnas de producto/tipo/país ni desglose por anuncio →
    // se omite la query de leads al agrupar por esas dimensiones.
    const needsLeads = (requires(['leads_count', 'leads_total', 'cpl', 'conversion_rate']) || isFieldDimQuery || fieldMetrics.length > 0) && !isSalesOnlyDim && !isAdsOnlyDim
    // Las ventas y el gasto no se pueden desglosar por un campo de formulario
    // (sales_events / metricas_diarias no tienen raw_fields) → se omiten cuando
    // se agrupa por campo para no romper el select ni inventar una fila "(total)".
    const needsSales = !isFieldDimQuery && !isAdsOnlyDim && requires(['sales_count', 'revenue', 'cpa', 'roas', 'conversion_rate'])
    const needsAds   = !isFieldDimQuery && requires([
        'spend', 'meta_spend', 'tiktok_spend', 'cpl', 'cpa', 'roas', 'clicks', 'impressions', 'cpc', 'cpm', 'frequency', 'ctr',
        ...AD_JSONB_METRICS, ...AD_SCALAR_METRICS, ...AD_RATE_METRICS,
        ...MANUAL_JSONB_METRICS.map(m => m.metric),
        'hotmart_revenue', 'hotmart_sales', 'hotmart_roas', 'hotmart_cpa', 'hotmart_roi',
    ])
    // Offline (día×cliente) y suscripciones (snapshot) son globales/por fecha,
    // no cruzan por dimensiones de lead/venta/anuncio.
    const isBreakdownDim = isSalesOnlyDim || isAdsOnlyDim || isFieldDimQuery
    const needsOffline = !isBreakdownDim && (requires([...OFFLINE_METRICS]) || offlineFields.length > 0)
    const needsSubs    = !isBreakdownDim && requires([...SUBS_METRICS])

    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)
    const lim      = Math.min(params.limit ?? 500, 5000)

    // ── LEADS query ───────────────────────────────────────────────────
    // Conteo EXACTO (count para el total, paginación completa para agrupados).
    // El Top-N (params.limit) se aplica luego en mergeResults, no al traer filas.
    let leadsData: LeadAgg[] = []
    if (needsLeads) {
        leadsData = await queryLeadsDirect(supabase, params, dateFrom, dateTo, fieldMetrics)
    }

    // ── SALES query ───────────────────────────────────────────────────
    let salesData: Array<{ dim: string | null; sales: number; revenue: number }> = []
    if (needsSales) {
        salesData = await querySalesDirect(supabase, params, dateFrom, dateTo)
    }

    // ── ADS query (metricas_diarias) ──────────────────────────────────
    let adsData: AdRow[] = []
    if (needsAds) {
        adsData = await queryAdsDirect(supabase, params, dateFrom, dateTo, lim)
    }

    // ── OFFLINE query (conversiones_offline_diarias) ──────────────────
    let offlineData: OfflineRow[] = []
    if (needsOffline) {
        offlineData = await queryOfflineDirect(params, dateFrom, dateTo, offlineFields)
    }

    // ── SUBS query (hotmart_subscriptions_snapshot, último snapshot) ──
    let subsData: Record<string, number> | null = null
    if (needsSubs) {
        subsData = await querySubsLatest(params, dateFrom, dateTo)
    }

    // ── Merge results ─────────────────────────────────────────────────
    return mergeResults(params, leadsData, salesData, adsData, fieldMetrics, offlineData, subsData, offlineFields)
}

// ── Campos de formulario: tipos de agregación ─────────────────────────

interface FieldMetricReq { agg: FieldAgg; key: string; outKey: string }
interface FieldAcc { sum: number; n: number; min: number; max: number; present: number }
interface LeadAgg { dim: string | null; count: number; fields: Record<string, FieldAcc> }

function newFieldAcc(): FieldAcc {
    return { sum: 0, n: 0, min: Infinity, max: -Infinity, present: 0 }
}

function accumulateField(acc: FieldAcc, raw: unknown): void {
    if (raw === null || raw === undefined) return
    const s = String(raw).trim()
    if (!s) return
    acc.present++
    const num = parseFieldNumber(s)
    if (num !== null) {
        acc.sum += num
        acc.n++
        if (num < acc.min) acc.min = num
        if (num > acc.max) acc.max = num
    }
}

function fieldAggValue(acc: FieldAcc | undefined, agg: FieldAgg): number {
    if (!acc) return 0
    switch (agg) {
        case 'sum':   return round2(acc.sum)
        case 'avg':   return acc.n > 0 ? round2(acc.sum / acc.n) : 0
        case 'min':   return acc.n > 0 ? round2(acc.min) : 0
        case 'max':   return acc.n > 0 ? round2(acc.max) : 0
        case 'count': return acc.present
        default:      return 0
    }
}

// ── Filtro avanzado (Y de O): evaluación en memoria ───────────────────
// Se evalúa sobre las filas ya traídas (leads/ventas). Columnas disponibles
// por tabla: los leads tienen todas las dimensiones de lead; las ventas solo
// UTMs + plataforma (no país/formulario/campos). Una condición sobre un campo
// no disponible en esa tabla se ignora (no restringe) → el grupo O sigue.
type AdvTable = 'leads' | 'sales'
const LEAD_ADV_COLS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'ip_country', 'form_name', 'form_plugin', 'attribution_method'])
const SALES_ADV_COLS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'platform'])

function advCellValue(row: Record<string, unknown>, field: string, table: AdvTable): string | undefined {
    const fk = parseFieldDim(field)
    if (fk !== null) {
        if (table !== 'leads') return undefined
        const rf = (row.raw_fields as Record<string, unknown> | null) ?? null
        return rf && rf[fk] !== null && rf[fk] !== undefined ? String(rf[fk]) : ''
    }
    const cols = table === 'sales' ? SALES_ADV_COLS : LEAD_ADV_COLS
    if (!cols.has(field)) return undefined
    return row[field] !== null && row[field] !== undefined ? String(row[field]) : ''
}

export function evalAdvancedRow(row: Record<string, unknown>, af: AdvancedFilter | undefined, table: AdvTable): boolean {
    if (!af?.groups?.length) return true
    for (const g of af.groups) {
        const conds = (g.conditions ?? []).filter(c => c.field && c.value && c.value.trim())
        if (!conds.length) continue
        let applicable = false, pass = false
        for (const c of conds) {
            const cell = advCellValue(row, c.field, table)
            if (cell === undefined) continue   // campo no disponible en esta tabla → se ignora
            applicable = true
            if (matchFilterCondition(cell, c.op, c.value)) { pass = true; break }
        }
        if (applicable && !pass) return false  // el grupo tenía condiciones aplicables y ninguna matcheó
    }
    return true
}

/** Columnas que hay que traer para poder evaluar el filtro avanzado en una tabla. */
export function collectAdvancedColumns(af: AdvancedFilter | undefined, table: AdvTable): { cols: string[]; needsRawFields: boolean } {
    const cols = new Set<string>()
    let needsRawFields = false
    for (const g of af?.groups ?? []) {
        for (const c of g.conditions ?? []) {
            if (!c.field || !c.value || !c.value.trim()) continue
            if (parseFieldDim(c.field) !== null) { if (table === 'leads') needsRawFields = true; continue }
            const set = table === 'sales' ? SALES_ADV_COLS : LEAD_ADV_COLS
            if (set.has(c.field)) cols.add(c.field)
        }
    }
    return { cols: Array.from(cols), needsRawFields }
}

// ── Direct PostgREST queries (no raw SQL needed) ──────────────────────

async function queryLeadsDirect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    fieldMetrics: FieldMetricReq[]
): Promise<LeadAgg[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyBase = (q: any) => {
        q = q.gte('created_at', dateFrom + 'T00:00:00').lte('created_at', dateTo + 'T23:59:59')
        if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
        return applyDimFilters(q, params.filters, leadFilterKey)
    }

    const fieldKeys = [...new Set(fieldMetrics.map(f => f.key))]
    const adv = params.advancedFilter
    const advCols = collectAdvancedColumns(adv, 'leads')
    const hasAdv = advancedFilterHasConditions(adv) && (advCols.cols.length > 0 || advCols.needsRawFields)
    const needsRawFields = isFieldDim(params.dimension) || fieldKeys.length > 0 || advCols.needsRawFields

    // Total sin agregar campos ni filtro avanzado: conteo EXACTO (head + count).
    if (params.dimension === 'none' && fieldKeys.length === 0 && !hasAdv) {
        const { count, error } = await applyBase(
            supabase.schema('report_utm').from('lead_events').select('id', { count: 'exact', head: true })
        )
        if (error) return []
        return [{ dim: 'total', count: count ?? 0, fields: {} }]
    }

    // Agrupado / métricas de campo / filtro avanzado: traer filas (paginado) y agrupar.
    let rows = await fetchAllRows(() =>
        applyBase(supabase.schema('report_utm').from('lead_events').select(buildLeadSelect(params.dimension, needsRawFields, advCols.cols)))
    )
    if (hasAdv) rows = rows.filter(r => evalAdvancedRow(r, adv, 'leads'))
    return aggregateLeads(rows, params.dimension, params.date_grouping, fieldKeys)
}

function buildLeadSelect(dimension: BiDimension, needsRawFields: boolean, extraCols: string[] = []): string {
    const cols = new Set<string>(['id', 'created_at'])
    if (dimension !== 'none' && dimension !== 'date' && !isFieldDim(dimension)) cols.add(dimension)
    if (needsRawFields) cols.add('raw_fields')
    for (const c of extraCols) cols.add(c)
    return Array.from(cols).join(',')
}

function aggregateLeads(
    rows: Record<string, unknown>[],
    dimension: BiDimension,
    grouping: DateGrouping | undefined,
    fieldKeys: string[]
): LeadAgg[] {
    const map = new Map<string, LeadAgg>()
    for (const r of rows) {
        const dim = getDimValue(r, dimension, grouping)
        let entry = map.get(dim)
        if (!entry) { entry = { dim, count: 0, fields: {} }; map.set(dim, entry) }
        entry.count++
        if (fieldKeys.length) {
            const rf = (r.raw_fields as Record<string, unknown> | null) ?? null
            for (const key of fieldKeys) {
                let acc = entry.fields[key]
                if (!acc) { acc = newFieldAcc(); entry.fields[key] = acc }
                accumulateField(acc, rf ? rf[key] : null)
            }
        }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count)
}

async function querySalesDirect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string
): Promise<Array<{ dim: string | null; sales: number; revenue: number }>> {
    const adv = params.advancedFilter
    const advCols = collectAdvancedColumns(adv, 'sales')
    const hasAdv = advancedFilterHasConditions(adv) && advCols.cols.length > 0

    const selectCols = new Set<string>(['id', 'created_at', 'amount', 'status', 'platform'])
    if (params.dimension !== 'none' && params.dimension !== 'date' && !isFieldDim(params.dimension)) selectCols.add(params.dimension)
    for (const c of advCols.cols) selectCols.add(c)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyBase = (q: any) => {
        q = q.gte('created_at', dateFrom + 'T00:00:00')
            .lte('created_at', dateTo + 'T23:59:59')
            .eq('status', 'approved')
        if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
        return applyDimFilters(q, params.filters, salesFilterKey)
    }

    // Traer TODAS las ventas aprobadas (paginado) para sumar revenue exacto.
    let data = await fetchAllRows(() =>
        applyBase(supabase.schema('report_utm').from('sales_events').select(Array.from(selectCols).join(',')))
    )
    if (hasAdv) data = data.filter(r => evalAdvancedRow(r, adv, 'sales'))

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

interface AdRow {
    dim: string | null
    spend: number
    clicks: number
    impressions: number
    [metric: string]: number | string | null   // métricas de campaña adicionales (del JSONB)
}

function newAdEntry(): Record<string, number> {
    const e: Record<string, number> = { spend: 0, meta_spend: 0, tiktok_spend: 0, clicks: 0, impressions: 0 }
    for (const k of AD_JSONB_METRICS) e[k] = 0
    for (const k of AD_SCALAR_METRICS) e[k] = 0
    for (const { metric } of MANUAL_JSONB_METRICS) e[metric] = 0
    // Acumuladores para promediar tasas GA4 ponderadas por sesiones.
    e._ga_bounce_wsum = 0
    e._ga_dur_wsum = 0
    return e
}

async function queryAdsDirect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    lim: number
): Promise<AdRow[]> {
    // metricas_diarias lives in the public schema. Se leen las columnas escalares
    // (gasto/clics/impresiones, fiables) + el JSONB meta_campaigns para sumar el
    // resto de métricas de campaña (alcance, video, compras, resultados…).
    const adBreakdown = ADS_ONLY_DIMS.has(params.dimension)
        ? (params.dimension === 'ad' ? 'meta_ads' : 'meta_adsets')
        : null

    // ── Aplicación de filtros al gasto ─────────────────────────────────
    // metricas_diarias está preagregada por día×cliente, sin UTM ni campos; el
    // único puente UTM→gasto es el NOMBRE de campaña (JSONB meta/tiktok_campaigns).
    //   • Filtro NO atribuible (país/formulario/campo/plataforma) → el gasto no
    //     puede recortarse → se devuelve vacío (mergeResults deja spend=0 y ratios
    //     null; la UI muestra el aviso "gasto no atribuible a este filtro").
    //   • Filtro de campaña activo → el gasto se deriva del JSONB por campaña,
    //     conservando solo las campañas cuyo nombre pasa el filtro (conserva el
    //     desglose por fecha/ad/adset). Las métricas escalares sin desglose por
    //     campaña (GA4, Hotmart, etc.) no son atribuibles → quedan en 0.
    //   • Otros filtros UTM (source/medium/content/term/id) sin mapeo limpio a
    //     gasto por campaña → se deja el gasto a nivel cuenta (comportamiento actual).
    if (hasNonAttributableFilter(params.filters, params.advancedFilter)) return []
    if (hasCampaignFilter(params.filters, params.advancedFilter)) {
        return queryAdsCampaignFiltered(
            params, dateFrom, dateTo, lim, adBreakdown,
            campaignNameFilterPredicate(params.filters, params.advancedFilter),
        )
    }

    const adCols = [
        'fecha', 'meta_spend', 'tiktok_spend', 'meta_clicks', 'tiktok_clicks',
        'meta_impressions', 'tiktok_impressions',
        ...AD_SCALAR_METRICS, ...AD_RATE_METRICS,
        // Métricas cargadas a mano por el equipo (ventas cerradas): viven en este
        // JSONB, no en una columna propia.
        'metricas_manuales',
        ...(adBreakdown ? [adBreakdown] : ['meta_campaigns']),
    ]
    let q = (await (await import('@/utils/supabase/server')).createAdminClient())
        .from('metricas_diarias')
        .select(adCols.join(','))
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
    const map = new Map<string, Record<string, number>>()

    // ── Desglose por anuncio/conjunto: agrupar el JSONB por ad_name/adset_name ──
    if (adBreakdown) {
        const nameKey = adBreakdown === 'meta_ads' ? 'ad_name' : 'adset_name'
        for (const r of data as unknown as Record<string, unknown>[]) {
            const elems = (r[adBreakdown] as Record<string, unknown>[] | null) ?? []
            for (const el of elems) {
                const key = String(el[nameKey] ?? '').trim() || '(sin nombre)'
                let entry = map.get(key)
                if (!entry) { entry = newAdEntry(); map.set(key, entry) }
                const sp = Number(el.spend ?? 0)
                entry.meta_spend += sp
                entry.spend      += sp
                entry.clicks      += Number(el.clicks ?? 0)
                entry.impressions += Number(el.impressions ?? 0)
                for (const k of AD_JSONB_METRICS) entry[k] += Number(el[k] ?? 0)
            }
        }
        return Array.from(map.entries())
            .map(([dim, v]) => ({ dim, ...v } as AdRow))
            .sort((a, b) => b.spend - a.spend)
            .slice(0, lim)
    }

    for (const r of data as unknown as Record<string, unknown>[]) {
        let dim = 'total'
        if (params.dimension === 'date') {
            const fecha = String(r.fecha ?? '')
            dim = truncateDate(fecha, grouping)
        }
        let entry = map.get(dim)
        if (!entry) { entry = newAdEntry(); map.set(dim, entry) }
        const metaSpend   = Number(r.meta_spend ?? 0)
        const tiktokSpend = Number(r.tiktok_spend ?? 0)
        entry.meta_spend   += metaSpend
        entry.tiktok_spend += tiktokSpend
        entry.spend        += metaSpend + tiktokSpend
        entry.clicks      += Number(r.meta_clicks ?? 0) + Number(r.tiktok_clicks ?? 0)
        entry.impressions += Number(r.meta_impressions ?? 0) + Number(r.tiktok_impressions ?? 0)
        // Métricas escalares aditivas (GA4 sesiones, TikTok conv., Hotmart ventas…)
        for (const k of AD_SCALAR_METRICS) entry[k] += Number(r[k] ?? 0)
        // Métricas manuales del dashboard (JSONB metricas_manuales).
        const manuales = (r.metricas_manuales ?? {}) as Record<string, unknown>
        for (const { metric, jsonKey } of MANUAL_JSONB_METRICS) {
            entry[metric] += Number(manuales[jsonKey] ?? 0) || 0
        }
        // Tasas GA4: promedio ponderado por sesiones (acumular numerador).
        const gaSess = Number(r.ga_sessions ?? 0)
        entry._ga_bounce_wsum += Number(r.ga_bounce_rate ?? 0) * gaSess
        entry._ga_dur_wsum    += Number(r.ga_avg_session_duration ?? 0) * gaSess
        // Resto de métricas de campaña desde el JSONB meta_campaigns (TikTok no las trae)
        const camps = (r.meta_campaigns as Record<string, unknown>[] | null) ?? []
        for (const c of camps) {
            for (const k of AD_JSONB_METRICS) entry[k] += Number(c[k] ?? 0)
        }
    }

    return Array.from(map.entries()).map(([dim, v]) => ({ dim, ...v } as AdRow))
}

/**
 * Gasto recortado por NOMBRE de campaña. Deriva el gasto del JSONB por campaña
 * (meta_campaigns / tiktok_campaigns) fila-día, conservando solo las campañas
 * cuyo nombre pasa `nameMatches`, y reagregando por la dimensión pedida
 * (total / date / ad / adset). Las métricas escalares sin desglose por campaña
 * (GA4, Hotmart, TikTok conv.) no son atribuibles → quedan en 0.
 */
async function queryAdsCampaignFiltered(
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    lim: number,
    adBreakdown: 'meta_ads' | 'meta_adsets' | null,
    nameMatches: (name: string) => boolean,
): Promise<AdRow[]> {
    const db = await createAdminClient()

    let publicId: string | null = null
    if (params.cliente_id) {
        publicId = await resolvePublicClienteId(params.cliente_id)
        if (!publicId) return []
    }

    const cols = ['fecha', 'meta_campaigns', 'tiktok_campaigns', ...(adBreakdown ? [adBreakdown] : [])]
    let q = db.from('metricas_diarias').select(cols.join(',')).gte('fecha', dateFrom).lte('fecha', dateTo).limit(lim)
    if (publicId) q = q.eq('cliente_id', publicId)

    const { data, error } = await q
    if (error || !data) return []

    const grouping = params.date_grouping ?? 'day'
    const map = new Map<string, Record<string, number>>()

    // ── Desglose por anuncio/conjunto: solo elementos de campañas que matchean ──
    if (adBreakdown) {
        const nameKey = adBreakdown === 'meta_ads' ? 'ad_name' : 'adset_name'
        for (const r of data as unknown as Record<string, unknown>[]) {
            // campaign_id de las campañas Meta cuyo nombre pasa el filtro.
            const okCampIds = new Set<string>()
            for (const c of (r.meta_campaigns as Record<string, unknown>[] | null) ?? []) {
                if (nameMatches(String(c.name ?? '')) && c.campaign_id != null) okCampIds.add(String(c.campaign_id))
            }
            for (const el of (r[adBreakdown] as Record<string, unknown>[] | null) ?? []) {
                const cid = el.campaign_id != null ? String(el.campaign_id) : null
                if (!cid || !okCampIds.has(cid)) continue
                const key = String(el[nameKey] ?? '').trim() || '(sin nombre)'
                let entry = map.get(key)
                if (!entry) { entry = newAdEntry(); map.set(key, entry) }
                const sp = Number(el.spend ?? 0)
                entry.meta_spend += sp
                entry.spend      += sp
                entry.clicks      += Number(el.clicks ?? 0)
                entry.impressions += Number(el.impressions ?? 0)
                for (const k of AD_JSONB_METRICS) entry[k] += Number(el[k] ?? 0)
            }
        }
        return Array.from(map.entries())
            .map(([dim, v]) => ({ dim, ...v } as AdRow))
            .sort((a, b) => b.spend - a.spend)
            .slice(0, lim)
    }

    for (const r of data as unknown as Record<string, unknown>[]) {
        const dim = params.dimension === 'date' ? truncateDate(String(r.fecha ?? ''), grouping) : 'total'
        let entry = map.get(dim)
        if (!entry) { entry = newAdEntry(); map.set(dim, entry) }
        for (const c of (r.meta_campaigns as Record<string, unknown>[] | null) ?? []) {
            if (!nameMatches(String(c.name ?? ''))) continue
            const sp = Number(c.spend ?? 0)
            entry.meta_spend   += sp
            entry.spend        += sp
            entry.clicks      += Number(c.clicks ?? 0)
            entry.impressions += Number(c.impressions ?? 0)
            for (const k of AD_JSONB_METRICS) entry[k] += Number(c[k] ?? 0)
        }
        for (const c of (r.tiktok_campaigns as Record<string, unknown>[] | null) ?? []) {
            if (!nameMatches(String(c.name ?? ''))) continue
            const sp = Number(c.spend ?? 0)
            entry.tiktok_spend += sp
            entry.spend        += sp
            entry.clicks      += Number(c.clicks ?? 0)
            entry.impressions += Number(c.impressions ?? 0)
        }
    }

    return Array.from(map.entries()).map(([dim, v]) => ({ dim, ...v } as AdRow))
}

// ── Offline (conversiones_offline_diarias) ────────────────────────────

interface OfflineRow {
    dim: string | null
    offline_leads: number; offline_ventas: number; offline_revenue: number; offline_total: number
    /** Columnas adicionales del Sheet solicitadas (clave sanitizada → valor). */
    fields: Record<string, number>
}

/**
 * Columna adicional de Sheet pedida en la query. `type` viene del propio token
 * (`offfield:<tipo>:<clave>`); los alias de expresión calculada no lo llevan y
 * agregan por suma.
 */
interface OfflineFieldReq { key: string; outKey: string; type: 'count' | 'currency' | 'percentage' }

/** Resuelve el public cliente_id enlazado a un cliente report_utm (o null). */
async function resolvePublicClienteId(rtmClienteId: string): Promise<string | null> {
    const adminSupa = await createAdminClient()
    const { data } = await adminSupa
        .schema('report_utm').from('clientes')
        .select('public_cliente_id').eq('id', rtmClienteId).maybeSingle()
    return data?.public_cliente_id ?? null
}

async function queryOfflineDirect(
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    offlineFields: OfflineFieldReq[] = []
): Promise<OfflineRow[]> {
    const db = await createAdminClient()
    const needsFields = offlineFields.length > 0
    let q = db.from('conversiones_offline_diarias')
        .select(needsFields
            ? 'fecha,tipo,total_cantidad,total_valor,custom_fields'
            : 'fecha,tipo,total_cantidad,total_valor')
        .gte('fecha', dateFrom).lte('fecha', dateTo)

    if (params.cliente_id) {
        const publicId = await resolvePublicClienteId(params.cliente_id)
        if (!publicId) return []
        q = q.eq('cliente_id', publicId)
    }

    const { data, error } = await q
    if (error || !data) return []

    const grouping = params.date_grouping ?? 'day'
    const map = new Map<string, OfflineRow>()
    // Los porcentajes no se suman: se promedian ponderados por la cantidad de la
    // fila, igual que al agregar el Sheet (computeConversionesAggregates).
    const pct = new Map<string, Record<string, { total: number; weight: number }>>()

    for (const r of data as unknown as Record<string, unknown>[]) {
        const dim = params.dimension === 'date' ? truncateDate(String(r.fecha ?? ''), grouping) : 'total'
        let e = map.get(dim)
        if (!e) {
            e = { dim, offline_leads: 0, offline_ventas: 0, offline_revenue: 0, offline_total: 0, fields: {} }
            map.set(dim, e)
            pct.set(dim, {})
        }
        const qty = Number(r.total_cantidad ?? 0)
        const val = Number(r.total_valor ?? 0)
        if (r.tipo === 'lead')  e.offline_leads  += qty
        if (r.tipo === 'venta') e.offline_ventas += qty
        e.offline_revenue += val
        e.offline_total   += qty

        if (needsFields) {
            const custom = (r.custom_fields ?? {}) as Record<string, unknown>
            for (const f of offlineFields) {
                const v = Number(custom[f.key] ?? 0)
                if (!Number.isFinite(v)) continue
                if (f.type === 'percentage') {
                    const acc = pct.get(dim)!
                    if (!acc[f.key]) acc[f.key] = { total: 0, weight: 0 }
                    acc[f.key].total  += v * qty
                    acc[f.key].weight += qty
                } else {
                    e.fields[f.key] = (e.fields[f.key] ?? 0) + v
                }
            }
        }
    }

    for (const [dim, acc] of pct) {
        const e = map.get(dim)
        if (!e) continue
        for (const [k, { total, weight }] of Object.entries(acc)) {
            e.fields[k] = weight > 0 ? round2(total / weight) : 0
        }
    }

    return Array.from(map.values())
}

// ── Suscripciones (último snapshot de hotmart_subscriptions_snapshot) ──

/**
 * Toma el snapshot MÁS RECIENTE (captured_date ≤ dateTo) del cliente. Es una
 * foto puntual, no una serie temporal → solo aplica a nivel global ("(total)").
 */
async function querySubsLatest(params: BiQueryParams, _dateFrom: string, dateTo: string): Promise<Record<string, number> | null> {
    if (!params.cliente_id) return null
    const publicId = await resolvePublicClienteId(params.cliente_id)
    if (!publicId) return null
    const db = await createAdminClient()
    const { data } = await db.from('hotmart_subscriptions_snapshot')
        .select('active_count,delayed_count,canceled_count,total_count,active_recurring_value,captured_date')
        .eq('cliente_id', publicId)
        .lte('captured_date', dateTo)
        .order('captured_date', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (!data) return null
    return {
        subs_active:   Number(data.active_count ?? 0),
        subs_delayed:  Number(data.delayed_count ?? 0),
        subs_canceled: Number(data.canceled_count ?? 0),
        subs_total:    Number(data.total_count ?? 0),
        subs_mrr:      Number(data.active_recurring_value ?? 0),
    }
}

// ── Merge ─────────────────────────────────────────────────────────────

function mergeResults(
    params: BiQueryParams,
    leadsData: LeadAgg[],
    salesData: Array<{ dim: string | null; sales: number; revenue: number }>,
    adsData:   AdRow[],
    fieldMetrics: FieldMetricReq[],
    offlineData: OfflineRow[] = [],
    subsData: Record<string, number> | null = null,
    offlineFields: OfflineFieldReq[] = []
): BiQueryRow[] {
    const keys = new Set<string>()
    leadsData.forEach(r => keys.add(r.dim ?? 'total'))
    salesData.forEach(r => keys.add(r.dim ?? 'total'))
    adsData.forEach(r => keys.add(r.dim ?? 'total'))
    offlineData.forEach(r => keys.add(r.dim ?? 'total'))
    if (subsData) keys.add('total')   // snapshot: solo a nivel global

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
        const spend        = Number((ad?.spend ?? 0).toFixed(2))
        const meta_spend   = Number((Number(ad?.meta_spend ?? 0)).toFixed(2))
        const tiktok_spend = Number((Number(ad?.tiktok_spend ?? 0)).toFixed(2))
        const clicks      = ad?.clicks ?? 0
        const impressions = ad?.impressions ?? 0
        const reach       = Number(ad?.reach ?? 0)
        // Derivadas GA4 / Hotmart
        const gaSessions    = Number(ad?.ga_sessions ?? 0)
        // ga_bounce_rate se guarda como fracción 0-1 → se emite en % (0-100).
        const gaBounceRate  = gaSessions > 0 ? round2((Number(ad?._ga_bounce_wsum ?? 0) / gaSessions) * 100) : null
        const gaAvgDuration = gaSessions > 0 ? round2(Number(ad?._ga_dur_wsum ?? 0) / gaSessions) : null
        const hotmartRevenue = round2(Number(ad?.ventas_principal ?? 0) + Number(ad?.ventas_bump ?? 0) + Number(ad?.ventas_upsell ?? 0))
        const hotmartSales   = Number(ad?.ventas_principal_count ?? 0) + Number(ad?.ventas_bump_count ?? 0) + Number(ad?.ventas_upsell_count ?? 0)

        const row: BiQueryRow = { dimension_value: key === 'total' ? null : key }

        if (params.metrics.includes('leads_count'))     row.leads_count     = leads_count
        // Compat: 'leads_total' era un duplicado exacto de leads_count (mismo conteo
        // de-duplicado de lead_events, que ya abarca todos los canales) y se retiró del
        // catálogo. Se sigue respondiendo para layouts anteriores a la migración 045.
        if ((params.metrics as string[]).includes('leads_total')) row.leads_total = leads_count
        if (params.metrics.includes('sales_count'))     row.sales_count     = sales_count
        if (params.metrics.includes('revenue'))         row.revenue         = revenue
        if (params.metrics.includes('spend'))           row.spend           = spend
        if (params.metrics.includes('meta_spend'))      row.meta_spend      = meta_spend
        if (params.metrics.includes('tiktok_spend'))    row.tiktok_spend    = tiktok_spend
        if (params.metrics.includes('clicks'))          row.clicks          = clicks
        if (params.metrics.includes('impressions'))     row.impressions     = impressions
        if (params.metrics.includes('cpl'))             row.cpl             = leads_count > 0 && spend > 0 ? round2(spend / leads_count) : null
        if (params.metrics.includes('cpa'))             row.cpa             = sales_count > 0 && spend > 0 ? round2(spend / sales_count) : null
        if (params.metrics.includes('roas'))            row.roas            = spend > 0 ? round2(revenue / spend) : null
        if (params.metrics.includes('conversion_rate')) row.conversion_rate = leads_count > 0 ? round2((sales_count / leads_count) * 100) : null
        if (params.metrics.includes('cpc'))             row.cpc             = clicks > 0 && spend > 0 ? round2(spend / clicks) : null
        if (params.metrics.includes('cpm'))             row.cpm             = impressions > 0 && spend > 0 ? round2((spend / impressions) * 1000) : null
        // Métricas de campaña aditivas (del JSONB) + ratios recalculados
        for (const k of AD_JSONB_METRICS) {
            if (params.metrics.includes(k)) row[k] = Number(ad?.[k] ?? 0)
        }
        if (params.metrics.includes('frequency')) row.frequency = reach > 0 ? round2(impressions / reach) : null
        if (params.metrics.includes('ctr'))       row.ctr       = impressions > 0 ? round2((clicks / impressions) * 100) : null
        // Métricas escalares aditivas (GA4 sesiones, TikTok conv., Hotmart ventas…)
        for (const k of AD_SCALAR_METRICS) {
            if (params.metrics.includes(k as BiMetric)) row[k] = Number(ad?.[k] ?? 0)
        }
        // Métricas manuales del dashboard (JSONB metricas_manuales)
        for (const { metric } of MANUAL_JSONB_METRICS) {
            if (params.metrics.includes(metric as BiMetric)) row[metric] = Number(ad?.[metric] ?? 0)
        }
        // GA4 tasas (promedio ponderado) + convenientes Hotmart (computadas)
        if (params.metrics.includes('ga_bounce_rate'))          row.ga_bounce_rate          = gaBounceRate
        if (params.metrics.includes('ga_avg_session_duration')) row.ga_avg_session_duration = gaAvgDuration
        if (params.metrics.includes('hotmart_revenue'))         row.hotmart_revenue         = hotmartRevenue
        if (params.metrics.includes('hotmart_sales'))           row.hotmart_sales           = hotmartSales
        // Retorno sobre la facturación agregada de Hotmart. Alternativa a
        // roas/cpa (que dependen de sales_events) para clientes que venden por
        // Hotmart sin webhook de ventas configurado.
        //
        // Exigen que AMBAS partes existan (mismo criterio que cpl/cpa): un cliente
        // que no vende por Hotmart mostraría si no un ROAS de 0 y un ROI de -100%,
        // que se leen como "se perdió toda la inversión" en vez de "sin datos".
        if (params.metrics.includes('hotmart_roas')) row.hotmart_roas = spend > 0 && hotmartRevenue > 0 ? round2(hotmartRevenue / spend) : null
        if (params.metrics.includes('hotmart_cpa'))  row.hotmart_cpa  = spend > 0 && hotmartSales > 0 ? round2(spend / hotmartSales) : null
        if (params.metrics.includes('hotmart_roi'))  row.hotmart_roi  = spend > 0 && hotmartRevenue > 0 ? round2(((hotmartRevenue - spend) / spend) * 100) : null
        // Conversiones offline
        const off = offlineData.find(r => (r.dim ?? 'total') === key)
        if (params.metrics.includes('offline_leads'))   row.offline_leads   = off?.offline_leads   ?? 0
        if (params.metrics.includes('offline_ventas'))  row.offline_ventas  = off?.offline_ventas  ?? 0
        if (params.metrics.includes('offline_revenue')) row.offline_revenue = round2(off?.offline_revenue ?? 0)
        if (params.metrics.includes('offline_total'))   row.offline_total   = off?.offline_total   ?? 0
        // Columnas adicionales del Sheet: se emiten por su token y quedan
        // disponibles por alias para los campos calculados.
        const offlineFieldValues: Record<string, number> = {}
        for (const of of offlineFields) {
            const v = off?.fields[of.key] ?? 0
            offlineFieldValues[of.outKey] = v
            if ((params.metrics as string[]).includes(of.outKey)) row[of.outKey] = v
        }
        // Suscripciones (snapshot): solo en la fila global "(total)"
        if (subsData && key === 'total') {
            for (const k of SUBS_METRICS) {
                if (params.metrics.includes(k)) row[k] = subsData[k] ?? 0
            }
        }

        // Métricas de campo de formulario (sum/avg/min/max/count de raw_fields).
        const fieldValues: Record<string, number> = {}
        for (const fm of fieldMetrics) {
            const v = fieldAggValue(lead?.fields[fm.key], fm.agg)
            fieldValues[fm.outKey] = v
            if (params.metrics.includes(fm.outKey as BiMetric)) row[fm.outKey] = v
        }

        // Campos calculados: se evalúan sobre las métricas base de la fila.
        if (params.calculated?.length) {
            const baseValues: Record<string, number> = {
                leads_count, sales_count, revenue, spend, meta_spend, tiktok_spend, clicks, impressions, reach,
                leads_total: leads_count,
                cpl: Number(row.cpl ?? 0),
                cpa: Number(row.cpa ?? 0),
                roas: Number(row.roas ?? 0),
                conversion_rate: Number(row.conversion_rate ?? 0),
                cpc: Number(row.cpc ?? 0),
                cpm: Number(row.cpm ?? 0),
                frequency: reach > 0 ? round2(impressions / reach) : 0,
                ctr: impressions > 0 ? round2((clicks / impressions) * 100) : 0,
                ...fieldValues,   // aliases f_<agg>__<clave> disponibles en la expresión
            }
            for (const k of AD_JSONB_METRICS) baseValues[k] = Number(ad?.[k] ?? 0)
            for (const k of AD_SCALAR_METRICS) baseValues[k] = Number(ad?.[k] ?? 0)
            for (const { metric } of MANUAL_JSONB_METRICS) baseValues[metric] = Number(ad?.[metric] ?? 0)
            baseValues.ga_bounce_rate = gaBounceRate ?? 0
            baseValues.ga_avg_session_duration = gaAvgDuration ?? 0
            baseValues.hotmart_revenue = hotmartRevenue
            baseValues.hotmart_sales = hotmartSales
            baseValues.hotmart_roas = spend > 0 ? round2(hotmartRevenue / spend) : 0
            baseValues.hotmart_cpa  = hotmartSales > 0 && spend > 0 ? round2(spend / hotmartSales) : 0
            baseValues.hotmart_roi  = spend > 0 ? round2(((hotmartRevenue - spend) / spend) * 100) : 0
            baseValues.offline_leads   = off?.offline_leads   ?? 0
            baseValues.offline_ventas  = off?.offline_ventas  ?? 0
            baseValues.offline_revenue = round2(off?.offline_revenue ?? 0)
            baseValues.offline_total   = off?.offline_total   ?? 0
            Object.assign(baseValues, offlineFieldValues)   // alias off__<clave>
            if (subsData && key === 'total') for (const k of SUBS_METRICS) baseValues[k] = subsData[k] ?? 0
            for (const cf of params.calculated) {
                row[cf.name] = evaluateExpression(cf.expression, baseValues)
            }
        }

        rows.push(row)
    }

    // Una serie temporal se ordena por FECHA, no por valor: ordenarla por la
    // métrica dejaba la gráfica de evolución con los días descolocados
    // (18 jul, 16 jul, 19 jul…). Las claves de fecha (día 'YYYY-MM-DD', semana
    // 'YYYY-MM-DD' del lunes, mes 'YYYY-MM') ordenan bien como texto.
    if (params.dimension === 'date') {
        rows.sort((a, b) => String(a.dimension_value ?? '').localeCompare(String(b.dimension_value ?? '')))
        // Con límite se conservan los períodos MÁS RECIENTES (el final de la serie),
        // manteniendo el orden cronológico.
        if (params.limit && rows.length > params.limit) return rows.slice(-params.limit)
        return rows
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

    const isSales = metric === 'sales_count' || metric === 'revenue'
    const table = isSales ? 'sales_events' : 'lead_events'

    const cols = new Set<string>(['id', 'created_at'])
    if (isSales) { cols.add('amount'); cols.add('status'); cols.add('platform') }
    if (dim1 !== 'none' && dim1 !== 'date' && dim1 !== 'platform' && !isFieldDim(dim1)) cols.add(dim1)
    if (dim2 !== 'none' && dim2 !== 'date' && dim2 !== 'platform' && !isFieldDim(dim2)) cols.add(dim2)
    // Ventas no tienen raw_fields → una dimensión de campo sobre ventas cae en
    // "(sin valor)"; solo lead_events puede desglosar por campo de formulario.
    if (!isSales && (isFieldDim(dim1) || isFieldDim(dim2))) cols.add('raw_fields')

    // Columnas necesarias para el filtro avanzado en esta tabla.
    const adv = params.advancedFilter
    const advCols = collectAdvancedColumns(adv, isSales ? 'sales' : 'leads')
    const hasAdv = advancedFilterHasConditions(adv) && (advCols.cols.length > 0 || advCols.needsRawFields)
    for (const c of advCols.cols) cols.add(c)
    if (advCols.needsRawFields) cols.add('raw_fields')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyBase = (q: any) => {
        q = q.gte('created_at', dateFrom + 'T00:00:00').lte('created_at', dateTo + 'T23:59:59')
        if (isSales) q = q.eq('status', 'approved')
        if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
        return applyDimFilters(q, params.filters, isSales ? salesFilterKey : leadFilterKey)
    }

    // Traer TODAS las filas (paginado); el Top-N se aplica después sobre los grupos.
    let data = await fetchAllRows(() =>
        applyBase(supabase.schema('report_utm').from(table).select(Array.from(cols).join(',')))
    )
    if (hasAdv) data = data.filter(r => evalAdvancedRow(r, adv, isSales ? 'sales' : 'leads'))

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
    const fieldKey = parseFieldDim(dimension)
    if (fieldKey !== null) {
        const rf = (row.raw_fields as Record<string, unknown> | null) ?? null
        const raw = rf ? rf[fieldKey] : null
        const v = raw === null || raw === undefined ? '' : String(raw).trim()
        return v || '(sin valor)'
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

export const VALID_DIM_KEYS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'ip_country', 'form_name', 'form_plugin', 'attribution_method', 'platform',
    'product_name', 'transaction_type', 'customer_country',
])
function isValidDimKey(key: string): boolean {
    return VALID_DIM_KEYS.has(key) || isFieldDim(key)
}

// Claves de filtro que EXISTEN como columna en cada tabla. Aplicar un filtro sobre
// una columna inexistente rompe la query PostgREST, así que el filtrado por dimensión
// debe ser consciente de la tabla (lead_events vs sales_events).
const LEAD_FILTER_KEYS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'ip_country', 'form_name', 'form_plugin', 'attribution_method',
])
const SALES_FILTER_KEYS = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'platform', 'product_name', 'transaction_type', 'customer_country',
])
/** ¿La clave de filtro aplica a lead_events? (incluye campos de formulario raw_fields). */
export function leadFilterKey(key: string): boolean {
    return LEAD_FILTER_KEYS.has(key) || isFieldDim(key)
}
/** ¿La clave de filtro aplica a sales_events? */
export function salesFilterKey(key: string): boolean {
    return SALES_FILTER_KEYS.has(key)
}

// La paginación por keyset vive en `@/lib/supabase-paginate` desde que también
// la usa el motor de campos de Sheet. Se reexporta para no tocar a quien ya la
// importaba desde aquí.
export { fetchAllRows }

/**
 * Aplica filtros de dimensión a una query PostgREST. Soporta multi-valor:
 * si el valor trae comas (ej. "facebook,instagram") usa IN (...); si no, igualdad.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyDimFilters(q: any, filters?: Record<string, string>, isAllowed: (k: string) => boolean = isValidDimKey): any {
    if (!filters) return q
    for (const [k, raw] of Object.entries(filters)) {
        if (!raw || !isAllowed(k)) continue
        q = applyOneFilter(q, k, raw)
    }
    return q
}

/** Aplica un filtro con su operador (eq/neq/contains/…). Exportable y reutilizable. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOneFilter(q: any, key: string, raw: string): any {
    const { op, value } = parseFilterValue(raw)
    const v = value.trim()
    if (!v) return q
    // Los filtros de campo de formulario apuntan a la clave JSONB (raw_fields->>clave).
    const fieldKey = parseFieldDim(key)
    const col = fieldKey !== null ? `raw_fields->>${fieldKey}` : key
    // Escapar comodines de LIKE en el valor del usuario
    const esc = (s: string) => s.replace(/[%_]/g, m => `\\${m}`)
    switch (op) {
        case 'neq':       return q.neq(col, v)
        case 'contains':  return q.ilike(col, `%${esc(v)}%`)
        case 'ncontains': return q.not(col, 'ilike', `%${esc(v)}%`)
        case 'starts':    return q.ilike(col, `${esc(v)}%`)
        case 'ends':      return q.ilike(col, `%${esc(v)}`)
        case 'eq':
        default:
            // Multi-valor por comas → IN
            if (v.includes(',')) {
                const vals = v.split(',').map(s => s.trim()).filter(Boolean)
                return vals.length ? q.in(col, vals) : q
            }
            return q.eq(col, v)
    }
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

    // Dimensión de campo de formulario (raw_fields): las ventas no tienen
    // raw_fields → los valores distintos siempre salen de lead_events.
    const fieldKey = parseFieldDim(dim)
    if (fieldKey !== null) {
        const rows = await fetchAllRows(() => {
            let q = supabase
                .schema('report_utm')
                .from('lead_events')
                .select('id,raw_fields')
                .gte('created_at', dateFrom + 'T00:00:00')
                .lte('created_at', dateTo + 'T23:59:59')
                .not('raw_fields', 'is', null)
            if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
            return applyDimFilters(q, params.filters, leadFilterKey)
        })
        const set = new Set<string>()
        for (const r of rows) {
            const rf = (r.raw_fields as Record<string, unknown> | null) ?? null
            const v = rf ? rf[fieldKey] : null
            if (v !== null && v !== undefined && String(v).trim()) set.add(String(v).trim())
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, 500)
    }

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
    q = applyDimFilters(q, params.filters, params.source === 'sales' ? salesFilterKey : leadFilterKey)

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
    advancedFilter?: AdvancedFilter
    /** Etapas del embudo, en orden. Se filtran contra FUNNEL_STAGE_METRICS. */
    metrics?: BiMetric[]
}): Promise<{ stage: string; value: number; label: string }[]> {
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    // Etapas válidas del widget; si no configura ninguna (o todas son inválidas)
    // se usa el embudo clásico impresiones → clics → leads → ventas.
    const allowed = new Set<string>(FUNNEL_STAGE_METRICS)
    const requested = (params.metrics ?? []).filter(m => allowed.has(m))
    const stages: BiMetric[] = requested.length >= 2 ? requested : DEFAULT_FUNNEL_STAGES

    const { metrics: _ignored, ...queryParams } = params

    // Las tres fuentes (gasto/campaña, leads, ventas) se consultan por separado
    // porque cada una tiene su propia tabla; solo se piden las que hagan falta.
    const adsMetrics   = stages.filter(m => m !== 'leads_count' && m !== 'sales_count')
    const needsLeads   = stages.includes('leads_count')
    const needsSales   = stages.includes('sales_count')

    const [adsResult, leadsResult, salesResult] = await Promise.all([
        adsMetrics.length
            ? runBiQuery({ ...queryParams, metrics: adsMetrics, dimension: 'none', date_from: dateFrom, date_to: dateTo })
            : Promise.resolve([] as BiQueryRow[]),
        needsLeads
            ? runBiQuery({ ...queryParams, metrics: ['leads_count'], dimension: 'none', date_from: dateFrom, date_to: dateTo })
            : Promise.resolve([] as BiQueryRow[]),
        needsSales
            ? runBiQuery({ ...queryParams, metrics: ['sales_count'], dimension: 'none', date_from: dateFrom, date_to: dateTo })
            : Promise.resolve([] as BiQueryRow[]),
    ])

    return stages.map(metric => {
        const source = metric === 'leads_count' ? leadsResult
            : metric === 'sales_count' ? salesResult
            : adsResult
        return {
            stage: metric,
            value: Number(source[0]?.[metric] ?? 0),
            label: METRIC_META[metric]?.label ?? metric,
        }
    })
}
