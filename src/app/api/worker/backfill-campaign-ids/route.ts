/**
 * One-time backfill endpoint: re-syncs the last N days for a client
 * to populate campaign_id in existing JSONB meta_campaigns records.
 *
 * Usage: GET /api/worker/backfill-campaign-ids?client_id=<uuid>&days=90
 * Requires the same CRON_SECRET authorization as the worker.
 *
 * This simply delegates to the main worker with a date range.
 * Once all clients have been backfilled, this endpoint can be removed.
 */

import { NextResponse } from 'next/server'
import { format, subDays } from 'date-fns'

export async function GET(request: Request) {
    const authHeader = request.headers.get('authorization')
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const clientId = searchParams.get('client_id')
    const days = Math.min(parseInt(searchParams.get('days') || '90'), 365)

    if (!clientId) {
        return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
    }

    const endDate = format(new Date(), 'yyyy-MM-dd')
    const startDate = format(subDays(new Date(), days), 'yyyy-MM-dd')

    // Build the worker URL with the date range
    const workerUrl = new URL('/api/worker', request.url)
    workerUrl.searchParams.set('client_id', clientId)
    workerUrl.searchParams.set('start', startDate)
    workerUrl.searchParams.set('end', endDate)

    const workerRes = await fetch(workerUrl.toString(), {
        headers: { authorization: authHeader || '' },
    })

    const result = await workerRes.json()

    return NextResponse.json({
        message: `Backfill complete for client ${clientId} (${days} days: ${startDate} → ${endDate})`,
        ...result,
    })
}
