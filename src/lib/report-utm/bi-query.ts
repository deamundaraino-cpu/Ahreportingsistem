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
    hasNonAttributableFilter, entityNameFilterPredicate, hasEntityFilter,
    ENTITY_FILTER_FIELDS, splitEntityGroups,
    platformScopeFromFilters, unifiedTarget, round2,
    parseSheetDim, parseSheetMetric, parseSheetView, extractSheetAliases,
    sheetFieldAlias, sheetViewAlias,
    isLeadFieldDim, parseLeadFieldDim,
} from './bi-metadata'
import { colombiaDateOf, colombiaRangeBounds } from '@/lib/colombia-date'
import { loadResolver, resolvePublicClienteId, SIN_CAMPANA, SIN_ANUNCIO, SIN_CONJUNTO } from './campaign-resolver'
import type { CampaignResolver, UtmRecord } from './campaign-resolver'
import { loadCamposCliente } from '@/lib/sheets/campos-db'
import { agregarDiarios, vistaIncluyeValor } from '@/lib/sheets/campos'
import { loadLeadCampos } from './lead-campos-db'
import { bucketDeLeadRaw, ordenarBuckets } from './lead-campos'
import type { LeadCampoDef } from './lead-campos'

// Dimensiones que SOLO existen en sales_events (no en lead_events). Al agrupar
// por ellas, la query de leads se omite (no tienen esas columnas).
const SALES_ONLY_DIMS = new Set(['product_name', 'transaction_type', 'customer_country'])

/** Campo UTM del que cuelga el filtro de cada entidad del reporting. */
const ENTITY_FILTER_FIELD = {
    campaign: 'utm_campaign',
    ad:       'utm_content',
    adset:    'utm_term',
} as const

/** Valor de dimensión para un registro sin cruce, por entidad. */
const SIN_ENTIDAD = { campaign: SIN_CAMPANA, ad: SIN_ANUNCIO, adset: SIN_CONJUNTO } as const

/**
 * Recorta una consulta sobre `created_at` al rango de días de COLOMBIA.
 *
 * Sustituye a `.gte('created_at', dateFrom + 'T00:00:00').lte('created_at',
 * dateTo + 'T23:59:59')`, que tenía dos problemas:
 *
 *  1. El literal iba SIN zona a una columna `timestamptz`, así que Postgres lo
 *     interpretaba en la zona del servidor (UTC): «desde el 1 de julio» era en
 *     realidad «desde las 19:00 del 30 de junio» en hora Colombia, y se colaban
 *     los leads de esa noche.
 *  2. El límite superior `<= 23:59:59` perdía las filas caídas en ese último
 *     segundo — con microsegundos ocurre de verdad. Ahora es `< día siguiente`.
 *
 * Está centralizado a propósito: eran ocho sitios repitiendo la misma expresión,
 * y arreglar siete de ocho habría sido peor que no arreglar ninguno, porque los
 * totales dejarían de cuadrar entre widgets.
 */
function rangoColombia<T>(q: T, dateFrom: string, dateTo: string): T {
    const b = colombiaRangeBounds(dateFrom, dateTo)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (q as any).gte('created_at', b.gte).lt('created_at', b.lt) as T
}

/** Columna cruda que sustituye al nombre real cuando no hay resolver. */
const ENTITY_RAW_COL = { campaign: 'utm_campaign', ad: 'utm_content', adset: 'utm_term' } as const

// Re-export para compatibilidad con imports existentes que apuntaban acá.
export type { BiMetric, BiDimension, DateGrouping, BiQueryParams, BiQueryRow, BiPivotRow } from './bi-metadata'
export { METRIC_META, DIMENSION_META } from './bi-metadata'

// ── Main query function ───────────────────────────────────────────────

export async function runBiQuery(params: BiQueryParams): Promise<BiQueryRow[]> {
    const supabase = await createAdminClient()

    // ── Campos de lead del catálogo ───────────────────────────────────
    // Se cargan antes que nada porque deciden cómo se agrupa y se filtra, y los
    // filtros planos se pasan al avanzado para que el motor tenga un solo camino.
    const leadCampos = await loadLeadCamposSiHaceFalta(supabase, params)
    params = liftLeadFieldFilters(params)
    const leadFieldClave = parseLeadFieldDim(params.dimension)

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
    // Agrupar por un campo de lead del catálogo tiene las mismas consecuencias
    // que agrupar por una clave cruda: ventas y gasto no se desglosan por la
    // respuesta de un formulario, así que ambas se tratan igual aguas abajo.
    const isFieldDimQuery = fieldDimKey !== null || leadFieldClave !== null

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

    // ── Campos de Sheet (sheet_campo_valores_diarios) ─────────────────
    // Tres tokens sobre la misma tabla: métrica del campo, vista guardada y
    // dimensión. En expresiones calc llegan por alias sf__/sv__.
    const sheetDimClave = parseSheetDim(params.dimension)
    const sheetReqs = new Map<string, SheetReq>()
    for (const m of params.metrics) {
        const met = parseSheetMetric(m)
        if (met) { sheetReqs.set(m, { kind: 'campo', campoClave: met.clave, clave: met.clave, outKey: m }); continue }
        const vista = parseSheetView(m)
        if (vista) sheetReqs.set(m, { kind: 'vista', campoClave: '', clave: vista, outKey: m })
    }
    for (const cf of params.calculated ?? []) {
        for (const a of extractSheetAliases(cf.expression)) {
            if (sheetReqs.has(a.alias)) continue
            sheetReqs.set(a.alias, a.kind === 'campo'
                ? { kind: 'campo', campoClave: a.clave, clave: a.clave, outKey: a.alias }
                : { kind: 'vista', campoClave: '', clave: a.clave, outKey: a.alias })
        }
    }
    const sheetFields = Array.from(sheetReqs.values())
    const isSheetDimQuery = sheetDimClave !== null

    const isSalesOnlyDim = SALES_ONLY_DIMS.has(params.dimension)
    // Dimensión unificada: leads, ventas y gasto se agrupan por el NOMBRE real de
    // la misma entidad (campaña / anuncio / conjunto), no por la columna cruda de
    // cada tabla. Es lo que hace que las tres fuentes compartan clave y que
    // mergeResults pueda unirlas en la misma fila.
    const unified = unifiedTarget(params.dimension)
    // Los leads no tienen columnas de producto/tipo/país → se omite su query al
    // agrupar por esas dimensiones. El nivel anuncio/conjunto SÍ los admite ahora:
    // se resuelve desde utm_content/utm_term.
    // 'leads_total' sigue en la lista solo por compatibilidad: se retiró del
    // catálogo en la migración 045 (era un duplicado exacto de leads_count), pero
    // un campo calculado guardado puede seguir nombrándola.
    const needsLeads = (requires(['leads_count', 'leads_total', 'cpl', 'conversion_rate']) || isFieldDimQuery || fieldMetrics.length > 0) && !isSalesOnlyDim && !isSheetDimQuery
    // Las ventas y el gasto no se pueden desglosar por un campo de formulario
    // (sales_events / metricas_diarias no tienen raw_fields) → se omiten cuando
    // se agrupa por campo para no romper el select ni inventar una fila "(total)".
    const needsSales = !isFieldDimQuery && !isSheetDimQuery && requires(['sales_count', 'revenue', 'cpa', 'roas', 'conversion_rate'])
    const needsAds   = !isFieldDimQuery && !isSheetDimQuery && requires([
        'spend', 'meta_spend', 'tiktok_spend', 'cpl', 'cpa', 'roas', 'clicks', 'impressions', 'cpc', 'cpm', 'frequency', 'ctr',
        ...AD_JSONB_METRICS, ...AD_SCALAR_METRICS, ...AD_RATE_METRICS,
        ...MANUAL_JSONB_METRICS.map(m => m.metric),
        'hotmart_revenue', 'hotmart_sales', 'hotmart_roas', 'hotmart_cpa', 'hotmart_roi',
    ])
    // Offline (día×cliente) y suscripciones (snapshot) son globales/por fecha,
    // no cruzan por dimensiones de lead/venta/anuncio.
    const isBreakdownDim = isSalesOnlyDim || unified !== null || isFieldDimQuery || isSheetDimQuery
    const needsOffline = !isBreakdownDim && (requires([...OFFLINE_METRICS]) || offlineFields.length > 0)
    const needsSubs    = !isBreakdownDim && requires([...SUBS_METRICS])
    // Los campos de Sheet sí se desglosan por su propia dimensión, pero no por las
    // de lead/venta/anuncio: su desglose diario no cruza con esas tablas.
    const needsSheet = (sheetFields.length > 0 || isSheetDimQuery) &&
        !isSalesOnlyDim && unified === null && !isFieldDimQuery

    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)

    // ── Resolver de campañas ──────────────────────────────────────────
    // Solo se carga cuando hace falta cruzar (dimensión unificada o filtro por
    // nombre de entidad) y hay cliente: la mayoría de widgets no lo necesitan y no
    // deben pagar la lectura del índice. Va cacheado por cliente+rango.
    const needsResolver = params.cliente_id != null &&
        (unified !== null || hasAnyEntityFilter(params.filters, params.advancedFilter))
    const resolver = needsResolver
        ? await loadResolver(params.cliente_id!, dateFrom, dateTo)
        : null

    // ── LEADS query ───────────────────────────────────────────────────
    // Conteo EXACTO (count para el total, paginación completa para agrupados).
    // El Top-N (params.limit) se aplica luego en mergeResults, no al traer filas.
    // Claves de dimensión que NO cruzaron con ninguna entidad real del reporting:
    // la UI las marca para que se vea que su gasto en 0 es un problema de mapeo,
    // no una campaña que no gastó.
    const nocross = new Set<string>()
    let leadsData: LeadAgg[] = []
    if (needsLeads) {
        leadsData = await queryLeadsDirect(supabase, params, dateFrom, dateTo, fieldMetrics, leadCampos, resolver, nocross)
    }

    // ── SALES query ───────────────────────────────────────────────────
    let salesData: Array<{ dim: string | null; sales: number; revenue: number }> = []
    if (needsSales) {
        salesData = await querySalesDirect(supabase, params, dateFrom, dateTo, resolver, nocross)
    }

    // ── ADS query (metricas_diarias) ──────────────────────────────────
    let adsData: AdRow[] = []
    if (needsAds) {
        adsData = await queryAdsDirect(params, dateFrom, dateTo)
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

    // ── CAMPOS DE SHEET (sheet_campo_valores_diarios) ─────────────────
    let sheetData: SheetRow[] = []
    if (needsSheet) {
        sheetData = await querySheetFieldsDirect(params, dateFrom, dateTo, sheetFields, sheetDimClave)
    }

    // ── Merge results ─────────────────────────────────────────────────
    return mergeResults(
        params, leadsData, salesData, adsData, fieldMetrics, offlineData, subsData, offlineFields,
        sheetData, sheetFields, leadCampos, nocross
    )
}

