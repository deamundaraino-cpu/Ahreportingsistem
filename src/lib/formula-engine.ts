/**
 * Formula Engine — evaluates simple arithmetic formulas against a metric row.
 * Supports: +, -, *, / and references to raw DB columns.
 * Returns null when division by zero or any referenced value is missing (0).
 */

// All available fields from metricas_diarias that formulas can reference.
const FIELD_MAP: Record<string, string> = {
    // ── Meta: Entrega ────────────────────────────────────────────────────────
    meta_spend: 'meta_spend',
    meta_impressions: 'meta_impressions',
    meta_reach: 'meta_reach',
    meta_frequency: 'meta_frequency',
    meta_clicks: 'meta_clicks',
    meta_link_clicks: 'meta_link_clicks',

    // ── Meta: Métricas calculadas (resueltas como macros) ─────────────────
    meta_cpc: 'meta_cpc',
    meta_cpc_link: 'meta_cpc_link',
    meta_cpm: 'meta_cpm',
    meta_ctr: 'meta_ctr',
    meta_ctr_link: 'meta_ctr_link',

    // ── Meta: Eventos estándar de píxel ──────────────────────────────────
    meta_leads: 'meta_leads',
    meta_leads_form: 'meta_leads_form',
    meta_cpl: 'meta_cpl',
    meta_purchases: 'meta_purchases',
    meta_cpp: 'meta_cpp',
    meta_roas: 'meta_roas',
    meta_adds_to_cart: 'meta_adds_to_cart',
    meta_cost_per_add_to_cart: 'meta_cost_per_add_to_cart',
    meta_initiates_checkout: 'meta_initiates_checkout',
    meta_cost_per_initiate_checkout: 'meta_cost_per_initiate_checkout',
    meta_landing_page_views: 'meta_landing_page_views',
    meta_cost_per_landing_page_view: 'meta_cost_per_landing_page_view',
    meta_complete_registration: 'meta_complete_registration',
    meta_cost_per_complete_registration: 'meta_cost_per_complete_registration',
    meta_view_content: 'meta_view_content',
    meta_cost_per_view_content: 'meta_cost_per_view_content',
    meta_search: 'meta_search',
    meta_add_to_wishlist: 'meta_add_to_wishlist',
    meta_contact: 'meta_contact',
    meta_cost_per_contact: 'meta_cost_per_contact',
    meta_schedule: 'meta_schedule',
    meta_cost_per_schedule: 'meta_cost_per_schedule',
    meta_start_trial: 'meta_start_trial',
    meta_submit_application: 'meta_submit_application',
    meta_subscribe: 'meta_subscribe',
    meta_find_location: 'meta_find_location',
    meta_customize_product: 'meta_customize_product',
    meta_donate: 'meta_donate',

    // ── Meta: Video ───────────────────────────────────────────────────────
    meta_video_views: 'meta_video_views',
    meta_video_3s_views: 'meta_video_3s_views',
    meta_video_thruplay: 'meta_video_thruplay',
    meta_cost_per_thruplay: 'meta_cost_per_thruplay',

    // ── Meta: Engagement ─────────────────────────────────────────────────
    meta_page_engagement: 'meta_page_engagement',
    meta_post_engagement: 'meta_post_engagement',
    meta_post_reactions: 'meta_post_reactions',
    meta_post_shares: 'meta_post_shares',
    meta_post_saves: 'meta_post_saves',
    meta_post_comments: 'meta_post_comments',

    // ── Meta: Mensajería ─────────────────────────────────────────────────
    meta_messaging_conversations_started: 'meta_messaging_conversations_started',
    meta_cost_per_messaging_conversation: 'meta_cost_per_messaging_conversation',

    // ── Meta: Resultados de objetivo ─────────────────────────────────────
    meta_results: 'meta_results',
    meta_cost_per_result: 'meta_cost_per_result',

    // ── Google Analytics 4 ───────────────────────────────────────────────
    ga_sessions: 'ga_sessions',
    ga_bounce_rate: 'ga_bounce_rate',
    ga_avg_session_duration: 'ga_avg_session_duration',

    // ── Hotmart ───────────────────────────────────────────────────────────
    hotmart_pagos_iniciados: 'hotmart_pagos_iniciados',
    hotmart_clics_link: 'hotmart_clics_link',

    // ── Ventas (totales globales — suma de todos los funnels + extras) ───
    ventas_principal: 'ventas_principal',
    ventas_bump: 'ventas_bump',
    ventas_upsell: 'ventas_upsell',
    ventas_principal_count: 'ventas_principal_count',
    ventas_bump_count: 'ventas_bump_count',
    ventas_upsell_count: 'ventas_upsell_count',
    ventas_principal_bruto: 'ventas_principal_bruto',
    ventas_bump_bruto:      'ventas_bump_bruto',
    ventas_upsell_bruto:    'ventas_upsell_bruto',

    // ── Funnel actual (inyectado por DashboardClient desde hotmart_funnel_data.by_tab[activeTabId]) ──
    funnel_principal_count: 'funnel_principal_count',
    funnel_principal_neto:  'funnel_principal_neto',
    funnel_principal_bruto: 'funnel_principal_bruto',
    funnel_principal_price: 'funnel_principal_price',  // precio público USD configurado en el tab
    funnel_bump_count:      'funnel_bump_count',
    funnel_bump_neto:       'funnel_bump_neto',
    funnel_bump_bruto:      'funnel_bump_bruto',
    funnel_upsell_count:    'funnel_upsell_count',
    funnel_upsell_neto:     'funnel_upsell_neto',
    funnel_upsell_bruto:    'funnel_upsell_bruto',
    funnel_upsell_visits:   'funnel_upsell_visits',
    funnel_pagos_iniciados: 'funnel_pagos_iniciados',

    // ── Manual ────────────────────────────────────────────────────────────
    leads_registrados: 'leads_registrados',

    // ── Google Sheets Leads ──────────────────────────────────────────────
    leads_totales: 'leads_totales',
    leads_calificados: 'leads_calificados',
    leads_no_calificados: 'leads_no_calificados',
    tasa_calificacion: 'tasa_calificacion',
}

