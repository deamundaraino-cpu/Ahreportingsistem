'use server'

import { revalidatePath } from 'next/cache'
import { reportUtmClient } from '@/lib/report-utm/client'
import { generateWebhookSecret } from '@/lib/report-utm/webhook-auth'

type ActionResult = { ok: true; secret?: string } | { ok: false; error: string }
type SimpleResult = { ok: true } | { ok: false; error: string }

export async function activateHotmartIntegrationAction(clienteId: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()
    const secret = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .upsert(
            {
                cliente_id: clienteId,
                tipo: 'hotmart',
                webhook_secret: secret,
                status: 'active',
                last_error: null,
            },
            { onConflict: 'cliente_id,tipo' },
        )

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret }
}

export async function rotateHotmartSecretAction(clienteId: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()
    const secret = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .update({ webhook_secret: secret, last_error: null })
        .eq('cliente_id', clienteId)
        .eq('tipo', 'hotmart')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret }
}

export async function setHotmartIntegrationStatusAction(
    clienteId: string,
    status: 'active' | 'inactive',
): Promise<ActionResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase
        .from('integrations')
        .update({ status })
        .eq('cliente_id', clienteId)
        .eq('tipo', 'hotmart')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

// ── Outbound webhooks ────────────────────────────────────────────

export async function createOutboundWebhookAction(
    clienteId: string,
    formData: FormData,
): Promise<ActionResult> {
    const nombre = String(formData.get('nombre') ?? '').trim()
    const url = String(formData.get('url') ?? '').trim()
    const eventTypesRaw = formData.getAll('event_types').map(String)

    if (!nombre) return { ok: false, error: 'Nombre requerido' }
    if (!url) return { ok: false, error: 'URL requerida' }
    try {
        const u = new URL(url)
        if (!['http:', 'https:'].includes(u.protocol)) {
            return { ok: false, error: 'URL debe ser http(s)' }
        }
    } catch {
        return { ok: false, error: 'URL inválida' }
    }

    const ALLOWED = new Set(['sale.approved', 'sale.pending', 'sale.refunded', 'sale.chargeback'])
    const event_types = eventTypesRaw.filter((t) => ALLOWED.has(t))
    if (event_types.length === 0) {
        return { ok: false, error: 'Elegí al menos un tipo de evento' }
    }

    const secret = generateWebhookSecret()
    const supabase = await reportUtmClient()
    const { error } = await supabase.from('outbound_webhooks').insert({
        cliente_id: clienteId,
        nombre,
        url,
        secret,
        event_types,
        enabled: true,
    })

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret }
}

export async function toggleOutboundWebhookAction(
    id: string,
    clienteId: string,
    enabled: boolean,
): Promise<SimpleResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase.from('outbound_webhooks').update({ enabled }).eq('id', id)
    if (error) return { ok: false, error: error.message }
    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

export async function deleteOutboundWebhookAction(
    id: string,
    clienteId: string,
): Promise<SimpleResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase.from('outbound_webhooks').delete().eq('id', id)
    if (error) return { ok: false, error: error.message }
    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

export async function rotateOutboundSecretAction(
    id: string,
    clienteId: string,
): Promise<ActionResult> {
    const secret = generateWebhookSecret()
    const supabase = await reportUtmClient()
    const { error } = await supabase
        .from('outbound_webhooks')
        .update({ secret })
        .eq('id', id)
    if (error) return { ok: false, error: error.message }
    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret }
}
