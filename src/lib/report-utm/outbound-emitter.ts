import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

type EmitterDb = ReturnType<SupabaseClient['schema']>

export type OutboundEventType =
    | 'sale.approved'
    | 'sale.pending'
    | 'sale.refunded'
    | 'sale.chargeback'

export type OutboundPayload = {
    event_type: OutboundEventType
    event_id: string
    cliente_id: string
    sale: Record<string, unknown>
    attribution: {
        visitor_id: string | null
        first_touch: Record<string, unknown> | null
        last_touch: Record<string, unknown> | null
        method: string | null
    }
    emitted_at: string
}

/**
 * Dispara webhooks salientes para todos los suscriptores activos del cliente
 * que matchean el event_type. Fire-and-forget desde el caller.
 *
 * Cada delivery:
 *   - Firma HMAC-SHA256 del body con el secret del subscriber
 *   - Headers: X-Rutm-Signature, X-Rutm-Event, X-Rutm-Delivery-Id
 *   - Timeout 8s
 *   - Logguea en outbound_deliveries y bumpea counters
 */
export async function emitOutboundForSale(
    db: EmitterDb,
    args: {
        clienteId: string
        saleEventId: string
        eventType: OutboundEventType
        salePayload: Record<string, unknown>
        attribution: OutboundPayload['attribution']
    },
): Promise<{ fired: number; skipped: number }> {
    const { data: subscribers } = await db
        .from('outbound_webhooks')
        .select('id, url, secret, event_types, success_count, failure_count')
        .eq('cliente_id', args.clienteId)
        .eq('enabled', true)

    type Sub = {
        id: string
        url: string
        secret: string
        event_types: string[]
        success_count: number
        failure_count: number
    }
    const subs = (subscribers ?? []) as Sub[]
    const matching = subs.filter(
        (s) => Array.isArray(s.event_types) && s.event_types.includes(args.eventType),
    )

    if (matching.length === 0) {
        return { fired: 0, skipped: subs.length }
    }

    const payload: OutboundPayload = {
        event_type: args.eventType,
        event_id: args.saleEventId,
        cliente_id: args.clienteId,
        sale: args.salePayload,
        attribution: args.attribution,
        emitted_at: new Date().toISOString(),
    }
    const body = JSON.stringify(payload)

    await Promise.all(
        matching.map((sub) => deliverOne(db, sub, body, payload, args.saleEventId, args.eventType)),
    )

    return { fired: matching.length, skipped: subs.length - matching.length }
}

async function deliverOne(
    db: EmitterDb,
    sub: {
        id: string
        url: string
        secret: string
        success_count: number
        failure_count: number
    },
    body: string,
    payload: OutboundPayload,
    saleEventId: string,
    eventType: string,
): Promise<void> {
    const startedAt = Date.now()
    const signature = crypto.createHmac('sha256', sub.secret).update(body, 'utf8').digest('hex')

    let responseStatus: number | null = null
    let responseBody = ''
    let errorMsg: string | null = null

    try {
        const ctrl = new AbortController()
        const timeout = setTimeout(() => ctrl.abort(), 8_000)
        const res = await fetch(sub.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Rutm-Signature': signature,
                'X-Rutm-Event': eventType,
                'X-Rutm-Delivery-Id': crypto.randomBytes(8).toString('hex'),
            },
            body,
            signal: ctrl.signal,
        })
        clearTimeout(timeout)
        responseStatus = res.status
        try {
            responseBody = (await res.text()).slice(0, 2000)
        } catch {
            responseBody = ''
        }
        if (!res.ok) errorMsg = `HTTP ${res.status}`
    } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err)
    }

    const durationMs = Date.now() - startedAt
    const isOk = responseStatus !== null && responseStatus >= 200 && responseStatus < 300

    await Promise.all([
        db
            .from('outbound_webhooks')
            .update({
                last_fired_at: new Date().toISOString(),
                last_status: responseStatus,
                last_error: errorMsg,
                success_count: isOk ? sub.success_count + 1 : sub.success_count,
                failure_count: isOk ? sub.failure_count : sub.failure_count + 1,
            })
            .eq('id', sub.id),
        db.from('outbound_deliveries').insert({
            webhook_id: sub.id,
            sale_event_id: saleEventId,
            event_type: eventType,
            payload: payload as unknown as Record<string, unknown>,
            response_status: responseStatus,
            response_body: responseBody || null,
            error: errorMsg,
            duration_ms: durationMs,
        }),
    ])
}