// Complex metrics that should be resolved dynamically (as formulas)
// to ensure perfect aggregation (e.g. not summing CPCs, but dividing total spend by total clicks).
const MACRO_MAP: Record<string, string> = {
    meta_cpc: 'meta_spend / meta_clicks',
    meta_cpc_link: 'meta_spend / meta_link_clicks',
    meta_cpm: '(meta_spend / meta_impressions) * 1000',
    meta_ctr: '(meta_clicks / meta_impressions) * 100',
    meta_ctr_link: '(meta_link_clicks / meta_impressions) * 100',
    meta_cpl: 'meta_spend / meta_leads',
    meta_cpl_form: 'meta_spend / meta_leads_form',
    meta_cpp: 'meta_spend / meta_purchases',
    meta_cost_per_add_to_cart: 'meta_spend / meta_adds_to_cart',
    meta_cost_per_initiate_checkout: 'meta_spend / meta_initiates_checkout',
    meta_cost_per_landing_page_view: 'meta_spend / meta_landing_page_views',
    meta_cost_per_complete_registration: 'meta_spend / meta_complete_registration',
    meta_cost_per_view_content: 'meta_spend / meta_view_content',
    meta_cost_per_contact: 'meta_spend / meta_contact',
    meta_cost_per_schedule: 'meta_spend / meta_schedule',
    meta_cost_per_thruplay: 'meta_spend / meta_video_thruplay',
    meta_cost_per_messaging_conversation: 'meta_spend / meta_messaging_conversations_started',
    meta_cost_per_result: 'meta_spend / meta_results',
    meta_roas: '(ventas_principal + ventas_bump + ventas_upsell) / meta_spend',

    // ── Funnel: macros derivadas (replicando estructura del Excel) ──────
    // Bruta = precio público fijo × nº ventas principal (19 USD × 5 = 95).
    // Requiere que el tab tenga principal_price_usd configurado; si no, devuelve 0.
    funnel_facturacion_bruta:   'funnel_principal_price * funnel_principal_count',
    // Neta = sum de comisiones reales que llegan a la cuenta (principal + bump + upsell).
    funnel_facturacion_neta:    'funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto',
    funnel_roas:                '(funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto) / meta_spend',
    funnel_roi:                 '((funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto) - meta_spend) / meta_spend',
    funnel_dinero_bolsa:        '(funnel_principal_neto + funnel_bump_neto + funnel_upsell_neto) - meta_spend',
    funnel_costo_compra:        'meta_spend / funnel_principal_count',
    funnel_pct_pagos_compras:   '(funnel_principal_count / funnel_pagos_iniciados) * 100',
    funnel_pct_conversion:      '(funnel_principal_count / meta_link_clicks) * 100',
    funnel_pct_conv_order:      '(funnel_bump_count / funnel_principal_count) * 100',
    funnel_pct_conv_upsell:     '(funnel_upsell_count / funnel_upsell_visits) * 100',
    funnel_costo_pago:          'meta_spend / funnel_pagos_iniciados',
    funnel_pct_visitas_pagos:   '(funnel_pagos_iniciados / ga_sessions) * 100',
    funnel_costo_visita:        'meta_spend / ga_sessions',
    funnel_pct_clics_visitas:   '(ga_sessions / meta_link_clicks) * 100',

    // ── Panel General: macros derivadas usando totales globales ─────────
    total_facturacion_neta:     'ventas_principal + ventas_bump + ventas_upsell',
    total_facturacion_bruta:    'ventas_principal_bruto',
    total_roas:                 '(ventas_principal + ventas_bump + ventas_upsell) / meta_spend',
    total_roi:                  '((ventas_principal + ventas_bump + ventas_upsell) - meta_spend) / meta_spend',
    total_dinero_bolsa:         '(ventas_principal + ventas_bump + ventas_upsell) - meta_spend',
    total_costo_compra:         'meta_spend / ventas_principal_count',
}

