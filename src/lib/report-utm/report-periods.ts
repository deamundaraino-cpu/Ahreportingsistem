// Cálculo de períodos y etiquetas para las entregas programadas de informes BI.
//
// Regla general: un informe programado SIEMPRE reporta el último período
// COMPLETO anterior al momento del envío. Así el cliente nunca recibe un
// período a medias.
//
//   weekly    → semana lunes-domingo previa      → "Semana 2 de Julio 2026"
//   biweekly  → quincena previa (1-15 / 16-fin)  → "1ra quincena de Julio 2026"
//   monthly   → mes calendario previo            → "Julio 2026"
//
// Toda la aritmética es sobre fechas civiles de Colombia (UTC-5, sin horario
// de verano). Se representa el "reloj de pared" de Bogotá desplazando el
// instante UTC y leyendo los componentes con los getters UTC.

export type ReportFrequency = 'weekly' | 'biweekly' | 'monthly'

export interface ReportPeriod {
    type: ReportFrequency
    /** Etiqueta legible para el cliente, única por año. Ej. "Semana 2 de Julio 2026". */
    label: string
    /** Inicio del período, YYYY-MM-DD (inclusive). */
    from: string
    /** Fin del período, YYYY-MM-DD (inclusive). */
    to: string
}

/** Colombia no aplica horario de verano: offset fijo. */
export const BOGOTA_OFFSET_HOURS = -5

const MONTHS = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

/** Componentes del reloj de pared de Bogotá para un instante dado. */
export interface BogotaParts {
    year: number
    /** 1-12 */
    month: number
    /** 1-31 */
    day: number
    /** 0-23 */
    hour: number
    /** 0 = domingo … 6 = sábado */
    weekday: number
}

export function bogotaParts(now: Date = new Date()): BogotaParts {
    const shifted = new Date(now.getTime() + BOGOTA_OFFSET_HOURS * 3_600_000)
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        hour: shifted.getUTCHours(),
        weekday: shifted.getUTCDay(),
    }
}

// ── Aritmética de fechas civiles (Date en UTC usado como fecha pura) ──

function civil(year: number, month: number, day: number): Date {
    return new Date(Date.UTC(year, month - 1, day))
}

function addDays(d: Date, n: number): Date {
    return new Date(d.getTime() + n * 86_400_000)
}

function fmt(d: Date): string {
    return d.toISOString().slice(0, 10)
}

export function daysInMonth(year: number, month: number): number {
    // Día 0 del mes siguiente = último día de este mes.
    return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function monthName(month: number): string {
    return MONTHS[month - 1] ?? ''
}

/**
 * Índice de la semana dentro de su mes (1-5), calculado sobre el LUNES de la
 * semana. Los lunes de un mes caen en los días d1, d1+7, … con d1 ∈ [1,7], por
 * lo que el bloque de 7 días del lunes da directamente su índice.
 */
export function weekOfMonth(monday: Date): number {
    return Math.floor((monday.getUTCDate() - 1) / 7) + 1
}

/** Lunes de la semana a la que pertenece la fecha dada. */
function mondayOf(d: Date): Date {
    const dow = d.getUTCDay()          // 0 = domingo
    const backToMonday = dow === 0 ? 6 : dow - 1
    return addDays(d, -backToMonday)
}

/**
 * Período completo inmediatamente anterior a `now` para la frecuencia dada.
 * `now` se interpreta en hora de Colombia.
 */
export function computePeriod(freq: ReportFrequency, now: Date = new Date()): ReportPeriod {
    const p = bogotaParts(now)
    const today = civil(p.year, p.month, p.day)

    if (freq === 'weekly') {
        const lastMonday = addDays(mondayOf(today), -7)
        const lastSunday = addDays(lastMonday, 6)
        const n = weekOfMonth(lastMonday)
        return {
            type: 'weekly',
            label: `Semana ${n} de ${monthName(lastMonday.getUTCMonth() + 1)} ${lastMonday.getUTCFullYear()}`,
            from: fmt(lastMonday),
            to: fmt(lastSunday),
        }
    }

    if (freq === 'biweekly') {
        if (p.day >= 16) {
            // Estamos en la 2da quincena → la última completa es la 1ra de este mes.
            return {
                type: 'biweekly',
                label: `1ra quincena de ${monthName(p.month)} ${p.year}`,
                from: fmt(civil(p.year, p.month, 1)),
                to: fmt(civil(p.year, p.month, 15)),
            }
        }
        // Estamos en la 1ra quincena → la última completa es la 2da del mes anterior.
        const prevMonth = p.month === 1 ? 12 : p.month - 1
        const prevYear = p.month === 1 ? p.year - 1 : p.year
        return {
            type: 'biweekly',
            label: `2da quincena de ${monthName(prevMonth)} ${prevYear}`,
            from: fmt(civil(prevYear, prevMonth, 16)),
            to: fmt(civil(prevYear, prevMonth, daysInMonth(prevYear, prevMonth))),
        }
    }

    // monthly
    const prevMonth = p.month === 1 ? 12 : p.month - 1
    const prevYear = p.month === 1 ? p.year - 1 : p.year
    return {
        type: 'monthly',
        label: `${monthName(prevMonth)} ${prevYear}`,
        from: fmt(civil(prevYear, prevMonth, 1)),
        to: fmt(civil(prevYear, prevMonth, daysInMonth(prevYear, prevMonth))),
    }
}

/**
 * Hora fija (reloj de Bogotá) a la que salen las entregas automáticas.
 * El plan Hobby de Vercel solo permite crons de una vez al día, así que el
 * digest corre una sola vez (13:00 UTC = 08:00 Colombia) y la hora no es
 * configurable por informe. Ver `vercel.json` → /api/cron/bi-report-digest.
 */
export const DELIVERY_HOUR = 8

/**
 * ¿Toca enviar hoy? Compara el día del reloj de Bogotá contra la configuración.
 * El cron corre una vez al día, así que basta con acertar el día.
 *
 *   weekly   → day_of_week (0-6, default 1 = lunes)
 *   biweekly → días 1 y 16 del mes (fijo)
 *   monthly  → day_of_month (1-28, default 1)
 */
export function matchesSchedule(
    schedule: { frequency?: ReportFrequency; day_of_week?: number; day_of_month?: number },
    now: Date = new Date(),
): boolean {
    const p = bogotaParts(now)

    switch (schedule.frequency) {
        case 'weekly':
            return p.weekday === clampInt(schedule.day_of_week, 0, 6, 1)
        case 'biweekly':
            return p.day === 1 || p.day === 16
        case 'monthly':
        default:
            return p.day === clampInt(schedule.day_of_month, 1, 28, 1)
    }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
    const n = typeof v === 'number' ? Math.trunc(v) : Number.NaN
    if (!Number.isFinite(n) || n < min || n > max) return fallback
    return n
}

/** Descripción corta de la programación para la UI. Ej. "Cada lunes a las 08:00". */
export function describeSchedule(schedule: {
    frequency?: ReportFrequency
    day_of_week?: number
    day_of_month?: number
}): string {
    const at = `a las ${String(DELIVERY_HOUR).padStart(2, '0')}:00`
    switch (schedule.frequency) {
        case 'weekly': {
            const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
            return `Cada ${days[clampInt(schedule.day_of_week, 0, 6, 1)]} ${at}`
        }
        case 'biweekly':
            return `Los días 1 y 16 de cada mes ${at}`
        case 'monthly':
        default:
            return `El día ${clampInt(schedule.day_of_month, 1, 28, 1)} de cada mes ${at}`
    }
}
