// Traducción de los tokens históricos a los ids canónicos `<fuente>.<campo>`.
//
// Tiene dos consumidores y ninguno es opcional:
//
//   1. El script que reescribe `bi_reports.layout` (migración de informes).
//   2. El motor, como red de seguridad en lectura: un enlace de entrega enviado
//      hace seis meses tiene que seguir resolviendo aunque su fila no se migrara.
//      Esa segunda capa NO se puede borrar nunca, igual que hoy no se puede
//      borrar el alias `dimension: 'campaign'` → `utm_campaign` que normaliza
//      `dispatchBiQuery`, ni el caso especial de `leads_total`.
//
// Client-safe: sin imports.

/** Métrica histórica → id canónico. */
export const LEGACY_MEASURE_IDS: Readonly<Record<string, string>> = {
    // ── Leads ──
    leads_count: 'leads.count',
    // Eliminada por la migración 045 (era un duplicado EXACTO de leads_count),
    // pero sigue habiendo informes guardados que la nombran.
    leads_total: 'leads.count',
    cpl: 'leads.cpl',
    conversion_rate: 'leads.conversion_rate',

    // ── Ventas ──
    sales_count: 'sales.count',
    revenue: 'sales.revenue',
    cpa: 'sales.cpa',
    roas: 'sales.roas',

    // ── Inversión ──
    spend: 'ads.spend',
    meta_spend: 'ads.spend_meta',
    tiktok_spend: 'ads.spend_tiktok',

    // ── Rendimiento ──
    clicks: 'ads.clicks',
    impressions: 'ads.impressions',
    ctr: 'ads.ctr',
    cpc: 'ads.cpc',
    cpm: 'ads.cpm',
    reach: 'ads.reach',
    frequency: 'ads.frequency',
    link_clicks: 'ads.link_clicks',

    // ── Eventos de campaña ──
    leads_form: 'ads.leads_form',
    purchases: 'ads.purchases',
    landing_page_views: 'ads.landing_page_views',
    complete_registration: 'ads.complete_registration',
    results: 'ads.results',
    video_views: 'ads.video_views',
    video_thruplay: 'ads.video_thruplay',
    messaging_conversations: 'ads.messaging_conversations',
    post_engagement: 'ads.post_engagement',
    post_reactions: 'ads.post_reactions',
    post_shares: 'ads.post_shares',
    post_comments: 'ads.post_comments',
    adds_to_cart: 'ads.adds_to_cart',
    initiates_checkout: 'ads.initiates_checkout',
    view_content: 'ads.view_content',
    search: 'ads.search',
    add_to_wishlist: 'ads.add_to_wishlist',
    contact: 'ads.contact',
    schedule: 'ads.schedule',
    subscribe: 'ads.subscribe',
    start_trial: 'ads.start_trial',
    submit_application: 'ads.submit_application',
    page_engagement: 'ads.page_engagement',
    post_saves: 'ads.post_saves',
    video_3s: 'ads.video_3s',
    tiktok_conversions: 'ads.conversions_tiktok',

    // ── GA4 ──
    ga_sessions: 'cuenta.ga_sessions',
    ga_bounce_rate: 'cuenta.ga_bounce_rate',
    ga_avg_session_duration: 'cuenta.ga_avg_session_duration',

    // ── Hotmart ──
    // El id canónico dice de dónde sale de verdad (GA4), y la etiqueta conserva
    // el nombre con el que el equipo lo conoce.
    hotmart_pagos_iniciados: 'cuenta.hotmart_pagos_iniciados',
    hotmart_revenue: 'cuenta.hotmart_revenue_calc',
    hotmart_sales: 'cuenta.hotmart_sales_calc',
    hotmart_roas: 'cuenta.hotmart_roas',
    hotmart_cpa: 'cuenta.hotmart_cpa',
    hotmart_roi: 'cuenta.hotmart_roi',
    ventas_principal: 'cuenta.ventas_principal',
    ventas_bump: 'cuenta.ventas_bump',
    ventas_upsell: 'cuenta.ventas_upsell',
    ventas_principal_count: 'cuenta.ventas_principal_count',
    ventas_bump_count: 'cuenta.ventas_bump_count',
    ventas_upsell_count: 'cuenta.ventas_upsell_count',
    ventas_principal_bruto: 'cuenta.ventas_principal_bruto',
    ventas_bump_bruto: 'cuenta.ventas_bump_bruto',
    ventas_upsell_bruto: 'cuenta.ventas_upsell_bruto',
    // Columna real que el worker NUNCA escribe: el valor vive en el JSONB
    // `metricas_manuales`. Leerla de la columna daba 0 en todos los informes.
    ventas_cerradas: 'cuenta.ventas_cerradas',

    // ── Ventas Hotmart por transacción (public.hotmart_ventas) ──
    // Las `hotmart_*` de arriba NO se repuntan aquí a propósito: cambiar a qué
    // apuntan movería los números de informes ya guardados y ya entregados por
    // enlace público. Es una decisión de producto, con aviso a los clientes, no
    // un efecto colateral de esta migración.
    hm_ventas: 'hotmart.ventas',
    hm_neto: 'hotmart.revenue_neto',
    hm_bruto: 'hotmart.revenue_bruto',
    hm_reembolsos: 'hotmart.reembolsos',
    hm_neto_reembolsado: 'hotmart.revenue_reembolsado',
    hm_tasa_reembolso: 'hotmart.tasa_reembolso',
    hm_roas: 'hotmart.roas',
    hm_cpa: 'hotmart.cpa',
    hm_ticket_medio: 'hotmart.ticket_medio',

    // ── Offline ──
    offline_leads: 'offline.leads',
    offline_ventas: 'offline.ventas',
    offline_revenue: 'offline.revenue',
    offline_total: 'offline.total',

    // ── Suscripciones ──
    subs_active: 'subs.active',
    subs_delayed: 'subs.delayed',
    subs_canceled: 'subs.canceled',
    subs_total: 'subs.total',
    subs_mrr: 'subs.mrr',
}