// ── Semantic Aliases ─────────────────────────────────────────────────────────
// High-level metric names that can be mapped to different data sources per layout.
// The Layout Builder UI reads this catalog to render dropdowns.
export const SEMANTIC_ALIASES: Record<string, { label: string; defaultSource: string; options: { value: string; label: string }[] }> = {
    '$visitas':            { label: 'Visitas / Sesiones',   defaultSource: 'ga_sessions', options: [
        { value: 'ga_sessions',             label: 'GA4 — Sessions' },
        { value: 'meta_landing_page_views', label: 'Meta — Landing Page Views' },
        { value: 'meta_link_clicks',        label: 'Meta — Clics en enlace' },
    ]},
    '$pagos_iniciados':    { label: 'Pagos Iniciados',      defaultSource: 'hotmart_pagos_iniciados', options: [
        { value: 'hotmart_pagos_iniciados', label: 'Hotmart — Checkouts' },
        { value: 'meta_initiates_checkout', label: 'Meta — Initiate Checkout' },
        { value: 'meta_adds_to_cart',       label: 'Meta — Add to Cart' },
    ]},
    '$conversiones':       { label: 'Conversiones',         defaultSource: 'meta_purchases', options: [
        { value: 'meta_purchases',              label: 'Meta — Purchases' },
        { value: 'meta_leads',                  label: 'Meta — Leads' },
        { value: 'meta_complete_registration',  label: 'Meta — Registros Completados' },
    ]},
    '$facturacion_principal': { label: 'Facturación Principal', defaultSource: 'ventas_principal', options: [
        { value: 'ventas_principal',  label: 'Hotmart — Ventas Principal' },
    ]},
    '$facturacion_bump':   { label: 'Facturación Bump',     defaultSource: 'ventas_bump', options: [
        { value: 'ventas_bump',  label: 'Hotmart — Ventas Bump' },
    ]},
    '$facturacion_upsell': { label: 'Facturación Upsell',   defaultSource: 'ventas_upsell', options: [
        { value: 'ventas_upsell',  label: 'Hotmart — Ventas Upsell' },
    ]},

    // ── Aliases del Funnel actual (resueltos según la pestaña activa) ────
    // Estos campos los inyecta DashboardClient en cada row leyendo
    // hotmart_funnel_data.by_tab[activeTabId]. En tabs sin funnel quedan en 0.
    '$funnel.principal_count':  { label: 'Funnel — Compras (Principal)',      defaultSource: 'funnel_principal_count',  options: [{ value: 'funnel_principal_count',  label: 'Funnel — # Ventas Principal' }] },
    '$funnel.principal_neto':   { label: 'Funnel — Neto Principal',           defaultSource: 'funnel_principal_neto',   options: [{ value: 'funnel_principal_neto',   label: 'Funnel — Neto Principal (USD)' }] },
    '$funnel.principal_bruto':  { label: 'Funnel — Bruto Principal',          defaultSource: 'funnel_principal_bruto',  options: [{ value: 'funnel_principal_bruto',  label: 'Funnel — Bruto Principal (USD)' }] },
    '$funnel.bump_count':       { label: 'Funnel — # Order Bumps',            defaultSource: 'funnel_bump_count',       options: [{ value: 'funnel_bump_count',       label: 'Funnel — # Order Bumps' }] },
    '$funnel.bump_neto':        { label: 'Funnel — Neto Order Bump',          defaultSource: 'funnel_bump_neto',        options: [{ value: 'funnel_bump_neto',        label: 'Funnel — Neto Order Bump (USD)' }] },
    '$funnel.upsell_count':     { label: 'Funnel — # Upsells',                defaultSource: 'funnel_upsell_count',     options: [{ value: 'funnel_upsell_count',     label: 'Funnel — # Upsells' }] },
    '$funnel.upsell_neto':      { label: 'Funnel — Neto Upsell',              defaultSource: 'funnel_upsell_neto',      options: [{ value: 'funnel_upsell_neto',      label: 'Funnel — Neto Upsell (USD)' }] },
    '$funnel.upsell_visits':    { label: 'Funnel — Visitas Pág. Upsell',      defaultSource: 'funnel_upsell_visits',    options: [{ value: 'funnel_upsell_visits',    label: 'GA4 — Visitas pág. upsell' }] },
    '$funnel.pagos_iniciados':  { label: 'Funnel — Pagos Iniciados (GA4)',    defaultSource: 'funnel_pagos_iniciados',  options: [{ value: 'funnel_pagos_iniciados',  label: 'GA4 — Visitas pág. de pago' }] },
    '$funnel.facturacion_neta': { label: 'Funnel — Facturación Neta',         defaultSource: 'funnel_facturacion_neta', options: [{ value: 'funnel_facturacion_neta', label: 'Funnel — Neto (Principal + Bump + Upsell)' }] },
    '$funnel.facturacion_bruta':{ label: 'Funnel — Facturación Bruta',        defaultSource: 'funnel_facturacion_bruta',options: [{ value: 'funnel_facturacion_bruta',label: 'Funnel — Precio × Ventas Principal' }] },
    '$funnel.roas':             { label: 'Funnel — ROAS',                     defaultSource: 'funnel_roas',             options: [{ value: 'funnel_roas',             label: 'Funnel — Neto / Spend' }] },
    '$funnel.roi':              { label: 'Funnel — ROI',                      defaultSource: 'funnel_roi',              options: [{ value: 'funnel_roi',              label: 'Funnel — (Neto - Spend) / Spend' }] },
    '$funnel.dinero_bolsa':     { label: 'Funnel — Dinero en la Bolsa',       defaultSource: 'funnel_dinero_bolsa',     options: [{ value: 'funnel_dinero_bolsa',     label: 'Funnel — Neto - Spend' }] },
}