/** ¿Hay filtro por nombre de campaña, anuncio o conjunto? */
function hasAnyEntityFilter(
    filters: Record<string, string> | undefined,
    advancedFilter: AdvancedFilter | undefined
): boolean {
    return (Object.values(ENTITY_FILTER_FIELD) as string[])
        .some(f => hasEntityFilter(filters, advancedFilter, f))
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

// ── Campos de lead del catálogo (leadfield:<clave>) ───────────────────
// Un campo del catálogo no se puede filtrar ni agrupar en SQL: une VARIAS claves
// de `raw_fields` y funde valores escritos distinto bajo un mismo bucket, y eso
// vive en la definición del campo, no en la fila. Así que se resuelve en memoria.
//
// Para no repetir esa evaluación en cada punto de entrada (tabla, pivot, slicer,
// embudo), los filtros planos `filters['leadfield:x']` se PASAN al filtro
// avanzado antes de consultar: a partir de ahí el único sitio que entiende de
// campos de lead es `advCellValue`, que ya se evalúa sobre las filas traídas.

/** Claves de campo de lead referenciadas por una consulta (dimensiones + filtros). */
function collectLeadFieldClaves(params: {
    dimension?: string
    dimension2?: string
    filters?: Record<string, string>
    advancedFilter?: AdvancedFilter
}): string[] {
    const out = new Set<string>()
    for (const d of [params.dimension, params.dimension2]) {
        const c = d ? parseLeadFieldDim(d) : null
        if (c) out.add(c)
    }
    for (const k of Object.keys(params.filters ?? {})) {
        const c = parseLeadFieldDim(k)
        if (c) out.add(c)
    }
    for (const g of params.advancedFilter?.groups ?? []) {
        for (const cond of g.conditions ?? []) {
            const c = parseLeadFieldDim(cond.field)
            if (c) out.add(c)
        }
    }
    return Array.from(out)
}

/**
 * Carga el catálogo de campos de lead del cliente si la consulta lo necesita.
 * Sin cliente o sin referencias devuelve lista vacía sin tocar la base: la
 * inmensa mayoría de los widgets no usan campos de lead y no deben pagar por
 * esta feature.
 */
async function loadLeadCamposSiHaceFalta(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: { cliente_id?: string; dimension?: string; dimension2?: string; filters?: Record<string, string>; advancedFilter?: AdvancedFilter }
): Promise<LeadCampoDef[]> {
    if (!params.cliente_id) return []
    if (collectLeadFieldClaves(params).length === 0) return []
    return loadLeadCampos(supabase.schema('report_utm'), params.cliente_id)
}

/**
 * Mueve los filtros planos de campo de lead al filtro avanzado, como grupos Y
 * adicionales. No muta la entrada: devuelve una copia de los params.
 */
function liftLeadFieldFilters<T extends { filters?: Record<string, string>; advancedFilter?: AdvancedFilter }>(params: T): T {
    const filters = params.filters ?? {}
    const claves = Object.keys(filters).filter(k => isLeadFieldDim(k) && String(filters[k] ?? '').trim())
    if (claves.length === 0) return params

    const restantes: Record<string, string> = {}
    for (const [k, v] of Object.entries(filters)) if (!claves.includes(k)) restantes[k] = v

    const grupos = claves.map(k => {
        const { op, value } = parseFilterValue(String(filters[k]))
        return { conditions: [{ field: k, op, value }] }
    })

    return {
        ...params,
        filters: restantes,
        advancedFilter: { groups: [...(params.advancedFilter?.groups ?? []), ...grupos] },
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

function advCellValue(
    row: Record<string, unknown>,
    field: string,
    table: AdvTable,
    campos: LeadCampoDef[] = []
): string | undefined {
    // Campo del catálogo: el valor comparable es el BUCKET, no lo que escribió el
    // formulario. Es lo que hace que filtrar por "$2M a $3M" alcance también a
    // los leads que respondieron "Entre $2.000.000 – $3.000.000".
    const clave = parseLeadFieldDim(field)
    if (clave !== null) {
        if (table !== 'leads') return undefined
        const campo = campos.find(c => c.clave === clave)
        // Sin catálogo (migración sin aplicar o campo borrado) la condición no es
        // evaluable: se ignora en vez de vaciar el informe en silencio.
        if (!campo) return undefined
        return bucketDeLeadRaw(campo, row.raw_fields as Record<string, unknown> | null) ?? ''
    }
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

export function evalAdvancedRow(
    row: Record<string, unknown>,
    af: AdvancedFilter | undefined,
    table: AdvTable,
    campos: LeadCampoDef[] = []
): boolean {
    if (!af?.groups?.length) return true
    for (const g of af.groups) {
        const conds = (g.conditions ?? []).filter(c => c.field && c.value && c.value.trim())
        if (!conds.length) continue
        let applicable = false, pass = false
        for (const c of conds) {
            const cell = advCellValue(row, c.field, table, campos)
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
            if (parseFieldDim(c.field) !== null || parseLeadFieldDim(c.field) !== null) {
                if (table === 'leads') needsRawFields = true
                continue
            }
            const set = table === 'sales' ? SALES_ADV_COLS : LEAD_ADV_COLS
            if (set.has(c.field)) cols.add(c.field)
        }
    }
    return { cols: Array.from(cols), needsRawFields }
}

// ── Direct PostgREST queries (no raw SQL needed) ──────────────────────

// ── Filtro por nombre de entidad, evaluado sobre el valor RESUELTO ────
// Un filtro `campaña = Promo Verano` tiene que alcanzar también a los leads que
// cruzan a esa campaña por `utm_id` o por el nombre del anuncio en `utm_content`,
// no solo a los que traen literalmente ese texto en `utm_campaign`. Por eso, con
// resolver disponible, el filtro sale del SQL y se evalúa en memoria contra el
// nombre real O el valor crudo (lo segundo, para que un UTM huérfano que el
// usuario filtra a mano siga siendo filtrable).

type EntityKind = 'campaign' | 'ad' | 'adset'
const ENTITY_KINDS: EntityKind[] = ['campaign', 'ad', 'adset']

interface EntityFilterPlan {
    /** Predicados activos por entidad. Vacío = no hay filtro de entidad. */
    matchers: Array<{ kind: EntityKind; test: (name: string) => boolean }>
    /** Filtro avanzado sin los grupos de entidad (ya cubiertos por los matchers). */
    restAdvanced: AdvancedFilter | undefined
    /** ¿Se aplica en memoria? Solo con resolver; si no, se deja el SQL de siempre. */
    inMemory: boolean
}

function buildEntityFilterPlan(
    params: BiQueryParams,
    resolver: CampaignResolver | null
): EntityFilterPlan {
    const matchers: EntityFilterPlan['matchers'] = []
    for (const kind of ENTITY_KINDS) {
        const field = ENTITY_FILTER_FIELD[kind]
        if (hasEntityFilter(params.filters, params.advancedFilter, field)) {
            matchers.push({ kind, test: entityNameFilterPredicate(params.filters, params.advancedFilter, field) })
        }
    }
    const inMemory = resolver !== null && matchers.length > 0
    const { rest } = splitEntityGroups(params.advancedFilter)
    return {
        matchers,
        restAdvanced: inMemory ? rest : params.advancedFilter,
        inMemory,
    }
}

/** ¿La fila pasa todos los filtros de entidad, por nombre resuelto o crudo? */
function rowPassesEntityFilters(
    row: Record<string, unknown>,
    plan: EntityFilterPlan,
    resolver: CampaignResolver
): boolean {
    for (const { kind, test } of plan.matchers) {
        const resolved = resolveEntityLabel(row, kind, resolver).label
        const raw = String(row[ENTITY_RAW_COL[kind]] ?? '')
        if (!test(resolved) && !test(raw)) return false
    }
    return true
}

/** Etiqueta de una entidad para una fila: nombre real o valor crudo. */
function resolveEntityLabel(
    row: Record<string, unknown>,
    kind: EntityKind,
    resolver: CampaignResolver | null
): { label: string; matched: boolean } {
    if (resolver) {
        const rec = row as UtmRecord
        return kind === 'campaign' ? resolver.campaignOf(rec)
            : kind === 'ad'        ? resolver.adOf(rec)
            :                        resolver.adsetOf(rec)
    }
    // Sin resolver (cliente sin enlace al reporting) se degrada al valor crudo:
    // el informe sigue agrupando, simplemente sin nombres reales ni gasto.
    const raw = String(row[ENTITY_RAW_COL[kind]] ?? '').trim()
    return { label: raw || SIN_ENTIDAD[kind], matched: false }
}

/** Claves UTM que hay que traer para poder resolver una entidad en memoria. */
const UTM_RESOLVE_COLS = ['utm_id', 'utm_campaign', 'utm_content', 'utm_term'] as const

async function queryLeadsDirect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    supabase: any,
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    fieldMetrics: FieldMetricReq[],
    leadCampos: LeadCampoDef[] = [],
    resolver: CampaignResolver | null = null,
    nocross: Set<string> = new Set()
): Promise<LeadAgg[]> {
    const plan = buildEntityFilterPlan(params, resolver)
    // Con el filtro de entidad resuelto en memoria, no debe aplicarse además por
    // SQL sobre la columna cruda: dejaría fuera los leads que cruzan por utm_id.
    const filterKey = plan.inMemory
        ? (k: string) => leadFilterKey(k) && !(ENTITY_FILTER_FIELDS.has(k))
        : leadFilterKey

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyBase = (q: any) => {
        // Día calendario Colombia: el literal sin zona equivalía a UTC, así que

        // «desde el 1 de julio» era «desde las 19:00 del 30 de junio» en Colombia.

        // El límite superior es exclusivo (< día siguiente) en vez de <= 23:59:59,

        // que perdía las filas con microsegundos en ese último segundo.

        q = rangoColombia(q, dateFrom, dateTo)
        if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
        return applyDimFilters(q, params.filters, filterKey)
    }

    const fieldKeys = [...new Set(fieldMetrics.map(f => f.key))]
    const adv = plan.restAdvanced
    const advCols = collectAdvancedColumns(adv, 'leads')
    const hasAdv = advancedFilterHasConditions(adv) && (advCols.cols.length > 0 || advCols.needsRawFields)
    const needsRawFields = isFieldDim(params.dimension) || isLeadFieldDim(params.dimension) ||
        fieldKeys.length > 0 || advCols.needsRawFields
    const unified = unifiedTarget(params.dimension)

    // Total sin agregar campos, filtro avanzado ni entidades: conteo EXACTO.
    if (params.dimension === 'none' && fieldKeys.length === 0 && !hasAdv && !plan.inMemory) {
        const { count, error } = await applyBase(
            supabase.schema('report_utm').from('lead_events').select('id', { count: 'exact', head: true })
        )
        if (error) return []
        return [{ dim: 'total', count: count ?? 0, fields: {} }]
    }

    // Agrupado / métricas de campo / filtro avanzado: traer filas (paginado) y agrupar.
    let rows = await fetchAllRows(() =>
        applyBase(supabase.schema('report_utm').from('lead_events').select(
            buildLeadSelect(params.dimension, needsRawFields, advCols.cols, unified !== null || plan.inMemory)
        ))
    )
    if (hasAdv) rows = rows.filter(r => evalAdvancedRow(r, adv, 'leads', leadCampos))
    if (plan.inMemory) rows = rows.filter(r => rowPassesEntityFilters(r, plan, resolver!))
    return aggregateLeads(rows, params.dimension, params.date_grouping, fieldKeys, leadCampos, resolver, nocross)
}

function buildLeadSelect(
    dimension: BiDimension,
    needsRawFields: boolean,
    extraCols: string[] = [],
    needsUtm = false
): string {
    const cols = new Set<string>(['id', 'created_at'])
    const unified = unifiedTarget(dimension)
    if (dimension !== 'none' && dimension !== 'date' && !unified &&
        !isFieldDim(dimension) && !isLeadFieldDim(dimension)) {
        // `utm_campaign_raw` no es una columna: agrupa por el utm_campaign crudo.
        cols.add(dimension === 'utm_campaign_raw' ? 'utm_campaign' : dimension)
    }
    // Resolver una entidad necesita las cuatro claves UTM, no solo la homónima:
    // la cascada de matching prueba utm_id, luego el nombre, luego content/term.
    if (needsUtm) for (const c of UTM_RESOLVE_COLS) cols.add(c)
    if (needsRawFields) cols.add('raw_fields')
    for (const c of extraCols) cols.add(c)
    return Array.from(cols).join(',')
}

function aggregateLeads(
    rows: Record<string, unknown>[],
    dimension: BiDimension,
    grouping: DateGrouping | undefined,
    fieldKeys: string[],
    leadCampos: LeadCampoDef[] = [],
    resolver: CampaignResolver | null = null,
    nocross: Set<string> = new Set()
): LeadAgg[] {
    const map = new Map<string, LeadAgg>()
    for (const r of rows) {
        const dim = getDimValue(r, dimension, grouping, leadCampos, resolver, nocross)
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
    dateTo: string,
    resolver: CampaignResolver | null = null,
    nocross: Set<string> = new Set()
): Promise<Array<{ dim: string | null; sales: number; revenue: number }>> {
    const plan = buildEntityFilterPlan(params, resolver)
    const filterKey = plan.inMemory
        ? (k: string) => salesFilterKey(k) && !(ENTITY_FILTER_FIELDS.has(k))
        : salesFilterKey

    const adv = plan.restAdvanced
    const advCols = collectAdvancedColumns(adv, 'sales')
    const hasAdv = advancedFilterHasConditions(adv) && advCols.cols.length > 0
    const unified = unifiedTarget(params.dimension)

    const selectCols = new Set<string>(['id', 'created_at', 'amount', 'status', 'platform'])
    if (params.dimension !== 'none' && params.dimension !== 'date' && !unified && !isFieldDim(params.dimension)) {
        selectCols.add(params.dimension === 'utm_campaign_raw' ? 'utm_campaign' : params.dimension)
    }
    if (unified || plan.inMemory) for (const c of UTM_RESOLVE_COLS) selectCols.add(c)
    for (const c of advCols.cols) selectCols.add(c)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyBase = (q: any) => {
        q = rangoColombia(q, dateFrom, dateTo)
            .eq('status', 'approved')
        if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
        return applyDimFilters(q, params.filters, filterKey)
    }

    // Traer TODAS las ventas aprobadas (paginado) para sumar revenue exacto.
    let data = await fetchAllRows(() =>
        applyBase(supabase.schema('report_utm').from('sales_events').select(Array.from(selectCols).join(',')))
    )
    if (hasAdv) data = data.filter(r => evalAdvancedRow(r, adv, 'sales'))
    if (plan.inMemory) data = data.filter(r => rowPassesEntityFilters(r, plan, resolver!))

    const map = new Map<string, { sales: number; revenue: number }>()
    for (const r of data as Record<string, unknown>[]) {
        let dim = getDimValue(r, params.dimension, params.date_grouping, [], resolver, nocross)
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

// ── Gasto (public.metricas_diarias) ───────────────────────────────────
//
// `metricas_diarias` está preagregada por día×cliente y NO tiene UTM. Lo que sí
// tiene es el desglose por entidad dentro de sus JSONB, en tres niveles y para
// las dos plataformas. Ese desglose es el que permite emitir el gasto con la
// MISMA clave (el nombre real) con la que el resolver agrupa leads y ventas.
//
// Nivel del que se deriva el gasto = el más específico entre lo que se agrupa y
// lo que se filtra. Agrupar por campaña filtrando por anuncio, por ejemplo,
// deriva de `meta_ads` y reagrupa por `campaign_name`.

/** Metadatos de cada nivel del JSONB: de dónde leer y cómo nombrar cada entidad. */
const ENTITY_LEVEL: Record<EntityKind, {
    /** Más alto = más específico. Decide de qué nivel se deriva el gasto. */
    rank: number
    metaCol: string
    tiktokCol: string
    /** Campo del elemento Meta que da el nombre de cada entidad en este nivel. */
    metaNameOf: Partial<Record<EntityKind, string>>
    /** Ídem para TikTok. Sus objetos de ad/adgroup NO llevan campaign_*. */
    tiktokNameOf: Partial<Record<EntityKind, string>>
}> = {
    campaign: {
        rank: 1, metaCol: 'meta_campaigns', tiktokCol: 'tiktok_campaigns',
        metaNameOf:   { campaign: 'name' },
        tiktokNameOf: { campaign: 'name' },
    },
    adset: {
        rank: 2, metaCol: 'meta_adsets', tiktokCol: 'tiktok_adgroups',
        metaNameOf:   { campaign: 'campaign_name', adset: 'adset_name' },
        tiktokNameOf: { adset: 'adgroup_name' },
    },
    ad: {
        rank: 3, metaCol: 'meta_ads', tiktokCol: 'tiktok_ads',
        metaNameOf:   { campaign: 'campaign_name', adset: 'adset_name', ad: 'ad_name' },
        tiktokNameOf: { ad: 'ad_name' },
    },
}

/**
 * Tope de filas de `metricas_diarias` por consulta. Es 1 fila por día y cliente,
 * así que cubre de sobra cualquier rango. NO puede depender del `limit` del
 * widget: ese es un Top-N de filas del informe, y usarlo aquí hacía que una tabla
 * con "Top 15" leyera solo 15 DÍAS de gasto.
 */
const MAX_AD_DAY_ROWS = 5000

async function queryAdsDirect(
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string
): Promise<AdRow[]> {
    // ── Aplicación de filtros al gasto ─────────────────────────────────
    //   • Filtro NO atribuible (país/formulario/campo de lead/Sheet) → el gasto no
    //     puede recortarse → se devuelve vacío (mergeResults deja spend=0 y ratios
    //     null; la UI muestra el aviso "gasto no atribuible a este filtro").
    //   • Filtro por nombre de entidad → el gasto se deriva del JSONB del nivel
    //     correspondiente. Las métricas escalares sin desglose por entidad (GA4,
    //     Hotmart, ventas_*) no son atribuibles → quedan en 0.
    //   • Filtro de source/medium que identifica una sola plataforma → el gasto se
    //     recorta a esa plataforma (antes se dejaba entero y el CPL salía inflado).
    if (hasNonAttributableFilter(params.filters, params.advancedFilter)) return []

    const platform = platformScopeFromFilters(params.filters, params.advancedFilter)
    const breakdown = unifiedTarget(params.dimension)

    // Entidades con filtro efectivo por nombre.
    const matchers = new Map<EntityKind, (name: string) => boolean>()
    for (const kind of ENTITY_KINDS) {
        const field = ENTITY_FILTER_FIELD[kind]
        if (hasEntityFilter(params.filters, params.advancedFilter, field)) {
            matchers.set(kind, entityNameFilterPredicate(params.filters, params.advancedFilter, field))
        }
    }

    // Nivel del JSONB: el más específico entre lo que se agrupa y lo que se filtra.
    const needed: EntityKind[] = [...matchers.keys(), ...(breakdown ? [breakdown] : [])]
    const level = needed.length
        ? needed.reduce((a, b) => (ENTITY_LEVEL[a].rank >= ENTITY_LEVEL[b].rank ? a : b))
        : null

    let publicId: string | null = null
    if (params.cliente_id) {
        publicId = await resolvePublicClienteId(params.cliente_id)
        // Sin enlace al cliente del reporting no hay gasto que cruzar.
        if (!publicId) return []
    }

    return level
        ? queryAdsFromJsonb(params, dateFrom, dateTo, publicId, level, breakdown, matchers, platform)
        : queryAdsScalar(params, dateFrom, dateTo, publicId, platform)
}

/**
 * Gasto a nivel cuenta: columnas escalares (fiables) + el JSONB `meta_campaigns`
 * para las métricas de campaña aditivas. Es el camino de siempre, y el único que
 * puede emitir GA4, Hotmart y las métricas manuales: esas solo existen a nivel
 * día×cliente, sin desglose por entidad.
 */
async function queryAdsScalar(
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    publicId: string | null,
    platform: 'meta' | 'tiktok' | null
): Promise<AdRow[]> {
    const db = await createAdminClient()
    const adCols = [
        'fecha', 'meta_spend', 'tiktok_spend', 'meta_clicks', 'tiktok_clicks',
        'meta_impressions', 'tiktok_impressions',
        ...AD_SCALAR_METRICS, ...AD_RATE_METRICS,
        // Métricas cargadas a mano por el equipo (ventas cerradas): viven en este
        // JSONB, no en una columna propia.
        'metricas_manuales',
        'meta_campaigns',
    ]
    let q = db.from('metricas_diarias')
        .select(adCols.join(','))
        .gte('fecha', dateFrom)
        .lte('fecha', dateTo)
        .limit(MAX_AD_DAY_ROWS)
    if (publicId) q = q.eq('cliente_id', publicId)

    const { data, error } = await q
    if (error || !data) return []

    const grouping = params.date_grouping ?? 'day'
    const map = new Map<string, Record<string, number>>()

    for (const r of data as unknown as Record<string, unknown>[]) {
        let dim = 'total'
        if (params.dimension === 'date') {
            dim = truncateDate(String(r.fecha ?? ''), grouping)
        }
        let entry = map.get(dim)
        if (!entry) { entry = newAdEntry(); map.set(dim, entry) }

        // Con un filtro de plataforma activo solo se suma el gasto de ESA
        // plataforma; el resto de la cuenta no forma parte de lo que el informe
        // está mostrando.
        const metaSpend   = platform === 'tiktok' ? 0 : Number(r.meta_spend ?? 0)
        const tiktokSpend = platform === 'meta'   ? 0 : Number(r.tiktok_spend ?? 0)
        entry.meta_spend   += metaSpend
        entry.tiktok_spend += tiktokSpend
        entry.spend        += metaSpend + tiktokSpend
        entry.clicks      += (platform === 'tiktok' ? 0 : Number(r.meta_clicks ?? 0))
                           + (platform === 'meta'   ? 0 : Number(r.tiktok_clicks ?? 0))
        entry.impressions += (platform === 'tiktok' ? 0 : Number(r.meta_impressions ?? 0))
                           + (platform === 'meta'   ? 0 : Number(r.tiktok_impressions ?? 0))

        // Escalares (GA4, TikTok conv., Hotmart) y manuales son de la CUENTA, no
        // de una plataforma: con un recorte por plataforma no son atribuibles y se
        // dejan en 0, igual que se hace bajo un filtro de campaña.
        if (!platform) {
            for (const k of AD_SCALAR_METRICS) entry[k] += Number(r[k] ?? 0)
            const manuales = (r.metricas_manuales ?? {}) as Record<string, unknown>
            for (const { metric, jsonKey } of MANUAL_JSONB_METRICS) {
                entry[metric] += Number(manuales[jsonKey] ?? 0) || 0
            }
            // Tasas GA4: promedio ponderado por sesiones (acumular numerador).
            const gaSess = Number(r.ga_sessions ?? 0)
            entry._ga_bounce_wsum += Number(r.ga_bounce_rate ?? 0) * gaSess
            entry._ga_dur_wsum    += Number(r.ga_avg_session_duration ?? 0) * gaSess
        }

        // Resto de métricas de campaña desde meta_campaigns (TikTok no las trae).
        if (platform !== 'tiktok') {
            const camps = (r.meta_campaigns as Record<string, unknown>[] | null) ?? []
            for (const c of camps) {
                for (const k of AD_JSONB_METRICS) entry[k] += Number(c[k] ?? 0)
            }
        }
    }

    return Array.from(map.entries()).map(([dim, v]) => ({ dim, ...v } as AdRow))
}

/**
 * Gasto derivado del desglose por entidad. Agrupa por el nombre pedido
 * (`breakdown`) o por fecha/total, conservando solo los elementos que pasan los
 * filtros de nombre. Las claves que emite son los nombres REALES, los mismos que
 * produce el resolver sobre los leads → `mergeResults` las une sin más.
 */
async function queryAdsFromJsonb(
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    publicId: string | null,
    level: EntityKind,
    breakdown: EntityKind | null,
    matchers: Map<EntityKind, (name: string) => boolean>,
    platform: 'meta' | 'tiktok' | null
): Promise<AdRow[]> {
    const db = await createAdminClient()
    const spec = ENTITY_LEVEL[level]
    // `meta_campaigns` se lee siempre: en los niveles ad/adset resuelve el nombre
    // de campaña cuando el elemento no lo trae (solo tiene campaign_id).
    const cols = Array.from(new Set(['fecha', spec.metaCol, spec.tiktokCol, 'meta_campaigns']))

    let q = db.from('metricas_diarias')
        .select(cols.join(','))
        .gte('fecha', dateFrom)
        .lte('fecha', dateTo)
        .limit(MAX_AD_DAY_ROWS)
    if (publicId) q = q.eq('cliente_id', publicId)

    const { data, error } = await q
    if (error || !data) return []

    const grouping = params.date_grouping ?? 'day'
    const map = new Map<string, Record<string, number>>()

    for (const r of data as unknown as Record<string, unknown>[]) {
        const dateKey = params.dimension === 'date' ? truncateDate(String(r.fecha ?? ''), grouping) : 'total'

        // campaign_id → nombre, para los niveles que no traen campaign_name.
        const campName = new Map<string, string>()
        for (const c of (r.meta_campaigns as Record<string, unknown>[] | null) ?? []) {
            if (c.campaign_id != null) campName.set(String(c.campaign_id), String(c.name ?? ''))
        }

        /** Nombre de una entidad para un elemento del nivel actual. */
        const nameOf = (
            el: Record<string, unknown>,
            kind: EntityKind,
            isMeta: boolean
        ): string | null => {
            const field = (isMeta ? spec.metaNameOf : spec.tiktokNameOf)[kind]
            if (field) {
                const v = String(el[field] ?? '').trim()
                if (v) return v
            }
            // Fallback solo para campaña en Meta: el elemento puede traer el id
            // aunque le falte el nombre.
            if (kind === 'campaign' && isMeta && el.campaign_id != null) {
                return campName.get(String(el.campaign_id)) || null
            }
            return null
        }

        /** ¿El elemento pasa todos los filtros de nombre aplicables? */
        const passes = (el: Record<string, unknown>, isMeta: boolean): boolean => {
            for (const [kind, test] of matchers) {
                const name = nameOf(el, kind, isMeta)
                // Sin nombre para esa entidad no se puede comprobar el filtro. Se
                // descarta: contarlo sería atribuir gasto a algo que el informe no
                // está mostrando. Es lo que deja fuera el gasto de TikTok a nivel
                // anuncio bajo un filtro de campaña (sus objetos no traen campaña).
                if (name === null || !test(name)) return false
            }
            return true
        }

        const consume = (
            elems: Record<string, unknown>[],
            isMeta: boolean,
            withJsonbMetrics: boolean
        ) => {
            for (const el of elems) {
                if (!passes(el, isMeta)) continue
                const key = breakdown
                    ? (nameOf(el, breakdown, isMeta) ?? SIN_ENTIDAD[breakdown])
                    : dateKey
                let entry = map.get(key)
                if (!entry) { entry = newAdEntry(); map.set(key, entry) }
                const sp = Number(el.spend ?? 0)
                if (isMeta) entry.meta_spend += sp
                else        entry.tiktok_spend += sp
                entry.spend       += sp
                entry.clicks      += Number(el.clicks ?? 0)
                entry.impressions += Number(el.impressions ?? 0)
                if (withJsonbMetrics) {
                    for (const k of AD_JSONB_METRICS) entry[k] += Number(el[k] ?? 0)
                }
                // TikTok solo reporta 4 métricas; `conversions` es la única propia.
                if (!isMeta) entry.tiktok_conversions += Number(el.conversions ?? 0)
            }
        }

        if (platform !== 'tiktok') {
            consume((r[spec.metaCol] as Record<string, unknown>[] | null) ?? [], true, true)
        }
        if (platform !== 'meta') {
            consume((r[spec.tiktokCol] as Record<string, unknown>[] | null) ?? [], false, false)
        }
    }

    return Array.from(map.entries())
        .map(([dim, v]) => ({ dim, ...v } as AdRow))
        .sort((a, b) => b.spend - a.spend)
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
// `resolvePublicClienteId` vive en campaign-resolver.ts (lo necesitan los dos).

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

// ── Campos de Sheet (sheet_campo_valores_diarios) ─────────────────────
/**
 * Un campo de Sheet unifica columnas equivalentes de varias pestañas y guarda un
 * desglose diario POR VALOR. Eso permite servir las tres lecturas desde la misma
 * tabla ya materializada, sin tocar las filas crudas:
 *
 *   • métrica  — `sheetagg:<agg>:<clave>`, agregando el desglose
 *   • vista    — `sheetview:<clave>`, sumando solo sus buckets
 *   • dimensión — `sheetdim:<clave>`, usando el bucket como valor de la fila
 */
interface SheetReq {
    kind: 'campo' | 'vista'
    /**
     * Clave del campo. Para una vista llega vacía —el token no la lleva— y se
     * resuelve contra el catálogo del cliente dentro de la consulta.
     */
    campoClave: string
    /** Clave propia del token (campo o vista). */
    clave: string
    outKey: string
}

interface SheetRow {
    dim: string
    values: Record<string, number>
}

async function querySheetFieldsDirect(
    params: BiQueryParams,
    dateFrom: string,
    dateTo: string,
    reqs: SheetReq[],
    sheetDimClave: string | null
): Promise<SheetRow[]> {
    if (!params.cliente_id) return []
    const publicId = await resolvePublicClienteId(params.cliente_id)
    if (!publicId) return []

    const db = await createAdminClient()
    const { campos, vistas } = await loadCamposCliente(db, publicId, { soloActivos: true })
    if (campos.length === 0) return []

    const campoPorClave = new Map(campos.map(c => [c.clave, c]))
    const vistaPorClave = new Map(vistas.map(v => [v.clave, v]))

    /** Campo del que depende un token: el suyo, o el padre si es una vista. */
    const campoDeReq = (r: SheetReq) =>
        r.kind === 'vista'
            ? campoPorClave.get(vistaPorClave.get(r.clave)?.campo_clave ?? '')
            : campoPorClave.get(r.campoClave)

    // Campos implicados: los de las métricas pedidas, los de sus vistas y el de la
    // dimensión. Se consulta solo lo necesario.
    const campoIds = new Set<string>()
    for (const r of reqs) {
        const c = campoDeReq(r)
        if (c) campoIds.add(c.id)
    }
    const dimCampo = sheetDimClave ? campoPorClave.get(sheetDimClave) : undefined
    if (dimCampo) campoIds.add(dimCampo.id)
    if (campoIds.size === 0) return []

    const { data, error } = await db.from('sheet_campo_valores_diarios')
        .select('campo_id,fecha,valor,filas,suma,n_num,minimo,maximo')
        .eq('cliente_id', publicId)
        .in('campo_id', Array.from(campoIds))
        .gte('fecha', dateFrom).lte('fecha', dateTo)
    if (error || !data) return []

    const grouping = params.date_grouping ?? 'day'

    // Filtro por valores del campo, si el informe lo trae. Solo aplica al campo
    // filtrado: el desglose está pre-agregado por campo, así que una condición
    // sobre OTRO campo no se puede resolver aquí (se ignora, igual que el resto
    // del motor ignora los cruces que la tabla no soporta).
    const filtroPorCampo = new Map<string, Set<string>>()
    for (const [k, v] of Object.entries(params.filters ?? {})) {
        const clave = parseSheetDim(k)
        if (!clave || !v || !String(v).trim()) continue
        const valores = String(v).split(',').map(s => s.trim()).filter(Boolean)
        const campo = campoPorClave.get(clave)
        if (campo && valores.length) filtroPorCampo.set(campo.id, new Set(valores))
    }

    const filas = (data as unknown as Record<string, unknown>[])
        .map(r => ({
            campo_id: String(r.campo_id),
            fecha: String(r.fecha ?? '').slice(0, 10),
            valor: String(r.valor ?? ''),
            filas: Number(r.filas ?? 0),
            suma: Number(r.suma ?? 0),
            n_num: Number(r.n_num ?? 0),
            minimo: r.minimo === null || r.minimo === undefined ? null : Number(r.minimo),
            maximo: r.maximo === null || r.maximo === undefined ? null : Number(r.maximo),
        }))
        .filter(r => {
            const permitidos = filtroPorCampo.get(r.campo_id)
            return !permitidos || permitidos.has(r.valor)
        })

    /** Clave de agrupación de una fila del desglose. */
    const dimDe = (r: { fecha: string; valor: string; campo_id: string }): string => {
        if (sheetDimClave) {
            // Al agrupar POR un campo, solo ese campo se desglosa por valor. Los
            // demás no tienen forma de repartirse entre sus buckets.
            return dimCampo && r.campo_id === dimCampo.id ? r.valor : 'total'
        }
        return params.dimension === 'date' ? truncateDate(r.fecha, grouping) : 'total'
    }

    const porDim = new Map<string, typeof filas>()
    for (const r of filas) {
        const dim = dimDe(r)
        const lista = porDim.get(dim)
        if (lista) lista.push(r)
        else porDim.set(dim, [r])
    }

    const out: SheetRow[] = []
    for (const [dim, rows] of porDim) {
        const values: Record<string, number> = {}

        for (const req of reqs) {
            const campo = campoDeReq(req)
            if (!campo) { values[req.outKey] = 0; continue }

            const propias = rows.filter(r => r.campo_id === campo.id)

            if (req.kind === 'vista') {
                const vista = vistaPorClave.get(req.clave)
                if (!vista) { values[req.outKey] = 0; continue }
                values[req.outKey] = round2(agregarDiarios(
                    propias.filter(r => vistaIncluyeValor(vista, r.valor)),
                    vista.agregacion
                ))
            } else {
                const agg = parseSheetMetric(req.outKey)?.agg ?? campo.agregacion
                values[req.outKey] = round2(agregarDiarios(propias, agg))
            }
        }

        out.push({ dim, values })
    }

    return out
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
    offlineFields: OfflineFieldReq[] = [],
    sheetData: SheetRow[] = [],
    sheetFields: SheetReq[] = [],
    leadCampos: LeadCampoDef[] = [],
    nocross: Set<string> = new Set()
): BiQueryRow[] {
    const keys = new Set<string>()
    leadsData.forEach(r => keys.add(r.dim ?? 'total'))
    salesData.forEach(r => keys.add(r.dim ?? 'total'))
    adsData.forEach(r => keys.add(r.dim ?? 'total'))
    offlineData.forEach(r => keys.add(r.dim ?? 'total'))
    sheetData.forEach(r => keys.add(r.dim))
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

        // Marca de "sin cruce": esta clave de dimensión es un UTM que no resolvió a
        // ninguna campaña/anuncio/conjunto real. Su gasto en 0 no significa que no
        // gastara, sino que el UTM no está mapeado. La tabla lo señala para que se
        // arregle en Cruce de campañas en vez de leerse como un dato.
        if (nocross.has(key)) row.__nocross = 1

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
        // Campos de Sheet: mismo patrón que las columnas offline — se emiten por
        // su token y quedan disponibles por alias para los campos calculados.
        const sheet = sheetData.find(r => r.dim === key)
        const sheetValues: Record<string, number> = {}
        for (const sf of sheetFields) {
            const v = sheet?.values[sf.outKey] ?? 0
            sheetValues[sf.outKey] = v
            if ((params.metrics as string[]).includes(sf.outKey)) row[sf.outKey] = v
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
            // Alias sf__<clave> (campo) y sv__<clave> (vista): es lo que permite
            // escribir "meta_spend / sv__leads_20_100" en un campo calculado.
            for (const sf of sheetFields) {
                baseValues[sf.outKey] = sheetValues[sf.outKey] ?? 0
                const alias = sf.kind === 'campo' ? sheetFieldAlias(sf.clave) : sheetViewAlias(sf.clave)
                baseValues[alias] = sheetValues[sf.outKey] ?? 0
            }
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

    // Un campo de lead con orden definido manda sobre el orden por métrica: para
    // eso se configura. Un tramo de ingresos ordenado por volumen deja de leerse
    // como una escala ("$2M a $3M" antes que "Menos de $2M") y es justo lo que se
    // quiere evitar al cruzar rangos.
    const leadFieldClave = parseLeadFieldDim(params.dimension)
    if (leadFieldClave !== null) {
        const campo = leadCampos.find(c => c.clave === leadFieldClave)
        if (campo && campo.valores_orden.length > 0) {
            const orden = ordenarBuckets(campo, rows.map(r => String(r.dimension_value ?? '')))
            const pos = new Map(orden.map((v, i) => [v, i]))
            rows.sort((a, b) =>
                (pos.get(String(a.dimension_value ?? '')) ?? orden.length) -
                (pos.get(String(b.dimension_value ?? '')) ?? orden.length))
            if (params.limit && rows.length > params.limit) return rows.slice(0, params.limit)
            return rows
        }
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
    const leadCampos = await loadLeadCamposSiHaceFalta(supabase, params)
    params = liftLeadFieldFilters(params)
    const dateFrom = params.date_from ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const dateTo   = params.date_to   ?? new Date().toISOString().slice(0, 10)
    const dim1 = params.dimension
    const dim2 = params.dimension2!

    const isSales = metric === 'sales_count' || metric === 'revenue'
    const table = isSales ? 'sales_events' : 'lead_events'
    const esDimDeCampo = (d: string) => isFieldDim(d) || isLeadFieldDim(d)
    // El pivot agrupa filas de leads/ventas, así que una dimensión unificada se
    // resuelve igual que en el resto del motor: el eje muestra nombres reales de
    // campaña/anuncio/conjunto, no el texto crudo del UTM.
    const pivotNeedsResolver = unifiedTarget(dim1) !== null || unifiedTarget(dim2) !== null
    const resolver = pivotNeedsResolver && params.cliente_id
        ? await loadResolver(params.cliente_id, dateFrom, dateTo)
        : null

    const cols = new Set<string>(['id', 'created_at'])
    if (isSales) { cols.add('amount'); cols.add('status'); cols.add('platform') }
    const axisCol = (d: BiDimension) => d === 'utm_campaign_raw' ? 'utm_campaign' : d
    if (dim1 !== 'none' && dim1 !== 'date' && dim1 !== 'platform' && !esDimDeCampo(dim1) && !unifiedTarget(dim1)) cols.add(axisCol(dim1))
    if (dim2 !== 'none' && dim2 !== 'date' && dim2 !== 'platform' && !esDimDeCampo(dim2) && !unifiedTarget(dim2)) cols.add(axisCol(dim2))
    if (pivotNeedsResolver) for (const c of UTM_RESOLVE_COLS) cols.add(c)
    // Ventas no tienen raw_fields → una dimensión de campo sobre ventas cae en
    // "(sin valor)"; solo lead_events puede desglosar por campo de formulario.
    if (!isSales && (esDimDeCampo(dim1) || esDimDeCampo(dim2))) cols.add('raw_fields')

    // Columnas necesarias para el filtro avanzado en esta tabla.
    const adv = params.advancedFilter
    const advCols = collectAdvancedColumns(adv, isSales ? 'sales' : 'leads')
    const hasAdv = advancedFilterHasConditions(adv) && (advCols.cols.length > 0 || advCols.needsRawFields)
    for (const c of advCols.cols) cols.add(c)
    if (advCols.needsRawFields) cols.add('raw_fields')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyBase = (q: any) => {
        // Día calendario Colombia: el literal sin zona equivalía a UTC, así que

        // «desde el 1 de julio» era «desde las 19:00 del 30 de junio» en Colombia.

        // El límite superior es exclusivo (< día siguiente) en vez de <= 23:59:59,

        // que perdía las filas con microsegundos en ese último segundo.

        q = rangoColombia(q, dateFrom, dateTo)
        if (isSales) q = q.eq('status', 'approved')
        if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
        return applyDimFilters(q, params.filters, isSales ? salesFilterKey : leadFilterKey)
    }

    // Traer TODAS las filas (paginado); el Top-N se aplica después sobre los grupos.
    let data = await fetchAllRows(() =>
        applyBase(supabase.schema('report_utm').from(table).select(Array.from(cols).join(',')))
    )
    if (hasAdv) data = data.filter(r => evalAdvancedRow(r, adv, isSales ? 'sales' : 'leads', leadCampos))

    const grouping = params.date_grouping ?? 'day'
    const pivot = new Map<string, Map<string, number>>()
    const seriesSet = new Set<string>()

    for (const r of data as unknown as Record<string, unknown>[]) {
        const k1 = getDimValue(r, dim1, grouping, leadCampos, resolver)
        const k2 = getDimValue(r, dim2, grouping, leadCampos, resolver)
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

function getDimValue(
    row: Record<string, unknown>,
    dimension: BiDimension,
    grouping?: DateGrouping,
    leadCampos: LeadCampoDef[] = [],
    resolver: CampaignResolver | null = null,
    nocross?: Set<string>
): string {
    if (dimension === 'none') return 'total'
    if (dimension === 'date') {
        // Día calendario COLOMBIA, no día UTC. Antes esto era
        // `String(created_at).slice(0, 10)`, los 10 primeros caracteres del ISO,
        // que es el día UTC — mientras el gasto se agrupa por
        // `metricas_diarias.fecha`, un DATE que el worker escribe en día
        // Colombia. Un lead de las 20:00 en Colombia es 01:00 UTC del día
        // siguiente, así que se comparaba contra el gasto del día equivocado.
        // Medido en julio 2026: el 26,9% de los leads caía en el día incorrecto.
        return truncateDate(colombiaDateOf(row.created_at as string), grouping ?? 'day')
    }
    // Dimensión unificada: la fila cuenta bajo el NOMBRE REAL de la campaña /
    // anuncio / conjunto al que cruza, que es la misma clave con la que se emite
    // el gasto. Sin cruce se queda con su UTM crudo y se marca, para que la fila
    // en 0 se lea como "este UTM no está mapeado" y no como "no gastó".
    const unified = unifiedTarget(dimension)
    if (unified !== null) {
        const { label, matched } = resolveEntityLabel(row, unified, resolver)
        if (!matched) nocross?.add(label)
        return label
    }
    // Auditoría: el utm_campaign tal cual llegó, sin resolver.
    if (dimension === 'utm_campaign_raw') {
        return String(row.utm_campaign ?? '').trim() || '(sin valor)'
    }
    // Campo del catálogo: la fila cuenta en su BUCKET, que es lo que une las
    // claves equivalentes y las variantes de escritura del mismo valor.
    const leadClave = parseLeadFieldDim(dimension)
    if (leadClave !== null) {
        const campo = leadCampos.find(c => c.clave === leadClave)
        if (!campo) return '(sin valor)'
        return bucketDeLeadRaw(campo, row.raw_fields as Record<string, unknown> | null) ?? '(sin valor)'
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

// `round2` vive en bi-metadata.ts: el motor y el diagnóstico deben redondear
// igual o sus totales no cuadran entre sí por céntimos.

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

    // Dimensión de campo de lead: los valores son los BUCKETS del campo, en el
    // orden que definió el analista. Se calculan sobre los leads del período —
    // no se listan los del catálogo a secas — para que el slicer no ofrezca
    // rangos que nadie respondió en el rango de fechas elegido.
    const leadClave = parseLeadFieldDim(dim)
    if (leadClave !== null) {
        if (!params.cliente_id) return []
        const campos = await loadLeadCampos(supabase.schema('report_utm'), params.cliente_id, { soloActivos: true })
        const campo = campos.find(c => c.clave === leadClave)
        if (!campo) return []

        const lifted = liftLeadFieldFilters({ filters: params.filters })
        const rows = await fetchAllRows(() => {
            let q = supabase
                .schema('report_utm')
                .from('lead_events')
                .select('id,raw_fields')
                .gte('created_at', colombiaRangeBounds(dateFrom, dateTo).gte)
                .lt('created_at', colombiaRangeBounds(dateFrom, dateTo).lt)
                .not('raw_fields', 'is', null)
            if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
            return applyDimFilters(q, lifted.filters, leadFilterKey)
        })

        const set = new Set<string>()
        for (const r of rows) {
            const b = bucketDeLeadRaw(campo, r.raw_fields as Record<string, unknown> | null)
            if (b) set.add(b)
        }
        return ordenarBuckets(campo, Array.from(set)).slice(0, 500)
    }

    // Dimensión de campo de Sheet: los valores salen del desglose ya
    // materializado, que está acotado por `max_valores`. No hace falta escanear
    // las filas crudas ni deduplicar nada.
    const sheetClave = parseSheetDim(dim)
    if (sheetClave !== null) {
        if (!params.cliente_id) return []
        const publicId = await resolvePublicClienteId(params.cliente_id)
        if (!publicId) return []

        const { campos } = await loadCamposCliente(supabase, publicId, { soloActivos: true })
        const campo = campos.find(c => c.clave === sheetClave)
        if (!campo) return []

        const { data } = await supabase.from('sheet_campo_valores_diarios')
            .select('valor')
            .eq('campo_id', campo.id)
            .gte('fecha', dateFrom).lte('fecha', dateTo)

        const set = new Set<string>()
        for (const r of (data ?? []) as Record<string, unknown>[]) {
            const v = String(r.valor ?? '').trim()
            if (v) set.add(v)
        }

        // El orden que definió el analista manda; lo que no esté en él va detrás,
        // alfabético. Así "1-10, 11-20, 20-100" no sale ordenado como texto.
        const orden = campo.valores_orden ?? []
        const pos = (v: string) => { const i = orden.indexOf(v); return i === -1 ? orden.length : i }
        return Array.from(set)
            .sort((a, b) => pos(a) - pos(b) || a.localeCompare(b))
            .slice(0, 500)
    }

    // Dimensión de campo de formulario (raw_fields): las ventas no tienen
    // raw_fields → los valores distintos siempre salen de lead_events.
    const fieldKey = parseFieldDim(dim)
    if (fieldKey !== null) {
        const rows = await fetchAllRows(() => {
            let q = supabase
                .schema('report_utm')
                .from('lead_events')
                .select('id,raw_fields')
                .gte('created_at', colombiaRangeBounds(dateFrom, dateTo).gte)
                .lt('created_at', colombiaRangeBounds(dateFrom, dateTo).lt)
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

    // ── Dimensión unificada: los valores son los que el motor va a AGRUPAR ──
    // Antes se listaban los utm_campaign crudos, así que elegir uno del slicer
    // devolvía 0: el motor agrupa y filtra por el nombre real de la campaña.
    // Ahora se devuelven los nombres reales (los que tienen gasto en el rango)
    // unidos a los UTM que no cruzaron, que siguen siendo filtrables.
    const unified = unifiedTarget(dim)
    if (unified !== null) {
        const resolver = params.cliente_id
            ? await loadResolver(params.cliente_id, dateFrom, dateTo)
            : null

        const set = new Set<string>()
        if (resolver) {
            const known = unified === 'campaign' ? resolver.campaignLabels()
                : unified === 'ad'               ? resolver.adLabels()
                :                                  resolver.adsetLabels()
            for (const n of known) if (n.trim()) set.add(n)
        }

        // Y lo que realmente aparece como fila: la etiqueta resuelta de cada lead
        // del período. Cubre los UTM huérfanos (filas propias, elegibles como
        // cualquier otra) y también las campañas con leads pero sin gasto en el
        // rango, que el índice conoce pero no lista como activas.
        const rows = await fetchAllRows(() => {
            let q = supabase
                .schema('report_utm')
                .from(table)
                .select(['id', ...UTM_RESOLVE_COLS].join(','))
                .gte('created_at', colombiaRangeBounds(dateFrom, dateTo).gte)
                .lt('created_at', colombiaRangeBounds(dateFrom, dateTo).lt)
            if (params.cliente_id) q = q.eq('cliente_id', params.cliente_id)
            return applyDimFilters(q, params.filters, params.source === 'sales' ? salesFilterKey : leadFilterKey)
        })
        for (const r of rows as Record<string, unknown>[]) {
            const { label } = resolveEntityLabel(r, unified, resolver)
            if (label && !label.startsWith('(sin ')) set.add(label)
        }

        return Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, 500)
    }

    const col = dim === 'utm_campaign_raw' ? 'utm_campaign' : dim === 'platform' ? 'platform' : dim

    let q = supabase
        .schema('report_utm')
        .from(table)
        .select(col)
        .gte('created_at', colombiaRangeBounds(dateFrom, dateTo).gte)
        .lt('created_at', colombiaRangeBounds(dateFrom, dateTo).lt)
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
