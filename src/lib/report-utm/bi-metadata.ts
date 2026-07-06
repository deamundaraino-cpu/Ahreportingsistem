// ── Client-safe types & metadata (NO server imports) ──────────────────
// Este archivo NO debe importar nada de '@/utils/supabase/server' ni de
// 'next/headers'. Lo consumen tanto el servidor (bi-query.ts) como los
// componentes cliente (widgets, editor). Mantenerlo libre de imports de
// servidor evita arrastrar next/headers al bundle del navegador.

export type BiMetric =
    | 'leads_count'
    | 'sales_count'
    | 'revenue'
    | 'spend'
    | 'meta_spend'
    | 'tiktok_spend'
    | 'cpl'
    | 'cpa'
    | 'roas'
    | 'conversion_rate'
    | 'clicks'
    | 'impressions'
    | 'cpc'
    | 'cpm'
    // ── Métricas de campaña (de metricas_diarias.meta_campaigns/tiktok_campaigns) ──
    | 'reach'
    | 'frequency'
    | 'ctr'
    | 'link_clicks'
    | 'leads_form'
    | 'purchases'
    | 'landing_page_views'
    | 'complete_registration'
    | 'results'
    | 'video_views'
    | 'video_thruplay'
    | 'messaging_conversations'
    | 'post_engagement'
    | 'post_reactions'
    | 'post_shares'
    | 'post_comments'

/**
 * Métricas de campaña ADITIVAS que se suman desde el JSONB `meta_campaigns`
 * (TikTok no las reporta → contribuyen 0). `spend`/`clicks`/`impressions` se
 * toman de las columnas escalares. `frequency`/`ctr` se recalculan de totales.
 * Las claves coinciden con los campos del objeto de campaña.
 */
export const AD_JSONB_METRICS = [
    'reach', 'link_clicks', 'leads_form', 'purchases', 'landing_page_views',
    'complete_registration', 'results', 'video_views', 'video_thruplay',
    'messaging_conversations', 'post_engagement', 'post_reactions',
    'post_shares', 'post_comments',
] as const

export type BiDimension =
    | 'none'
    | 'utm_source'
    | 'utm_medium'
    | 'utm_campaign'
    | 'utm_content'
    | 'utm_term'
    | 'utm_id'
    | 'campaign'
    | 'date'
    | 'ip_country'
    | 'form_name'
    | 'form_plugin'
    | 'attribution_method'
    | 'platform'

export type DateGrouping = 'day' | 'week' | 'month'

export interface CalculatedFieldDef {
    name: string
    expression: string
}

export interface BiQueryParams {
    cliente_id?: string
    metrics: BiMetric[]
    dimension: BiDimension
    dimension2?: BiDimension
    date_from?: string
    date_to?: string
    date_grouping?: DateGrouping
    filters?: Record<string, string>
    limit?: number
    sort?: 'asc' | 'desc'
    calculated?: CalculatedFieldDef[]
    advancedFilter?: AdvancedFilter   // filtro guardado (Y de O), evaluado en memoria
}

export interface BiQueryRow {
    dimension_value: string | null
    leads_count?: number
    sales_count?: number
    revenue?: number
    spend?: number
    cpl?: number | null
    cpa?: number | null
    roas?: number | null
    conversion_rate?: number | null
    clicks?: number
    impressions?: number
    cpc?: number | null
    cpm?: number | null
    // campos calculados u otras claves dinámicas
    [key: string]: number | string | null | undefined
}

/** Fila pivoteada: una dimensión primaria + series por dimensión secundaria. */
export interface BiPivotRow {
    dimension_value: string
    series: Record<string, number>
}

