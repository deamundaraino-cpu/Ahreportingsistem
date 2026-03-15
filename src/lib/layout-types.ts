// Shared types for the layout system

export type CardColor = 'default' | 'emerald' | 'red' | 'blue' | 'amber'

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
}

export interface CardDef {
    id: string
    label: string
    formula: string
    prefix?: string
    suffix?: string
    decimals?: number
    color?: CardColor
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
}

export interface ReportLayout {
    nombre: string
    columnas: ColDef[]
    tarjetas: CardDef[]
    graficos?: ChartDef[]
}
