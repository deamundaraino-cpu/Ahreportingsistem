// ── Client-safe types & metadata (NO server imports) ──────────────────
// Este archivo NO debe importar nada de '@/utils/supabase/server' ni de
// 'next/headers'. Lo consumen tanto el servidor (bi-query.ts) como los
// componentes cliente (widgets, editor). Mantenerlo libre de imports de
// servidor evita arrastrar next/headers al bundle del navegador.

export type BiMetric =
    | 'leads_count'
    | 'leads_total'
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
    // ── Meta píxel ampliado (aditivas del JSONB meta_campaigns) ──
    | 'adds_to_cart'
    | 'initiates_checkout'
    | 'view_content'
    | 'search'
    | 'add_to_wishlist'
    | 'contact'
    | 'schedule'
    | 'subscribe'
    | 'start_trial'
    | 'submit_application'
    | 'page_engagement'
    | 'post_saves'
    | 'video_3s'
    // ── GA4 (columnas escalares de metricas_diarias) ──
    | 'ga_sessions'
    | 'ga_bounce_rate'
    | 'ga_avg_session_duration'
    // ── TikTok ──
    | 'tiktok_conversions'
    // ── Hotmart (columnas escalares de metricas_diarias) ──
    | 'hotmart_pagos_iniciados'
    | 'hotmart_revenue'
    | 'hotmart_sales'
    | 'ventas_principal'
    | 'ventas_bump'
    | 'ventas_upsell'
    | 'ventas_principal_count'
    | 'ventas_bump_count'
    | 'ventas_upsell_count'
    | 'ventas_cerradas'
    | 'ventas_principal_bruto'
    | 'ventas_bump_bruto'
    | 'ventas_upsell_bruto'
    // ── Conversiones offline (conversiones_offline_diarias) ──
    | 'offline_leads'
    | 'offline_ventas'
    | 'offline_revenue'
    | 'offline_total'
    // ── Suscripciones Hotmart (último snapshot, hotmart_subscriptions_snapshot) ──
    | 'subs_active'
    | 'subs_delayed'
    | 'subs_canceled'
    | 'subs_total'
    | 'subs_mrr'

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
    // Ampliación (jul 2026): más eventos de píxel presentes en meta_campaigns.
    'adds_to_cart', 'initiates_checkout', 'view_content', 'search',
    'add_to_wishlist', 'contact', 'schedule', 'subscribe', 'start_trial',
    'submit_application', 'page_engagement', 'post_saves', 'video_3s',
] as const

/**
 * Métricas ESCALARES aditivas de `public.metricas_diarias` (nombre de métrica =
 * nombre de columna). Se suman fila-a-fila igual que meta_spend. No cruzan por
 * dimensiones de lead (caen en "(total)"); solo global, por fecha o campaña.
 */
export const AD_SCALAR_METRICS = [
    'ga_sessions', 'tiktok_conversions', 'hotmart_pagos_iniciados',
    'ventas_principal', 'ventas_bump', 'ventas_upsell',
    'ventas_principal_count', 'ventas_bump_count', 'ventas_upsell_count',
    'ventas_cerradas',
    'ventas_principal_bruto', 'ventas_bump_bruto', 'ventas_upsell_bruto',
] as const

/**
 * Métricas de TASA de `metricas_diarias` que NO son aditivas: se promedian
 * ponderadas por sesiones (ga_sessions) para un agregado correcto.
 */
export const AD_RATE_METRICS = ['ga_bounce_rate', 'ga_avg_session_duration'] as const

/** Métricas de conversiones offline (tabla `conversiones_offline_diarias`). */
export const OFFLINE_METRICS = ['offline_leads', 'offline_ventas', 'offline_revenue', 'offline_total'] as const

/** Métricas de suscripciones (último snapshot de `hotmart_subscriptions_snapshot`). */
export const SUBS_METRICS = ['subs_active', 'subs_delayed', 'subs_canceled', 'subs_total', 'subs_mrr'] as const

