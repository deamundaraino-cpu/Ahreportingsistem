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

// ════════════════════════════════════════════════════════════════════════
// Consultas sobre columnas `timestamptz` (created_at de leads y ventas)
// ════════════════════════════════════════════════════════════════════════
//
// ── El bug que resuelven estos dos helpers ───────────────────────────────
// El módulo tenía dos errores distintos, los dos por la misma causa: tratar un
// instante como si fuera una fecha de calendario.
//
//  1. AGRUPAR — `String(created_at).slice(0, 10)` toma los 10 primeros
//     caracteres del ISO, que es el día **UTC**. El gasto, en cambio, se agrupa
//     por `metricas_diarias.fecha`, un DATE que el worker escribe en día
//     Colombia. Resultado: un lead de las 20:00 en Colombia es 01:00 UTC del día
//     siguiente y se comparaba contra el gasto del día equivocado.
//
//  2. RECORTAR — `.gte('created_at', dateFrom + 'T00:00:00')` manda un literal
//     SIN zona a una columna `timestamptz`. Postgres lo interpreta en la zona
//     del servidor (UTC), así que «desde el 1 de julio» significaba en realidad
//     «desde las 19:00 del 30 de junio, hora Colombia».
//
// Medido en julio 2026: **26,9% de los leads** (9.021 de 33.531) caían en un día
// distinto al correcto, con días desviados hasta ±349 leads, y 266 leads cruzaban
// incluso el borde del mes.
//
// Colombia es UTC-5 FIJO (no hay horario de verano), así que basta con desplazar
// el instante o anclar el literal con `-05:00`. Nada de esto necesita `date-fns`,
// por lo que el worker self-hosted lo puede compartir.

/** Desplazamiento fijo de Colombia en formato ISO. */
export const COLOMBIA_UTC_OFFSET = '-05:00';

/**
 * Día de calendario en hora Colombia de un instante (`timestamptz`).
 *
 * Es el reemplazo de `String(created_at).slice(0, 10)`. Acepta lo que devuelve
 * PostgREST (`2026-07-15T23:30:00+00:00`, `2026-07-15T23:30:00Z`, …) y también un
 * `yyyy-MM-dd` suelto, que se devuelve intacto: una fecha de calendario ya no
 * tiene hora que convertir, y convertirla la retrasaría un día.
 */
export function colombiaDateOf(instant: string | Date | null | undefined): string {
    if (!instant) return '';
    if (typeof instant === 'string') {
        // Ya es una fecha de calendario: no lleva hora, no hay nada que mover.
        if (ISO_DATE.test(instant)) return instant;
        const t = Date.parse(instant);
        if (Number.isNaN(t)) return instant.slice(0, 10);
        return new Date(t - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 10);
    }
    return new Date(instant.getTime() - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Límites de un rango de días de Colombia, listos para comparar contra una
 * columna `timestamptz`.
 *
 * El límite superior es EXCLUSIVO (`< día siguiente a las 00:00`) en vez del
 * `<= 23:59:59` que se usaba: con `23:59:59` se perdía cualquier fila caída en
 * ese último segundo, y con microsegundos eso ocurre de verdad.
 *
 * Se devuelven con el desplazamiento explícito para que Postgres no tenga que
 * suponer la zona.
 *
 *   colombiaRangeBounds('2026-07-01', '2026-07-31')
 *   → { gte: '2026-07-01T00:00:00-05:00', lt: '2026-08-01T00:00:00-05:00' }
 */
export function colombiaRangeBounds(
    dateFrom: string,
    dateTo: string,
): { gte: string; lt: string } {
    const siguiente = addDaysISO(dateTo, 1);
    return {
        gte: `${dateFrom}T00:00:00${COLOMBIA_UTC_OFFSET}`,
        lt: `${siguiente}T00:00:00${COLOMBIA_UTC_OFFSET}`,
    };
}

/** Suma días a un `yyyy-MM-dd`. Aritmética pura, sin zonas de por medio. */
export function addDaysISO(date: string, days: number): string {
    if (!ISO_DATE.test(date)) return date;
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
        .toISOString()
        .slice(0, 10);
}
