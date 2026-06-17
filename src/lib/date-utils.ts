import {
    startOfWeek,
    endOfWeek,
    isBefore,
    addDays,
    parseISO,
    format,
    startOfMonth,
    endOfMonth
} from 'date-fns';

// ────────────────────────────────────────────────────────────────
// Zona horaria de la operación: Colombia = America/Bogota = UTC-5
// fijo (Colombia NO usa horario de verano, así que el offset nunca
// cambia). Estos helpers convierten "ahora" a la fecha de calendario
// colombiana, para que los crons calculen el día correcto sin importar
// a qué hora (o desde qué TZ de servidor) se disparen.
// ────────────────────────────────────────────────────────────────
export const COLOMBIA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Fecha de "hoy" en hora Colombia (yyyy-MM-dd). */
export function colombiaToday(now: Date = new Date()): string {
    return new Date(now.getTime() - COLOMBIA_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** Fecha de "ayer" en hora Colombia (yyyy-MM-dd). */
export function colombiaYesterday(now: Date = new Date()): string {
    return new Date(now.getTime() - COLOMBIA_UTC_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}

export function getMonthWeeks(year: number, month: number) {
    const date = new Date(year, month - 1, 1)
    const monthStart = startOfMonth(date)
    const monthEnd = endOfMonth(date)
    return getWeeksInRange(format(monthStart, 'yyyy-MM-dd'), format(monthEnd, 'yyyy-MM-dd'))
}

export function getWeeksInRange(startDateStr: string, endDateStr: string) {
    const rangeStart = parseISO(startDateStr)
    let rangeEnd = parseISO(endDateStr)

    // Asegurarnos que rangeEnd no sea menor a rangeStart
    if (isBefore(rangeEnd, rangeStart)) {
        rangeEnd = rangeStart
    }

    let currentDate = rangeStart
    const weeks = []
    let weekIndex = 1

    while (isBefore(currentDate, rangeEnd) || currentDate.getTime() === rangeEnd.getTime()) {
        // Si estamos justo en el rango inicial, forzamos que sea el inicio de esta semana 'recortada'
        let weekStart = weekIndex === 1 ? rangeStart : startOfWeek(currentDate, { weekStartsOn: 1 })

        if (isBefore(weekStart, rangeStart)) {
            weekStart = rangeStart
        }

        let weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 })

        if (isBefore(rangeEnd, weekEnd)) {
            weekEnd = rangeEnd
        }

        weeks.push({
            weekNumber: weekIndex,
            start: format(weekStart, 'yyyy-MM-dd'),
            end: format(weekEnd, 'yyyy-MM-dd')
        })

        currentDate = addDays(weekEnd, 1)
        weekIndex++
    }

    return weeks
}
