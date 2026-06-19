import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createSSRClient } from '@/utils/supabase/server'
import { syncMetaLeadsForCliente, type MetaLeadsSyncSummary } from '@/lib/report-utm/meta-leads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min — el backfill puede tener muchos formularios/leads

/**
 * Polling de Meta Lead Ads → report_utm.lead_events.
 *
 *   GET  /api/cron/sync-meta-leads            (cron Vercel, todos los clientes activos)
 *   POST /api/cron/sync-meta-leads?clienteId= (trigger manual / backfill de un cliente)
 *
 * Es la red de seguridad del webhook + el backfill histórico (~90 días que
 * Meta conserva). La dedup por external_id evita duplicar leads que el webhook
 * ya haya insertado. Protegido por CRON_SECRET (mismo patrón que /api/worker).
 */

async function run(request: Request) {
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let supabase: SupabaseClient
    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
        supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY)
    } else {
        supabase = await createSSRClient()
    }
    const db = supabase.schema('report_utm')

    const onlyClienteId = new URL(request.url).searchParams.get('clienteId')

    let intQuery = db
        .from('integrations')
        .select('id, cliente_id, config, status')
        .eq('tipo', 'meta_lead_ads')
        .eq('status', 'active')
    if (onlyClienteId) intQuery = intQuery.eq('cliente_id', onlyClienteId)

    const { data: integrations, error: intError } = await intQuery
    if (intError) {
        return NextResponse.json({ error: 'Failed to list integrations' }, { status: 500 })
    }

    // Presupuesto global: cada cliente ya se autolimita; esto evita que muchos
    // clientes en backfill excedan el maxDuration del cron. Los que queden se
    // procesan en la próxima corrida (cursor intacto; el webhook cubre el realtime).
    const startedAt = Date.now()
    const CRON_BUDGET_MS = 250_000

    const results: Array<{ clienteId: string } & MetaLeadsSyncSummary> = []
    let skipped = 0
    for (const integration of integrations ?? []) {
        if (Date.now() - startedAt > CRON_BUDGET_MS) { skipped++; continue }
        const summary = await syncMetaLeadsForCliente(supabase, integration)
        results.push({ clienteId: integration.cliente_id, ...summary })
    }

    const totalImported = results.reduce((s, r) => s + (r.imported ?? 0), 0)
    return NextResponse.json({ ok: true, clientes: results.length, skipped, imported: totalImported, results })
}

export async function GET(request: Request) {
    return run(request)
}

export async function POST(request: Request) {
    return run(request)
}
