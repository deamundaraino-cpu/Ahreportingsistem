/**
 * Ejecutor de la cola `sync_jobs`.
 *
 * Cada job se traduce a una llamada HTTP a los endpoints de sync que ya existen
 * en la app. Se hace así a propósito: la lógica de Meta/TikTok/Hotmart/GA4 son
 * ~2.000 líneas afinadas en `src/app/api/worker/route.ts`, y duplicarlas en el
 * worker del VPS garantizaría que las dos copias divergieran. El VPS aporta el
 * scheduler persistente y el control de la cola; el cómputo sigue viviendo en un
 * único sitio.
 *
 * Reanudación: si un job se corta por presupuesto de tiempo, la respuesta trae
 * `resumeFrom` y el runner **reencola** el tramo que falta como un job nuevo, en
 * vez de darlo por hecho. Se hace así (y no avanzando un cursor dentro del mismo
 * job) para que en el panel cada job siga representando el rango que realmente
 * cubrió. Si en cambio el proceso muere sin responder, vence el lease y el job
 * entero se reintenta: más lento, pero los upserts son idempotentes.
 */

import {
    claimJob,
    completeJob,
    failJob,
    enqueueJob,
    type SyncJob,
} from './queue'

export type RunnerOptions = {
    /** URL base de la app (ej. https://reportes.adshouse.cloud). */
    appUrl: string
    /** CRON_SECRET compartido. */
    cronSecret: string
    /** Identifica al ejecutor en `locked_by` y `sync_runs.ejecutor`. */
    workerId: string
    /** 'vercel' | 'vps' — solo para el historial. */
    ejecutor?: string
    /** Corta el bucle al superarlo (Vercel: ~45s; VPS: sin prisa). */
    budgetMs?: number
    /** Segundos de lease; pasado ese tiempo otro ejecutor puede reclamar el job. */
    leaseSeconds?: number
    /** Timeout de cada llamada HTTP a la app. */
    requestTimeoutMs?: number
}

export type RunnerResult = {
    claimed: number
    done: number
    failed: number
    requeued: number
    details: Array<{ jobId: string; tipo: string; estado: string; message?: string }>
}

/** Traduce un job a la petición HTTP que lo ejecuta. */
function buildRequest(job: SyncJob, appUrl: string): { url: string; method: 'GET' | 'POST' } {
    const base = appUrl.replace(/\/$/, '')
    const qs = new URLSearchParams()
    const start = job.fecha_inicio
    if (start) qs.set('start', start)
    if (job.fecha_fin) qs.set('end', job.fecha_fin)
    if (job.cliente_id) qs.set('client_id', job.cliente_id)
    if (job.params?.force) qs.set('force', '1')
    if (job.params?.refresh_days) qs.set('refresh_days', String(job.params.refresh_days))

    switch (job.tipo) {
        case 'metricas':
            return { url: `${base}/api/worker?${qs}`, method: 'GET' }
        case 'sheets_leads':
            return { url: `${base}/api/worker/google-sheets?${qs}`, method: 'GET' }
        case 'sheets_conversiones':
            return { url: `${base}/api/worker/google-sheets-conversiones?${qs}`, method: 'GET' }
        case 'meta_leads': {
            const p = new URLSearchParams()
            if (job.cliente_id) p.set('clienteId', job.cliente_id)
            return { url: `${base}/api/cron/sync-meta-leads?${p}`, method: 'POST' }
        }
        case 'utm_aggregate':
            return { url: `${base}/api/cron/report-utm/aggregate?${qs}`, method: 'GET' }
        case 'cierre_mes':
            return { url: `${base}/api/cron/cierre-mes?${qs}`, method: 'POST' }
        default:
            throw new Error(`Tipo de job desconocido: ${job.tipo}`)
    }
}

async function executeJob(
    job: SyncJob,
    opts: RunnerOptions,
): Promise<{ ok: boolean; partial: boolean; resumeFrom?: string | null; body: any; message?: string }> {
    const { url, method } = buildRequest(job, opts.appUrl)
    const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${opts.cronSecret}` },
        signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 120_000),
    })

    let body: any = null
    try {
        body = await res.json()
    } catch {
        body = { raw: await res.text().catch(() => '') }
    }

    if (!res.ok) {
        return { ok: false, partial: false, body, message: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}` }
    }
    return {
        ok: true,
        partial: !!body?.partial,
        resumeFrom: body?.resumeFrom ?? null,
        body,
    }
}

