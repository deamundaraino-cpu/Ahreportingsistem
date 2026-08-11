// ── Client-safe types & metadata (NO server imports) ──────────────────
// Este archivo NO debe importar nada de '@/utils/supabase/server' ni de
// 'next/headers'. Lo consumen tanto el servidor (bi-query.ts) como los
// componentes cliente (widgets, editor). Mantenerlo libre de imports de
// servidor evita arrastrar next/headers al bundle del navegador.

// `bi/expr.ts` es puro (sin imports), así que respeta la regla de arriba.
import { parseExpr, isExprError, evalExpr } from './bi/expr'
// `bi-valores` no importa nada, así que la dependencia va en un solo sentido y
// no hay ciclo. Es la ÚNICA forma de partir una selección guardada: tenerla
// escrita cuatro veces fue lo que dejó que un valor con coma se rompiera en
// silencio durante todo este tiempo.
import { parseSeleccion } from './bi-valores'

/**
 * Normalización fuerte de etiquetas: minúsculas, sin acentos, `_`/`-` como
 * espacios, espacios colapsados. Convierte muchos "casi-iguales" en matches
 * EXACTOS reales (`promo_verano` → `promo verano` ← `Promo Verano`).
 *
 * Vive aquí —y no en el resolver de campañas, que es server-only— porque el
 * cruce UTM↔campaña se compara igual en los dos lados: el motor al agrupar y la
 * UI al avisar de que un filtro no coincide con ninguna campaña. Con dos
 * normalizaciones distintas la UI avisaba en falso de lo que el motor sí cruzaba.
 */
export function normLabel(s: string): string {
    return (s ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // quita acentos (marcas combinantes)
        .replace(/[_-]+/g, ' ')            // _ y - → espacio
        .trim()
        .replace(/\s+/g, ' ')
}

/** Redondeo a 2 decimales. Único en el módulo: el motor y el diagnóstico deben
 *  redondear igual o sus totales no cuadran entre sí por céntimos. */
export function round2(n: number): number {
    return Math.round(n * 100) / 100
}

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
    | 'hotmart_roas'
    | 'hotmart_cpa'
    | 'hotmart_roi'
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
    // ── Ventas Hotmart por transacción (public.hotmart_ventas) ──
    // A diferencia de las `hotmart_*` de arriba, que leen el agregado diario de
    // `metricas_diarias` y por eso NO se pueden repartir por campaña, estas
    // vienen de una tabla con una fila por venta y sí cruzan.
    | 'hm_ventas'
    | 'hm_neto'
    | 'hm_bruto'
    | 'hm_reembolsos'
    | 'hm_neto_reembolsado'
    | 'hm_tasa_reembolso'
    | 'hm_roas'
    | 'hm_cpa'
    | 'hm_ticket_medio'
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
    'ventas_principal_bruto', 'ventas_bump_bruto', 'ventas_upsell_bruto',
] as const

/**
 * Métricas que viven dentro del JSONB `metricas_diarias.metricas_manuales`
 * (entrada manual del dashboard), no en una columna propia.
 *
 * `ventas_cerradas` TIENE columna en la tabla, pero el worker nunca la escribe:
 * el número real que carga el equipo queda en `metricas_manuales.VENTAS_CERRADAS`.
 * Leerla de la columna devolvía siempre 0 en los informes.
 */
