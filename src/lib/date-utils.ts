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
// Zona horaria de la operación: Colombia = America/Bogota = UTC-5 fijo.
// Los helpers viven en `colombia-date.ts` —sin dependencias, para que el worker
// self-hosted los pueda compilar junto a la cola— y se re-exportan aquí porque
// toda la app los importa desde `@/lib/date-utils`.
// ────────────────────────────────────────────────────────────────
export {
    COLOMBIA_UTC_OFFSET_MS,
    colombiaToday,
    colombiaYesterday,
    clampRangeToToday,
} from './colombia-date';

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