export const METRIC_META: Record<BiMetric, { label: string; format: 'number' | 'currency' | 'percent' | 'ratio'; source: 'leads' | 'sales' | 'ads' | 'computed' }> = {
    leads_count:     { label: 'Leads',           format: 'number',   source: 'leads' },
    sales_count:     { label: 'Ventas',          format: 'number',   source: 'sales' },
    revenue:         { label: 'Revenue',         format: 'currency', source: 'sales' },
    spend:           { label: 'Gasto total',     format: 'currency', source: 'ads' },
    meta_spend:      { label: 'Gasto Meta',      format: 'currency', source: 'ads' },
    tiktok_spend:    { label: 'Gasto TikTok',    format: 'currency', source: 'ads' },
    cpl:             { label: 'CPL',             format: 'currency', source: 'computed' },
    cpa:             { label: 'CPA',             format: 'currency', source: 'computed' },
    roas:            { label: 'ROAS',            format: 'ratio',    source: 'computed' },
    conversion_rate: { label: 'Conv. Rate',      format: 'percent',  source: 'computed' },
    clicks:          { label: 'Clics',           format: 'number',   source: 'ads' },
    impressions:     { label: 'Impresiones',     format: 'number',   source: 'ads' },
    cpc:             { label: 'CPC',             format: 'currency', source: 'computed' },
    cpm:             { label: 'CPM',             format: 'currency', source: 'computed' },
    // ── Campaña ──
    reach:                  { label: 'Alcance',            format: 'number',  source: 'ads' },
    frequency:              { label: 'Frecuencia',         format: 'ratio',   source: 'computed' },
    ctr:                    { label: 'CTR',                format: 'percent', source: 'computed' },
    link_clicks:            { label: 'Clics de enlace',    format: 'number',  source: 'ads' },
    leads_form:             { label: 'Leads de formulario',format: 'number',  source: 'ads' },
    purchases:              { label: 'Compras',            format: 'number',  source: 'ads' },
    landing_page_views:     { label: 'Vistas de landing',  format: 'number',  source: 'ads' },
    complete_registration:  { label: 'Registros',          format: 'number',  source: 'ads' },
    results:                { label: 'Resultados',         format: 'number',  source: 'ads' },
    video_views:            { label: 'Reproducciones',     format: 'number',  source: 'ads' },
    video_thruplay:         { label: 'ThruPlay',           format: 'number',  source: 'ads' },
    messaging_conversations:{ label: 'Conversaciones',     format: 'number',  source: 'ads' },
    post_engagement:        { label: 'Interacciones',      format: 'number',  source: 'ads' },
    post_reactions:         { label: 'Reacciones',         format: 'number',  source: 'ads' },
    post_shares:            { label: 'Compartidos',        format: 'number',  source: 'ads' },
    post_comments:          { label: 'Comentarios',        format: 'number',  source: 'ads' },
}

export const DIMENSION_META: Record<BiDimension, { label: string }> = {
    none:              { label: 'Total' },
    utm_source:        { label: 'Source' },
    utm_medium:        { label: 'Medium' },
    utm_campaign:      { label: 'Campaña' },
    utm_content:       { label: 'Contenido' },
    utm_term:          { label: 'Término' },
    utm_id:            { label: 'UTM ID' },
    campaign:          { label: 'Campaña (cruzada)' },
    date:              { label: 'Fecha' },
    ip_country:        { label: 'País' },
    form_name:         { label: 'Formulario' },
    form_plugin:       { label: 'Plugin' },
    attribution_method:{ label: 'Atribución' },
    platform:          { label: 'Plataforma' },
}

// ── Filtros por valor (ocultar filas que no cumplan una condición numérica) ──
// Ej: spend > 0 oculta campañas sin gasto; cpl ≤ 50 deja solo leads baratos.
export type ValueOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'

export interface ValueFilter {
    metric: string          // clave de métrica/columna a evaluar
    op: ValueOp
    value: number
    value2?: number         // solo para 'between'
}

export const VALUE_OPS: { value: ValueOp; label: string; short: string }[] = [
    { value: 'gt',      label: 'mayor que',     short: '>' },
    { value: 'gte',     label: 'mayor o igual', short: '≥' },
    { value: 'lt',      label: 'menor que',     short: '<' },
    { value: 'lte',     label: 'menor o igual', short: '≤' },
    { value: 'eq',      label: 'igual a',       short: '=' },
    { value: 'neq',     label: 'distinto de',   short: '≠' },
    { value: 'between', label: 'entre',         short: '↔' },
]