export const MANUAL_JSONB_METRICS = [
    { metric: 'ventas_cerradas', jsonKey: 'VENTAS_CERRADAS' },
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

/**
 * Dimensiones de nivel anuncio/conjunto. Desde la unificación, leads y ventas
 * TAMBIÉN se agrupan por ellas (resolviendo utm_content/utm_term contra los
 * nombres reales), así que ya no son exclusivas del gasto; el nombre se conserva
 * porque siguen siendo las únicas que no existen como columna en lead_events.
 */
export const ADS_ONLY_DIMS: ReadonlySet<string> = new Set(['ad', 'adset'])

/**
 * Métricas ADITIVAS: sumar sus valores fila a fila da un total correcto, así que
 * la tabla puede calcular la fila "Total". Se excluyen ratios/promedios (CPL,
 * ROAS, CTR… se recalculan sobre los totales base) y `reach`, que es un conteo
 * de personas ÚNICAS: sumar el alcance de varias campañas cuenta dos veces a
 * quien vio ambas.
 */
export const ADDITIVE_METRICS: ReadonlySet<string> = new Set<string>([
    'leads_count', 'sales_count', 'revenue',
    'spend', 'meta_spend', 'tiktok_spend', 'clicks', 'impressions',
    ...AD_JSONB_METRICS.filter(m => m !== 'reach'),
    ...AD_SCALAR_METRICS,
    ...MANUAL_JSONB_METRICS.map(m => m.metric),
    ...OFFLINE_METRICS,
    'hotmart_revenue', 'hotmart_sales',
    // Conteos e importes por transacción: aditivos. Los ratios de la misma
    // fuente (tasa de reembolso, ROAS, CPA, ticket medio) NO están aquí: se
    // recalculan sobre los totales de sus operandos.
    'hm_ventas', 'hm_neto', 'hm_bruto', 'hm_reembolsos', 'hm_neto_reembolsado',
])

/** ¿La fila "Total" de una tabla puede sumar esta métrica directamente? */
export function isAdditiveMetric(metric: string): boolean {
    // Los campos de Sheet lo deciden por su agregación (ver isAdditiveSheetToken).
    if (isSheetToken(metric)) return isAdditiveSheetToken(metric)
    return ADDITIVE_METRICS.has(metric)
}

/**
 * Métricas válidas como ETAPA de un embudo: deben ser conteos aditivos y estar
 * ordenadas de mayor a menor a lo largo del funnel. Se excluyen importes y
 * ratios (un embudo de "$" o de "%" no tiene sentido).
 */
export const FUNNEL_STAGE_METRICS = [
    'impressions', 'reach', 'clicks', 'link_clicks', 'landing_page_views',
    'video_views', 'video_thruplay', 'leads_count', 'leads_form',
    'complete_registration', 'view_content', 'adds_to_cart',
    'initiates_checkout', 'purchases', 'sales_count', 'hm_ventas',
] as const

/** Etapas por defecto del embudo cuando el widget no configura ninguna. */
export const DEFAULT_FUNNEL_STAGES: BiMetric[] = ['impressions', 'clicks', 'leads_count', 'sales_count']

/**
 * Métricas soportadas por el pivot (dimensión secundaria). El pivot agrupa filas
 * de lead_events/sales_events, así que solo puede contar filas o sumar `amount`:
 * cualquier otra métrica (gasto, campaña, GA4…) daría un conteo de filas sin
 * sentido. El editor y el endpoint restringen `dimension2` a estas.
 */
export const PIVOT_METRICS: BiMetric[] = [
    'leads_count', 'sales_count', 'revenue',
    // Las cinco medidas físicas de `hotmart_ventas`. Todas son o un conteo de
    // filas o la suma de una columna, que es exactamente lo que el pivot sabe
    // hacer; los ratios de la misma fuente quedan fuera porque no se pueden
    // sumar por celda.
    'hm_ventas', 'hm_neto', 'hm_bruto', 'hm_reembolsos', 'hm_neto_reembolsado',
]

/** ¿Esta métrica se puede usar con una dimensión secundaria (gráfica apilada)? */
export function supportsPivot(metric: string): boolean {
    return (PIVOT_METRICS as string[]).includes(metric)
}

export type BiDimension =
    | 'none'
    | 'utm_source'
    | 'utm_medium'
    | 'utm_campaign'
    | 'utm_content'
    | 'utm_term'
    | 'utm_id'
    /**
     * Alias histórico de `utm_campaign`. Antes tenía su propio motor
     * (`runCampaignQuery`); hoy `utm_campaign` YA cruza con el gasto, así que el
     * dispatcher lo normaliza a `utm_campaign` al entrar. Se mantiene en el tipo
     * porque hay informes guardados con `dimension: 'campaign'`.
     */
    | 'campaign'
    /**
     * Agrupa por la columna `utm_campaign` TAL CUAL, sin resolver contra las
     * campañas reales. Solo para auditar los UTM que llegan; es el
     * comportamiento que tenía `utm_campaign` antes de la unificación.
     */
    | 'utm_campaign_raw'
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
    // ── public.hotmart_ventas ──
    | 'hm_tipo'
    | 'hm_oferta'
    | 'hm_producto'
    | 'hm_pais'
    | 'hm_metodo_pago'
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

// ── Catálogo de métricas ──────────────────────────────────────────────
//
// Cada métrica declara DOS cosas además de su etiqueta y formato:
//
//   `group`     — dónde se muestra en el selector. Sustituye al antiguo `source`,
//                 que era un vertedero: 56 de 72 métricas estaban marcadas 'ads',
//                 incluidas GA4, Hotmart, offline y suscripciones. Como el editor
//                 lo usaba para decidir avisos, avisaba en falso sobre ellas.
//
//   `breakdown` — hasta dónde se puede desglosar. Es la respuesta a "¿por qué mi
//                 tabla por país muestra el gasto en 0?", y lo que permite marcar
//                 la métrica en el selector ANTES de que el usuario la elija:
//                   • 'any'      cruza por cualquier dimensión (columnas de
//                                lead_events / sales_events)
//                   • 'campaign' cruza por fecha y por campaña/anuncio/conjunto
//                                (gasto y JSONB de anuncios: no hay UTM en
//                                metricas_diarias, solo el nombre de la entidad)
//                   • 'total'    solo total o fecha (columnas escalares de
//                                metricas_diarias: GA4, Hotmart, offline)
//                   • 'global'   solo el total del período (snapshot puntual)

export type MetricGroup =
    | 'leads' | 'ventas' | 'inversion' | 'rendimiento'
    | 'campana' | 'ga4' | 'hotmart' | 'offline' | 'subs'

export type MetricBreakdown = 'any' | 'campaign' | 'total' | 'global'

export interface MetricMetaEntry {
    label: string
    format: 'number' | 'currency' | 'percent' | 'ratio'
    group: MetricGroup
    breakdown: MetricBreakdown
}

/** Etiqueta de cada grupo en el selector, en el orden en que se muestran. */
export const METRIC_GROUP_META: { key: MetricGroup; label: string }[] = [
    { key: 'leads',       label: 'Leads' },
    { key: 'ventas',      label: 'Ventas' },
    { key: 'inversion',   label: 'Inversión' },
    { key: 'rendimiento', label: 'Rendimiento de anuncios' },
    { key: 'campana',     label: 'Eventos de campaña (Meta / TikTok)' },
    { key: 'hotmart',     label: 'Hotmart' },
    { key: 'ga4',         label: 'Google Analytics 4' },
    { key: 'offline',     label: 'Conversiones offline' },
    { key: 'subs',        label: 'Suscripciones' },
]

export const METRIC_META: Record<BiMetric, MetricMetaEntry> = {
    // ── Leads ──
    // Conteo de-duplicado de lead_events, que ya abarca TODOS los canales
    // (formularios web + Meta Lead Ads). La antigua 'leads_total' era un duplicado
    // exacto de esta métrica y se eliminó del catálogo (ver migración 045).
    // Se llama "(contactos)" para no confundirla con `leads_form` (píxel de Meta)
    // ni con `offline_leads` (Sheet): son tres cosas distintas que se solapan.
    leads_count:     { label: 'Leads (contactos)', format: 'number',   group: 'leads',  breakdown: 'any' },
    cpl:             { label: 'CPL',               format: 'currency', group: 'leads',  breakdown: 'campaign' },
    conversion_rate: { label: 'Conv. Rate',        format: 'percent',  group: 'leads',  breakdown: 'any' },
    // ── Ventas ──
    sales_count:     { label: 'Ventas',            format: 'number',   group: 'ventas', breakdown: 'any' },
    revenue:         { label: 'Revenue',           format: 'currency', group: 'ventas', breakdown: 'any' },
    cpa:             { label: 'CPA',               format: 'currency', group: 'ventas', breakdown: 'campaign' },
    roas:            { label: 'ROAS',              format: 'ratio',    group: 'ventas', breakdown: 'campaign' },
    // ── Inversión ──
    spend:           { label: 'Gasto total',       format: 'currency', group: 'inversion', breakdown: 'campaign' },
    meta_spend:      { label: 'Gasto Meta',        format: 'currency', group: 'inversion', breakdown: 'campaign' },
    tiktok_spend:    { label: 'Gasto TikTok',      format: 'currency', group: 'inversion', breakdown: 'campaign' },
    // ── Rendimiento de anuncios ──
    clicks:          { label: 'Clics',             format: 'number',   group: 'rendimiento', breakdown: 'campaign' },
    impressions:     { label: 'Impresiones',       format: 'number',   group: 'rendimiento', breakdown: 'campaign' },
    ctr:             { label: 'CTR',               format: 'percent',  group: 'rendimiento', breakdown: 'campaign' },
    cpc:             { label: 'CPC',               format: 'currency', group: 'rendimiento', breakdown: 'campaign' },
    cpm:             { label: 'CPM',               format: 'currency', group: 'rendimiento', breakdown: 'campaign' },
    reach:           { label: 'Alcance',           format: 'number',   group: 'rendimiento', breakdown: 'campaign' },
    frequency:       { label: 'Frecuencia',        format: 'ratio',    group: 'rendimiento', breakdown: 'campaign' },
    link_clicks:     { label: 'Clics de enlace',   format: 'number',   group: 'rendimiento', breakdown: 'campaign' },
    // ── Eventos de campaña (JSONB meta_campaigns / tiktok_*) ──
    // `leads_form` es lo que reporta el PÍXEL de Meta, no la tabla de leads:
    // puede diferir de leads_count y no son sumables entre sí.
    leads_form:             { label: 'Leads del píxel de Meta', format: 'number', group: 'campana', breakdown: 'campaign' },
    purchases:              { label: 'Compras',            format: 'number',  group: 'campana', breakdown: 'campaign' },
    landing_page_views:     { label: 'Vistas de landing',  format: 'number',  group: 'campana', breakdown: 'campaign' },
    complete_registration:  { label: 'Registros',          format: 'number',  group: 'campana', breakdown: 'campaign' },
    results:                { label: 'Resultados',         format: 'number',  group: 'campana', breakdown: 'campaign' },
    video_views:            { label: 'Reproducciones',     format: 'number',  group: 'campana', breakdown: 'campaign' },
    video_thruplay:         { label: 'ThruPlay',           format: 'number',  group: 'campana', breakdown: 'campaign' },
    messaging_conversations:{ label: 'Conversaciones',     format: 'number',  group: 'campana', breakdown: 'campaign' },
    post_engagement:        { label: 'Interacciones',      format: 'number',  group: 'campana', breakdown: 'campaign' },
    post_reactions:         { label: 'Reacciones',         format: 'number',  group: 'campana', breakdown: 'campaign' },
    post_shares:            { label: 'Compartidos',        format: 'number',  group: 'campana', breakdown: 'campaign' },
    post_comments:          { label: 'Comentarios',        format: 'number',  group: 'campana', breakdown: 'campaign' },
    adds_to_cart:           { label: 'Añadir al carrito',  format: 'number',  group: 'campana', breakdown: 'campaign' },
    // "(Meta)" en el nombre: `hotmart_pagos_iniciados` se llamaba igual y eran dos
    // métricas de fuentes distintas indistinguibles en el selector.
    initiates_checkout:     { label: 'Iniciar pago (Meta)', format: 'number', group: 'campana', breakdown: 'campaign' },
    view_content:           { label: 'Ver contenido',          format: 'number', group: 'campana', breakdown: 'campaign' },
    search:                 { label: 'Búsquedas',              format: 'number', group: 'campana', breakdown: 'campaign' },
    add_to_wishlist:        { label: 'Añadir a lista deseos',  format: 'number', group: 'campana', breakdown: 'campaign' },
    contact:                { label: 'Contactos',              format: 'number', group: 'campana', breakdown: 'campaign' },
    schedule:               { label: 'Agendamientos',          format: 'number', group: 'campana', breakdown: 'campaign' },
    subscribe:              { label: 'Suscripciones (píxel)',  format: 'number', group: 'campana', breakdown: 'campaign' },
    start_trial:            { label: 'Inicio de prueba',       format: 'number', group: 'campana', breakdown: 'campaign' },
    submit_application:     { label: 'Solicitudes',            format: 'number', group: 'campana', breakdown: 'campaign' },
    page_engagement:        { label: 'Interacción con página', format: 'number', group: 'campana', breakdown: 'campaign' },
    post_saves:             { label: 'Guardados',              format: 'number', group: 'campana', breakdown: 'campaign' },
    video_3s:               { label: 'Video 3s',               format: 'number', group: 'campana', breakdown: 'campaign' },
    tiktok_conversions:     { label: 'Conversiones TikTok',    format: 'number', group: 'campana', breakdown: 'campaign' },
    // ── GA4 (columnas escalares de metricas_diarias: día×cliente, sin campaña) ──
    ga_sessions:            { label: 'Sesiones (GA4)',         format: 'number',  group: 'ga4', breakdown: 'total' },
    ga_bounce_rate:         { label: 'Tasa de rebote (GA4)',   format: 'percent', group: 'ga4', breakdown: 'total' },
    ga_avg_session_duration:{ label: 'Duración sesión GA4 (s)', format: 'number', group: 'ga4', breakdown: 'total' },
    // ── Hotmart ──
    // OJO: `hotmart_pagos_iniciados` se calcula desde GA4 (payment_page_views),
    // no desde la API de Hotmart. El nombre viene del dashboard clásico.
    hotmart_pagos_iniciados:{ label: 'Pagos iniciados (Hotmart)', format: 'number',   group: 'hotmart', breakdown: 'total' },
    // Sumas de columnas escalares, no ratios: son aditivas (ver ADDITIVE_METRICS).
    hotmart_revenue:        { label: 'Facturación Hotmart (neto)', format: 'currency', group: 'hotmart', breakdown: 'total' },
    hotmart_sales:          { label: 'Ventas Hotmart (total)',  format: 'number',   group: 'hotmart', breakdown: 'total' },
    // Retorno calculado sobre la facturación agregada de Hotmart, no sobre
    // sales_events (ventas por webhook). Sirve para clientes que venden por
    // Hotmart sin webhook configurado, donde roas/cpa/revenue darían 0.
    hotmart_roas:           { label: 'ROAS (Hotmart)',          format: 'ratio',    group: 'hotmart', breakdown: 'total' },
    hotmart_cpa:            { label: 'CPA (Hotmart)',           format: 'currency', group: 'hotmart', breakdown: 'total' },
    hotmart_roi:            { label: 'ROI % (Hotmart)',         format: 'percent',  group: 'hotmart', breakdown: 'total' },
    ventas_principal:       { label: 'Ventas principal (neto)', format: 'currency', group: 'hotmart', breakdown: 'total' },
    ventas_bump:            { label: 'Ventas bump (neto)',      format: 'currency', group: 'hotmart', breakdown: 'total' },
    ventas_upsell:          { label: 'Ventas upsell (neto)',    format: 'currency', group: 'hotmart', breakdown: 'total' },
    ventas_principal_count: { label: 'Ventas principal (#)',    format: 'number',   group: 'hotmart', breakdown: 'total' },
    ventas_bump_count:      { label: 'Ventas bump (#)',         format: 'number',   group: 'hotmart', breakdown: 'total' },
    ventas_upsell_count:    { label: 'Ventas upsell (#)',       format: 'number',   group: 'hotmart', breakdown: 'total' },
    ventas_cerradas:        { label: 'Ventas cerradas (#)',     format: 'number',   group: 'hotmart', breakdown: 'total' },
    ventas_principal_bruto: { label: 'Ventas principal (bruto)',format: 'currency', group: 'hotmart', breakdown: 'total' },
    ventas_bump_bruto:      { label: 'Ventas bump (bruto)',     format: 'currency', group: 'hotmart', breakdown: 'total' },
    ventas_upsell_bruto:    { label: 'Ventas upsell (bruto)',   format: 'currency', group: 'hotmart', breakdown: 'total' },
    // ── Ventas Hotmart por transacción (public.hotmart_ventas) ──
    // `breakdown: 'any'` y no 'total': esta fuente tiene una fila por venta, con
    // sus propios UTM, así que se desglosa por cualquiera de sus columnas Y por
    // campaña. Es lo que las `hotmart_*` agregadas nunca pudieron hacer.
    hm_ventas:              { label: 'Ventas Hotmart (#)',        format: 'number',   group: 'hotmart', breakdown: 'any' },
    hm_neto:                { label: 'Facturación Hotmart (neto)',format: 'currency', group: 'hotmart', breakdown: 'any' },
    hm_bruto:               { label: 'Facturación Hotmart (bruto)',format: 'currency',group: 'hotmart', breakdown: 'any' },
    hm_reembolsos:          { label: 'Reembolsos (#)',            format: 'number',   group: 'hotmart', breakdown: 'any' },
    hm_neto_reembolsado:    { label: 'Facturación reembolsada',   format: 'currency', group: 'hotmart', breakdown: 'any' },
    hm_tasa_reembolso:      { label: 'Tasa de reembolso',         format: 'percent',  group: 'hotmart', breakdown: 'any' },
    // Estas dos heredan el límite del gasto: `ads_daily` se desglosa por campaña,
    // no por producto ni por país.
    hm_roas:                { label: 'ROAS (Hotmart real)',       format: 'ratio',    group: 'hotmart', breakdown: 'campaign' },
    hm_cpa:                 { label: 'CPA (Hotmart real)',        format: 'currency', group: 'hotmart', breakdown: 'campaign' },
    hm_ticket_medio:        { label: 'Ticket medio',              format: 'currency', group: 'hotmart', breakdown: 'any' },
    // ── Conversiones offline (Google Sheets del cliente) ──
    offline_leads:          { label: 'Leads offline (Sheet)',        format: 'number',   group: 'offline', breakdown: 'total' },
    offline_ventas:         { label: 'Ventas offline (Sheet)',       format: 'number',   group: 'offline', breakdown: 'total' },
    offline_revenue:        { label: 'Revenue offline (Sheet)',      format: 'currency', group: 'offline', breakdown: 'total' },
    offline_total:          { label: 'Conversiones offline (Sheet)', format: 'number',   group: 'offline', breakdown: 'total' },
    // ── Suscripciones Hotmart (último snapshot) ──
    // Es una FOTO puntual, no una serie: solo tiene sentido en el total del
    // período. Con cualquier dimensión (incluida Fecha) no hay nada que repartir.
    subs_active:            { label: 'Suscripciones activas',   format: 'number',   group: 'subs', breakdown: 'global' },
    subs_delayed:           { label: 'Suscripciones atrasadas', format: 'number',   group: 'subs', breakdown: 'global' },
    subs_canceled:          { label: 'Suscripciones canceladas',format: 'number',   group: 'subs', breakdown: 'global' },
    subs_total:             { label: 'Suscripciones (total)',   format: 'number',   group: 'subs', breakdown: 'global' },
    subs_mrr:               { label: 'MRR (valor recurrente)',  format: 'currency', group: 'subs', breakdown: 'global' },
}

/**
 * Las que sirven para el 90% de los informes y cruzan bien entre sí. Son las que
 * el editor muestra por defecto; el resto queda tras "Ver todas".
 */
export const RECOMMENDED_METRICS: BiMetric[] = [
    'leads_count', 'sales_count', 'revenue', 'spend',
    'cpl', 'cpa', 'roas', 'clicks', 'impressions', 'ctr', 'cpc', 'cpm',
    'hm_ventas', 'hm_neto', 'hm_roas', 'hm_cpa',
]

/**
 * ¿Esta métrica se desglosa por esta dimensión, o caería en la fila total?
 *
 * Es lo que permite marcar la métrica en el selector antes de elegirla, en vez de
 * dejar que el usuario descubra el 0 en el informe ya montado. Los tokens
 * dinámicos (campos de formulario, de Sheet) no se evalúan aquí: tienen sus
 * propios avisos, más específicos.
 */
export function metricCrossesDimension(metric: string, dimension: string): boolean {
    if (dimension === 'none') return true
    // Las columnas extra de Sheet offline viven en conversiones_offline_diarias,
    // que es día×cliente: se comportan como 'total'.
    if (isOfflineFieldMetric(metric)) return dimension === 'date'
    const meta = METRIC_META[metric as BiMetric]
    if (!meta) return true   // calculada, campo de formulario o de Sheet
    switch (meta.breakdown) {
        case 'any':      return true
        case 'campaign': return dimension === 'date' || unifiedTarget(dimension) !== null
        case 'total':    return dimension === 'date'
        case 'global':   return false
    }
}

/** Métricas del catálogo que pertenecen a un grupo, en orden de declaración. */
export function metricsOfGroup(group: MetricGroup): BiMetric[] {
    return (Object.keys(METRIC_META) as BiMetric[]).filter(m => METRIC_META[m].group === group)
}

export const DIMENSION_META: Record<BiDimension, { label: string; hidden?: boolean }> = {
    none:              { label: 'Total' },
    utm_source:        { label: 'Source' },
    utm_medium:        { label: 'Medium' },
    utm_campaign:      { label: 'Campaña' },
    utm_content:       { label: 'Contenido (anuncio)' },
    utm_term:          { label: 'Término (conjunto)' },
    utm_id:            { label: 'UTM ID' },
    // Alias histórico: el dispatcher lo normaliza a utm_campaign. Oculto del
    // selector para no ofrecer dos "Campaña" que ahora hacen lo mismo.
    campaign:          { label: 'Campaña', hidden: true },
    utm_campaign_raw:  { label: 'Campaña UTM (crudo)' },
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
    // ── Dimensiones de public.hotmart_ventas ──
    hm_tipo:           { label: 'Tipo de venta (Hotmart)' },
    hm_oferta:         { label: 'Oferta (Hotmart)' },
    hm_producto:       { label: 'Producto (Hotmart)' },
    hm_pais:           { label: 'País (Hotmart)' },
    hm_metodo_pago:    { label: 'Método de pago' },
}

// ── Dimensiones unificadas (leads/ventas ↔ gasto) ─────────────────────
// `metricas_diarias` está preagregada por día×cliente y no tiene UTM: el único
// puente hacia los leads es el NOMBRE de la entidad (campaña / anuncio /
// conjunto). Para estas dimensiones, leads y ventas NO se agrupan por su columna
// cruda sino por el nombre real al que resuelven, y el gasto se desglosa con ese
// mismo nombre. Así ambas fuentes comparten clave y `mergeResults` las une.
//
// Fuera de esta lista (país, formulario, campo de lead…) no hay puente posible y
// el gasto sigue cayendo en la fila total, como hasta ahora.

/** Dimensiones que se resuelven contra las campañas reales del reporting. */
export const UNIFIED_DIMS: ReadonlySet<string> = new Set([
    'utm_campaign', 'campaign', 'utm_id',
    'utm_content', 'ad',
    'utm_term', 'adset',
])

/** Entidad del reporting a la que resuelve una dimensión unificada (o null). */
export function unifiedTarget(dim: string): 'campaign' | 'ad' | 'adset' | null {
    switch (dim) {
        case 'utm_campaign': case 'campaign': case 'utm_id': return 'campaign'
        case 'utm_content':  case 'ad':                      return 'ad'
        case 'utm_term':     case 'adset':                   return 'adset'
        default: return null
    }
}

/**
 * Plataforma de ads a la que apunta un valor de utm_source/utm_medium.
 * Devuelve null cuando el valor no identifica una plataforma concreta (orgánico,
 * email, un source propio del cliente…), que es lo que impide recortar el gasto.
 */
const PLATFORM_ALIASES: Record<string, 'meta' | 'tiktok'> = {
    facebook: 'meta', fb: 'meta', ig: 'meta', instagram: 'meta',
    meta: 'meta', meta_ads: 'meta', 'facebook ads': 'meta', 'meta ads': 'meta',
    tiktok: 'tiktok', tt: 'tiktok', tiktok_ads: 'tiktok', 'tiktok ads': 'tiktok',
}

export function platformFromUtm(source?: string | null, medium?: string | null): 'meta' | 'tiktok' | null {
    for (const raw of [source, medium]) {
        if (!raw) continue
        const hit = PLATFORM_ALIASES[normLabel(raw)]
        if (hit) return hit
    }
    return null
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

// ── Campos de lead del catálogo (report_utm.lead_campos) ──────────────
// La dimensión `field:<clave>` de arriba lee una clave CRUDA de raw_fields, tal
// como la escribió el formulario. Sirve para explorar, pero no para cruzar: la
// misma pregunta llega con claves distintas según el formulario y el mismo valor
// se escribe de varias formas (ver migración 060).
//
// Un "campo de lead" es la definición por cliente que unifica esas claves y esos
// valores bajo un nombre propio, y se referencia con su propio token:
//   • Dimensión / filtro:  "leadfield:<clave>"
// El token guarda solo la `clave` (slug estable), así que renombrar el campo no
// rompe los widgets ya guardados.
//
// NO existe alias de expresión calculada para estos campos, y no es un olvido: un
// campo de lead es una DIMENSIÓN (agrupa por bucket), no una medida — no lleva
// agregación, así que no hay ningún número que un `lf__<clave>` pudiera devolver.
// Para medir un campo numérico del formulario está `fieldagg:<agg>:<clave>`
// (alias `f_<agg>__<clave>`), que sí agrega. Un comentario anterior aquí anunciaba
// un alias `lf__<clave>` que nunca se implementó: quien lo usara obtenía 0.

export const LEAD_FIELD_PREFIX = 'leadfield:'

export function makeLeadFieldDim(clave: string): string {
    return `${LEAD_FIELD_PREFIX}${clave}`
}
export function isLeadFieldDim(token: string): boolean {
    return typeof token === 'string' && token.startsWith(LEAD_FIELD_PREFIX)
}
export function parseLeadFieldDim(token: string): string | null {
    if (!isLeadFieldDim(token)) return null
    const clave = token.slice(LEAD_FIELD_PREFIX.length)
    return clave || null
}

/**
 * Etiqueta legible de un token de campo de lead. null si no lo es. Con el
 * catálogo del cliente usa el nombre que puso el analista — que es lo que hace
 * que ese nombre aparezca en el selector, en los chips de filtro y en las
 * columnas; sin él (widget guardado de otro cliente) humaniza la clave.
 */
export function leadFieldLabel(token: string, campos: LeadFieldMeta[] = []): string | null {
    const clave = parseLeadFieldDim(token)
    if (clave === null) return null
    return campos.find(c => c.clave === clave)?.nombre ?? humanizeFieldKey(clave)
}

/** Metadata de un campo de lead expuesta al navegador (editor y filtros). */
export interface LeadFieldMeta {
    clave: string
    nombre: string
    descripcion?: string | null
    /** Buckets que produce, ya en el orden configurado. */
    valores: string[]
    /** Claves crudas que unifica, para el tooltip del editor. */
    claves_origen: string[]
    /** Leads del período que responden este campo. */
    cobertura: number
    alta_cardinalidad: boolean
}

// ── Columnas adicionales de Sheets offline (custom_fields JSONB) ──────
// Cada cliente define en su config qué columnas extra de sus Google Sheets se
// sincronizan (`custom_columns` por pestaña), y el sync las guarda en
// `conversiones_offline_diarias.custom_fields`. Como son dinámicas por cliente,
// se referencian con un token namespaced igual que los campos de formulario:
//   • Métrica: "offfield:<tipo>:<clave>"  (tipo = count | currency | percentage)
// El tipo viaja en el token para que los widgets sepan formatear (y el motor,
// promediar los porcentajes) sin releer la config del cliente.
// En expresiones de campos calculados se usa el alias "off__<clave>", que al no
// llevar tipo siempre agrega por suma.

export type OfflineFieldType = 'count' | 'currency' | 'percentage'

export const OFFLINE_FIELD_PREFIX = 'offfield:'

const OFFLINE_TYPES = new Set<string>(['count', 'currency', 'percentage'])

export function makeOfflineFieldMetric(type: OfflineFieldType, key: string): string {
    return `${OFFLINE_FIELD_PREFIX}${type}:${key}`
}
export function isOfflineFieldMetric(token: string): boolean {
    return typeof token === 'string' && token.startsWith(OFFLINE_FIELD_PREFIX)
}
export function parseOfflineFieldMetric(token: string): { type: OfflineFieldType; key: string } | null {
    if (!isOfflineFieldMetric(token)) return null
    const rest = token.slice(OFFLINE_FIELD_PREFIX.length)
    const idx = rest.indexOf(':')
    if (idx <= 0) return null
    const type = rest.slice(0, idx)
    const key = rest.slice(idx + 1)
    if (!OFFLINE_TYPES.has(type) || !key) return null
    return { type: type as OfflineFieldType, key }
}

/** Alias identificador-safe para usar una columna de Sheet en expresiones calc. */
export function offlineFieldAlias(key: string): string {
    return `off__${key.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`
}

/** Extrae de una expresión calc las columnas de Sheet referenciadas por alias. */
export function extractOfflineFieldAliases(expression: string): { key: string; alias: string }[] {
    const out: { key: string; alias: string }[] = []
    const re = /\boff__([a-z0-9_]+)\b/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(expression)) !== null) {
        const key = m[1].toLowerCase()
        out.push({ key, alias: `off__${key}` })
    }
    return out
}

