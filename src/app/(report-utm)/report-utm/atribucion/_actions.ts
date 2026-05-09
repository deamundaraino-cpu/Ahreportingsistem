'use server'

import { revalidatePath } from 'next/cache'
import { aggregateHourlyMetrics } from '@/lib/report-utm/aggregate'

export async function runAggregateNowAction(args: {
    clienteId?: string
    hours?: number
}): Promise<{ ok: true; rowsWritten: number } | { ok: false; error: string }> {
    const hours = Math.max(1, Math.min(24 * 30, args.hours ?? 24))
    const sinceISO = new Date(Date.now() - hours * 3600_000).toISOString()
    const r = await aggregateHourlyMetrics({ sinceISO, clienteId: args.clienteId })
    if (!r.ok) return r
    revalidatePath('/report-utm/atribucion')
    revalidatePath('/report-utm')
    return r
}
