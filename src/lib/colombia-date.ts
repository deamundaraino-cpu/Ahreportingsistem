/**
 * Fecha de calendario en hora Colombia, sin dependencias.
 *
 * Vive aparte de `date-utils.ts` a propósito: el worker self-hosted
 * (`sync-worker/`) compila `src/lib/sync/queue.ts` con su propio tsconfig y no
 * tiene `date-fns` instalado. Estos helpers son aritmética de strings, así que
 * los pueden compartir la app y el worker sin arrastrar la librería.
 *
 * Colombia = America/Bogota = UTC-5 fijo (no usa horario de verano), así que el
 * desfase nunca cambia y basta con desplazar el instante y leer sus componentes
 * UTC.
 */

export const COLOMBIA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha de "hoy" en hora Colombia (yyyy-MM-dd). */
export function colombiaToday(now: Date = new Date()): string {
    return new Date(now.getTime() - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** Fecha de "ayer" en hora Colombia (yyyy-MM-dd). */
export function colombiaYesterday(now: Date = new Date()): string {
    return new Date(now.getTime() - COLOMBIA_UTC_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Recorta un rango [start, end] contra HOY en hora Colombia.
 *
 * Ningún día futuro existe todavía en Meta/TikTok/Hotmart/GA4: pedirlo solo
 * genera filas vacías o un job condenado a fallar. Mirar un rango que termina en
 * el futuro sí es legítimo (la ventana completa de un lanzamiento, por ejemplo),
 * así que el recorte se aplica al SINCRONIZAR, nunca a lo que se visualiza.
 *
 * Devuelve `null` si el rango entero está en el futuro (no hay nada que pedir).
 * Un rango con fechas mal formadas se devuelve intacto: validarlo es tarea de
 * quien lo consume.
 */
export function clampRangeToToday(
    start: string,
    end: string,
    today: string = colombiaToday(),
): { start: string; end: string; clamped: boolean } | null {
    if (!ISO_DATE.test(start) || !ISO_DATE.test(end)) return { start, end, clamped: false };
    if (start > today) return null;
    if (end <= today) return { start, end, clamped: false };
    return { start, end: today, clamped: true };
}