/** Metadata de una columna adicional de Sheet expuesta en el BI. */
export interface OfflineFieldMeta {
    key: string                       // nombre sanitizado (clave en custom_fields)
    label: string                     // etiqueta configurada por el analista
    type: OfflineFieldType
    /** Sheets/pestañas donde está definida (para el tooltip del editor). */
    sources: string[]
}

/**
 * Etiqueta legible para un token de columna de Sheet. null si no lo es.
 * Con la lista de columnas del cliente usa la etiqueta configurada; sin ella
 * (widgets ya guardados) humaniza la clave.
 */
export function offlineFieldLabel(token: string, fields: OfflineFieldMeta[] = []): string | null {
    const parsed = parseOfflineFieldMetric(token)
    if (!parsed) return null
    const meta = fields.find(f => f.key === parsed.key)
    return `${meta?.label ?? humanizeFieldKey(parsed.key)} (Sheet)`
}

/** Formato de visualización de un token de columna de Sheet. null si no lo es. */
export function offlineFieldFormat(token: string): 'number' | 'currency' | 'percent' | null {
    const parsed = parseOfflineFieldMetric(token)
    if (!parsed) return null
    return parsed.type === 'currency' ? 'currency' : parsed.type === 'percentage' ? 'percent' : 'number'
}