/** Registra la ejecución en `sync_runs` (best-effort: nunca tumba el job). */
async function recordRun(
    db: any,
    job: SyncJob,
    opts: RunnerOptions,
    startedAt: number,
    estado: 'ok' | 'partial' | 'error',
    body: any,
    error?: string,
): Promise<void> {
    try {
        const results = Array.isArray(body?.results) ? body.results : []
        const logs = Array.isArray(body?.debugLogs) ? body.debugLogs.slice(0, 200) : []
        await db.from('sync_runs').insert({
            job_id: job.id,
            tipo: job.tipo,
            cliente_id: job.cliente_id,
            fecha_inicio: job.fecha_inicio,
            fecha_fin: job.fecha_fin,
            started_at: new Date(startedAt).toISOString(),
            finished_at: new Date().toISOString(),
            duracion_ms: Date.now() - startedAt,
            estado,
            filas_escritas: results.filter((r: any) => r?.status === 'ok').length,
            filas_saltadas: results.filter((r: any) => String(r?.status ?? '').startsWith('skipped')).length,
            stats: {
                partial: !!body?.partial,
                partialClientes: body?.partialClientes ?? [],
                alerts: body?.alerts ?? null,
            },
            error: error?.slice(0, 2000) ?? null,
            logs,
            ejecutor: opts.ejecutor ?? 'vercel',
        })
    } catch {
        // El historial es observabilidad, no puede hacer fallar la sincronización.
    }
}

/**
 * Drena la cola hasta agotar el presupuesto o quedarse sin jobs.
 * Devuelve el resumen de lo procesado.
 */
export async function runJobs(db: any, opts: RunnerOptions): Promise<RunnerResult> {
    const budgetMs = opts.budgetMs ?? 45_000
    const startedLoop = Date.now()
    const result: RunnerResult = { claimed: 0, done: 0, failed: 0, requeued: 0, details: [] }

    while (Date.now() - startedLoop < budgetMs) {
        const job = await claimJob(db, opts.workerId, opts.leaseSeconds ?? 600)
        if (!job) break
        result.claimed++

        const startedAt = Date.now()
        try {
            const exec = await executeJob(job, opts)

            if (!exec.ok) {
                const exhausted = await failJob(db, job, exec.message ?? 'error desconocido')
                result.failed++
                result.details.push({ jobId: job.id, tipo: job.tipo, estado: exhausted ? 'error' : 'reintento', message: exec.message })
                await recordRun(db, job, opts, startedAt, 'error', exec.body, exec.message)
                continue
            }

            if (exec.partial && exec.resumeFrom && job.fecha_fin && exec.resumeFrom <= job.fecha_fin) {
                // Se hizo una parte: cerrar este job y encolar el resto. Sin esto el
                // rango restante se daría por sincronizado y quedaría un hueco.
                await completeJob(db, job.id)
                await enqueueJob(db, {
                    tipo: job.tipo,
                    clienteId: job.cliente_id,
                    start: exec.resumeFrom,
                    end: job.fecha_fin,
                    params: job.params,
                    prioridad: job.prioridad,
                    triggeredBy: `${job.triggered_by}:continuacion`,
                })
                result.done++
                result.requeued++
                result.details.push({ jobId: job.id, tipo: job.tipo, estado: 'parcial', message: `reanuda en ${exec.resumeFrom}` })
                await recordRun(db, job, opts, startedAt, 'partial', exec.body)
                continue
            }

            await completeJob(db, job.id)
            result.done++
            result.details.push({ jobId: job.id, tipo: job.tipo, estado: 'ok' })
            await recordRun(db, job, opts, startedAt, 'ok', exec.body)
        } catch (e: any) {
            const message = e?.message ?? String(e)
            const exhausted = await failJob(db, job, message)
            result.failed++
            result.details.push({ jobId: job.id, tipo: job.tipo, estado: exhausted ? 'error' : 'reintento', message })
            await recordRun(db, job, opts, startedAt, 'error', null, message)
        }
    }

    return result
}
