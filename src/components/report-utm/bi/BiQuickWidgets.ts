// Scorecards preconfigurados para añadir de un clic.
//
// Montar un informe empezaba siempre por los mismos 4-5 KPIs, cada uno con el
// mismo recorrido por el editor. Estos presets los insertan ya configurados
// (con comparación vs período anterior activada).
//
// Las variantes Hotmart de ROAS/CPA/ROI están aquí a propósito: para los clientes
// que venden por Hotmart sin webhook de ventas, son las únicas que traen datos.

import type { BiWidget } from './BiTypes'
import type { BiMetric } from '@/lib/report-utm/bi-metadata'

export interface QuickWidgetPreset {
    /** Etiqueta del menú. */
    label: string
    metric: BiMetric
    /** Título del widget insertado. */
    title: string
}

export const QUICK_WIDGETS: QuickWidgetPreset[] = [
    { label: 'Gasto',             metric: 'spend',              title: 'Inversión publicitaria' },
    { label: 'Leads',             metric: 'leads_count',        title: 'Contactos generados' },
    { label: 'CPL',               metric: 'cpl',                title: 'Costo por contacto' },
    { label: 'ROAS (Hotmart)',    metric: 'hotmart_roas',       title: 'Retorno (ROAS)' },
    { label: 'CPA (Hotmart)',     metric: 'hotmart_cpa',        title: 'Costo por venta' },
    { label: 'ROI % (Hotmart)',   metric: 'hotmart_roi',        title: 'Retorno sobre inversión' },
    { label: 'Facturación',       metric: 'hotmart_revenue',    title: 'Facturación del período' },
    { label: 'Checkouts',         metric: 'initiates_checkout', title: 'Pagos iniciados' },
    { label: 'CTR',               metric: 'ctr',                title: 'CTR' },
    { label: 'CPM',               metric: 'cpm',                title: 'CPM' },
]

/** Construye el widget listo para insertar en el layout. */
export function buildQuickWidget(preset: QuickWidgetPreset, id: string): BiWidget {
    return {
        id,
        type: 'scorecard',
        title: preset.title,
        w: 1,
        h: 1,
        config: { metric: preset.metric, compare_period: true },
    }
}
