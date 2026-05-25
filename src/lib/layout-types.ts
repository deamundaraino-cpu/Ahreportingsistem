// Shared types for the layout system

export type CardColor = 'default' | 'emerald' | 'red' | 'blue' | 'amber'

/** Operadores de filtro para nombre de campaña */
export type CampaignFilterOperator =
    | 'includes'    // Incluye
    | 'excludes'    // Excluye
    | 'exact'       // Coincide con
    | 'not_exact'   // No coincide con
    | 'starts_with' // Inicia con
    | 'ends_with'   // Finaliza con
    | 'any_of'      // Entre estas (multi-selección)
    | 'none_of'     // Fuera de estas (multi-selección)

export interface CampaignFilterSpec {
    type: 'group' | 'keyword'
    operator?: CampaignFilterOperator
    value: string | string[]
}

export type FormFilterField = 'form_id' | 'form_name'

export interface FormFilterSpec {
    field: FormFilterField
    operator?: CampaignFilterOperator
    value: string | string[]
}

/**
 * Attribution strategy presets for layouts.
 * Determines which data sources are used for semantic aliases ($visitas, $conversiones, etc.)
 * - hybrid: GA4 visits + Hotmart sales + Meta conversions
 * - full_meta: all metrics resolved from Meta Ads
 * - full_hotmart: sales and conversions from Hotmart
 * - custom: manual source_mapping per alias (default, no auto-fallback applied)
 */
export type AttributionStrategy = 'hybrid' | 'full_meta' | 'full_hotmart' | 'custom'

export interface ColDef {
    id: string
    label: string
    formula: string
    prefix?: string
    suffix?: string
    decimals?: number
    align?: 'left' | 'right'
    highlight?: boolean
    hidden?: boolean
    isManual?: boolean
    campaignFilter?: CampaignFilterSpec
    formFilter?: FormFilterSpec
}

export interface CardDef {
    id: string
    label: string
    formula: string
    prefix?: string
    suffix?: string
    decimals?: number
    color?: CardColor
    campaignFilter?: CampaignFilterSpec
    formFilter?: FormFilterSpec
}

export type ChartType =
    | 'area'          // Área con gradiente
    | 'stacked_area'  // Área apilada
    | 'bar'           // Barras agrupadas
    | 'stacked_bar'   // Barras apiladas
    | 'line'          // Líneas
    | 'donut'         // Rosquilla (donut)
    | 'pie'           // Torta completa
    | 'composed'      // Barras + línea combinado
    | 'radial'        // Barras radiales circulares
    | 'scatter'       // Dispersión (correlación entre 2 métricas)
    | 'funnel'        // Embudo de conversión

export interface ChartDef {
    id: string
    title: string
    type: ChartType
    categoryColumns: string[] // e.g. ["fecha", "week"]
    valueFormulas: string[]   // e.g. ["meta_spend", "meta_leads"]
    colors?: string[]         // e.g. ["amber", "cyan"]
    height?: number
    campaignFilter?: CampaignFilterSpec
    formFilter?: FormFilterSpec
    yAxes?: ('left' | 'right')[]
    types?: ('line' | 'bar' | 'area' | '')[]
    strokeWidths?: number[]
    showDataLabels?: boolean
    periodicity?: 'day' | 'week' | 'month' | 'year'
    units?: ('number' | 'currency' | 'percent')[]
}

export interface TextBlockDef {
    id: string
    blockType?: 'text' | 'separator'
    content: string
    style: 'h1' | 'h2' | 'h3' | 'p'
    align?: 'left' | 'center' | 'right'
    color?: 'white' | 'zinc' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'cyan' | 'blue'
    fontFamily?: 'sans' | 'serif' | 'mono'
    fontSize?: 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '4xl' | '6xl' | '8xl'
    colSpan?: number // 1 to 4
    backgroundColor?: string // 'transparent', 'indigo', 'etc' or hex
    borderRadius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full'
    separatorStyle?: 'line' | 'dashed' | 'dots' | 'space'
    separatorWidth?: 'full' | 'half' | 'small'
}

export interface RankingColumnDef {
    formula: string
    label: string
    prefix?: string
    suffix?: string
    decimals?: number
    highlight?: boolean
}

export interface RankingTableDef {
    id: string
    title: string
    platform?: 'meta' | 'tiktok'
    dimension: 'campaigns' | 'ads' | 'adsets' | 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups'
    columns: RankingColumnDef[]
    topN: number
    sortColumnIndex: number
    sortOrder: 'desc' | 'asc'
    showRank?: boolean
    campaignFilter?: CampaignFilterSpec
    formFilter?: FormFilterSpec
}

export interface MetricDef {
    id: string
    label: string
    formula: string
    prefix?: string
    suffix?: string
    decimals?: number
}

export interface ReportLayout {
    nombre: string
    columnas: ColDef[]
    tarjetas: CardDef[]
    graficos?: ChartDef[]
    text_blocks?: TextBlockDef[]
    custom_metrics?: MetricDef[]
    blocks_order?: string[] // IDs or type-prefixed IDs like 'cards', 'chart:id', 'table', 'text:id'
    source_mapping?: Record<string, string>  // { "$visitas": "ga_sessions", "$pagos_iniciados": "hotmart_pagos_iniciados" }
    attribution_strategy?: AttributionStrategy
    ranking_tables?: RankingTableDef[]
}