export function matchesValueFilter(v: number, f: ValueFilter): boolean {
    const a = f.value
    switch (f.op) {
        case 'eq':  return v === a
        case 'neq': return v !== a
        case 'gt':  return v > a
        case 'gte': return v >= a
        case 'lt':  return v < a
        case 'lte': return v <= a
        case 'between': {
            const b = f.value2 ?? a
            const lo = Math.min(a, b), hi = Math.max(a, b)
            return v >= lo && v <= hi
        }
        default: return true
    }
}

/** Filtra filas dejando solo las que cumplen TODAS las condiciones de valor. */
export function applyValueFilters(rows: BiQueryRow[], filters?: ValueFilter[]): BiQueryRow[] {
    if (!filters || filters.length === 0) return rows
    return rows.filter(r => filters.every(f => matchesValueFilter(Number(r[f.metric] ?? 0), f)))
}

// ── Filtros UTM (variables globales del reporte) ──────────────────────
// Estos campos UTM pueden usarse como variables para recortar TODO el
// reporte (no solo agrupar). Se pasan al endpoint como filters[<key>].
export const UTM_FILTER_KEYS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'utm_id',
] as const

export type UtmFilterKey = typeof UTM_FILTER_KEYS[number]

export const UTM_FILTER_LABELS: Record<UtmFilterKey, string> = {
    utm_source:   'Source',
    utm_medium:   'Medium',
    utm_campaign: 'Campaña',
    utm_content:  'Contenido',
    utm_term:     'Término',
    utm_id:       'UTM ID',
}

/**
 * Agrega los filtros UTM activos a los query params de un widget,
 * con la forma `filters[utm_source]=valor` que entiende el endpoint.
 * Client-safe: lo usan los widgets en el navegador.
 */
export function appendUtmFilters(
    params: URLSearchParams,
    filters: Record<string, string | undefined>
): void {
    for (const key of UTM_FILTER_KEYS) {
        const value = filters[key]
        if (value && value.trim()) params.set(`filters[${key}]`, value.trim())
    }
}

/** Firma estable de los filtros UTM, para deps de useEffect. */
export function utmFilterSignature(filters: Record<string, string | undefined>): string {
    return UTM_FILTER_KEYS.map((k) => filters[k] ?? '').join('|')
}

// ── Operadores de filtro ──────────────────────────────────────────────
// El valor de un filtro puede llevar un operador codificado como
// "<op>:<valor>" (ej. "contains:instagram"). Sin prefijo válido = igualdad
// exacta (compatibilidad con drill-down, slicers y reportes existentes).

export type FilterOp = 'eq' | 'neq' | 'contains' | 'ncontains' | 'starts' | 'ends'

export const FILTER_OPS: { value: FilterOp; label: string; short: string }[] = [
    { value: 'eq',        label: 'es igual a',   short: '=' },
    { value: 'neq',       label: 'no es igual a', short: '≠' },
    { value: 'contains',  label: 'contiene',     short: '∋' },
    { value: 'ncontains', label: 'no contiene',  short: '∌' },
    { value: 'starts',    label: 'empieza con',  short: '⊢' },
    { value: 'ends',      label: 'termina con',  short: '⊣' },
]

const OP_SET = new Set<string>(FILTER_OPS.map(o => o.value))

/** Separa "<op>:<valor>" en operador + valor. Sin prefijo válido → eq. */
export function parseFilterValue(raw: string): { op: FilterOp; value: string } {
    const idx = raw.indexOf(':')
    if (idx > 0) {
        const maybe = raw.slice(0, idx)
        if (OP_SET.has(maybe)) return { op: maybe as FilterOp, value: raw.slice(idx + 1) }
    }
    return { op: 'eq', value: raw }
}

/** Codifica operador + valor en el formato de filtro. eq se guarda plano. */
export function encodeFilterValue(op: FilterOp, value: string): string {
    return op === 'eq' ? value : `${op}:${value}`
}