/**
 * Resolves semantic aliases ($visitas, $pagos_iniciados, etc.) to their
 * concrete database field names using the layout's source_mapping.
 * Falls back to the alias's default source if no mapping is found.
 */
export function resolveAliases(formula: string, mapping: Record<string, string> = {}): string {
    let expr = formula
    // Sort by length descending so longer aliases ($funnel.facturacion_neta) replace before shorter prefixes
    const sortedAliases = Object.entries(SEMANTIC_ALIASES).sort(([a], [b]) => b.length - a.length)
    for (const [alias, config] of sortedAliases) {
        const replacement = mapping[alias] || config.defaultSource
        expr = expr.replaceAll(alias, replacement)
    }
    return expr
}

/**
 * Resolves semantic aliases with automatic platform fallback.
 * If the selected source requires a platform not in availablePlatforms,
 * falls back to the best available Meta alternative.
 *
 * Examples:
 *   $visitas → ga_sessions (if GA4 configured) or meta_landing_page_views (if not)
 *   $pagos_iniciados → hotmart_pagos_iniciados (if Hotmart configured) or meta_initiates_checkout (if not)
 */
export function resolveAliasesWithFallback(
    formula: string,
    mapping: Record<string, string> = {},
    availablePlatforms: Set<string> = new Set(['meta'])
): string {
    let expr = formula
    const sortedAliases = Object.entries(SEMANTIC_ALIASES).sort(([a], [b]) => b.length - a.length)
    for (const [alias, config] of sortedAliases) {
        let selected = mapping[alias] || config.defaultSource

        // Fallback: if selected source requires unavailable platform, use Meta alternative
        if (selected.startsWith('ga_') && !availablePlatforms.has('ga4')) {
            const metaAlt = config.options.find(o => o.value.startsWith('meta_'))
            if (metaAlt) selected = metaAlt.value
        } else if (selected.startsWith('hotmart_') && !availablePlatforms.has('hotmart')) {
            const metaAlt = config.options.find(o => o.value.startsWith('meta_'))
            if (metaAlt) selected = metaAlt.value
        } else if (selected.startsWith('ventas_') && !availablePlatforms.has('hotmart')) {
            // ventas_* fields come from Hotmart commissions API — fallback to 0 implicitly
            // (no Meta equivalent for revenue, just leave as-is so formula returns null gracefully)
        }

        expr = expr.replaceAll(alias, selected)
    }
    return expr
}

