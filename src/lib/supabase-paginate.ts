/**
 * Paginación de queries PostgREST.
 *
 * Vive en un módulo neutro porque lo usan tanto el motor del BI como el de
 * campos de Sheet, y hacer que uno dependiera del otro crearía un ciclo: el BI
 * necesita leer los campos y los campos necesitan paginar.
 */

/**
 * Trae TODAS las filas de una query paginando (PostgREST limita ~1000 por
 * request). Evita el undercount de contar solo la primera página.
 * `buildQuery` debe devolver una query NUEVA en cada llamada, y su select DEBE
 * incluir la columna `id` (uuid, PK).
 *
 * Paginación por KEYSET (cursor sobre `id`), no por OFFSET: `.range()` sin un
 * ORDER BY estable devuelve órdenes distintos entre páginas → se saltan/duplican
 * filas (peor aún con inserciones en vivo). El cursor `id > lastId` con orden por
 * `id` es determinista e inmune al desplazamiento por inserciones concurrentes.
 */
export async function fetchAllRows(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildQuery: () => any,
    pageSize = 1000,
    hardCap = 200000
): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = []
    let lastId: string | null = null
    while (all.length < hardCap) {
        let q = buildQuery().order('id', { ascending: true }).limit(pageSize)
        if (lastId !== null) q = q.gt('id', lastId)
        const { data, error } = await q
        if (error || !data || data.length === 0) break
        const rows = data as Array<Record<string, unknown>>
        all.push(...rows)
        const last = rows[rows.length - 1]?.id
        if (last === undefined || last === null) break   // sin `id` en el select no se puede avanzar
        lastId = String(last)
        if (rows.length < pageSize) break
    }
    return all
}
