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

// `colombia-date` en vez de `date-utils`: este archivo lo compila también el
// worker del VPS, que no tiene `date-fns` instalado.
import { clampRangeToToday } from '../colombia-date'

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
    /**
     * Contactos de GoHighLevel → `report_utm.lead_events`. Backfill de 90 días y
     * red de seguridad del webhook: el cursor (`dateAdded` del último visto) vive
     * en `integrations.config.sync_cursor`, no en el job.
     */
    | 'ghl_leads'
    | 'utm_aggregate'
    | 'cierre_mes'
    /** Compara el gasto guardado contra el real de la cuenta y repara los días que divergen. */
    | 'reconciliar'
    /**
     * Trae las ventas de Hotmart de un rango a `public.hotmart_ventas`.
     * Con `params.reclasificar` reescribe solo tipo/tab_id LEYENDO la tabla, sin
     * gastar una sola petición a la API.
     */
    | 'hotmart_ventas'
    /**
     * Reescanea una ventana móvil buscando reembolsos y chargebacks.
     * Hace falta un job aparte porque `sales/history` filtra por FECHA DE COMPRA:
     * un reembolso de hoy sobre una compra de hace un mes no aparece hoy.
     */
    | 'hotmart_reconciliar'

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
 * Tipos que piden datos día a día a una API externa: su rango NUNCA puede
 * incluir el futuro. Los de Sheets quedan fuera a propósito — la hoja del
 * cliente sí puede tener filas con fecha futura y ahí sí hay algo que leer.
 */
const TIPOS_SIN_FUTURO: SyncJobTipo[] = ['metricas', 'reconciliar']

/**
 * Recorta el futuro del rango de un job.
 *
 * Devuelve `null` cuando el rango entero es futuro: encolarlo garantizaba un job
 * que fallaba 3 veces y quedaba en rojo en /admin/sync sin nada que reparar.
 */
function rangoSincronizable(input: EnqueueInput): { start: string | null; end: string | null } | null {
    const start = input.start ?? null
    const end = input.end ?? null
    if (!start || !end || !TIPOS_SIN_FUTURO.includes(input.tipo)) return { start, end }
    const recortado = clampRangeToToday(start, end)
    return recortado ? { start: recortado.start, end: recortado.end } : null
}

/**
 * Encola un job. El índice único parcial de la migración impide duplicar un
 * trabajo que ya está pendiente o corriendo, así que reencolar es inofensivo.
 *
 * Devuelve `null` si no se creó nada: o era un duplicado, o el rango estaba por
 * completo en el futuro.
 */
export async function enqueueJob(db: any, input: EnqueueInput): Promise<SyncJob | null> {
    const rango = rangoSincronizable(input)
    if (!rango) return null

    const row = {
        tipo: input.tipo,
        cliente_id: input.clienteId ?? null,
        fecha_inicio: rango.start,
        fecha_fin: rango.end,
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
    // Se recorta ANTES de trocear: si no, un rango que termina en el futuro
    // generaba chunks enteramente futuros que `enqueueJob` descartaba uno a uno.
    const rango = rangoSincronizable(input)
    if (!rango || !rango.start || !rango.end) return 0

    const chunks = splitRange(rango.start, rango.end, input.chunkDays ?? DEFAULT_CHUNK_DAYS)
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

/**
 * Devuelve un job a la cola SIN gastar un intento.
 *
 * Es para cuando el job está perfectamente bien pero no toca ahora (ver
 * `clienteOcupado`). `failJob` no sirve: consumiría reintentos y acabaría
 * pintando de rojo en /admin/sync algo que nunca falló.
 */
export async function releaseJob(db: any, jobId: string): Promise<void> {
    const { error } = await db
        .from('sync_jobs')
        .update({ estado: 'pending', locked_at: null, locked_by: null })
        .eq('id', jobId)
    if (error) throw new Error(`releaseJob: ${error.message}`)
}

/**
 * ¿Hay OTRO job vivo del mismo cliente, tomado por otro ejecutor?
 *
 * `claim_sync_job` usa SKIP LOCKED, que garantiza que un job no se entrega dos
 * veces, pero NO que un cliente no se procese dos veces a la vez: el cron de
 * Vercel y el worker del VPS pueden estar corriendo rangos solapados del mismo
 * cliente (se observaron 5 corridas del mismo cliente en 3 minutos). Dos
 * corridas concurrentes sobre las mismas fechas se pisan los datos, así que la
 * segunda se devuelve a la cola y espera turno.
 *
 * Solo cuenta el lease vivo: un job 'running' con `locked_at` viejo es un
 * ejecutor muerto, y bloquear por él dejaría al cliente sin sincronizar.
 */
export async function clienteOcupado(
    db: any,
    clienteId: string | null,
    jobIdActual: string,
    worker: string,
    leaseSeconds = 600,
): Promise<boolean> {
    if (!clienteId) return false
    const vivoDesde = new Date(Date.now() - leaseSeconds * 1000).toISOString()
    const { data, error } = await db
        .from('sync_jobs')
        .select('id')
        .eq('cliente_id', clienteId)
        .eq('estado', 'running')
        .neq('id', jobIdActual)
        .neq('locked_by', worker)
        .gte('locked_at', vivoDesde)
        .limit(1)
    // Ante un error de consulta se sigue adelante: perder una sincronización es
    // peor que un solapamiento ocasional.
    if (error) return false
    return (data ?? []).length > 0
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
