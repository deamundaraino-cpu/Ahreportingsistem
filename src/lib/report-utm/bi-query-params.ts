// Parsing compartido de los query params de los widgets BI.
//
// Lo usan el endpoint autenticado (/api/report-utm/bi/query) y el endpoint
// público por token (/api/report-utm/bi/public/[token]/query). Mantenerlo en un
// solo sitio evita que las dos rutas se desincronicen cuando se añade un
// parámetro nuevo (un filtro, un campo calculado, etc.).

import type {
    BiMetric, BiDimension, DateGrouping, CalculatedFieldDef, AdvancedFilter,
} from './bi-metadata'
import { parseAdvancedFilter, advancedFilterHasConditions } from './bi-metadata'

export type BiQueryType = 'standard' | 'funnel' | 'compare' | 'pivot' | 'distinct'

const VALID_TYPES: BiQueryType[] = ['standard', 'funnel', 'compare', 'pivot', 'distinct']

/** Tope duro de filas por consulta (evita que un token público pida el universo). */
export const MAX_QUERY_LIMIT = 500

export interface ParsedBiQuery {
    type: BiQueryType
    cliente_id?: string
    date_from?: string
    date_to?: string
    date_grouping: DateGrouping
    dimension: BiDimension
    dimension2?: BiDimension
    limit: number
    sort: 'asc' | 'desc'
    metrics: BiMetric[]
    filters: Record<string, string>
    calculated: CalculatedFieldDef[]
    advancedFilter?: AdvancedFilter
}

export function parseBiQueryParams(sp: URLSearchParams): ParsedBiQuery {
    const rawType = sp.get('type') ?? 'standard'
    const type = (VALID_TYPES as string[]).includes(rawType) ? (rawType as BiQueryType) : 'standard'

    const rawLimit = parseInt(sp.get('limit') ?? '500', 10)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_QUERY_LIMIT)
        : MAX_QUERY_LIMIT

    // metrics puede venir como CSV o como múltiples ?metrics[]=
    const metricsRaw = sp.get('metrics') ?? sp.getAll('metrics[]').join(',')
    const metrics = metricsRaw.split(',').map(s => s.trim()).filter(Boolean) as BiMetric[]

    // filtros de dimensión: ?filters[utm_source]=facebook
    const filters: Record<string, string> = {}
    // campos calculados: ?calc[Nombre]=expresion
    const calculated: CalculatedFieldDef[] = []
    for (const [key, value] of sp.entries()) {
        if (!value) continue
        const f = key.match(/^filters\[(.+)\]$/)
        if (f) { filters[f[1]] = value; continue }
        const c = key.match(/^calc\[(.+)\]$/)
        if (c) calculated.push({ name: c[1], expression: value })
    }

    const advancedRaw = sp.get('advanced')
    const parsedAdv = advancedRaw ? parseAdvancedFilter(advancedRaw) : undefined
    const advancedFilter = parsedAdv && advancedFilterHasConditions(parsedAdv) ? parsedAdv : undefined

    return {
        type,
        cliente_id:    sp.get('cliente_id') ?? undefined,
        date_from:     sp.get('date_from') ?? undefined,
        date_to:       sp.get('date_to') ?? undefined,
        date_grouping: (sp.get('date_grouping') ?? 'day') as DateGrouping,
        dimension:     (sp.get('dimension') ?? 'none') as BiDimension,
        dimension2:    (sp.get('dimension2') ?? undefined) as BiDimension | undefined,
        limit,
        sort:          (sp.get('sort') ?? 'desc') as 'asc' | 'desc',
        metrics,
        filters,
        calculated,
        advancedFilter,
    }
}
