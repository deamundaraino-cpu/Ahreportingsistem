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
/** Intentos por página antes de darse por vencido. */
const REINTENTOS = 3;

export async function fetchAllRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  pageSize = 1000,
  hardCap = 200000
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let lastId: string | null = null;
  while (all.length < hardCap) {
    // Una página que falla se REINTENTA antes de rendirse.
    //
    // Cortar en silencio devolvía un conteo PARCIAL con pinta de definitivo:
    // un error transitorio a mitad del recorrido dejaba, por ejemplo, 893 de
    // 6.648 leads, y el informe enseñaba ese 893 sin que nada avisara. Se vio
    // al estrenar los segmentos de lead, que obligan a paginar donde antes
    // bastaba un `count` exacto, pero el riesgo era de todos los que paginan.
    let rows: Array<Record<string, unknown>> | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ultimoError: any = null;
    for (let intento = 1; intento <= REINTENTOS; intento++) {
      let q = buildQuery().order('id', { ascending: true }).limit(pageSize);
      if (lastId !== null) q = q.gt('id', lastId);
      const { data, error } = await q;
      if (!error && data) {
        rows = data as Array<Record<string, unknown>>;
        break;
      }
      ultimoError = error;
      // Espera corta y creciente: lo que falla aquí es un pico de latencia o
      // una caché de esquema recién invalidada, no un error de lógica.
      if (intento < REINTENTOS) await new Promise((r) => setTimeout(r, 150 * intento));
    }

    if (!rows) {
      // Con lo ya traído se sigue devolviendo algo —cortar del todo dejaría
      // el widget vacío en vez de casi completo—, pero NUNCA en silencio.
      console.error(
        `[paginate] página fallida tras ${REINTENTOS} intentos con ${all.length} filas ya traídas;` +
          ` el resultado va a quedar INCOMPLETO:`,
        ultimoError?.message ?? ultimoError
      );
      break;
    }

    if (rows.length === 0) break;
    all.push(...rows);
    const last = rows[rows.length - 1]?.id;
    if (last === undefined || last === null) break; // sin `id` en el select no se puede avanzar
    lastId = String(last);
    if (rows.length < pageSize) break;
  }
  return all;
}