/**
 * Recursively expands macros and custom metrics in a formula.
 * Detects circular references to avoid infinite loops.
 */
function expandFormulaRecursive(
    formula: string,
    macroMap: Record<string, string>,
    path: string[] = []
): string {
    let expr = formula.trim()
    
    // Resolve full-match macros first (e.g. "meta_cpc")
    if (macroMap[expr] && !path.includes(expr)) {
        return expandFormulaRecursive(macroMap[expr], macroMap, [...path, expr])
    }

    // Replace all occurrences of macros within the formula
    // We sort keys by length descending to avoid partial replacements (e.g. meta_cpc vs meta_cpc_link)
    const sortedKeys = Object.keys(macroMap).sort((a, b) => b.length - a.length)
    
    for (const key of sortedKeys) {
        if (expr.includes(key)) {
            const regex = new RegExp(`\\b${key}\\b`, 'g')
            if (regex.test(expr)) {
                if (path.includes(key)) {
                    // Circular reference detected
                    return '0' 
                }
                const replacement = macroMap[key]
                const expanded = expandFormulaRecursive(replacement, macroMap, [...path, key])
                expr = expr.replaceAll(regex, `(${expanded})`)
            }
        }
    }
    return expr
}

/**
 * Evaluates a formula string against a metric row object.
 * Returns the numeric result or null if calculation isn't possible.
 */