// ── Campos de Sheet (tablas sheet_campos / sheet_campo_valores_diarios) ──
// Un "campo" unifica columnas equivalentes de varias pestañas bajo un nombre
// visible propio y guarda un desglose diario POR VALOR. Eso permite las tres
// cosas a la vez, cada una con su token:
//   • Dimensión (agrupar y filtrar por él): "sheetdim:<clave>"
//   • Métrica del campo:                    "sheetagg:<agg>:<clave>"
//   • Vista guardada ("Leads 20-100"):      "sheetview:<clave>"
//
// La agregación viaja en el token de métrica para que los widgets ya guardados
// sigan midiendo lo mismo aunque después se cambie la agregación por defecto del
// campo. En expresiones calc se usan los alias "sf__<clave>" y "sv__<clave>".
//
// Los prefijos planos del dashboard clásico son `sf_` y `sv_`, deliberadamente
// distintos de `sheet_`: ese ya lo produce el aplanado de custom_fields en
// getDashboardData, y una colisión cambiaría valores de layouts existentes en
// silencio.

export type SheetCampoAgg = 'count' | 'sum' | 'avg' | 'min' | 'max'

export const SHEET_DIM_PREFIX = 'sheetdim:'
export const SHEET_METRIC_PREFIX = 'sheetagg:'
export const SHEET_VIEW_PREFIX = 'sheetview:'

