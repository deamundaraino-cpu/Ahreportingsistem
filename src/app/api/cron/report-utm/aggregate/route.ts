import { NextRequest, NextResponse } from 'next/server'
import { authenticateCron } from '@/lib/cron-auth'
import { aggregateHourlyMetrics } from '@/lib/report-utm/aggregate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
    return handle(req)
}

export async function POST(req: NextRequest) {
    return handle(req)
}

async function handle(req: NextRequest) {
    try {
        authenticateCron(req)
    } catch (err) {
        const status = (err as { statusCode?: number }).statusCode ?? 401
        return NextResponse.json(
            { error: (err as Error).message || 'Unauthorized' },
            { status },
        )
    }

    const url = req.nextUrl
    const hours = Math.max(1, Math.min(24 * 30, parseInt(url.searchParams.get('hours') ?? '24', 10) || 24))
    const clienteId = url.searchParams.get('cliente_id') || url.searchParams.get('clienteId') || undefined

    const sinceISO = new Date(Date.now() - hours * 3600_000).toISOString()
    const result = await aggregateHourlyMetrics({ sinceISO, clienteId })

    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 })
    }
    return NextResponse.json({
        ok: true,
        window_hours: hours,
        cliente_id: clienteId ?? null,
        rows_written: result.rowsWritten,
        completed_at: new Date().toISOString(),
    })
}