export function evaluateFormula(
    formula: string,
    row: Record<string, any>,
    context: Record<string, number> = {},
    sourceMapping: Record<string, string> = {},
    availablePlatforms?: Set<string>,
    customMetrics: Record<string, string> = {}
): number | null {
    if (formula === 'fecha') return null // fecha is handled separately

    try {
        let expr = availablePlatforms
            ? resolveAliasesWithFallback(formula, sourceMapping, availablePlatforms)
            : resolveAliases(formula, sourceMapping)
        
        // Merge standard macros with user-defined custom metrics for recursive expansion
        const fullMacroMap = { ...MACRO_MAP, ...customMetrics }
        expr = expandFormulaRecursive(expr, fullMacroMap)

        // Replace all known field names with numeric values from the row
        const allFields = { ...FIELD_MAP }

        // Add dynamic meta_custom fields and manual metrics found in the row
        Object.keys(row).forEach(k => {
            if (k !== 'fecha' && k !== 'meta_campaigns' && k !== 'metricas_manuales' && typeof row[k] === 'number') {
                allFields[k] = k
            } else if (k.startsWith('meta_custom_')) {
                allFields[k] = k
            }
        })

        // Add context variables so they can override or provide values for the formula
        Object.keys(context).forEach(k => {
            allFields[k] = k
        })

        for (const [field] of Object.entries(allFields)) {
            let val = 0
            if (context[field] !== undefined) {
                val = context[field]
            } else {
                val = parseFloat(row[field] ?? '0') || 0
            }
            // Use word boundary-safe replacement to avoid partial matches
            const regex = new RegExp(`\\b${field}\\b`, 'g')
            expr = expr.replaceAll(regex, val.toString())
        }

        // Replace any remaining meta_custom_* identifiers with 0
        // (custom conversions referenced in formulas but absent from the row default to 0)
        expr = expr.replace(/\bmeta_custom_\w+\b/g, '0')

        // Only allow safe characters: digits, operators, spaces, parentheses, dots
        if (!/^[\d\s\+\-\*\/\.\(\)]+$/.test(expr)) return null

        // eslint-disable-next-line no-new-func
        const result = new Function(`"use strict"; return (${expr})`)()
        if (!isFinite(result) || isNaN(result)) return null
        return result as number
    } catch {
        return null
    }
}


/**
 * Aggregates a formula over multiple rows by summing numerator and denominator separately.
/**
 * Aggregates a formula over multiple rows.
 * By computing sums of all raw fields first, we ensure that ratios (like CPC = sum(spend)/sum(clicks))
 * are calculated correctly, rather than averaging percentages.
 */
export function aggregateFormula(
    formula: string,
    rows: Record<string, any>[],
    context: Record<string, number> = {},
    sourceMapping: Record<string, string> = {},
    availablePlatforms?: Set<string>,
    customMetrics: Record<string, string> = {}
): number | null {
    if (rows.length === 0 && Object.keys(context).length === 0) return null

    // Accumulate all known fields into a single total row
    const totalRow: Record<string, number> = {}

    // Collect all unique fields from FIELD_MAP and all rows (for dynamic custom fields)
    const allKnownFields = new Set(Object.keys(FIELD_MAP))
    rows.forEach(r => {
        Object.keys(r).forEach(k => {
            if (k !== 'fecha' && k !== 'meta_campaigns' && k !== 'metricas_manuales' && typeof r[k] === 'number') {
                allKnownFields.add(k)
            } else if (k.startsWith('meta_custom_')) {
                allKnownFields.add(k)
            }
        })
    })

    for (const field of allKnownFields) {
        totalRow[field] = rows.reduce((sum, r) => sum + (parseFloat(r[field] ?? '0') || 0), 0)
    }

    // Evaluate the formula once exactly on the aggregated totals
    return evaluateFormula(formula, totalRow, context, sourceMapping, availablePlatforms, customMetrics)
}


/**
 * Formats a numeric result based on column definition.
 */
export function formatValue(
    value: number | null,
    opts: { prefix?: string; suffix?: string; decimals?: number }
): string {
    if (value === null) return '-'
    const { prefix = '', suffix = '', decimals = 2 } = opts
    const formatted = value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    })
    return `${prefix}${formatted}${suffix}`
}