const SHEET_AGGS = new Set<string>(['count', 'sum', 'avg', 'min', 'max'])

export function makeSheetDim(clave: string): string {
    return `${SHEET_DIM_PREFIX}${clave}`
}
export function isSheetDim(token: string): boolean {
    return typeof token === 'string' && token.startsWith(SHEET_DIM_PREFIX)
}
export function parseSheetDim(token: string): string | null {
    if (!isSheetDim(token)) return null
    const clave = token.slice(SHEET_DIM_PREFIX.length)
    return clave || null
}

export function makeSheetMetric(agg: SheetCampoAgg, clave: string): string {
    return `${SHEET_METRIC_PREFIX}${agg}:${clave}`
}
export function isSheetMetric(token: string): boolean {
    return typeof token === 'string' && token.startsWith(SHEET_METRIC_PREFIX)
}
export function parseSheetMetric(token: string): { agg: SheetCampoAgg; clave: string } | null {
    if (!isSheetMetric(token)) return null
    const rest = token.slice(SHEET_METRIC_PREFIX.length)
    const idx = rest.indexOf(':')
    if (idx <= 0) return null
    const agg = rest.slice(0, idx)
    const clave = rest.slice(idx + 1)
    if (!SHEET_AGGS.has(agg) || !clave) return null
    return { agg: agg as SheetCampoAgg, clave }
}

export function makeSheetView(clave: string): string {
    return `${SHEET_VIEW_PREFIX}${clave}`
}
export function isSheetView(token: string): boolean {
    return typeof token === 'string' && token.startsWith(SHEET_VIEW_PREFIX)
}
export function parseSheetView(token: string): string | null {
    if (!isSheetView(token)) return null
    const clave = token.slice(SHEET_VIEW_PREFIX.length)
    return clave || null
}

/** ¿El token es de campos de Sheet, de cualquiera de los tres tipos? */
export function isSheetToken(token: string): boolean {
    return isSheetDim(token) || isSheetMetric(token) || isSheetView(token)
}

/** Alias identificador-safe de un campo, para expresiones calc. */
export function sheetFieldAlias(clave: string): string {
    return `sf__${clave.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`
}
/** Alias identificador-safe de una vista, para expresiones calc. */
export function sheetViewAlias(clave: string): string {
    return `sv__${clave.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`
}

/** Extrae de una expresión calc los campos y vistas de Sheet referenciados. */
export function extractSheetAliases(
    expression: string
): { kind: 'campo' | 'vista'; clave: string; alias: string }[] {
    const out: { kind: 'campo' | 'vista'; clave: string; alias: string }[] = []
    const re = /\bs(f|v)__([a-z0-9_]+)\b/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(expression)) !== null) {
        const kind = m[1].toLowerCase() === 'f' ? 'campo' : 'vista'
        const clave = m[2].toLowerCase()
        out.push({ kind, clave, alias: `s${kind === 'campo' ? 'f' : 'v'}__${clave}` })
    }
    return out
}

/** Metadata de un campo de Sheet expuesta al editor (client-safe). */
export interface SheetFieldMeta {
    clave: string
    nombre: string
    rol: 'dimension' | 'metrica' | 'ambos'
    formato: 'number' | 'currency' | 'percent' | 'text'
    agregacion: SheetCampoAgg
    /** Valores (buckets) que produce, para ofrecerlos en filtros sin consultar. */
    valores: string[]
    alta_cardinalidad: boolean
    /** "Sheet › Pestaña" de donde sale, para el tooltip del editor. */
    sources: string[]
}

/** Metadata de una vista guardada. */
export interface SheetViewMeta {
    clave: string
    nombre: string
    campo_clave: string
    agregacion: SheetCampoAgg
    formato: 'number' | 'currency' | 'percent'
}

const SHEET_AGG_LABEL: Record<SheetCampoAgg, string> = {
    count: 'Conteo', sum: 'Suma', avg: 'Promedio', min: 'Mínimo', max: 'Máximo',
}

/**
 * Etiqueta legible de un token de campo de Sheet. null si no lo es.
 * Con el catálogo del cliente usa el nombre que puso el analista — que es lo que
 * hace que ese nombre aparezca en todas partes; sin él (widget ya guardado de
 * otro cliente) humaniza la clave.
 */