// ── Campos de formulario (raw_fields JSONB) ───────────────────────────
// Los formularios de cada cliente guardan sus campos en
// `report_utm.lead_events.raw_fields` (JSONB plano { clave: valor }). Son
// dinámicos por cliente, así que se referencian con tokens namespaced que
// conviven con las dimensiones/métricas fijas:
//   • Dimensión:  "field:<clave>"            → agrupar / filtrar por el campo
//   • Métrica:    "fieldagg:<agg>:<clave>"   → sum / avg / min / max / count
// En expresiones de campos calculados se referencian con el alias
// identificador "f_<agg>__<clave>" (solo claves identificador-safe [a-z0-9_]).

export type FieldAgg = 'sum' | 'avg' | 'min' | 'max' | 'count'

export const FIELD_AGGS: { value: FieldAgg; label: string; short: string }[] = [
    { value: 'sum',   label: 'Suma',     short: '∑' },
    { value: 'avg',   label: 'Promedio', short: 'x̄' },
    { value: 'min',   label: 'Mínimo',   short: '↓' },
    { value: 'max',   label: 'Máximo',   short: '↑' },
    { value: 'count', label: 'Respuestas', short: '#' },
]

const FIELD_AGG_LABEL: Record<FieldAgg, string> = {
    sum: 'Suma', avg: 'Promedio', min: 'Mínimo', max: 'Máximo', count: 'Respuestas',
}

export const FIELD_DIM_PREFIX = 'field:'
export const FIELD_METRIC_PREFIX = 'fieldagg:'

export function makeFieldDim(key: string): string {
    return `${FIELD_DIM_PREFIX}${key}`
}
export function isFieldDim(token: string): boolean {
    return typeof token === 'string' && token.startsWith(FIELD_DIM_PREFIX)
}
export function parseFieldDim(token: string): string | null {
    return isFieldDim(token) ? token.slice(FIELD_DIM_PREFIX.length) : null
}

export function makeFieldMetric(agg: FieldAgg, key: string): string {
    return `${FIELD_METRIC_PREFIX}${agg}:${key}`
}
export function isFieldMetric(token: string): boolean {
    return typeof token === 'string' && token.startsWith(FIELD_METRIC_PREFIX)
}
export function parseFieldMetric(token: string): { agg: FieldAgg; key: string } | null {
    if (!isFieldMetric(token)) return null
    const rest = token.slice(FIELD_METRIC_PREFIX.length)
    const idx = rest.indexOf(':')
    if (idx <= 0) return null
    const agg = rest.slice(0, idx) as FieldAgg
    const key = rest.slice(idx + 1)
    if (!(agg in FIELD_AGG_LABEL) || !key) return null
    return { agg, key }
}

/** Alias identificador-safe para usar una métrica de campo en expresiones calc. */
export function fieldMetricAlias(agg: FieldAgg, key: string): string {
    return `f_${agg}__${key.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`
}

/** Extrae de una expresión calc las métricas de campo referenciadas por alias. */
export function extractFieldMetricAliases(
    expression: string
): { agg: FieldAgg; key: string; alias: string }[] {
    const out: { agg: FieldAgg; key: string; alias: string }[] = []
    const re = /\bf_(sum|avg|min|max|count)__([a-z0-9_]+)\b/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(expression)) !== null) {
        const agg = m[1].toLowerCase() as FieldAgg
        const key = m[2].toLowerCase()
        out.push({ agg, key, alias: `f_${agg}__${key}` })
    }
    return out
}

/** 'producto_interes' → 'Producto interes'. */
export function humanizeFieldKey(key: string): string {
    const s = key.replace(/[_-]+/g, ' ').trim()
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : key
}

/** Etiqueta legible para un token de dimensión de campo. null si no lo es. */
export function fieldDimLabel(token: string): string | null {
    const key = parseFieldDim(token)
    return key !== null ? humanizeFieldKey(key) : null
}

/** Etiqueta legible para un token de métrica de campo. null si no lo es. */
export function fieldMetricLabel(token: string): string | null {
    const p = parseFieldMetric(token)
    return p ? `${FIELD_AGG_LABEL[p.agg]} · ${humanizeFieldKey(p.key)}` : null
}

/** Formato de visualización de una métrica de campo (numérico simple). */
export function fieldMetricFormat(token: string): 'number' | null {
    return isFieldMetric(token) ? 'number' : null
}