/** Dimensiones que SOLO desglosan gasto/métricas de campaña (nivel anuncio/conjunto). */
export const ADS_ONLY_DIMS = ['ad', 'adset'] as const

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
    // ── Dimensiones de ventas (solo sales_events) ──
    | 'product_name'
    | 'transaction_type'
    | 'customer_country'
    // ── Dimensiones de anuncio/conjunto (solo gasto/métricas de campaña) ──
    | 'ad'
    | 'adset'

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
    // Leads (todos los canales): conteo de-duplicado de lead_events, que ya abarca todos los canales
    // (formularios web + Meta Lead Ads). Equivale a leads_count; NO suma el agregado de Meta.
    leads_total:     { label: 'Leads (todos los canales)', format: 'number', source: 'leads' },
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
    // ── Meta píxel ampliado ──
    adds_to_cart:           { label: 'Añadir al carrito',      format: 'number', source: 'ads' },
    initiates_checkout:     { label: 'Iniciar pago',           format: 'number', source: 'ads' },
    view_content:           { label: 'Ver contenido',          format: 'number', source: 'ads' },
    search:                 { label: 'Búsquedas',              format: 'number', source: 'ads' },
    add_to_wishlist:        { label: 'Añadir a lista deseos',  format: 'number', source: 'ads' },
    contact:                { label: 'Contactos',              format: 'number', source: 'ads' },
    schedule:               { label: 'Agendamientos',          format: 'number', source: 'ads' },
    subscribe:              { label: 'Suscripciones',          format: 'number', source: 'ads' },
    start_trial:            { label: 'Inicio de prueba',       format: 'number', source: 'ads' },
    submit_application:     { label: 'Solicitudes',            format: 'number', source: 'ads' },
    page_engagement:        { label: 'Interacción con página', format: 'number', source: 'ads' },
    post_saves:             { label: 'Guardados',              format: 'number', source: 'ads' },
    video_3s:               { label: 'Video 3s',               format: 'number', source: 'ads' },
    // ── GA4 ──
    ga_sessions:            { label: 'Sesiones (GA4)',         format: 'number',  source: 'ads' },
    ga_bounce_rate:         { label: 'Tasa de rebote (GA4)',   format: 'percent', source: 'ads' },
    ga_avg_session_duration:{ label: 'Duración sesión GA4 (s)', format: 'number',  source: 'ads' },
    // ── TikTok ──
    tiktok_conversions:     { label: 'Conversiones TikTok',    format: 'number',  source: 'ads' },
    // ── Hotmart ──
    hotmart_pagos_iniciados:{ label: 'Pagos iniciados (Hotmart)', format: 'number',   source: 'ads' },
    hotmart_revenue:        { label: 'Facturación Hotmart (neto)', format: 'currency', source: 'computed' },
    hotmart_sales:          { label: 'Ventas Hotmart (total)',  format: 'number',   source: 'computed' },
    ventas_principal:       { label: 'Ventas principal (neto)', format: 'currency', source: 'ads' },
    ventas_bump:            { label: 'Ventas bump (neto)',      format: 'currency', source: 'ads' },
    ventas_upsell:          { label: 'Ventas upsell (neto)',    format: 'currency', source: 'ads' },
    ventas_principal_count: { label: 'Ventas principal (#)',    format: 'number',   source: 'ads' },
    ventas_bump_count:      { label: 'Ventas bump (#)',         format: 'number',   source: 'ads' },
    ventas_upsell_count:    { label: 'Ventas upsell (#)',       format: 'number',   source: 'ads' },
    ventas_cerradas:        { label: 'Ventas cerradas (#)',     format: 'number',   source: 'ads' },
    ventas_principal_bruto: { label: 'Ventas principal (bruto)',format: 'currency', source: 'ads' },
    ventas_bump_bruto:      { label: 'Ventas bump (bruto)',     format: 'currency', source: 'ads' },
    ventas_upsell_bruto:    { label: 'Ventas upsell (bruto)',   format: 'currency', source: 'ads' },
    // ── Conversiones offline ──
    offline_leads:          { label: 'Leads offline',           format: 'number',   source: 'ads' },
    offline_ventas:         { label: 'Ventas offline',          format: 'number',   source: 'ads' },
    offline_revenue:        { label: 'Revenue offline',         format: 'currency', source: 'ads' },
    offline_total:          { label: 'Conversiones offline',    format: 'number',   source: 'ads' },
    // ── Suscripciones Hotmart (último snapshot) ──
    subs_active:            { label: 'Suscripciones activas',   format: 'number',   source: 'ads' },
    subs_delayed:           { label: 'Suscripciones atrasadas', format: 'number',   source: 'ads' },
    subs_canceled:          { label: 'Suscripciones canceladas',format: 'number',   source: 'ads' },
    subs_total:             { label: 'Suscripciones (total)',   format: 'number',   source: 'ads' },
    subs_mrr:               { label: 'MRR (valor recurrente)',  format: 'currency', source: 'ads' },
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
    product_name:      { label: 'Producto (venta)' },
    transaction_type:  { label: 'Tipo de transacción' },
    customer_country:  { label: 'País del cliente' },
    ad:                { label: 'Anuncio' },
    adset:             { label: 'Conjunto de anuncios' },
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

