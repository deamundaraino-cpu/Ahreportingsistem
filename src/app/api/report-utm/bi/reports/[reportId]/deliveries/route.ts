// Historial de entregas de un informe BI.
//
//   GET  → lista las entregas (más recientes primero) para el panel "Historial".
//   POST → genera una entrega manual del último período completo (o de un
//          período explícito) y la envía por los canales indicados.

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/utils/supabase/server'
import { computePeriod, type ReportFrequency } from '@/lib/report-utm/report-periods'
import { deliverReport } from '@/lib/report-utm/report-delivery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ reportId: string }> }

const FREQUENCIES: ReportFrequency[] = ['weekly', 'biweekly', 'monthly']

function baseUrl(req: NextRequest): string {
    const env = process.env.NEXT_PUBLIC_APP_URL
    if (env) return env.replace(/\/$/, '')
    return req.nextUrl.origin
}

export async function GET(_req: NextRequest, { params }: Params) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { reportId } = await params
    const db = await createAdminClient()
    const { data, error } = await db
        .from('bi_report_deliveries')
        .select('*')
        .eq('report_id', reportId)
        .order('sent_at', { ascending: false })
        .limit(100)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data: data ?? [] })
}

export async function POST(req: NextRequest, { params }: Params) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { reportId } = await params
    const body = await req.json().catch(() => ({}))

    const db = await createAdminClient()
    const { data: report, error } = await db
        .from('bi_reports')
        .select('id, nombre, cliente_id, schedule')
        .eq('id', reportId)
        .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const schedule = (report.schedule ?? {}) as {
        frequency?: ReportFrequency
        channels?: { whatsapp?: boolean; email?: boolean }
        emails?: string[]
    }

    // La frecuencia del cuerpo manda (permite enviar "el mes pasado" de un
    // informe configurado como semanal); si no, la del informe.
    const requested = body.frequency as ReportFrequency | undefined
    const frequency: ReportFrequency =
        requested && FREQUENCIES.includes(requested) ? requested : (schedule.frequency ?? 'monthly')

    const period = computePeriod(frequency)

    const result = await deliverReport({
        db,
        report: { id: report.id, nombre: report.nombre, cliente_id: report.cliente_id },
        origin: baseUrl(req),
        period,
        channels: body.channels ?? schedule.channels ?? {},
        emails: body.emails ?? schedule.emails ?? [],
        // Reenvío manual: si el período ya se entregó, reutiliza su link.
        force: body.force !== false,
    })

    if (result.error) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ data: result })
}