/**
 * Convierte el valor (string) de un campo de formulario a número, o null si
 * no es numérico. Acepta enteros/decimales con coma o punto y separadores de
 * miles simples ("1.000,50", "1,000.50", "12,5", "$1200"). Se usa tanto en el
 * descubrimiento (inferir tipo) como en la agregación (sum/avg/min/max).
 */
export function parseFieldNumber(raw: unknown): number | null {
    if (raw === null || raw === undefined) return null
    let s = String(raw).trim()
    if (!s) return null
    s = s.replace(/[$€£\s]/g, '')
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))       s = s.replace(/\./g, '').replace(',', '.') // 1.000,50
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))  s = s.replace(/,/g, '')                     // 1,000.50
    else if (/^-?\d+(,\d+)?$/.test(s))                s = s.replace(',', '.')                     // 12,5
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
}

/** Metadata de un campo de formulario descubierto (endpoint form-fields). */
export interface FormFieldMeta {
    key: string
    label: string
    type: 'number' | 'text'
    coverage: number        // 0..1 fracción de leads que traen el campo
    distinctCount: number
    sampleValues: string[]
}

/**
 * Agrega al query los filtros de campo de formulario activos (claves "field:*"),
 * con la forma `filters[field:<clave>]=valor` que entiende el endpoint. Client-safe.
 */
export function appendFieldFilters(
    params: URLSearchParams,
    filters: Record<string, string | undefined>
): void {
    for (const [k, v] of Object.entries(filters)) {
        if (isFieldDim(k) && v && String(v).trim()) params.set(`filters[${k}]`, String(v).trim())
    }
}

/** Firma estable de los filtros de campo activos, para deps de useEffect. */
export function fieldFilterSignature(filters: Record<string, string | undefined>): string {
    return Object.keys(filters)
        .filter(isFieldDim)
        .sort()
        .map((k) => `${k}=${filters[k] ?? ''}`)
        .join('|')
}

// ── Campos calculados ─────────────────────────────────────────────────
// Evaluador seguro de expresiones aritméticas sobre métricas base.
// Solo permite identificadores de métrica, números, + - * / ( ) y punto.

const ALLOWED_EXPR = /^[a-z0-9_+\-*/().\s]+$/i

/**
 * Evalúa una expresión tipo "revenue / leads_count" usando los valores
 * de una fila. Devuelve null si la expresión es inválida o hay división
 * por cero. Client-safe (no usa nada de servidor).
 */
