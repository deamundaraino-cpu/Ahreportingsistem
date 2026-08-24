/**
 * Agrupación de filas para un upsert masivo seguro.
 *
 * ── El fallo que esto evita ──────────────────────────────────────────────
 * El worker «preserva» los datos de una plataforma OMITIENDO sus claves del
 * objeto que va al upsert (`...(!metaFailed && { meta_spend, ... })`). Eso solo
 * es cierto si todas las filas del lote tienen las mismas claves: PostgREST
 * normaliza un insert masivo a UNA lista de columnas —la unión de las claves de
 * todas las filas— y a la fila que no trae una clave le mete NULL, que el
 * `ON CONFLICT DO UPDATE` escribe encima. En un lote mezclado, omitir un campo
 * no lo preservaba: lo BORRABA.
 *
 * Caso real: Sur Profundo perdió el gasto y los leads de Meta del 24 al 27 de
 * julio de 2026 (3.385.086 COP y 432 leads) aunque el worker los había
 * descargado bien. La ventana de refresco de Meta son 7 días y la de TikTok 3,
 * así que hay fechas en las que Meta no se re-pide pero TikTok sí trae datos:
 * esa fila entraba al lote sin las claves de Meta y anulaba las columnas. La
 * corrida siguiente los volvía a bajar y otra los borraba de nuevo, en bucle,
 * por eso nunca se auto-reparaba.
 *
 * Agrupando por forma, cada upsert lleva filas con exactamente las mismas
 * columnas y omitir vuelve a significar «no tocar».
 */

/** Firma estable de una fila: sus claves ordenadas. */
export function firmaDeFila(fila: Record<string, unknown>): string {
  return Object.keys(fila).sort().join('|');
}

/**
 * Parte un lote en grupos homogéneos (mismo conjunto de claves).
 *
 * Conserva el orden de aparición y no pierde ni duplica filas. En la práctica
 * son 1-3 grupos por corrida, así que el coste en queries es despreciable.
 */
export function agruparPorForma<T extends Record<string, unknown>>(filas: T[]): T[][] {
  const grupos = new Map<string, T[]>();
  for (const fila of filas) {
    const firma = firmaDeFila(fila);
    const grupo = grupos.get(firma);
    if (grupo) grupo.push(fila);
    else grupos.set(firma, [fila]);
  }
  return [...grupos.values()];
}

/** Plataformas cuyas columnas NO viajan en este grupo (se conservan en BD). */
export function plataformasOmitidas(
  fila: Record<string, unknown>,
  plataformas: readonly string[] = ['meta', 'tiktok']
): string[] {
  return plataformas.filter((p) => !(`${p}_spend` in fila));
}
