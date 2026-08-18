// Despacho de una consulta BI ya parseada al motor correcto.
//
// Lo comparten el endpoint autenticado (/api/report-utm/bi/query) y el público
// por token (/api/report-utm/bi/public/[token]/query), de modo que ambos
// resuelven exactamente igual y no se desincronizan.

import { runBiQuery, runFunnelQuery, runComparison, runPivotQuery, runValores } from './bi-query'
import { aValoresPlanos } from './bi-valores'
import {
    supportsPivot, PIVOT_METRICS, METRIC_META, isSheetDim,
    hasNonAttributableFilter, NON_ATTRIBUTABLE_FIELDS,
} from './bi-metadata'
import { resolvePublicClienteId } from './campaign-resolver'
import { computeDiagnostics } from './bi/diagnostics'
import type { QueryDiagnostics } from './bi/diagnostics'
import type { ParsedBiQuery } from './bi-query-params'
import { esConsultaDeValores } from './bi-query-params'

export interface DispatchResult {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data?: any
    /**
     * Por qué un campo no se pudo medir. ADITIVO: los widgets que solo leen
     * `data` siguen funcionando igual. Es lo que permite pintar «—» con su
     * motivo en vez de un 0 que no significa cero.
     */
    meta?: QueryDiagnostics
    error?: string
    status?: number
}

/**
 * Qué campos del filtro activo NO son atribuibles al gasto.
 *
 * `hasNonAttributableFilter` ya decide SI hay alguno (y el motor lo usa para
 * anular la consulta de gasto); aquí hace falta además CUÁLES, para poder
 * nombrarlos en el aviso en vez de dar una explicación genérica.
 */
function camposNoAtribuibles(p: ParsedBiQuery): string[] {
    const out = new Set<string>()
    const esNoAtribuible = (campo: string) =>
        NON_ATTRIBUTABLE_FIELDS.has(campo) ||
        campo.startsWith('field:') || campo.startsWith('leadfield:') || campo.startsWith('sheetdim:')

    for (const [k, v] of Object.entries(p.filters ?? {})) {
        if (v && String(v).trim() && esNoAtribuible(k)) out.add(k)
    }
    for (const g of p.advancedFilter?.groups ?? []) {
        for (const c of g.conditions ?? []) {
            if (c.value && c.value.trim() && esNoAtribuible(c.field)) out.add(c.field)
        }
    }
    return [...out]
}

/**
 * Calcula el diagnóstico de la consulta. No cambia ningún número: solo explica
 * los que el motor ya devuelve.
 *
 * Nunca hace fallar la consulta: si el diagnóstico revienta, se devuelven las
 * filas sin él. Un aviso roto no debe tumbar un informe.
 */
async function diagnosticarSeguro(p: ParsedBiQuery): Promise<QueryDiagnostics | undefined> {
    try {
        // Sin cliente no hay nada que diagnosticar (y sin él el motor tampoco
        // lee las fuentes que cuelgan del cliente público).
        if (!p.cliente_id) return undefined
        const publicId = await resolvePublicClienteId(p.cliente_id)
        return computeDiagnostics({
            metrics: p.metrics as unknown as string[],
            dimension: p.dimension,
            dimension2: p.dimension2,
            calculated: p.calculated.map(c => ({ name: c.name, expression: c.expression })),
            hasPublicLink: publicId !== null,
            unattributableFilters: hasNonAttributableFilter(p.filters, p.advancedFilter)
                ? camposNoAtribuibles(p)
                : undefined,
        })
    } catch {
        return undefined
    }
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
        const [data, meta] = await Promise.all([
            runFunnelQuery({
                cliente_id: p.cliente_id,
                date_from: p.date_from,
                date_to: p.date_to,
                filters: p.filters,
                advancedFilter: p.advancedFilter,
                metrics: p.metrics,
            }),
            diagnosticarSeguro(p),
        ])
        return { data, meta }
    }

    if (esConsultaDeValores(p.type)) {
        // Enumerar valores alimenta un desplegable: no hay métricas que
        // explicar, así que no se diagnostica.
        //
        // `source` y `limit` se reenvían de verdad. Antes se perdían aquí: el
        // slicer los mandaba en la URL, el parseo no los leía y esta llamada no
        // los pasaba, así que un slicer sobre ventas listaba valores de leads.
        const r = await runValores({
            cliente_id: p.cliente_id,
            dimension: p.dimension,
            date_from: p.date_from,
            date_to: p.date_to,
            filters: p.filters,
            source: p.source,
            search: p.search,
            limit: p.limit,
        })
        // `distinct` conserva su contrato histórico —un array de nombres— para
        // que un widget servido desde la caché del navegador siga funcionando.
        return { data: p.type === 'distinct' ? aValoresPlanos(r) : r }
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
                error: `La dimensión secundaria solo admite: ${validas} y los segmentos de campo de lead.`,
                status: 400,
            }
        }
        const [data, meta] = await Promise.all([
            runPivotQuery(base, p.metrics[0]),
            diagnosticarSeguro(p),
        ])
        return { data, meta }
    }

    // Un widget de FÓRMULA no pide métricas: pide una expresión (calc[...]) que el
    // motor resuelve leyendo los identificadores que referencia. Exigir `metrics`
    // aquí lo rechazaba con un 400 que el widget mostraba como un simple 0.
    if (!p.metrics.length && !p.calculated.length) {
        return { error: 'metrics is required', status: 400 }
    }

    if (p.type === 'compare') {
        const [data, meta] = await Promise.all([runComparison(base), diagnosticarSeguro(p)])
        return { data, meta }
    }

    const [data, meta] = await Promise.all([runBiQuery(base), diagnosticarSeguro(p)])
    return { data, meta }
}