export function sheetFieldLabel(
    token: string,
    fields: SheetFieldMeta[] = [],
    views: SheetViewMeta[] = []
): string | null {
    const dim = parseSheetDim(token)
    if (dim) return fields.find(f => f.clave === dim)?.nombre ?? humanizeFieldKey(dim)

    const met = parseSheetMetric(token)
    if (met) {
        const nombre = fields.find(f => f.clave === met.clave)?.nombre ?? humanizeFieldKey(met.clave)
        // El conteo es la lectura por defecto de un campo: no hace falta decirlo.
        return met.agg === 'count' ? nombre : `${SHEET_AGG_LABEL[met.agg]} · ${nombre}`
    }

    const vista = parseSheetView(token)
    if (vista) return views.find(v => v.clave === vista)?.nombre ?? humanizeFieldKey(vista)

    return null
}

/** Formato de visualización de un token de campo de Sheet. null si no lo es. */
export function sheetFieldFormat(
    token: string,
    fields: SheetFieldMeta[] = [],
    views: SheetViewMeta[] = []
): 'number' | 'currency' | 'percent' | null {
    const met = parseSheetMetric(token)
    if (met) {
        // Un conteo de filas es siempre un número, aunque la columna sea de dinero.
        if (met.agg === 'count') return 'number'
        const f = fields.find(x => x.clave === met.clave)?.formato
        return f === 'currency' || f === 'percent' ? f : 'number'
    }

    const vista = parseSheetView(token)
    if (vista) {
        const v = views.find(x => x.clave === vista)
        if (v?.agregacion === 'count') return 'number'
        return v?.formato ?? 'number'
    }

    return null
}

/**
 * ¿El token de Sheet se puede sumar entre filas? Solo los conteos y las sumas:
 * un promedio o un extremo agregados fila a fila darían un número inventado.
 */
