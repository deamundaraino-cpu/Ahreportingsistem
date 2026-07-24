import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron-auth'
import { notifyUsers } from '@/lib/notifications/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * Healthcheck del pipeline de sincronización.
 *
 * Responde métricas de salud y, si detecta que el pipeline está "stale" (sin
 * ninguna ejecución OK reciente) o hay jobs en error, avisa a los admins por la
 * campanita. Lo consume el workflow de GitHub Actions, que falla ruidosamente
 * (email al owner + issue) cuando este endpoint reporta problemas — el objetivo
 * es que una caída del sync deje de ser invisible.
 *
 *   GET|POST /api/worker/health   (Bearer CRON_SECRET)
 */
const STALE_HOURS = 12

async function handler(request: Request) {
    const authError = requireCronAuth(request)
    if (authError) return authError
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY requerido' }, { status: 500 })
    }
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY)

    const nowMs = Date.now()
    const dosHorasAtras = new Date(nowMs - 2 * 3_600_000).toISOString()

    const [ultimoOkRes, jobsErrorRes, pendingViejosRes, ultimaMetricaRes] = await Promise.all([
        db.from('sync_runs').select('finished_at').eq('estado', 'ok')
            .order('finished_at', { ascending: false }).limit(1).maybeSingle(),
        db.from('sync_jobs').select('id').eq('estado', 'error').limit(500),
        db.from('sync_jobs').select('id').eq('estado', 'pending').lt('created_at', dosHorasAtras).limit(500),
        db.from('metricas_diarias').select('synced_at')
            .order('synced_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    ])

    const ultimoOkMs = ultimoOkRes.data?.finished_at ? new Date(ultimoOkRes.data.finished_at).getTime() : null
    const horasDesdeUltimoOk = ultimoOkMs ? (nowMs - ultimoOkMs) / 3_600_000 : null
    const jobsError = (jobsErrorRes.data ?? []).length
    const jobsPendingViejos = (pendingViejosRes.data ?? []).length
    const maxSyncedAt = ultimaMetricaRes.data?.synced_at ?? null

    const stale = horasDesdeUltimoOk === null || horasDesdeUltimoOk > STALE_HOURS

    // Aviso a admins con dedupe: como mucho una notificación cada STALE_HOURS,
    // para no spamear la campanita en cada pasada del cron.
    if (stale || jobsError > 0) {
        const { data: reciente } = await db
            .from('notifications')
            .select('id')
            .eq('type', 'sync_failed')
            .gte('created_at', new Date(nowMs - STALE_HOURS * 3_600_000).toISOString())
            .limit(1)

        if (!reciente || reciente.length === 0) {
            await notifyUsers({
                db,
                type: 'sync_failed',
                severity: 'error',
                audience: 'admins',
                title: stale
                    ? `Pipeline de sync sin ejecuciones OK en ${STALE_HOURS}h`
                    : `Jobs de sincronización en error (${jobsError})`,
                message: stale
                    ? `Última sincronización correcta: ${horasDesdeUltimoOk === null ? 'nunca registrada' : `hace ~${Math.round(horasDesdeUltimoOk)}h`}. Revisa el worker (VPS/GitHub Actions) y el CRON_SECRET.`
                    : `${jobsError} job(s) agotaron sus reintentos. Revísalo en el panel de sincronización.`,
                link: '/admin/sync',
                metadata: { stale, horasDesdeUltimoOk, jobsError, jobsPendingViejos },
            })
        }
    }

    return NextResponse.json({
        ok: true,
        stale,
        horas_desde_ultimo_ok: horasDesdeUltimoOk,
        jobs_error: jobsError,
        jobs_pending_viejos: jobsPendingViejos,
        max_synced_at: maxSyncedAt,
        umbral_horas: STALE_HOURS,
    })
}

export async function GET(request: Request) { return handler(request) }
export async function POST(request: Request) { return handler(request) }
