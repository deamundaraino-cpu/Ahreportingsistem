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
    | 'cpl'
    | 'cpa'
    | 'roas'
    | 'conversion_rate'
    | 'clicks'
    | 'impressions'
    | 'cpc'
    | 'cpm'

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
    spend:           { label: 'Gasto',           format: 'currency', source: 'ads' },
    cpl:             { label: 'CPL',             format: 'currency', source: 'computed' },
    cpa:             { label: 'CPA',             format: 'currency', source: 'computed' },
    roas:            { label: 'ROAS',            format: 'ratio',    source: 'computed' },
    conversion_rate: { label: 'Conv. Rate',      format: 'percent',  source: 'computed' },
    clicks:          { label: 'Clics',           format: 'number',   source: 'ads' },
    impressions:     { label: 'Impresiones',     format: 'number',   source: 'ads' },
    cpc:             { label: 'CPC',             format: 'currency', source: 'computed' },
    cpm:             { label: 'CPM',             format: 'currency', source: 'computed' },
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