export function evaluateExpression(
    expression: string,
    values: Record<string, number>
): number | null {
    if (!expression || !ALLOWED_EXPR.test(expression)) return null
    // Reemplaza identificadores por sus valores numéricos (0 si falta).
    const replaced = expression.replace(/[a-z_][a-z0-9_]*/gi, (id) => {
        const v = values[id]
        return Number.isFinite(v) ? String(v) : '0'
    })
    // Tras el reemplazo solo deben quedar números y operadores.
    if (!/^[0-9+\-*/().\s]+$/.test(replaced)) return null
    try {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${replaced});`)()
        if (typeof result !== 'number' || !Number.isFinite(result)) return null
        return Math.round(result * 100) / 100
    } catch {
        return null
    }
}

// ── Filtro avanzado guardado (Y de O) ─────────────────────────────────
// Filtro del informe que se persiste y auto-aplica a TODOS los widgets.
// Estructura de dos niveles: grupos unidos por Y (AND), cada grupo con
// condiciones unidas por O (OR). Ej: (source=fb O source=ig) Y (campaña ∋ verano).
// Se guarda serializado en `bi_reports.filters['__adv']` (columna existente,
// sin migración) y se evalúa en memoria sobre leads/ventas en el motor.

export interface FilterCondition {
    field: string       // utm_* | ip_country | form_name | form_plugin | attribution_method | platform | field:<clave>
    op: FilterOp
    value: string
}
export interface FilterGroup {
    conditions: FilterCondition[]   // unidas por O
}
export interface AdvancedFilter {
    groups: FilterGroup[]           // unidos por Y
}

/** Clave reservada dentro de BiFilters donde se serializa el filtro avanzado. */
export const ADVANCED_FILTER_KEY = '__adv'

/** Dimensiones base (no de formulario) ofrecidas en el constructor de filtros. */
export const FILTERABLE_BASE_DIMS: { value: string; label: string }[] = [
    { value: 'utm_source',         label: 'Source' },
    { value: 'utm_medium',         label: 'Medium' },
    { value: 'utm_campaign',       label: 'Campaña' },
    { value: 'utm_content',        label: 'Contenido' },
    { value: 'utm_term',           label: 'Término' },
    { value: 'utm_id',             label: 'UTM ID' },
    { value: 'ip_country',         label: 'País' },
    { value: 'form_name',          label: 'Formulario' },
    { value: 'form_plugin',        label: 'Plugin' },
    { value: 'attribution_method', label: 'Atribución' },
    { value: 'platform',           label: 'Plataforma (solo ventas)' },
]

/** Parsea el filtro avanzado desde su forma serializada (string JSON u objeto). */
export function parseAdvancedFilter(raw: unknown): AdvancedFilter {
    if (!raw) return { groups: [] }
    let obj: unknown = raw
    if (typeof raw === 'string') {
        try { obj = JSON.parse(raw) } catch { return { groups: [] } }
    }
    const groups = (obj as { groups?: unknown })?.groups
    if (!Array.isArray(groups)) return { groups: [] }
    return {
        groups: groups.map((g) => {
            const conds = (g as { conditions?: unknown })?.conditions
            return {
                conditions: Array.isArray(conds)
                    ? conds
                        .filter((c): c is FilterCondition => !!c && typeof (c as FilterCondition).field === 'string')
                        .map((c) => ({ field: c.field, op: (c.op ?? 'eq') as FilterOp, value: String(c.value ?? '') }))
                    : [],
            }
        }),
    }
}

/** ¿El filtro avanzado tiene al menos una condición completa (campo + valor)? */
export function advancedFilterHasConditions(af: AdvancedFilter | undefined | null): boolean {
    return !!af?.groups?.some((g) => g.conditions?.some((c) => c.field && c.value && c.value.trim()))
}

/** Serializa el filtro avanzado descartando condiciones/grupos vacíos. */
export function serializeAdvancedFilter(af: AdvancedFilter): string {
    const groups = (af.groups ?? [])
        .map((g) => ({ conditions: (g.conditions ?? []).filter((c) => c.field && c.value && c.value.trim()) }))
        .filter((g) => g.conditions.length > 0)
    return JSON.stringify({ groups })
}

/** Agrega el filtro avanzado (si hay) como parámetro `advanced` del query. */
export function appendAdvancedFilter(
    params: URLSearchParams,
    filters: Record<string, string | undefined>
): void {
    const raw = filters[ADVANCED_FILTER_KEY]
    if (raw && String(raw).trim() && String(raw) !== '{"groups":[]}') {
        params.set('advanced', String(raw))
    }
}

/** Firma estable del filtro avanzado, para deps de useEffect. */
export function advancedFilterSignature(filters: Record<string, string | undefined>): string {
    return String(filters[ADVANCED_FILTER_KEY] ?? '')
}

/**
 * Evalúa una condición de filtro en memoria (misma semántica que el filtrado
 * en base: eq/neq exactos y admiten multi-valor por comas; contains/starts/ends
 * insensibles a mayúsculas). Client-safe.
 */
export function matchFilterCondition(cell: string, op: FilterOp, target: string): boolean {
    const v = cell ?? ''
    const t = (target ?? '').trim()
    const lc = v.toLowerCase(), lt = t.toLowerCase()
    const parts = t.split(',').map((s) => s.trim()).filter(Boolean)
    switch (op) {
        case 'eq':        return parts.some((x) => v === x)
        case 'neq':       return !parts.some((x) => v === x)
        case 'contains':  return lc.includes(lt)
        case 'ncontains': return !lc.includes(lt)
        case 'starts':    return lc.startsWith(lt)
        case 'ends':      return lc.endsWith(lt)
        default:          return true
    }
}
