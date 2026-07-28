/**
 * Cola de sincronización sobre Postgres (`public.sync_jobs`).
 *
 * Es la pieza que permite sincronizar rangos largos sin depender de una única
 * invocación larga: el trabajo se trocea, cada unidad persiste su cursor y
 * `claimJob` usa FOR UPDATE SKIP LOCKED para que dos ejecutores (el worker del
 * VPS y el endpoint de respaldo en Vercel) nunca tomen el mismo job.
 *
 * Sin dependencias de Next.js a propósito: el worker self-hosted importa este
 * mismo archivo.
 */

export type SyncJobTipo =
    | 'metricas'
    /**
     * LEGACY (migración 059): la integración "Google Sheets — Leads" se retiró y
     * su hoja se sincroniza por `sheets_conversiones`. El valor se conserva en el
     * tipo porque `sync_jobs` puede tener filas históricas con él.
     */
    | 'sheets_leads'
    | 'sheets_conversiones'
    | 'meta_leads'
    | 'utm_aggregate'
    | 'cierre_mes'
    /** Compara el gasto guardado contra el real de la cuenta y repara los días que divergen. */
    | 'reconciliar'

export type SyncJobEstado = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

export type SyncJob = {
    id: string
    tipo: SyncJobTipo
    cliente_id: string | null
    fecha_inicio: string | null
    fecha_fin: string | null
    params: Record<string, any>
    cursor: Record<string, any>
    estado: SyncJobEstado
    prioridad: number
    intentos: number
    max_intentos: number
    last_error: string | null
    locked_at: string | null
    locked_by: string | null
    triggered_by: string
    created_at: string
    updated_at: string
}

/** Días por job de métricas. Corto para que cada unidad quepa holgada en 60s. */
export const DEFAULT_CHUNK_DAYS = 14

export type EnqueueInput = {
    tipo: SyncJobTipo
    clienteId?: string | null
    start?: string | null
    end?: string | null
    params?: Record<string, any>
    prioridad?: number
    triggeredBy?: string
}

/**
 * Encola un job. El índice único parcial de la migración impide duplicar un
 * trabajo que ya está pendiente o corriendo, así que reencolar es inofensivo.
 */
export async function enqueueJob(db: any, input: EnqueueInput): Promise<SyncJob | null> {
    const row = {
        tipo: input.tipo,
        cliente_id: input.clienteId ?? null,
        fecha_inicio: input.start ?? null,
        fecha_fin: input.end ?? null,
        params: input.params ?? {},
        prioridad: input.prioridad ?? 5,
        triggered_by: input.triggeredBy ?? 'cron',
    }
    const { data, error } = await db
        .from('sync_jobs')
        .insert(row)
        .select()
        .maybeSingle()

    // 23505 = ya hay un job equivalente pendiente/corriendo. No es un fallo.
    if (error && (error as any).code !== '23505') throw new Error(`enqueueJob: ${error.message}`)
    return (data as SyncJob) ?? null
}

/** Trocea [start, end] en sub-rangos de `chunkDays` días (inclusive ambos extremos). */
export function splitRange(start: string, end: string, chunkDays = DEFAULT_CHUNK_DAYS): Array<{ start: string; end: string }> {
    const out: Array<{ start: string; end: string }> = []
    const DAY = 86_400_000
    let cur = Date.parse(`${start}T00:00:00Z`)
    const last = Date.parse(`${end}T00:00:00Z`)
    if (Number.isNaN(cur) || Number.isNaN(last) || cur > last) return out
    while (cur <= last) {
        const chunkEnd = Math.min(cur + (chunkDays - 1) * DAY, last)
        out.push({
            start: new Date(cur).toISOString().slice(0, 10),
            end: new Date(chunkEnd).toISOString().slice(0, 10),
        })
        cur = chunkEnd + DAY
    }
    return out
}

/**
 * Encola un rango largo como varios jobs de `chunkDays`.
 * Un sync manual de 365 días se convierte en ~27 unidades reanudables en vez de
 * una petición que muere a los 60s.
 */
export async function enqueueRange(
    db: any,
    input: EnqueueInput & { start: string; end: string; chunkDays?: number },
): Promise<number> {
    const chunks = splitRange(input.start, input.end, input.chunkDays ?? DEFAULT_CHUNK_DAYS)
    let created = 0
    for (const c of chunks) {
        const job = await enqueueJob(db, { ...input, start: c.start, end: c.end })
        if (job) created++
    }
    return created
}

/** Toma un job de la cola de forma atómica. null = cola vacía. */
export async function claimJob(db: any, worker: string, leaseSeconds = 600): Promise<SyncJob | null> {
    const { data, error } = await db.rpc('claim_sync_job', {
        p_worker: worker,
        p_lease_seconds: leaseSeconds,
    })
    if (error) throw new Error(`claimJob: ${error.message}`)
    const rows = (data ?? []) as SyncJob[]
    return rows[0] ?? null
}

/**
 * Renueva el lease de un job largo sin soltarlo, opcionalmente guardando
 * progreso. El runner actual reanuda reencolando el tramo restante, así que esto
 * es para ejecutores que procesen unidades dentro de un mismo job.
 */
export async function heartbeat(db: any, jobId: string, cursor?: Record<string, any>): Promise<void> {
    const { error } = await db
        .from('sync_jobs')
        .update({ locked_at: new Date().toISOString(), ...(cursor ? { cursor } : {}) })
        .eq('id', jobId)
    if (error) throw new Error(`heartbeat: ${error.message}`)
}

export async function completeJob(db: any, jobId: string): Promise<void> {
    const { error } = await db
        .from('sync_jobs')
        .update({ estado: 'done', locked_at: null, locked_by: null, last_error: null })
        .eq('id', jobId)
    if (error) throw new Error(`completeJob: ${error.message}`)
}

/**
 * Marca el fallo. Si quedan intentos vuelve a 'pending' (lo retomará el próximo
 * ciclo); si se agotaron queda en 'error' para que el panel lo muestre.
 * Devuelve true si el job quedó definitivamente en error.
 */
export async function failJob(db: any, job: SyncJob, message: string): Promise<boolean> {
    const exhausted = job.intentos >= job.max_intentos
    const { error } = await db
        .from('sync_jobs')
        .update({
            estado: exhausted ? 'error' : 'pending',
            last_error: message.slice(0, 2000),
            locked_at: null,
            locked_by: null,
        })
        .eq('id', job.id)
    if (error) throw new Error(`failJob: ${error.message}`)
    return exhausted
}

/** Resumen de la cola para el panel de admin. */
export async function queueStats(db: any): Promise<Record<SyncJobEstado, number>> {
    const { data, error } = await db.from('sync_jobs').select('estado')
    if (error) throw new Error(`queueStats: ${error.message}`)
    const out: Record<string, number> = { pending: 0, running: 0, done: 0, error: 0, cancelled: 0 }
    for (const r of (data ?? []) as Array<{ estado: string }>) {
        out[r.estado] = (out[r.estado] ?? 0) + 1
    }
    return out as Record<SyncJobEstado, number>
}
