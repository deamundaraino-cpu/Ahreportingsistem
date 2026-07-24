import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron-auth'
import { runJobs } from '@/lib/sync/runner'
import { queueStats } from '@/lib/sync/queue'
import { ensurePlanDiario } from '@/lib/sync/planner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Drena la cola `sync_jobs` dentro del presupuesto de una función de Vercel.
 *
 * Es el ejecutor de RESPALDO: el principal es `sync-worker/` en el VPS, que no
 * tiene límite de tiempo. Este endpoint existe para que la sincronización siga
 * funcionando si el VPS está caído o aún no se ha desplegado, y para dar
 * respuesta inmediata cuando alguien pulsa "Sincronizar" en el dashboard.
 *
 *   GET|POST /api/worker/run-jobs   (Bearer CRON_SECRET)
 */
async function run(request: Request) {
    const authError = requireCronAuth(request)
    if (authError) return authError

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY requerido' }, { status: 500 })
    }
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY)

    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (!appUrl) {
        return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL requerido para invocar los endpoints de sync' }, { status: 500 })
    }

    // Respaldo de planning: si el VPS no encoló el plan de esta franja, lo hace
    // este drenador antes de drenar. Best-effort: un fallo aquí no debe impedir
    // que se procese lo que ya haya en la cola.
    let plan: Awaited<ReturnType<typeof ensurePlanDiario>> | { error: string } | null = null
    try {
        plan = await ensurePlanDiario(db)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[run-jobs] ensurePlanDiario falló', msg)
        plan = { error: msg }
    }

    const result = await runJobs(db, {
        appUrl,
        cronSecret: process.env.CRON_SECRET ?? '',
        workerId: `vercel-${Math.random().toString(36).slice(2, 8)}`,
        ejecutor: 'vercel',
        // Margen dentro de los 60s de Hobby: al agotarse se deja la cola para la
        // siguiente llamada (los jobs no procesados siguen en 'pending').
        budgetMs: 40_000,
        // Lease corto: si esta función muere a los 60s, el job vuelve a la cola pronto.
        leaseSeconds: 180,
        requestTimeoutMs: 55_000,
    })

    return NextResponse.json({ ok: true, plan, ...result, cola: await queueStats(db) })
}

export async function GET(request: Request) { return run(request) }
export async function POST(request: Request) { return run(request) }