/** Dimensión histórica → id canónico. `none` se conserva tal cual. */
export const LEGACY_DIMENSION_IDS: Readonly<Record<string, string>> = {
    none: 'none',
    utm_source: 'leads.utm_source',
    utm_medium: 'leads.utm_medium',
    utm_campaign: 'leads.campaign',
    utm_content: 'leads.content',
    utm_term: 'leads.term',
    utm_id: 'leads.utm_id',
    // Alias histórico: tuvo su propio motor (`runCampaignQuery`) y hoy lo
    // normaliza `dispatchBiQuery` al entrar.
    campaign: 'leads.campaign',
    utm_campaign_raw: 'leads.utm_campaign_raw',
    date: 'leads.date',
    ip_country: 'leads.ip_country',
    form_name: 'leads.form_name',
    form_plugin: 'leads.form_plugin',
    attribution_method: 'leads.attribution_method',
    platform: 'sales.platform',
    product_name: 'sales.product_name',
    transaction_type: 'sales.transaction_type',
    customer_country: 'sales.customer_country',
    hm_tipo: 'hotmart.tipo',
    hm_oferta: 'hotmart.oferta',
    hm_producto: 'hotmart.producto',
    hm_pais: 'hotmart.pais',
    hm_metodo_pago: 'hotmart.metodo_pago',
    ad: 'ads.ad',
    adset: 'ads.adset',
}

/** Prefijos de las familias de tokens dinámicos. */
const DYNAMIC_PREFIXES = [
    'field:', 'fieldagg:', 'leadfield:', 'leadseg:', 'offfield:',
    'sheetdim:', 'sheetagg:', 'sheetview:',
] as const

/** ¿Es ya un id canónico `<fuente>.<campo>`? */
export function isCanonicalId(token: string): boolean {
    return /^[a-z0-9_]+\.[a-z0-9_]+$/.test(token)
}

/** ¿Es un token de una familia dinámica (campo por cliente)? */
export function isDynamicToken(token: string): boolean {
    return DYNAMIC_PREFIXES.some(p => token.startsWith(p))
}

