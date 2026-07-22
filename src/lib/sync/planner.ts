/**
 * Planner: decide QUÉ jobs encolar y cuándo.
 *
 * Sustituye a los 9 crons de `vercel.json` (el plan Hobby solo admite 2). En vez
 * de nueve disparadores independientes, un único planner encola el plan del día
 * y el runner lo drena en el orden que marca la prioridad.
 */

import { enqueueJob, enqueueRange, type SyncJobTipo } from './queue'
import { colombiaToday, colombiaYesterday } from '../date-utils'

/** Prioridades: menor = antes. El sync manual (1) siempre adelanta al cron. */
export const PRIORIDAD = {
    manual: 1,
    intradia: 3,
    diario: 5,
    cierre: 7,
} as const

export type PlanResult = { encolados: number; detalle: Record<string, number> }

/**
 * Plan diario completo: métricas de ayer y hoy para todos los clientes activos,
 * más los workers de Sheets, leads de Meta y la agregación UTM.
 *
 * Se encola ayer Y hoy a propósito: "ayer" ya cerró en Colombia y trae las
 * cifras definitivas; "hoy" da una foto parcial para que el dashboard no
 * aparezca vacío durante la jornada.
 */
export async function planDiario(db: any, opts?: { triggeredBy?: string }): Promise<PlanResult> {
    const triggeredBy = opts?.triggeredBy ?? 'planner'
    const hoy = colombiaToday()
    const ayer = colombiaYesterday()
    const detalle: Record<string, number> = {}

    const { data: clientes, error } = await db.from('clientes').select('id')
    if (error) throw new Error(`planDiario: ${error.message}`)

    let total = 0
    for (const c of (clientes ?? []) as Array<{ id: string }>) {
        const job = await enqueueJob(db, {
            tipo: 'metricas',
            clienteId: c.id,
            start: ayer,
            end: hoy,
            prioridad: PRIORIDAD.diario,
            triggeredBy,
        })
        if (job) total++
    }
    detalle.metricas = total

    // Estos tres iteran clientes internamente: un job global por tipo basta.
    const globales: SyncJobTipo[] = ['sheets_leads', 'sheets_conversiones', 'meta_leads', 'utm_aggregate']
    for (const tipo of globales) {
        const job = await enqueueJob(db, {
            tipo,
            start: ayer,
            end: hoy,
            prioridad: PRIORIDAD.diario,
            triggeredBy,
        })
        if (job) { total++; detalle[tipo] = 1 }
    }

    return { encolados: total, detalle }
}

/**
 * Refresco intradía: solo el día en curso, para todos los clientes.
 * Barato — Meta y TikTok se piden en una llamada por rango, y un solo día de
 * Hotmart/GA4 son pocas peticiones.
 */
export async function planIntradia(db: any, opts?: { triggeredBy?: string }): Promise<PlanResult> {
    const hoy = colombiaToday()
    const { data: clientes, error } = await db.from('clientes').select('id')
    if (error) throw new Error(`planIntradia: ${error.message}`)

    let total = 0
    for (const c of (clientes ?? []) as Array<{ id: string }>) {
        const job = await enqueueJob(db, {
            tipo: 'metricas',
            clienteId: c.id,
            start: hoy,
            end: hoy,
            prioridad: PRIORIDAD.intradia,
            triggeredBy: opts?.triggeredBy ?? 'intradia',
        })
        if (job) total++
    }
    return { encolados: total, detalle: { metricas: total } }
}

/**
 * Cierre mensual: re-descarga final del mes anterior con la ventana de
 * atribución completa y congelado del período.
 *
 * Se lanza el día 7 para dar margen a la reatribución de Meta (hasta 28 días
 * para conversiones, pero la mayor parte del ajuste ocurre en la primera
 * semana). `refresh_days: 35` fuerza a re-pedir todo el mes aunque las fechas ya
 * tuvieran datos.
 */
export async function planCierreMes(db: any, periodo?: string): Promise<PlanResult> {
    const hoy = colombiaToday()
    const ref = periodo ? new Date(`${periodo}T00:00:00Z`) : new Date(`${hoy}T00:00:00Z`)
    // Mes anterior al de referencia.
    const primerDiaMesAnterior = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1))
    const ultimoDiaMesAnterior = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 0))
    const start = primerDiaMesAnterior.toISOString().slice(0, 10)
    const end = ultimoDiaMesAnterior.toISOString().slice(0, 10)

    const { data: clientes, error } = await db.from('clientes').select('id')
    if (error) throw new Error(`planCierreMes: ${error.message}`)

    let total = 0
    for (const c of (clientes ?? []) as Array<{ id: string }>) {
        // Primero la re-descarga forzada del mes...
        total += await enqueueRange(db, {
            tipo: 'metricas',
            clienteId: c.id,
            start,
            end,
            params: { force: true, refresh_days: 35 },
            prioridad: PRIORIDAD.cierre,
            triggeredBy: 'cierre_mes',
        })
        // ...y luego el congelado, que corre después por prioridad más baja.
        const job = await enqueueJob(db, {
            tipo: 'cierre_mes',
            clienteId: c.id,
            start,
            end,
            prioridad: PRIORIDAD.cierre + 1,
            triggeredBy: 'cierre_mes',
        })
        if (job) total++
    }

    return { encolados: total, detalle: { periodo: 1, rango: total } }
}

/** Borra jobs y runs viejos. Llamar una vez al día desde el planner. */
export async function limpiarHistorial(db: any, dias = 30): Promise<void> {
    const corte = new Date(Date.now() - dias * 86_400_000).toISOString()
    await db.from('sync_jobs').delete().in('estado', ['done', 'cancelled']).lt('updated_at', corte)
    await db.from('sync_runs').delete().lt('started_at', corte)
}
