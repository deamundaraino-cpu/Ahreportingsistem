// Shared types for the layout system

export type CardColor = 'default' | 'emerald' | 'red' | 'blue' | 'amber'

/** Variante de visualización de una tarjeta */
export type CardVariant = 'default' | 'stat' | 'sparkline' | 'threshold' | 'progress'

/** Umbrales para la tarjeta tipo semáforo */
export interface CardThreshold {
    greenOperator: '>=' | '<=' | '>' | '<'
    greenValue: number
    yellowOperator: '>=' | '<=' | '>' | '<'
    yellowValue: number
}

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

/**
 * Filtro compuesto de campañas para una PESTAÑA: varias condiciones combinadas
 * con Y (todas deben cumplirse) u O (basta una).
 *
 * Se persiste dentro de `cliente_tabs.keyword_meta` (TEXT) serializado con el
 * prefijo `__cf:` para no requerir migración de BD. Una sola condición `includes`
 * se guarda como string plano (compatibilidad total hacia atrás). Ver
 * `parseTabFilter` / `serializeTabFilter` en src/lib/campaign-filter.ts.
 */
export interface TabCampaignFilter {
    mode: 'and' | 'or'
    conditions: CampaignFilterSpec[]
}

export type FormFilterField = 'form_id' | 'form_name'

export interface FormFilterSpec {
    field: FormFilterField
    operator?: CampaignFilterOperator
    value: string | string[]
}

export type SheetFilterOperator =
    | 'equals'
    | 'not_equals'
    | 'includes'
    | 'excludes'
    | 'any_of'
    | 'none_of'
    | 'greater_than'
    | 'less_than'
    | 'greater_equal'
    | 'less_equal'

export interface SheetFilterSpec {
    field: string // e.g. "sheet_rango_inversion" or standard fields "tipo", "fuente", "notas"
    operator: SheetFilterOperator
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
    sheetFilter?: SheetFilterSpec
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
    sheetFilter?: SheetFilterSpec
    account_id?: string
    // Visualization variants
    variant?: CardVariant
    showDelta?: boolean          // Muestra % cambio vs período anterior
    threshold?: CardThreshold    // Para variant='threshold': colores automáticos por umbral
    targetFormula?: string       // Para variant='progress': fórmula del valor objetivo
    targetLabel?: string         // Etiqueta del objetivo en la barra de progreso
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
    sheetFilter?: SheetFilterSpec
    account_id?: string
    yAxes?: ('left' | 'right')[]
    types?: ('line' | 'bar' | 'area' | '')[]
    strokeWidths?: number[]
    showDataLabels?: boolean
    periodicity?: 'day' | 'week' | 'month' | 'year'
    units?: ('number' | 'currency' | 'percent')[]
    dimension?: 'campaigns' | 'ads' | 'adsets' | 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups'
    topN?: number
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
    // Sin `sheetFilter`: estas tablas agregan por campaña/anuncio desde
    // `meta_campaigns`/`meta_ads`, filas que no llevan datos offline. El campo
    // existió sin UI ni lector y nunca pudo cambiar un número.
    account_id?: string
}

/**
 * Bloque de desglose de leads por RESPUESTA de formulario.
 *
 * Responde "cuántos leads contestaron A, cuántos B y cuántos C", no "cuántos
 * respondieron la pregunta". Los datos salen de `report_utm.lead_events`
 * (raw_fields) plegados por la migración 071 y cruzados con las campañas reales
 * por la cascada de `campaign-resolver`.
 *
 * ── Por qué NO lleva gasto ni CPL ────────────────────────────────────────────
 * No es un descuido ni una fase 2. El gasto vive en `metricas_diarias`, agregado
 * por día y campaña: una fila de gasto no sabe qué respondió cada lead, porque
 * una respuesta de formulario no existe a nivel de anuncio. Repartirlo entre
 * respuestas —proporcionalmente o como sea— produciría un CPL inventado con
 * aspecto de dato medido, que es peor que no tenerlo.
 *
 * Es la misma decisión que ya toman los filtros por país, por formulario y por
 * campo de lead en el BI, documentada en docs/17 ("El gasto no se recorta por
 * respuesta") y docs/18 parte 5. Para el costo por lead de un segmento hay que
 * compararlo a mano contra el gasto de su campaña.
 */
export interface LeadAnswerBlockDef {
    id: string
    title: string
    /**
     * De dónde sale la definición de la pregunta:
     *  - 'catalogo' → `clave` referencia `report_utm.lead_campos`, así que el
     *    nombre visible, la agrupación de respuestas equivalentes y su orden los
     *    manda el analista.
     *  - 'auto' → `clavesOrigen` viaja dentro del bloque y se sintetiza un campo
     *    sin agrupación. Es lo que permite estrenar la feature en un cliente sin
     *    configurar nada; el modal ofrece promoverlo al catálogo.
     *
     * A partir de aquí el resto del código NO distingue: los dos producen un
     * `LeadCampoDef` y `bucketDeValor` solo necesita eso.
     */
    origen: 'catalogo' | 'auto'
    /** Slug del campo del catálogo. Solo con `origen: 'catalogo'`. */
    clave?: string
    /** Claves de `raw_fields` ya normalizadas. Solo con `origen: 'auto'`. */
    clavesOrigen?: string[]
    /** Etiqueta visible. Con `origen: 'catalogo'` cae al `nombre` del catálogo. */
    label?: string
    /**
     * `bars`  → una barra por respuesta, totales del período.
     * `daily` → una fila por día: total del día y de qué está hecho
     *           («hoy 40: 15 A, 5 B, 3 C, 17 sin responder»).
     */
    display?: 'bars' | 'daily'
    topN?: number
    /** Funde la cola larga en "Otras respuestas" en vez de esconderla. */
    agruparResto?: boolean
    showDelta?: boolean
    showCsv?: boolean
    ocultarVacios?: boolean
    /** Filtro propio del bloque, encadenado DESPUÉS del filtro de la pestaña. */
    campaignFilter?: CampaignFilterSpec
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
    lead_answer_blocks?: LeadAnswerBlockDef[]
}

