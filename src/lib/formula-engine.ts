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

    // ── Ventas ────────────────────────────────────────────────────────────
    ventas_principal: 'ventas_principal',
    ventas_bump: 'ventas_bump',
    ventas_upsell: 'ventas_upsell',

    // ── Manual ────────────────────────────────────────────────────────────
    leads_registrados: 'leads_registrados',
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
}

/**
 * Expands complex metric names into their underlying mathematical formulas
 */
function expandMacros(formula: string): string {
    let expr = formula.trim()
    if (MACRO_MAP[expr]) {
        return MACRO_MAP[expr]
    }
    // Also replace macros if they are part of a larger formula, but ensure whole word match
    for (const [macro, replacement] of Object.entries(MACRO_MAP)) {
        expr = expr.replaceAll(new RegExp(`\\b${macro}\\b`, 'g'), `(${replacement})`)
    }
    return expr
}

/**
 * Evaluates a formula string against a metric row object.
 * Returns the numeric result or null if calculation isn't possible.
 */
export function evaluateFormula(formula: string, row: Record<string, any>, context: Record<string, number> = {}): number | null {
    if (formula === 'fecha') return null // fecha is handled separately

    try {
        let expr = expandMacros(formula)

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
export function aggregateFormula(formula: string, rows: Record<string, any>[], context: Record<string, number> = {}): number | null {
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
    return evaluateFormula(formula, totalRow, context)
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
