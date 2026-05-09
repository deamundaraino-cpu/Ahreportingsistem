import { createAdminClient } from '@/utils/supabase/server'

/**
 * Re-agrega `report_utm.hourly_metrics` desde `report_utm.sales_events`
 * para una ventana de tiempo. Usa upsert: borra el bucket previo de cada
 * (cliente_id, hour, utm_source, utm_campaign) y reescribe.
 *
 * Estrategia:
 *   1. Borrar buckets afectados por la ventana.
 *   2. Recalcular agregaciones desde sales_events.
 *   3. Insert masivo.
 */
export async function aggregateHourlyMetrics(args: {
    sinceISO: string // ej: hace 24h
    untilISO?: string // default: ahora
    clienteId?: string // si se especifica, solo ese cliente
}): Promise<{ ok: true; rowsWritten: number } | { ok: false; error: string }> {
    const supabase = await createAdminClient()
    const db = supabase.schema('report_utm')

    const since = args.sinceISO
    const until = args.untilISO ?? new Date().toISOString()

    // 1) Traer eventos en ventana
    let query = db
        .from('sales_events')
        .select('cliente_id, sale_timestamp, received_at, amount, status, utm_source, utm_campaign')
        .gte('received_at', since)
        .lte('received_at', until)

    if (args.clienteId) query = query.eq('cliente_id', args.clienteId)

    const { data: events, error: eventsError } = await query
    if (eventsError) return { ok: false, error: eventsError.message }

    type Event = {
        cliente_id: string
        sale_timestamp: string | null
        received_at: string
        amount: number | string
        status: string
        utm_source: string | null
        utm_campaign: string | null
    }
    const list = (events ?? []) as Event[]

    // 2) Agrupar por (cliente_id, hour, utm_source, utm_campaign)
    type Bucket = {
        cliente_id: string
        hour: string
        utm_source: string
        utm_campaign: string
        sales_count: number
        total_revenue: number
        refunds_count: number
        refunds_amount: number
    }

    const buckets = new Map<string, Bucket>()
    const affectedRanges = new Map<string, { cliente_id: string; minHour: string; maxHour: string }>()

    for (const e of list) {
        const ts = e.sale_timestamp ?? e.received_at
        const hour = truncateToHour(ts)
        const utm_source = e.utm_source ?? ''
        const utm_campaign = e.utm_campaign ?? ''
        const amount = Number(e.amount ?? 0)
        const isApproved = e.status === 'approved'
        const isRefunded = e.status === 'refunded' || e.status === 'chargeback'

        const key = `${e.cliente_id}|${hour}|${utm_source}|${utm_campaign}`
        let b = buckets.get(key)
        if (!b) {
            b = {
                cliente_id: e.cliente_id,
                hour,
                utm_source,
                utm_campaign,
                sales_count: 0,
                total_revenue: 0,
                refunds_count: 0,
                refunds_amount: 0,
            }
            buckets.set(key, b)
        }
        if (isApproved) {
            b.sales_count += 1
            b.total_revenue += amount
        } else if (isRefunded) {
            b.refunds_count += 1
            b.refunds_amount += amount
        }

        // tracking de rango afectado por cliente
        const r = affectedRanges.get(e.cliente_id)
        if (!r) {
            affectedRanges.set(e.cliente_id, { cliente_id: e.cliente_id, minHour: hour, maxHour: hour })
        } else {
            if (hour < r.minHour) r.minHour = hour
            if (hour > r.maxHour) r.maxHour = hour
        }
    }

    if (buckets.size === 0) {
        return { ok: true, rowsWritten: 0 }
    }

    // 3) Borrar buckets en rango por cliente para evitar duplicados
    for (const r of affectedRanges.values()) {
        const { error: delError } = await db
            .from('hourly_metrics')
            .delete()
            .eq('cliente_id', r.cliente_id)
            .gte('hour', r.minHour)
            .lte('hour', r.maxHour)
        if (delError) return { ok: false, error: `delete failed: ${delError.message}` }
    }

    // 4) Insert
    const rows = Array.from(buckets.values()).map((b) => ({
        cliente_id: b.cliente_id,
        hour: b.hour,
        utm_source: b.utm_source,
        utm_campaign: b.utm_campaign,
        sales_count: b.sales_count,
        total_revenue: b.total_revenue,
        refunds_count: b.refunds_count,
        refunds_amount: b.refunds_amount,
    }))

    const { error: insertError } = await db.from('hourly_metrics').insert(rows)
    if (insertError) return { ok: false, error: `insert failed: ${insertError.message}` }

    return { ok: true, rowsWritten: rows.length }
}

function truncateToHour(iso: string): string {
    const d = new Date(iso)
    d.setUTCMinutes(0, 0, 0)
    return d.toISOString()
}
