import type { BiMetric, BiDimension, DateGrouping, ValueFilter } from '@/lib/report-utm/bi-metadata'

export type { ValueFilter } from '@/lib/report-utm/bi-metadata'

export type WidgetType =
    | 'scorecard'
    | 'line'
    | 'area'
    | 'bar'
    | 'combo'
    | 'pie'
    | 'scatter'
    | 'treemap'
    | 'table'
    | 'matrix'
    | 'funnel'
    | 'slicer'
    | 'kpi'
    | 'multicard'
    | 'narrative'
    | 'decomposition'

export type SlicerMode = 'dropdown' | 'list' | 'daterange'

export interface ConditionalRule {
    metric: string          // a qué métrica/columna aplica
    op: 'gt' | 'lt'         // mayor que / menor que
    value: number
    color: 'green' | 'red' | 'amber'
}

export interface WidgetConfig {
    metric?: BiMetric | string       // comma-separated for multi-metric widgets
    dimension?: BiDimension
    dimension2?: BiDimension         // dimensión secundaria (stacked / combo / matrix)
    date_grouping?: DateGrouping
    metrics?: BiMetric[]             // used in funnel widget
    limit?: number                   // Top-N
    sort?: 'asc' | 'desc'            // orden
    compare_period?: boolean         // scorecard: comparar vs período anterior
    color?: string                   // color base del widget (hex)
    conditional?: ConditionalRule[]  // formato condicional en tablas
    value_filters?: ValueFilter[]    // ocultar filas que no cumplan condiciones numéricas
    show_totals?: boolean            // fila de totales en tablas
    // Power BI extras
    slicer_mode?: SlicerMode         // slicer: tipo de control
    source?: 'leads' | 'sales'       // slicer/distinct: tabla base
    target?: number                  // KPI: meta/objetivo
    databars?: string[]              // tabla: columnas con barras en celda
    colorscale?: string[]            // tabla: columnas con escala de color
}

export interface BiWidget {
    id: string
    type: WidgetType
    title: string
    w?: number  // col span hint (1-4), default 2
    h?: number  // row span hint (1-3), default 1
    config: WidgetConfig
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
    created_at?: string
    updated_at?: string
}
