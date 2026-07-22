// Cron: envío automático de informes BI programados.
//
// Corre UNA VEZ AL DÍA (13:00 UTC = 08:00 Colombia; el plan Hobby de Vercel no
// admite crons más frecuentes). Recorre los informes (bi_reports) con
// schedule.enabled=true, comprueba si el día de Colombia coincide con la programación
// (semanal / quincenal / mensual), calcula el último período COMPLETO y delega
// el envío + registro en el historial a `deliverReport`.
// Protegido por CRON_SECRET (mismo patrón que los demás crons).

import { NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'
import { computePeriod, matchesSchedule, type ReportFrequency } from '@/lib/report-utm/report-periods'
import { deliverReport, type DeliverReportResult } from '@/lib/report-utm/report-delivery'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Vercel Hobby corta a 60s: pedir más no alarga nada, solo desalinea los presupuestos internos.
export const maxDuration = 60

interface Schedule {
    enabled?: boolean
    frequency?: ReportFrequency
    day_of_week?: number
    day_of_month?: number
    channels?: { whatsapp?: boolean; email?: boolean }
    emails?: string[]
}

function baseUrl(request: Request): string {
    const env = process.env.NEXT_PUBLIC_APP_URL
    if (env) return env.replace(/\/$/, '')
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host')
    if (host) return `https://${host}`
    return 'https://reportes.adshouse.cloud'
}

export async function GET(request: Request) {
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // `?force=1` ignora la comprobación de hora/día (para probar a mano). El
    // dedup por período sigue activo: no reenvía un período ya entregado.
    const force = new URL(request.url).searchParams.get('force') === '1'

    const db = await createAdminClient()
    const origin = baseUrl(request)
    const now = new Date()

    const { data: reports, error } = await db
        .from('bi_reports')
        .select('id, nombre, cliente_id, schedule, schedule_last_sent_at')
        .eq('schedule->>enabled', 'true')

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const results: Array<DeliverReportResult | { id: string; skipped: string }> = []

    for (const rep of reports ?? []) {
        const schedule = (rep.schedule ?? {}) as Schedule
        if (!schedule.enabled) continue

        if (!force && !matchesSchedule(schedule, now)) {
            results.push({ id: rep.id, skipped: 'not_scheduled_now' })
            continue
        }

        const frequency: ReportFrequency = schedule.frequency ?? 'monthly'
        const period = computePeriod(frequency, now)

        const outcome = await deliverReport({
            db,
            report: { id: rep.id, nombre: rep.nombre, cliente_id: rep.cliente_id },
            origin,
            period,
            channels: schedule.channels ?? {},
            emails: schedule.emails ?? [],
        })
        results.push(outcome)
    }

    const sent = results.filter(r => !('skipped' in r && r.skipped) && !('error' in r && r.error)).length
    return NextResponse.json({ ok: true, evaluated: results.length, sent, results })
}
