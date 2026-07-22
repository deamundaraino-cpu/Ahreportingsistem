import type { BiMetric, BiDimension, DateGrouping, ValueFilter, AdvancedFilter, CampaignFilterSpec } from '@/lib/report-utm/bi-metadata'

export type { ValueFilter } from '@/lib/report-utm/bi-metadata'

// Tipos de widget que el editor ofrece y el dispatcher (BiWidgetCard) renderiza.
// Se retiraron treemap, matrix, kpi, multicard, narrative y decomposition: estaban
// declarados pero sin componente ni opción en el editor, así que solo podían
// acabar en "Widget desconocido".
export type WidgetType =
    | 'scorecard'
    | 'line'
    | 'area'
    | 'bar'
    | 'combo'
    | 'pie'
    | 'scatter'
    | 'table'
    | 'funnel'
    | 'slicer'
    // ── Bloques estructurales / presentacionales (sin fetch de datos) ──
    | 'section'   // contenedor colapsable que agrupa widgets (config.children)
    | 'heading'   // título divisor a lo ancho
    | 'text'      // párrafo de texto libre / comentario para el cliente
    | 'summary'   // resumen ejecutivo en lenguaje simple (auto o config.text)

export type SlicerMode = 'dropdown' | 'list' | 'daterange'

/**
 * Presentación de un scorecard:
 *  - `default`   solo el valor (con delta si `compare_period`)
 *  - `threshold` semáforo con umbrales propios del widget
 *  - `progress`  barra de avance hacia `target`
 */
export type ScorecardVariant = 'default' | 'threshold' | 'progress'

/** Umbrales del semáforo. Verde si cumple el primero; ámbar si cumple el segundo; rojo si no. */
export interface ScorecardThreshold {
    greenOp: 'gte' | 'lte'
    green: number
    yellowOp: 'gte' | 'lte'
    yellow: number
}

export interface ConditionalRule {
    metric: string          // a qué métrica/columna aplica
    op: 'gt' | 'lt'         // mayor que / menor que
    value: number
    color: 'green' | 'red' | 'amber'
}

/** Clave interna con la que viaja el resultado de la fórmula de un widget. */
export const WIDGET_FORMULA_KEY = '__formula'

export interface WidgetConfig {
    metric?: BiMetric | string       // comma-separated for multi-metric widgets; incluye tokens fieldagg:
    // ── Fórmula propia del widget ──
    // Alternativa a `metric`: una expresión que cruza métricas de distintas
    // fuentes (ej. "meta_spend / ga_sessions" = costo por visita). Cuando está
    // definida manda sobre `metric`. Es local al widget: para reutilizar una
    // fórmula en varios widgets están los campos calculados del informe.
    formula?: string
    formula_format?: 'number' | 'currency' | 'percent' | 'ratio'
    formula_decimals?: number
    dimension?: BiDimension | string // incluye tokens field:<clave> (campos de formulario)
    dimension2?: BiDimension | string // dimensión secundaria (stacked / combo)
    date_grouping?: DateGrouping
    metrics?: BiMetric[]             // used in funnel widget
    limit?: number                   // Top-N
    sort?: 'asc' | 'desc'            // orden
    compare_period?: boolean         // scorecard: comparar vs período anterior
    color?: string                   // color base del widget (hex)
    conditional?: ConditionalRule[]  // formato condicional en tablas
    value_filters?: ValueFilter[]    // ocultar filas que no cumplan condiciones numéricas
    advanced_filter?: AdvancedFilter // filtro Y-de-O propio del widget (se combina en Y con el del informe)
    campaign_filter?: CampaignFilterSpec // filtro rápido por nombre de campaña (recorta gasto y leads)
    show_totals?: boolean            // fila de totales en tablas
    // ── Scorecard: variantes de presentación ──
    variant?: ScorecardVariant       // default = solo valor (+ delta si compare_period)
    threshold?: ScorecardThreshold   // variant 'threshold': umbrales verde/ámbar propios del widget
    // Power BI extras
    slicer_mode?: SlicerMode         // slicer: tipo de control
    source?: 'leads' | 'sales'       // slicer/distinct: tabla base
    target?: number                  // KPI: meta/objetivo
    databars?: string[]              // tabla: columnas con barras en celda
    colorscale?: string[]            // tabla: columnas con escala de color
    // ── Bloques estructurales / presentacionales ──
    text?: string                    // text: párrafo libre (soporta \n, **negrita**, - viñetas)
    heading_level?: 1 | 2 | 3        // heading: jerarquía del título
    align?: 'left' | 'center'        // heading/text: alineación
    collapsed?: boolean              // section: estado colapsado
    columns?: number                 // section: columnas del grid interno (1-4, default 4)
    accent?: string                  // section/heading: color de acento (hex)
}

export interface BiWidget {
    id: string
    type: WidgetType
    title: string
    w?: number  // col span hint (1-4), default 2
    h?: number  // row span hint (1-3), default 1
    config: WidgetConfig
    children?: BiWidget[]  // sólo para type 'section': widgets contenidos
}

export interface BiFilters {
    cliente_id?: string
    date_from?: string
    date_to?: string
    days?: string   // shortcut for last N days
    [key: string]: string | undefined
}

export interface CalculatedField {
    id: string
    name: string        // nombre visible y key
    expression: string  // ej. "revenue / leads_count"
    format?: 'number' | 'currency' | 'percent' | 'ratio'
    decimals?: number   // 0-4; sin definir usa el redondeo por defecto del formato
}

export interface BiSchedule {
    enabled?: boolean
    frequency?: 'weekly' | 'biweekly' | 'monthly'
    /** weekly: 0 = domingo … 6 = sábado (default 1 = lunes). */
    day_of_week?: number
    /** monthly: día 1-28 (default 1). biweekly usa siempre los días 1 y 16. */
    day_of_month?: number
    channels?: { whatsapp?: boolean; email?: boolean }
    emails?: string[]
}

/** Una entrega registrada en el historial (public.bi_report_deliveries). */
export interface BiDelivery {
    id: string
    report_id: string
    period_type: 'weekly' | 'biweekly' | 'monthly'
    period_label: string
    date_from: string
    date_to: string
    delivery_token: string
    sent_at: string
    sent_to?: Record<string, unknown>
}

export interface BiReport {
    id: string
    nombre: string
    descripcion?: string | null
    layout: BiWidget[]
    filters: BiFilters
    calculated_fields?: CalculatedField[]
    public_token?: string | null
    cliente_id?: string | null
    schedule?: BiSchedule
    created_at?: string
    updated_at?: string
}
