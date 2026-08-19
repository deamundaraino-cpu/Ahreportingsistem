import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron-auth'
import { createClient as createSSRClient } from '@/utils/supabase/server'
import {
    syncGhlLeadsForCliente,
    type GhlIntegrationRow,
    type GhlLeadsSyncSummary,
} from '@/lib/report-utm/ghl-leads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel Hobby corta a 60s. El backfill largo se hace desde el worker
// self-hosted; aquí el cursor reanudable permite avanzar por tandas.
export const maxDuration = 60

/**
 * Polling de GoHighLevel → report_utm.lead_events.
 *
 *   GET  /api/cron/sync-ghl-leads            (todas las integraciones activas)
 *   POST /api/cron/sync-ghl-leads?clienteId= (trigger manual / backfill de un cliente)
 *
 * Es la red de seguridad del webhook + el backfill de 90 días. La dedup por
 * external_id evita duplicar contactos que el webhook ya haya insertado.
 * Protegido por CRON_SECRET (mismo patrón que /api/cron/sync-meta-leads).
 */

async function run(request: Request) {
    const authError = requireCronAuth(request)
    if (authError) return authError

    let supabase: SupabaseClient
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY,
        )
    } else {
        supabase = await createSSRClient()
    }
    const db = supabase.schema('report_utm')

    const onlyClienteId = new URL(request.url).searchParams.get('clienteId')

    let intQuery = db
        .from('integrations')
        .select('id, cliente_id, access_token_encrypted, config, status')
        .eq('tipo', 'gohighlevel')
        .eq('status', 'active')
    if (onlyClienteId) intQuery = intQuery.eq('cliente_id', onlyClienteId)

    const { data: integrations, error: intError } = await intQuery
    if (intError) {
        return NextResponse.json({ error: 'Failed to list integrations' }, { status: 500 })
    }

    // Presupuesto global: cada cliente ya se autolimita; esto evita que varios
    // clientes en backfill excedan el maxDuration. Los que queden se procesan en
    // la próxima corrida (cursor intacto; el webhook cubre el tiempo real).
    const startedAt = Date.now()
    const CRON_BUDGET_MS = 45_000

    const results: Array<{ clienteId: string } & GhlLeadsSyncSummary> = []
    let skipped = 0
    for (const integration of (integrations ?? []) as GhlIntegrationRow[]) {
        if (Date.now() - startedAt > CRON_BUDGET_MS) {
            skipped++
            continue
        }
        const summary = await syncGhlLeadsForCliente(supabase, integration)
        results.push({ clienteId: integration.cliente_id, ...summary })
    }

    const totalImported = results.reduce((s, r) => s + (r.imported ?? 0), 0)
    return NextResponse.json({
        ok: true,
        clientes: results.length,
        skipped,
        imported: totalImported,
        results,
    })
}

export async function GET(request: Request) {
    return run(request)
}

export async function POST(request: Request) {
    return run(request)
}
