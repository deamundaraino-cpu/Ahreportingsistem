import { createAdminClient } from '@/utils/supabase/server'

/**
 * Re-agrega `report_utm.hourly_metrics` desde `report_utm.sales_events`
 * para una ventana de tiempo.
 *
 * Estrategia:
 *   1. Detectar qué HORAS quedan afectadas por los eventos recibidos en la ventana.
 *   2. Releer TODOS los eventos cuya hora-bucket cae en esas horas (no solo los de
 *      la ventana).
 *   3. Borrar esas horas y reinsertar el agregado completo.
 *
 * El paso 2 es la corrección clave. Antes se seleccionaba por `received_at` pero
 * se agrupaba por `sale_timestamp`, y luego se borraba el rango horario ENTERO:
 * una venta antigua que llegó por webhook hace días quedaba dentro del rango
 * borrado pero fuera de la ventana consultada, así que desaparecía del agregado.
 * Los conteos e ingresos de esas horas DISMINUÍAN en cada corrida.
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
    const windowEvents = (events ?? []) as Event[]
    if (windowEvents.length === 0) return { ok: true, rowsWritten: 0 }

    // 1b) Horas afectadas por cliente (según la hora-bucket, no la de recepción).
    const affectedRanges = new Map<string, { cliente_id: string; minHour: string; maxHour: string }>()
    for (const e of windowEvents) {
        const hour = truncateToHour(e.sale_timestamp ?? e.received_at)
        const r = affectedRanges.get(e.cliente_id)
        if (!r) {
            affectedRanges.set(e.cliente_id, { cliente_id: e.cliente_id, minHour: hour, maxHour: hour })
        } else {
            if (hour < r.minHour) r.minHour = hour
            if (hour > r.maxHour) r.maxHour = hour
        }
    }

    // 1c) Releer TODOS los eventos cuya hora-bucket cae en las horas afectadas.
    // Sin esto, las ventas que llegaron en corridas anteriores desaparecen al
    // borrarse el rango horario.
    const list: Event[] = []
    for (const r of affectedRanges.values()) {
        // El bucket `maxHour` cubre hasta maxHour+59:59 → cota superior exclusiva.
        const rangeEnd = new Date(new Date(r.maxHour).getTime() + 3600_000).toISOString()
        const { data: full, error: fullError } = await db
            .from('sales_events')
            .select('cliente_id, sale_timestamp, received_at, amount, status, utm_source, utm_campaign')
            .eq('cliente_id', r.cliente_id)
            .or(
                `and(sale_timestamp.gte.${r.minHour},sale_timestamp.lt.${rangeEnd}),` +
                `and(sale_timestamp.is.null,received_at.gte.${r.minHour},received_at.lt.${rangeEnd})`
            )
        if (fullError) return { ok: false, error: `reread failed: ${fullError.message}` }
        list.push(...((full ?? []) as Event[]))
    }

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
    }

    if (buckets.size === 0) {
        return { ok: true, rowsWritten: 0 }
    }

    // 3) Borrar los buckets de las horas afectadas (ya recalculados por completo)
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
