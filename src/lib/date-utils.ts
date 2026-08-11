// ────────────────────────────────────────────────────────────────
// Zona horaria de la operación: Colombia = America/Bogota = UTC-5 fijo.
// Los helpers viven en `colombia-date.ts` —sin dependencias, para que el worker
// self-hosted los pueda compilar junto a la cola— y se re-exportan aquí porque
// toda la app los importa desde `@/lib/date-utils`.
//
// El troceado en semanas de este módulo es aritmética de fechas de calendario en
// strings, por la misma razón que `colombia-date.ts`: mezclar instantes con
// medianoches es lo que causaba el bug del lunes documentado en
// `getWeeksInRange`.
// ────────────────────────────────────────────────────────────────
import { addDaysISO } from './colombia-date';

export {
    COLOMBIA_UTC_OFFSET_MS,
    colombiaToday,
    colombiaYesterday,
    clampRangeToToday,
    addDaysISO,
} from './colombia-date';

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/

/** Día de la semana con lunes = 0. Se lee en UTC: un `yyyy-MM-dd` no tiene zona. */
function indiceDesdeLunes(fecha: string): number {
    return (new Date(`${fecha}T00:00:00Z`).getUTCDay() + 6) % 7
}

/** `yyyy-MM-dd` que además existe en el calendario ('2026-02-31' no existe). */
function esFechaDeCalendario(fecha: string): boolean {
    if (!FECHA_ISO.test(fecha)) return false
    const t = Date.parse(`${fecha}T00:00:00Z`)
    // V8 NO devuelve NaN para '2026-02-31': lo desborda a marzo. El ida y vuelta
    // es lo único que distingue una fecha real de una imposible.
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === fecha
}

export function getMonthWeeks(year: number, month: number) {
    const primero = `${year}-${String(month).padStart(2, '0')}-01`
    const primeroSiguiente = month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`
    return getWeeksInRange(primero, addDaysISO(primeroSiguiente, -1))
}

/**
 * Trocea [start, end] en semanas de lunes a domingo, recortadas al rango.
 *
 * Aritmética de fechas de calendario, en strings. La versión anterior mezclaba
 * instantes con medianoches: `endOfWeek()` devuelve el domingo a las
 * 23:59:59.999 y `addDays(weekEnd, 1)` daba entonces el lunes a las 23:59:59.999,
 * que no es "antes de" ni "igual a" el lunes a las 00:00 con el que se comparaba.
 * Resultado: cuando el rango terminaba justo en LUNES, la última semana no se
 * emitía y ese día desaparecía de la Vista de Embudo Diaria y de la gráfica (los
 * demás días se salvaban de casualidad, porque el recorte contra `rangeEnd`
 * sustituía el instante por una medianoche limpia). 10 de los 12 presets terminan
 * en "hoy", así que cada lunes se perdía el día más reciente.
 *
 * `weekNumber` es un contador secuencial desde 1, NO la semana ISO del año.
 */
export function getWeeksInRange(startDateStr: string, endDateStr: string) {
    // Igual que antes: una entrada que no es fecha ('all', '', basura) no produce
    // semanas. Aquí además es obligatorio, porque `addDaysISO` devuelve intacto lo
    // que no reconoce y el bucle no avanzaría nunca.
    if (!esFechaDeCalendario(startDateStr) || !esFechaDeCalendario(endDateStr)) return []

    const rangeStart = startDateStr
    // Un rango invertido se colapsa a un solo día, como hacía la versión anterior.
    const rangeEnd = endDateStr < startDateStr ? startDateStr : endDateStr

    const weeks: { weekNumber: number; start: string; end: string }[] = []
    let cursor = rangeStart
    let weekIndex = 1

    while (cursor <= rangeEnd) {
        // La primera semana arranca en el rango, no en su lunes: un rango que
        // empieza a mitad de semana da una primera semana corta.
        let weekStart = weekIndex === 1 ? rangeStart : cursor
        if (weekStart < rangeStart) weekStart = rangeStart

        // Domingo de esa semana, recortado al final del rango.
        let weekEnd = addDaysISO(weekStart, 6 - indiceDesdeLunes(weekStart))
        if (weekEnd > rangeEnd) weekEnd = rangeEnd

        weeks.push({ weekNumber: weekIndex, start: weekStart, end: weekEnd })

        cursor = addDaysISO(weekEnd, 1)
        weekIndex++
    }

    return weeks
}