/**
 * Traduce un token dinámico a su id canónico.
 *
 * El formato nuevo usa un único separador con aridad fija en vez de los tres
 * niveles de `:` de hoy (`field:k`, `fieldagg:agg:k`, `sheetagg:agg:k`), que
 * obligaban a cada parser a rebanar con `indexOf(':')` por su cuenta.
 *
 *   field:<k>            → leads.raw__<k>
 *   fieldagg:<agg>:<k>   → leads.raw__<k>__<agg>
 *   leadfield:<k>        → leads.campo__<k>
 *   leadseg:<k>          → leads.segmento__<k>
 *   offfield:<tipo>:<k>  → offline.custom__<k>
 *   sheetdim:<k>         → sheet.<k>
 *   sheetagg:<agg>:<k>   → sheet.<k>__<agg>
 *   sheetview:<k>        → sheet.vista__<k>
 */
export function migrateDynamicToken(token: string): string | null {
    const rest = (p: string) => token.slice(p.length)

    if (token.startsWith('fieldagg:')) {
        const body = rest('fieldagg:')
        const i = body.indexOf(':')
        if (i < 0) return null
        return `leads.raw__${body.slice(i + 1)}__${body.slice(0, i)}`
    }
    if (token.startsWith('field:')) return `leads.raw__${rest('field:')}`
    // Antes que `leadfield:` no hace falta ordenar nada —los prefijos no son
    // prefijo uno de otro—, pero sí van juntos para que se lean como familia.
    if (token.startsWith('leadfield:')) return `leads.campo__${rest('leadfield:')}`
    if (token.startsWith('leadseg:')) return `leads.segmento__${rest('leadseg:')}`
    if (token.startsWith('offfield:')) {
        const body = rest('offfield:')
        const i = body.indexOf(':')
        // El tipo se descarta: era una propiedad del campo, no de su identidad,
        // y `bi-availability` tenía que ADIVINARLO porque el dato no lo guarda.
        return i < 0 ? `offline.custom__${body}` : `offline.custom__${body.slice(i + 1)}`
    }
    if (token.startsWith('sheetagg:')) {
        const body = rest('sheetagg:')
        const i = body.indexOf(':')
        if (i < 0) return null
        return `sheet.${body.slice(i + 1)}__${body.slice(0, i)}`
    }
    if (token.startsWith('sheetview:')) return `sheet.vista__${rest('sheetview:')}`
    if (token.startsWith('sheetdim:')) return `sheet.${rest('sheetdim:')}`
    return null
}

/**
 * Traduce cualquier token de MEDIDA a su id canónico.
 *
 * Idempotente por construcción: un id ya canónico se devuelve igual, así que
 * reejecutar la migración es un no-op. Un token desconocido (el nombre de un
 * campo calculado del informe, por ejemplo) se devuelve tal cual: el llamador
 * decide qué hacer, nunca se descarta en silencio.
 */
export function migrateMeasureId(token: string): string {
    if (!token) return token
    if (isCanonicalId(token)) return token
    if (isDynamicToken(token)) return migrateDynamicToken(token) ?? token
    return LEGACY_MEASURE_IDS[token] ?? token
}

/** Traduce cualquier token de DIMENSIÓN a su id canónico. Idempotente. */
export function migrateDimensionId(token: string): string {
    if (!token) return token
    if (token === 'none') return 'none'
    if (isCanonicalId(token)) return token
    if (isDynamicToken(token)) return migrateDynamicToken(token) ?? token
    return LEGACY_DIMENSION_IDS[token] ?? token
}

/** Inverso de `LEGACY_MEASURE_IDS`, sin los alias (el primero gana). */
export const CANONICAL_TO_LEGACY_MEASURE: Readonly<Record<string, string>> = (() => {
    const out: Record<string, string> = {}
    for (const [legacy, canonical] of Object.entries(LEGACY_MEASURE_IDS)) {
        if (!(canonical in out)) out[canonical] = legacy
    }
    return out
})()
