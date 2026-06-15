import type { SupabaseClient } from '@supabase/supabase-js'
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify'
import { NOTIFICATION_TYPES, type NotificationType } from '@/lib/whatsapp/types'
import { notifyUsers } from '@/lib/notifications/notify'
import type { OutboundEventType } from './outbound-emitter'

type SaleForNotification = {
    status: string
    currency: string | null
    amount: number
    product_name: string | null
    customer_name: string | null
    customer_email: string | null
}

/**
 * Envía notificaciones WhatsApp + campanita in-app tras recibir una venta.
 * Diseñado para llamarse dentro de `after()` en cada webhook route.
 */
export async function notifyOnSaleReceived(args: {
    supabaseAdmin: SupabaseClient
    trackingDb: ReturnType<SupabaseClient['schema']>
    clienteId: string
    platform: string
    parsed: SaleForNotification
    insertedId: string
    outboundType: OutboundEventType
}): Promise<void> {
    const { supabaseAdmin, trackingDb, clienteId, parsed, insertedId, outboundType } = args

    if (!NOTIFICATION_TYPES.includes(outboundType as NotificationType)) return

    try {
        const { data: rutmCliente } = await trackingDb
            .from('clientes')
            .select('public_cliente_id, nombre')
            .eq('id', clienteId)
            .maybeSingle()

        const amount = `${parsed.currency ?? ''} ${Number(parsed.amount ?? 0).toFixed(2)}`.trim()
        const label =
            outboundType === 'sale.approved' ? '✅ Venta aprobada' : '↩️ Venta reembolsada'
        const message =
            `${label} — *${rutmCliente?.nombre ?? 'Cliente'}*\n` +
            `Producto: ${parsed.product_name ?? '—'}\n` +
            `Monto: ${amount}\n` +
            `Cliente: ${parsed.customer_name ?? parsed.customer_email ?? '—'}`

        await sendWhatsAppNotification({
            db: supabaseAdmin,
            clienteId: rutmCliente?.public_cliente_id ?? null,
            notificationType: outboundType as NotificationType,
            message,
        })

        const publicClienteId = rutmCliente?.public_cliente_id ?? null
        await notifyUsers({
            db: supabaseAdmin,
            type: outboundType === 'sale.approved' ? 'sale_approved' : 'sale_refunded',
            severity: outboundType === 'sale.approved' ? 'success' : 'warning',
            clienteId: publicClienteId,
            title:
                outboundType === 'sale.approved'
                    ? `Venta aprobada — ${rutmCliente?.nombre ?? 'Cliente'}`
                    : `Venta reembolsada — ${rutmCliente?.nombre ?? 'Cliente'}`,
            message: `${parsed.product_name ?? 'Producto'} · ${amount} · ${parsed.customer_name ?? parsed.customer_email ?? '—'}`,
            link: publicClienteId ? `/dashboard/${publicClienteId}` : undefined,
            metadata: { sale_event_id: insertedId, platform: args.platform },
        })
    } catch (err) {
        console.error('[sale-notifications] notify failed', err)
    }
}
