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

export type BiQueryType = 'standard' | 'funnel' | 'compare' | 'pivot' | 'distinct' | 'valores'

const VALID_TYPES: BiQueryType[] = ['standard', 'funnel', 'compare', 'pivot', 'distinct', 'valores']

/** Tope duro de filas por consulta (evita que un token público pida el universo). */
export const MAX_QUERY_LIMIT = 500

/**
 * ¿Esta consulta ENUMERA los valores de una dimensión?
 *
 * `distinct` devuelve solo los nombres (contrato histórico) y `valores` los
 * devuelve con su recuento, pero las dos exponen exactamente la misma
 * información: qué valores existen para un cliente en un rango.
 *
 * Existe como función y no como comparación suelta porque el informe público
 * restringe estas consultas a las dimensiones que su layout muestra en un
 * slicer. Esa guarda estaba escrita contra el literal `'distinct'`, así que
 * añadir un tipo nuevo habría abierto un agujero sin que nadie lo notara.
 */
export function esConsultaDeValores(t: BiQueryType): boolean {
    return t === 'distinct' || t === 'valores'
}

/** Cuántos valores devuelve `type=valores` si no se pide otra cosa. */
export const LIMITE_VALORES_DEFECTO = 200

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
    /**
     * Tabla base al enumerar valores. El slicer YA lo enviaba y este parseo no
     * lo leía, así que un slicer configurado sobre ventas listaba valores de
     * leads. Se valida contra los dos literales en vez de castear.
     */
    source?: 'leads' | 'sales'
    /** Búsqueda por subcadena, para cuando la lista de valores viene truncada. */
    search?: string
}

export function parseBiQueryParams(sp: URLSearchParams): ParsedBiQuery {
    const rawType = sp.get('type') ?? 'standard'
    const type = (VALID_TYPES as string[]).includes(rawType) ? (rawType as BiQueryType) : 'standard'

    // Enumerar valores tiene su propio defecto: 500 sería traer casi el universo
    // de una dimensión cada vez que se abre un desplegable, y 200 ya cubre de
    // sobra la columna más variada que hay hoy (648 valores en toda la base).
    const defectoLimit = type === 'valores' ? LIMITE_VALORES_DEFECTO : MAX_QUERY_LIMIT
    const rawLimit = parseInt(sp.get('limit') ?? String(defectoLimit), 10)
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_QUERY_LIMIT)
        : defectoLimit

    const rawSource = sp.get('source')
    const source = rawSource === 'sales' || rawSource === 'leads' ? rawSource : undefined

    // Una búsqueda de un solo carácter devolvería casi todo y costaría lo mismo
    // que no buscar; se descarta en vez de disparar la consulta.
    const rawSearch = (sp.get('search') ?? '').trim().slice(0, 64)
    const search = rawSearch.length >= 2 ? rawSearch : undefined

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
        source,
        search,
    }
}