export function isAdditiveSheetToken(token: string, views: SheetViewMeta[] = []): boolean {
    const met = parseSheetMetric(token)
    if (met) return met.agg === 'count' || met.agg === 'sum'

    const vista = parseSheetView(token)
    if (vista) {
        const agg = views.find(v => v.clave === vista)?.agregacion
        // Sin catálogo se asume conteo, que es la agregación por defecto de una vista.
        return agg === undefined || agg === 'count' || agg === 'sum'
    }

    return false
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
 * Agrega al query los filtros de campo activos —tanto los de clave cruda
 * ("field:*") como los del catálogo de campos de lead ("leadfield:*")—, con la
 * forma `filters[<token>]=valor` que entiende el endpoint. Client-safe.
 */
export function appendFieldFilters(
    params: URLSearchParams,
    filters: Record<string, string | undefined>
): void {
    for (const [k, v] of Object.entries(filters)) {
        if ((isFieldDim(k) || isLeadFieldDim(k)) && v && String(v).trim()) {
            params.set(`filters[${k}]`, String(v).trim())
        }
    }
}

/** Firma estable de los filtros de campo activos, para deps de useEffect. */
export function fieldFilterSignature(filters: Record<string, string | undefined>): string {
    return Object.keys(filters)
        .filter((k) => isFieldDim(k) || isLeadFieldDim(k))
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

/**
 * Evalúa una expresión tipo "revenue / leads_count" usando los valores
 * de una fila. Devuelve null si la expresión es inválida o hay división
 * por cero. Client-safe (no usa nada de servidor).
 *
 * Fachada sobre `bi/expr.ts`, que parsea a un AST. Antes esto sustituía
 * identificadores por texto con un `replace` y luego evaluaba la aritmética
 * resultante; el problema no era el cálculo sino que la MISMA expresión se
 * leía con otro regex en `bi-query.ts` para deducir qué métricas traer, y las
 * dos lecturas no coincidían. Con un AST, `refs` es la única fuente de verdad.
 *
 * `onMissing: 'zero'` conserva el comportamiento histórico a propósito: un
 * identificador sin valor cuenta como 0, así que ningún informe ya guardado
 * cambia de número. Las métricas derivadas nuevas usan `'null'`, que es lo
 * correcto (ver la doctrina de `lib/fx.ts`: cero ≠ desconocido).
 */
export function evaluateExpression(
    expression: string,
    values: Record<string, number>
): number | null {
    const parsed = parseExpr(expression)
    if (isExprError(parsed)) return null
    return evalExpr(parsed.ast, values, { onMissing: 'zero', decimals: 2 })
}

// ── Filtro avanzado guardado (Y de O) ─────────────────────────────────
// Filtro del informe que se persiste y auto-aplica a TODOS los widgets.
// Estructura de dos niveles: grupos unidos por Y (AND), cada grupo con
// condiciones unidas por O (OR). Ej: (source=fb O source=ig) Y (campaña ∋ verano).
// Se guarda serializado en `bi_reports.filters['__adv']` (columna existente,
// sin migración) y se evalúa en memoria sobre leads/ventas en el motor.

export interface FilterCondition {
    field: string       // utm_* | ip_country | form_name | form_plugin | attribution_method | platform | field:<clave> | leadfield:<clave>
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

/** Filtro de campaña simple de un widget: operador + texto. */
export interface CampaignFilterSpec {
    op: FilterOp
    value: string
}

/**
 * Fusiona el filtro de campaña simple de un widget dentro de su filtro avanzado,
 * como un grupo Y adicional sobre `utm_campaign`.
 *
 * Es puro azúcar de UI: el motor ya sabe recortar el gasto por nombre de campaña
 * (`campaignNameFilterPredicate` + `queryAdsCampaignFiltered`) cuando ve una
 * condición sobre utm_campaign, así que expresarlo así hace que gasto Y leads
 * queden filtrados sin tocar el motor. No muta el filtro guardado.
 */
export function withCampaignFilter(
    af: AdvancedFilter | undefined | null,
    campaign: CampaignFilterSpec | undefined | null
): AdvancedFilter | undefined {
    const value = campaign?.value?.trim()
    if (!value) return af ?? undefined
    return {
        groups: [
            ...(af?.groups ?? []),
            { conditions: [{ field: 'utm_campaign', op: campaign!.op, value }] },
        ],
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
    // `parseSeleccion` en vez de `split(',')`: respeta las comas escapadas de los
    // valores que llevan una dentro. Sin escapes se comporta idéntico, así que
    // los filtros ya guardados se leen igual.
    const parts = parseSeleccion(t)
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

/**
 * Igual que `matchFilterCondition` pero normalizando AMBOS lados con `normLabel`.
 *
 * Es la comparación correcta cuando lo que se compara son NOMBRES de entidades
 * del reporting (campaña, anuncio, conjunto): el UTM llega como `promo_verano` y
 * la campaña se llama `Promo Verano`. Con `toLowerCase` a secas eso no matcheaba,
 * así que elegir una campaña del desplegable dejaba el widget en 0.
 *
 * No sustituye a `matchFilterCondition`: en columnas de texto libre (país,
 * formulario, campos de lead) la igualdad exacta sigue siendo la esperada.
 */
export function matchFilterConditionNorm(cell: string, op: FilterOp, target: string): boolean {
    const v = normLabel(cell ?? '')
    const t = (target ?? '').trim()
    const lt = normLabel(t)
    const parts = parseSeleccion(t).map((s) => normLabel(s)).filter(Boolean)
    switch (op) {
        case 'eq':        return parts.some((x) => v === x)
        case 'neq':       return !parts.some((x) => v === x)
        case 'contains':  return v.includes(lt)
        case 'ncontains': return !v.includes(lt)
        case 'starts':    return v.startsWith(lt)
        case 'ends':      return v.endsWith(lt)
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

/**
 * Campos de filtro que no pueden atribuirse al gasto de campañas.
 *
 * Se exporta para que el diagnóstico pueda NOMBRAR cuáles están activos (no solo
 * decir que hay alguno). Duplicar la lista en el dispatcher habría dejado dos
 * verdades que se desincronizan en cuanto se añada un campo.
 */
export const NON_ATTRIBUTABLE_FIELDS: ReadonlySet<string> =
    new Set(['ip_country', 'form_name', 'form_plugin', 'attribution_method', 'platform'])

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
/** Campos UTM que nombran una entidad del reporting (campaña/anuncio/conjunto). */
export const ENTITY_FILTER_FIELDS: ReadonlySet<string> = new Set([
    'utm_campaign', 'utm_content', 'utm_term',
])

/**
 * Condiciones de filtro que restringen EFECTIVAMENTE el nombre de una entidad.
 * Cada "clause" es un OR de condiciones; las clauses van en AND.
 *
 * Un grupo del filtro avanzado es un O, así que solo restringe el nombre de este
 * campo si TODAS sus ramas hablan de este mismo campo. Un grupo mixto
 * (`campaña = A` O `país = CO`) admite cualquier campaña por su segunda rama:
 * recortar el gasto por "A" dejaría fuera gasto que el informe sí muestra.
 */
function entityFilterClauses(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined,
    field: string
): Array<{ op: FilterOp; value: string }[]> {
    const clauses: Array<{ op: FilterOp; value: string }[]> = []

    const plain = filters?.[field]
    if (plain && plain.trim()) {
        const { op, value } = parseFilterValue(plain)
        if (value.trim()) clauses.push([{ op, value }])
    }

    for (const g of advancedFilter?.groups ?? []) {
        const conds = (g.conditions ?? []).filter((c) => c.field && c.value && c.value.trim())
        if (!conds.length) continue
        if (!conds.every((c) => c.field === field)) continue
        clauses.push(conds.map((c) => ({ op: c.op, value: c.value })))
    }

    return clauses
}

export function entityNameFilterPredicate(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined,
    field: string
): (name: string) => boolean {
    const clauses = entityFilterClauses(filters, advancedFilter, field)
    if (!clauses.length) return () => true
    // Comparación NORMALIZADA: lo que se filtra es el nombre real de una entidad
    // del reporting contra un valor que el usuario eligió de un desplegable o
    // escribió a mano. `promo_verano` y `Promo Verano` son la misma campaña.
    return (name: string) =>
        clauses.every((or) => or.some((c) => matchFilterConditionNorm(name ?? '', c.op, c.value)))
}

/** ¿Hay alguna condición que restrinja efectivamente el nombre de esta entidad? */
export function hasEntityFilter(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined,
    field: string
): boolean {
    return entityFilterClauses(filters, advancedFilter, field).length > 0
}

/**
 * Grupos del filtro avanzado que hablan SOLO de entidades del reporting. Se
 * evalúan contra el nombre resuelto (no contra la columna cruda), así que el
 * motor los saca del camino normal para no aplicarlos dos veces con criterios
 * distintos. El resto de grupos se evalúa como siempre.
 */
export function splitEntityGroups(
    af: AdvancedFilter | undefined
): { entityOnly: AdvancedFilter | undefined; rest: AdvancedFilter | undefined } {
    if (!af?.groups?.length) return { entityOnly: undefined, rest: undefined }
    const entity: AdvancedFilter['groups'] = []
    const rest: AdvancedFilter['groups'] = []
    for (const g of af.groups) {
        const conds = (g.conditions ?? []).filter((c) => c.field && c.value && c.value.trim())
        if (conds.length && conds.every((c) => ENTITY_FILTER_FIELDS.has(c.field))) entity.push(g)
        else rest.push(g)
    }
    return {
        entityOnly: entity.length ? { groups: entity } : undefined,
        rest: rest.length ? { groups: rest } : undefined,
    }
}

/** Predicado sobre el NOMBRE de campaña. Atajo de `entityNameFilterPredicate`. */
export function campaignNameFilterPredicate(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined
): (name: string) => boolean {
    return entityNameFilterPredicate(filters, advancedFilter, 'utm_campaign')
}

/**
 * Plataforma a la que el filtro activo restringe el gasto, o null si no lo
 * restringe a una sola.
 *
 * Un filtro `utm_source = facebook` recortaba los leads pero dejaba el gasto
 * entero (Meta + TikTok), así que el CPL salía inflado sin avisar. Cuando TODAS
 * las condiciones de source/medium apuntan a la misma plataforma, el gasto se
 * puede recortar a esa plataforma sin inventar nada.
 *
 * Devuelve null en cuanto hay ambigüedad: dos plataformas mezcladas, un valor
 * que no identifica plataforma (orgánico, email, un source propio) o un operador
 * que no delimita un valor concreto (`neq`, `ncontains`).
 */
export function platformScopeFromFilters(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined
): 'meta' | 'tiktok' | null {
    const found = new Set<'meta' | 'tiktok'>()
    let sawCondition = false

    /** Plataformas a las que apunta una condición; null = no delimita. */
    const scopeOf = (field: string, op: FilterOp, value: string): ('meta' | 'tiktok')[] | null => {
        if (field !== 'utm_source' && field !== 'utm_medium') return null
        // Solo los operadores que AFIRMAN un valor delimitan la plataforma.
        if (op !== 'eq' && op !== 'contains' && op !== 'starts') return null
        const parts = parseSeleccion(value)
        if (!parts.length) return null
        const out: ('meta' | 'tiktok')[] = []
        for (const p of parts) {
            const hit = field === 'utm_source' ? platformFromUtm(p, null) : platformFromUtm(null, p)
            if (!hit) return null   // un valor sin plataforma clara invalida el recorte
            out.push(hit)
        }
        return out
    }

    for (const key of ['utm_source', 'utm_medium'] as const) {
        const raw = filters?.[key]
        if (!raw || !raw.trim()) continue
        sawCondition = true
        const { op, value } = parseFilterValue(raw)
        const scope = scopeOf(key, op, value)
        if (!scope) return null
        for (const p of scope) found.add(p)
    }

    for (const g of advancedFilter?.groups ?? []) {
        const conds = (g.conditions ?? []).filter(c => c.value && c.value.trim())
        const relevant = conds.filter(c => c.field === 'utm_source' || c.field === 'utm_medium')
        if (!relevant.length) continue
        // Un grupo es un O: solo delimita si es ENTERAMENTE de plataforma y todas
        // sus ramas apuntan a la misma. Si mezcla source con otra cosa, la otra
        // rama puede traer gasto de cualquier plataforma → no se recorta.
        if (relevant.length !== conds.length) return null
        sawCondition = true
        const grupo = new Set<'meta' | 'tiktok'>()
        for (const c of relevant) {
            const scope = scopeOf(c.field, c.op, c.value)
            if (!scope) return null
            for (const p of scope) grupo.add(p)
        }
        if (grupo.size !== 1) return null
        for (const p of grupo) found.add(p)
    }

    if (!sawCondition || found.size !== 1) return null
    return Array.from(found)[0]
}

/** ¿Hay alguna condición de filtro sobre utm_campaign (plana o avanzada)? */
export function hasCampaignFilter(
    filters: Record<string, string | undefined> | undefined,
    advancedFilter: AdvancedFilter | undefined
): boolean {
    return hasEntityFilter(filters, advancedFilter, 'utm_campaign')
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
    // Los campos de Sheet tampoco son atribuibles: el gasto solo se cruza con UTM
    // por el nombre de campaña, así que filtrar por "rango de ingresos" recortaría
    // los leads pero dejaría el gasto entero y el CPL saldría inventado.
    for (const [k, v] of Object.entries(filters ?? {})) {
        if (!v || !String(v).trim()) continue
        if (NON_ATTRIBUTABLE_FIELDS.has(k) || isFieldDim(k) || isLeadFieldDim(k) || isSheetDim(k)) return true
    }
    return !!advancedFilter?.groups?.some((g) =>
        g.conditions?.some(
            (c) => c.value && c.value.trim() &&
                (NON_ATTRIBUTABLE_FIELDS.has(c.field) || isFieldDim(c.field) ||
                    isLeadFieldDim(c.field) || isSheetDim(c.field))
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
    leads_count:   'Personas que dejaron sus datos durante el período, sumando formularios web y formularios de Meta. Es el conteo real de contactos: no se suma con “Leads del píxel de Meta” ni con “Leads offline”, que miden lo mismo desde otra fuente y se solapan.',
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
    hotmart_revenue: 'Dinero facturado en Hotmart en el período (neto de comisiones).',
    hotmart_sales:   'Cantidad de ventas de Hotmart en el período (principal + bump + upsell).',
    hotmart_roas:    'Retorno de la inversión usando la facturación de Hotmart: por cada $1 invertido en anuncios, cuántos $ se facturaron. Cuanto MÁS ALTO, mejor. Se calcula sobre el total del período, sin atribuir a una campaña concreta.',
    hotmart_cpa:     'Cuánto costó, en promedio, cada venta de Hotmart. Cuanto MÁS BAJO, mejor. Se calcula sobre el total del período, sin atribuir a una campaña concreta.',
    hotmart_roi:     'Ganancia sobre la inversión publicitaria: (facturación Hotmart − inversión) ÷ inversión. Un 100% significa que se recuperó el doble de lo invertido. Cuanto MÁS ALTO, mejor.',
    // ── Ventas Hotmart por transacción ──
    // Las de arriba leen el agregado diario y por eso dicen "sin atribuir a una
    // campaña". Estas vienen de una fila por venta, con sus propios UTM, y sí se
    // reparten por campaña.
    hm_ventas:           'Cantidad de ventas cobradas de Hotmart en el período. No incluye las reembolsadas ni las pendientes de pago.',
    hm_neto:             'Dinero que realmente llega a la cuenta: la comisión del productor, ya descontada la tarifa de Hotmart. Convertido a dólares.',
    hm_bruto:            'Precio pagado por el comprador antes de comisiones, convertido a dólares.',
    hm_reembolsos:       'Cantidad de ventas del período que acabaron reembolsadas o en contracargo. Se cuentan en la fecha de la VENTA, no en la del reembolso.',
    hm_neto_reembolsado: 'Dinero neto de las ventas del período que acabaron devueltas. Se imputa a la fecha de la venta original para que el retorno de la campaña refleje lo que de verdad dejó.',
    hm_tasa_reembolso:   'Qué porcentaje de la facturación acabó devuelta. Cuanto MÁS BAJO, mejor.',
    hm_roas:             'Retorno de la inversión publicitaria con las ventas atribuidas a cada campaña: por cada $1 invertido, cuántos $ se facturaron. Cuanto MÁS ALTO, mejor. A diferencia del ROAS de cuenta, este SÍ se reparte por campaña.',
    hm_cpa:              'Cuánto costó, en promedio, cada venta de Hotmart atribuida a la campaña. Cuanto MÁS BAJO, mejor.',
    hm_ticket_medio:     'Facturación neta dividida entre el número de ventas: cuánto deja, en promedio, cada compra.',
    // ── Las tres métricas que se llaman "leads" y NO son comparables ──
    leads_form:    'Leads que reporta el píxel de Meta desde sus propios formularios. Puede no coincidir con “Leads (contactos)”: mide otra cosa, en otro sistema, y los mismos contactos pueden estar en ambas. No las sumes.',
    offline_leads: 'Leads que el equipo carga a mano en el Google Sheet del cliente. Se solapan con “Leads (contactos)” si el mismo contacto está en los dos sitios.',
    // ── Eventos del píxel ──
    initiates_checkout: 'Veces que alguien empezó un pago en la web, según el píxel de Meta.',
    purchases:     'Compras que registra el píxel de Meta. Es la lectura de Meta, no la de la pasarela de pago.',
    complete_registration: 'Registros completados que reporta el píxel de Meta.',
    view_content:  'Veces que alguien vio una página de producto o contenido clave, según el píxel.',
    adds_to_cart:  'Veces que alguien añadió un producto al carrito, según el píxel.',
    contact:       'Veces que alguien inició un contacto (chat, llamada, formulario), según el píxel.',
    messaging_conversations: 'Conversaciones iniciadas por mensaje (WhatsApp, Messenger, Instagram) desde los anuncios.',
    video_views:   'Reproducciones de video de los anuncios.',
    video_thruplay: 'Reproducciones que llegaron a 15 segundos o al final del video. Mide interés real, no un scroll.',
    results:       'Resultados según el objetivo de cada campaña (suma de leads, compras e inicios de pago).',
    post_engagement: 'Interacciones totales con los anuncios: reacciones, comentarios, compartidos y clics.',
    // ── Las que solo existen a nivel de cuenta ──
    ga_avg_session_duration: 'Cuánto dura, en promedio, una visita al sitio. Es un dato del sitio entero: no se puede repartir por campaña.',
    hotmart_pagos_iniciados: 'Veces que alguien llegó a la página de pago. Se mide con Google Analytics, no con Hotmart, y es del sitio entero: no se reparte por campaña.',
    offline_ventas:  'Ventas que el equipo carga a mano en el Google Sheet del cliente.',
    offline_revenue: 'Dinero de las ventas cargadas a mano en el Google Sheet del cliente.',
    offline_total:   'Todas las filas de conversión del Google Sheet, sin distinguir leads de ventas.',
    ventas_cerradas: 'Ventas cerradas que carga el equipo a mano en el dashboard.',
    // ── Suscripciones: una foto, no una serie ──
    subs_active:   'Suscripciones activas en la última foto disponible. Es un estado del momento, no algo que ocurriera durante el período: no cambia si mueves las fechas ni se puede repartir por campaña o por día.',
    subs_delayed:  'Suscripciones con el pago atrasado en la última foto disponible.',
    subs_canceled: 'Suscripciones canceladas en la última foto disponible.',
    subs_total:    'Total de suscripciones registradas en la última foto disponible.',
    subs_mrr:      'Dinero recurrente que generan las suscripciones activas, en la última foto disponible.',
}

/**
 * Texto de respaldo por grupo, para las métricas sin entrada propia. Evita que
 * una métrica llegue al cliente final sin ninguna explicación.
 */
const GROUP_GLOSSARY: Record<MetricGroup, string> = {
    leads:       'Métrica sobre los contactos generados en el período.',
    ventas:      'Métrica sobre las ventas registradas en el período.',
    inversion:   'Dinero invertido en publicidad durante el período.',
    rendimiento: 'Métrica de rendimiento de los anuncios en el período.',
    campana:     'Evento medido por el píxel de la plataforma de anuncios durante el período.',
    ga4:         'Dato del sitio web medido por Google Analytics. Es del sitio entero: no se reparte por campaña.',
    hotmart:     'Dato de facturación de Hotmart en el período. Es del total de la cuenta: no se reparte por campaña.',
    offline:     'Dato cargado a mano en el Google Sheet del cliente.',
    subs:        'Estado de las suscripciones en la última foto disponible, no algo ocurrido durante el período.',
}

/**
 * Texto del glosario para una métrica. Con entrada propia devuelve la suya; si
 * no, el texto genérico de su grupo. Solo devuelve undefined para tokens que no
 * son del catálogo (campos de formulario, de Sheet, calculadas), que llevan su
 * propia etiqueta configurada por el analista.
 */
export function metricGlossary(metric: string): string | undefined {
    const own = METRIC_GLOSSARY[metric]
    if (own) return own
    const meta = METRIC_META[metric as BiMetric]
    return meta ? GROUP_GLOSSARY[meta.group] : undefined
}

/** Métricas donde un valor MENOR es mejor (costos y tasas de abandono). */
export const LOWER_IS_BETTER = new Set([
    'cpl', 'cpa', 'cpc', 'cpm', 'spend', 'meta_spend', 'tiktok_spend',
    'ga_bounce_rate', 'frequency', 'hotmart_cpa',
    'hm_cpa', 'hm_reembolsos', 'hm_neto_reembolsado', 'hm_tasa_reembolso',
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
    // Las variantes Hotmart miden lo mismo con otra fuente → misma meta.
    hotmart_cpa: { key: 'cpa_max',      mustNotExceed: true },
    hotmart_roas:{ key: 'roas_min',     mustNotExceed: false },
    hm_cpa:      { key: 'cpa_max',      mustNotExceed: true },
    hm_roas:     { key: 'roas_min',     mustNotExceed: false },
    leads_count: { key: 'leads_target', mustNotExceed: false },
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
