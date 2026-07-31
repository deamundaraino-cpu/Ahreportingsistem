// Despacho de una consulta BI ya parseada al motor correcto.
//
// Lo comparten el endpoint autenticado (/api/report-utm/bi/query) y el público
// por token (/api/report-utm/bi/public/[token]/query), de modo que ambos
// resuelven exactamente igual y no se desincronizan.

import { runBiQuery, runFunnelQuery, runComparison, runPivotQuery, runDistinctValues } from './bi-query'
import { supportsPivot, PIVOT_METRICS, METRIC_META, isSheetDim } from './bi-metadata'
import type { ParsedBiQuery } from './bi-query-params'

export interface DispatchResult {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: any
    error?: string
    status?: number
}

export async function dispatchBiQuery(rawParams: ParsedBiQuery): Promise<DispatchResult> {
    // "Campaña (cruzada)" tuvo su propio motor (`runCampaignQuery`), que solo
    // emitía ~20 de las 72 métricas e ignoraba los campos calculados. Hoy la
    // dimensión `utm_campaign` del motor principal hace el mismo cruce con todo
    // el catálogo, así que el alias se normaliza aquí y sigue el camino normal:
    // los informes guardados con `dimension: 'campaign'` no se enteran.
    const p: ParsedBiQuery = {
        ...rawParams,
        dimension:  rawParams.dimension  === 'campaign' ? 'utm_campaign' : rawParams.dimension,
        dimension2: rawParams.dimension2 === 'campaign' ? 'utm_campaign' : rawParams.dimension2,
    }

    const base = {
        cliente_id: p.cliente_id,
        metrics: p.metrics,
        dimension: p.dimension,
        dimension2: p.dimension2,
        date_from: p.date_from,
        date_to: p.date_to,
        date_grouping: p.date_grouping,
        filters: p.filters,
        limit: p.limit,
        sort: p.sort,
        calculated: p.calculated.length ? p.calculated : undefined,
        advancedFilter: p.advancedFilter,
    }

    if (p.type === 'funnel') {
        const data = await runFunnelQuery({
            cliente_id: p.cliente_id,
            date_from: p.date_from,
            date_to: p.date_to,
            filters: p.filters,
            advancedFilter: p.advancedFilter,
            metrics: p.metrics,
        })
        return { data }
    }

    if (p.type === 'distinct') {
        const data = await runDistinctValues({
            cliente_id: p.cliente_id,
            dimension: p.dimension,
            date_from: p.date_from,
            date_to: p.date_to,
            filters: p.filters,
        })
        return { data }
    }

    if (p.type === 'pivot') {
        if (!p.metrics.length || !p.dimension2) {
            return { error: 'pivot requires metric + dimension2', status: 400 }
        }
        // El pivot agrupa filas de lead_events/sales_events: solo puede contar filas
        // o sumar `amount`. Con cualquier otra métrica devolvería un conteo de filas
        // disfrazado de gasto/alcance, así que se rechaza explícitamente.
        // Un campo de Sheet no puede ser eje de una tabla dinámica: su desglose
        // vive en su propia tabla y no cruza con las filas de leads/ventas que
        // agrupa el pivot. Se dice explícitamente en vez de devolver ceros.
        if (isSheetDim(p.dimension) || isSheetDim(p.dimension2)) {
            return {
                error: 'Un campo de Sheet no se puede usar como eje de una tabla dinámica. ' +
                    'Úsalo como dimensión principal en una tabla o una gráfica.',
                status: 400,
            }
        }
        if (!supportsPivot(p.metrics[0])) {
            const validas = PIVOT_METRICS.map(m => METRIC_META[m]?.label ?? m).join(', ')
            return {
                error: `La dimensión secundaria solo admite: ${validas}.`,
                status: 400,
            }
        }
        const data = await runPivotQuery(base, p.metrics[0])
        return { data }
    }

    // Un widget de FÓRMULA no pide métricas: pide una expresión (calc[...]) que el
    // motor resuelve leyendo los identificadores que referencia. Exigir `metrics`
    // aquí lo rechazaba con un 400 que el widget mostraba como un simple 0.
    if (!p.metrics.length && !p.calculated.length) {
        return { error: 'metrics is required', status: 400 }
    }

    if (p.type === 'compare') {
        const data = await runComparison(base)
        return { data }
    }

    const data = await runBiQuery(base)
    return { data }
}