// ── Filtros de dimensión no-UTM (país/formulario/plugin/atribución/plataforma) ──
// appendUtmFilters cubre las UTM y appendFieldFilters las claves "field:*"; estas
// dimensiones planas quedaban fuera y por eso un drill/slicer por País no llegaba
// al API. Estas claves ya están permitidas en el backend (VALID_DIM_KEYS).

/** Claves de filtro plano de dimensión no cubiertas por appendUtmFilters/appendFieldFilters. */
export const DIM_FILTER_KEYS = ['ip_country', 'form_name', 'form_plugin', 'attribution_method', 'platform'] as const

/**
 * Agrega al query los filtros planos de dimensión no-UTM activos, con la forma
 * `filters[<clave>]=valor` que entiende el endpoint. Client-safe.
 */
export function appendDimFilters(
    params: URLSearchParams,
    filters: Record<string, string | undefined>
): void {
    for (const key of DIM_FILTER_KEYS) {
        const value = filters[key]
        if (value && String(value).trim()) params.set(`filters[${key}]`, String(value).trim())
    }
}

/** Firma estable de los filtros de dimensión no-UTM, para deps de useEffect. */
export function dimFilterSignature(filters: Record<string, string | undefined>): string {
    return DIM_FILTER_KEYS.map((k) => filters[k] ?? '').join('|')
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

/**
 * Agrega el filtro avanzado como parámetro `advanced` del query, combinando el
 * filtro del INFORME (serializado en filters['__adv']) con el filtro propio del
 * WIDGET (si se pasa). Ambos se fusionan en Y (AND): sus grupos se concatenan,
 * de modo que el widget muestra la intersección de ambos filtros. Retrocompatible:
 * sin `widgetFilter` se comporta como antes (solo filtro del informe).
 */
export function appendAdvancedFilter(
    params: URLSearchParams,
    filters: Record<string, string | undefined>,
    widgetFilter?: AdvancedFilter
): void {
    const report = parseAdvancedFilter(filters[ADVANCED_FILTER_KEY] ?? '')
    const combined: AdvancedFilter = { groups: [...(report.groups ?? []), ...(widgetFilter?.groups ?? [])] }
    if (advancedFilterHasConditions(combined)) {
        params.set('advanced', serializeAdvancedFilter(combined))
    }
}

/** Firma estable del filtro avanzado del informe, para deps de useEffect. */
export function advancedFilterSignature(filters: Record<string, string | undefined>): string {
    return String(filters[ADVANCED_FILTER_KEY] ?? '')
}

/** Firma estable del filtro avanzado propio de un widget, para deps de useEffect. */
export function widgetAdvancedSignature(af: AdvancedFilter | undefined | null): string {
    return af && advancedFilterHasConditions(af) ? serializeAdvancedFilter(af) : ''
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

// ── Atribución de gasto a filtros ─────────────────────────────────────
// El gasto (metricas_diarias) está preagregado por día×cliente, sin UTM ni
// campos de formulario. El único puente UTM→gasto es el NOMBRE de campaña
// (cruce loadCampaignIndex/matchToCampaign). Por eso:
//   • un filtro sobre utm_campaign SÍ puede recortar el gasto (por nombre);
//   • un filtro sobre país/formulario/campo/plataforma NO es atribuible al gasto.
// Los demás UTM (source/medium/content/term/id) no tienen mapeo limpio a gasto
// a nivel de campaña → se dejan sin recortar (limitación física documentada).

/** Campos de filtro que no pueden atribuirse al gasto de campañas. */
const NON_ATTRIBUTABLE_FIELDS = new Set(['ip_country', 'form_name', 'form_plugin', 'attribution_method', 'platform'])

/**
 * Construye un predicado sobre el NOMBRE de campaña a partir de las condiciones
 * de filtro (planas + avanzadas) cuyo campo es utm_campaign. Sirve para recortar
 * el gasto, que solo se atribuye a UTM vía el nombre de campaña.
 *
 * Semántica idéntica al filtro avanzado (grupos en Y, condiciones en O) pero
 * restringida a utm_campaign: un grupo sin condición de campaña se ignora (no
 * restringe el gasto). El filtro plano filters['utm_campaign'] actúa como grupo Y
 * adicional. Sin ninguna condición de campaña → predicado que acepta todo.
 */
export function campaignNameFilterPredicate(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined
): (name: string) => boolean {
    // Cada "clause" es un OR de condiciones (op,value); las clauses van en AND.
    const clauses: Array<{ op: FilterOp; value: string }[]> = []

    const plain = filters?.utm_campaign
    if (plain && plain.trim()) {
        const { op, value } = parseFilterValue(plain)
        if (value.trim()) clauses.push([{ op, value }])
    }

    for (const g of advancedFilter?.groups ?? []) {
        const conds = (g.conditions ?? [])
            .filter((c) => c.field === 'utm_campaign' && c.value && c.value.trim())
            .map((c) => ({ op: c.op, value: c.value }))
        if (conds.length) clauses.push(conds)
    }

    if (!clauses.length) return () => true
    return (name: string) =>
        clauses.every((or) => or.some((c) => matchFilterCondition(name ?? '', c.op, c.value)))
}

/** ¿Hay alguna condición de filtro sobre utm_campaign (plana o avanzada)? */
export function hasCampaignFilter(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined
): boolean {
    if (filters?.utm_campaign && filters.utm_campaign.trim()) return true
    return !!advancedFilter?.groups?.some(
        (g) => g.conditions?.some((c) => c.field === 'utm_campaign' && c.value && c.value.trim())
    )
}

/**
 * ¿Hay algún filtro activo que NO puede atribuirse al gasto (país/formulario/
 * plugin/atribución/plataforma/campo de formulario)? Cuando es true, el gasto y
 * sus ratios se anulan (decisión de producto: evitar CPL/CPA/ROAS engañosos).
 */
export function hasNonAttributableFilter(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined
): boolean {
    for (const [k, v] of Object.entries(filters ?? {})) {
        if (!v || !String(v).trim()) continue
        if (NON_ATTRIBUTABLE_FIELDS.has(k) || isFieldDim(k)) return true
    }
    return !!advancedFilter?.groups?.some((g) =>
        g.conditions?.some(
            (c) => c.value && c.value.trim() && (NON_ATTRIBUTABLE_FIELDS.has(c.field) || isFieldDim(c.field))
        )
    )
}

// ============================================================
// Comprensión para el cliente: glosario, metas y semáforos.
// ============================================================

/**
 * Explicación en lenguaje simple de cada métrica, pensada para el cliente final
 * (no para el trafficker). Se muestra como tooltip junto al título del widget.
 */
export const METRIC_GLOSSARY: Record<string, string> = {
    leads_count:   'Personas que dejaron sus datos en un formulario durante el período.',
    leads_total:   'Total de personas que dejaron sus datos, sumando formularios web y formularios de Meta.',
    sales_count:   'Cantidad de ventas registradas en el período.',
    revenue:       'Dinero total facturado por las ventas del período.',
    spend:         'Dinero invertido en publicidad (Meta + TikTok) durante el período.',
    meta_spend:    'Dinero invertido en anuncios de Meta (Facebook e Instagram).',
    tiktok_spend:  'Dinero invertido en anuncios de TikTok.',
    cpl:           'Costo por Lead: cuánto cuesta, en promedio, conseguir un contacto. Cuanto MÁS BAJO, mejor.',
    cpa:           'Costo por Adquisición: cuánto cuesta, en promedio, conseguir una venta. Cuanto MÁS BAJO, mejor.',
    roas:          'Retorno de la inversión publicitaria: por cada $1 invertido, cuántos $ se facturaron. Cuanto MÁS ALTO, mejor. Un ROAS de 3x significa que se facturó el triple de lo invertido.',
    conversion_rate: 'Porcentaje de leads que terminaron comprando.',
    clicks:        'Veces que alguien hizo clic en un anuncio.',
    impressions:   'Veces que se mostró un anuncio (una misma persona puede verlo varias veces).',
    reach:         'Personas distintas que vieron los anuncios.',
    frequency:     'Cuántas veces vio el anuncio, en promedio, cada persona. Si sube mucho, el público se está saturando.',
    ctr:           'Porcentaje de personas que hicieron clic tras ver el anuncio. Mide qué tan atractivo es el anuncio.',
    cpc:           'Costo por clic: cuánto se paga, en promedio, por cada clic.',
    cpm:           'Costo por cada mil impresiones del anuncio.',
    link_clicks:   'Clics que llevaron a la página de destino.',
    landing_page_views: 'Veces que la página de destino se cargó por completo tras un clic.',
    ga_sessions:   'Visitas al sitio web medidas por Google Analytics.',
    ga_bounce_rate: 'Porcentaje de visitas que se fueron sin interactuar con el sitio. Cuanto MÁS BAJO, mejor.',
}

/** Texto del glosario para una métrica, si existe. */
export function metricGlossary(metric: string): string | undefined {
    return METRIC_GLOSSARY[metric]
}

/** Métricas donde un valor MENOR es mejor (costos y tasas de abandono). */
export const LOWER_IS_BETTER = new Set([
    'cpl', 'cpa', 'cpc', 'cpm', 'spend', 'meta_spend', 'tiktok_spend',
    'ga_bounce_rate', 'frequency',
])

/** ¿Para esta métrica, bajar es mejorar? */
export function isLowerBetter(metric: string): boolean {
    return LOWER_IS_BETTER.has(metric)
}

/** Metas por cliente (report_utm.clientes.config.goals). */
export interface ClienteGoals {
    /** CPL objetivo: no superar. */
    cpl_max?: number
    /** CPA objetivo: no superar. */
    cpa_max?: number
    /** ROAS mínimo aceptable. */
    roas_min?: number
    /** Leads esperados en el período. */
    leads_target?: number
    /** Presupuesto del período: no superar. */
    budget?: number
}

/** Métrica → clave de meta y sentido de la comparación. */
const GOAL_BY_METRIC: Record<string, { key: keyof ClienteGoals; mustNotExceed: boolean }> = {
    cpl:         { key: 'cpl_max',      mustNotExceed: true },
    cpa:         { key: 'cpa_max',      mustNotExceed: true },
    roas:        { key: 'roas_min',     mustNotExceed: false },
    leads_count: { key: 'leads_target', mustNotExceed: false },
    leads_total: { key: 'leads_target', mustNotExceed: false },
    spend:       { key: 'budget',       mustNotExceed: true },
    meta_spend:  { key: 'budget',       mustNotExceed: true },
}

export type GoalStatus = 'good' | 'warn' | 'bad'

export interface GoalEvaluation {
    status: GoalStatus
    /** Valor objetivo con el que se comparó. */
    target: number
    /** true si la meta es un techo (no superar), false si es un piso (alcanzar). */
    mustNotExceed: boolean
}

/** Margen de tolerancia antes de marcar en rojo (±15%). */
const GOAL_TOLERANCE = 0.15

/**
 * Compara el valor de una métrica contra la meta del cliente.
 * Devuelve null si la métrica no tiene meta asociada o la meta no está definida.
 */
export function evaluateGoal(
    metric: string,
    value: number,
    goals?: ClienteGoals | null,
): GoalEvaluation | null {
    if (!goals) return null
    const rule = GOAL_BY_METRIC[metric]
    if (!rule) return null
    const target = goals[rule.key]
    if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) return null

    let status: GoalStatus
    if (rule.mustNotExceed) {
        // Techo: cumplir es quedar por debajo.
        if (value <= target) status = 'good'
        else if (value <= target * (1 + GOAL_TOLERANCE)) status = 'warn'
        else status = 'bad'
    } else {
        // Piso: cumplir es alcanzar o superar.
        if (value >= target) status = 'good'
        else if (value >= target * (1 - GOAL_TOLERANCE)) status = 'warn'
        else status = 'bad'
    }
    return { status, target, mustNotExceed: rule.mustNotExceed }
}

/** ¿Esta métrica puede compararse contra alguna meta del cliente? */
export function metricHasGoal(metric: string, goals?: ClienteGoals | null): boolean {
    return evaluateGoal(metric, 0, goals) !== null || (!!GOAL_BY_METRIC[metric] && !!goals)
}
