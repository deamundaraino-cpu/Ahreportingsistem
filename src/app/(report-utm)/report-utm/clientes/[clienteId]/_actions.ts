'use server'

import { revalidatePath } from 'next/cache'
import { reportUtmClient, reportUtmAdminClient } from '@/lib/report-utm/client'
import { createClient } from '@/utils/supabase/server'
import { generateWebhookSecret } from '@/lib/report-utm/webhook-auth'
import { encrypt } from '@/lib/report-utm/encryption'
import { sendMetaLeadEvent } from '@/lib/report-utm/meta-capi'
import { decrypt } from '@/lib/report-utm/encryption'
import { getMetaAccountsForCliente, syncMetaLeadsForCliente, discoverAndSubscribePages } from '@/lib/report-utm/meta-leads'

type ActionResult = { ok: true; secret?: string; events_received?: number } | { ok: false; error: string }
type SimpleResult = { ok: true } | { ok: false; error: string }
type SyncResult = { ok: true; imported: number; forms: number } | { ok: false; error: string }

async function getUserRole(): Promise<string | null> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()
    return profile?.role ?? null
}

const S2S_ALLOWED_ROLES = new Set(['admin', 'trafficker'])

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

// ── CartPanda webhook ─────────────────────────────────────────────

export async function activateCartPandaIntegrationAction(clienteId: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()
    const secret = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .upsert(
            {
                cliente_id: clienteId,
                tipo: 'cartpanda',
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

export async function rotateCartPandaSecretAction(clienteId: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()
    const secret = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .update({ webhook_secret: secret, last_error: null })
        .eq('cliente_id', clienteId)
        .eq('tipo', 'cartpanda')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret }
}

export async function setCartPandaIntegrationStatusAction(
    clienteId: string,
    status: 'active' | 'inactive',
): Promise<SimpleResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase
        .from('integrations')
        .update({ status })
        .eq('cliente_id', clienteId)
        .eq('tipo', 'cartpanda')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

// ── Shopify webhook ───────────────────────────────────────────────

export async function activateShopifyIntegrationAction(clienteId: string, shopDomain: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()
    const secret = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .upsert(
            {
                cliente_id: clienteId,
                tipo: 'shopify',
                webhook_secret: secret,
                status: 'active',
                config: { shop_domain: shopDomain },
                last_error: null,
            },
            { onConflict: 'cliente_id,tipo' },
        )

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret }
}

export async function rotateShopifySecretAction(clienteId: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()
    const secret = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .update({ webhook_secret: secret, last_error: null })
        .eq('cliente_id', clienteId)
        .eq('tipo', 'shopify')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret }
}

export async function setShopifyIntegrationStatusAction(
    clienteId: string,
    status: 'active' | 'inactive',
): Promise<SimpleResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase
        .from('integrations')
        .update({ status })
        .eq('cliente_id', clienteId)
        .eq('tipo', 'shopify')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

// ── S2S (server-to-server pixel) ──────────────────────────────────

export async function activateS2SIntegrationAction(clienteId: string): Promise<ActionResult> {
    const role = await getUserRole()
    if (!role || !S2S_ALLOWED_ROLES.has(role)) return { ok: false, error: 'Sin permisos para activar S2S' }

    const supabase = await reportUtmAdminClient()
    const token = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .upsert(
            {
                cliente_id: clienteId,
                tipo: 's2s',
                s2s_token: token,
                status: 'active',
                last_error: null,
            },
            { onConflict: 'cliente_id,tipo' },
        )

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret: token }
}

export async function rotateS2STokenAction(clienteId: string): Promise<ActionResult> {
    const role = await getUserRole()
    if (!role || !S2S_ALLOWED_ROLES.has(role)) return { ok: false, error: 'Sin permisos para rotar el token S2S' }

    const supabase = await reportUtmAdminClient()
    const token = generateWebhookSecret()

    const { error } = await supabase
        .from('integrations')
        .update({ s2s_token: token, last_error: null })
        .eq('cliente_id', clienteId)
        .eq('tipo', 's2s')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true, secret: token }
}

export async function setS2SIntegrationStatusAction(
    clienteId: string,
    status: 'active' | 'inactive',
): Promise<SimpleResult> {
    const role = await getUserRole()
    if (!role || !S2S_ALLOWED_ROLES.has(role)) return { ok: false, error: 'Sin permisos para cambiar el estado S2S' }

    const supabase = await reportUtmAdminClient()
    const { error } = await supabase
        .from('integrations')
        .update({ status })
        .eq('cliente_id', clienteId)
        .eq('tipo', 's2s')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

// ── Google Ads Offline Conversions ───────────────────────────────

export async function saveGoogleAdsConfigAction(
    clienteId: string,
    args: {
        customerId: string
        conversionAction: string
        loginCustomerId: string | null
        accessToken: string | null
    },
): Promise<ActionResult> {
    const supabase = await reportUtmClient()

    const updates: Record<string, unknown> = {
        cliente_id: clienteId,
        tipo: 'google',
        status: 'active',
        last_error: null,
        config: {
            customer_id: args.customerId,
            conversion_action: args.conversionAction,
            ...(args.loginCustomerId ? { login_customer_id: args.loginCustomerId } : {}),
        },
    }

    if (args.accessToken) {
        try {
            updates['access_token_encrypted'] = encrypt(args.accessToken)
        } catch {
            return { ok: false, error: 'Error cifrando token — verificá RUTM_ENCRYPTION_KEY' }
        }
    }

    const { error } = await supabase
        .from('integrations')
        .upsert(updates, { onConflict: 'cliente_id,tipo' })

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

export async function testGoogleAdsAction(clienteId: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()

    const { data: integration } = await supabase
        .from('integrations')
        .select('config, access_token_encrypted')
        .eq('cliente_id', clienteId)
        .eq('tipo', 'google')
        .maybeSingle()

    if (!integration?.config?.customer_id) {
        return { ok: false, error: 'Configurá el Customer ID primero' }
    }
    if (!integration.access_token_encrypted) {
        return { ok: false, error: 'No hay access token guardado' }
    }

    let accessToken: string
    try {
        accessToken = decrypt(integration.access_token_encrypted as string)
    } catch {
        return { ok: false, error: 'Error descifrando token — ingresá un nuevo access token' }
    }

    // Verificar conectividad listando metadata del customer (solo GET)
    const customerId = String(integration.config.customer_id)
    const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? ''
    if (!devToken) return { ok: false, error: 'GOOGLE_ADS_DEVELOPER_TOKEN no configurado en servidor' }

    const headers: Record<string, string> = {
        'Authorization': `Bearer ${accessToken}`,
        'developer-token': devToken,
    }
    const loginCustomerId = integration.config.login_customer_id
    if (loginCustomerId) headers['login-customer-id'] = String(loginCustomerId)

    const gadsVersion = process.env.GOOGLE_ADS_API_VERSION ?? 'v18'
    const res = await fetch(
        `https://googleads.googleapis.com/${gadsVersion}/customers/${customerId}`,
        { headers },
    )
    if (!res.ok) {
        const txt = await res.text().catch(() => String(res.status))
        return { ok: false, error: `Google Ads API: ${res.status} — ${txt.slice(0, 200)}` }
    }

    return { ok: true }
}

// ── Meta Conversions API (CAPI) ───────────────────────────────────

export async function saveMetaCAPIConfigAction(
    clienteId: string,
    args: { pixelId: string; accessToken: string | null; testEventCode: string | null },
): Promise<ActionResult> {
    const supabase = await reportUtmClient()

    const updates: Record<string, unknown> = {
        cliente_id: clienteId,
        tipo: 'meta',
        status: 'active',
        last_error: null,
        config: {
            pixel_id: args.pixelId,
            ...(args.testEventCode ? { test_event_code: args.testEventCode } : {}),
        },
    }

    if (args.accessToken) {
        try {
            updates['access_token_encrypted'] = encrypt(args.accessToken)
        } catch {
            return { ok: false, error: 'Error cifrando token — verificá RUTM_ENCRYPTION_KEY' }
        }
    }

    const { error } = await supabase
        .from('integrations')
        .upsert(updates, { onConflict: 'cliente_id,tipo' })

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

export async function testMetaCAPIAction(clienteId: string): Promise<ActionResult> {
    const supabase = await reportUtmClient()

    const { data: integration } = await supabase
        .from('integrations')
        .select('config, access_token_encrypted')
        .eq('cliente_id', clienteId)
        .eq('tipo', 'meta')
        .maybeSingle()

    if (!integration?.config?.pixel_id) {
        return { ok: false, error: 'Configurá el Pixel ID primero' }
    }
    if (!integration.access_token_encrypted) {
        return { ok: false, error: 'No hay access token guardado' }
    }

    let accessToken: string
    try {
        accessToken = decrypt(integration.access_token_encrypted as string)
    } catch {
        return { ok: false, error: 'Error descifrando token — regenerá el access token' }
    }

    const result = await sendMetaLeadEvent({
        pixelId: String(integration.config.pixel_id),
        accessToken,
        customer: { email: null, phone: null, name: null, country: null },
        attribution: { visitorId: null, fbclid: null, ipAddress: null, userAgent: null },
        testEventCode: integration.config.test_event_code
            ? String(integration.config.test_event_code)
            : null,
        eventName: 'TestLead',
    })

    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, events_received: result.events_received }
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

// ── Meta Lead Ads (formularios instantáneos) ──────────────────────

export async function activateMetaLeadsAction(clienteId: string): Promise<SimpleResult> {
    const base = await createClient()
    // Precondición: el cliente debe tener Meta conectado (token + cuenta).
    const { error: metaError } = await getMetaAccountsForCliente(base, clienteId)
    if (metaError) return { ok: false, error: metaError }

    // Suscribir las Páginas al webhook leadgen (best-effort; el polling cubre si falla).
    const { pages } = await discoverAndSubscribePages(base, clienteId)

    const supabase = base.schema('report_utm')
    const { error } = await supabase
        .from('integrations')
        .upsert(
            {
                cliente_id: clienteId,
                tipo: 'meta_lead_ads',
                status: 'active',
                last_error: null,
                config: { backfill_done: false, pages },
            },
            { onConflict: 'cliente_id,tipo' },
        )

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

export async function setMetaLeadsStatusAction(
    clienteId: string,
    status: 'active' | 'inactive',
): Promise<SimpleResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase
        .from('integrations')
        .update({ status })
        .eq('cliente_id', clienteId)
        .eq('tipo', 'meta_lead_ads')

    if (error) return { ok: false, error: error.message }

    revalidatePath(`/report-utm/clientes/${clienteId}`)
    return { ok: true }
}

export async function syncMetaLeadsNowAction(clienteId: string): Promise<SyncResult> {
    const base = await createClient()
    const supabase = base.schema('report_utm')

    const { data: integration } = await supabase
        .from('integrations')
        .select('id, cliente_id, config, status')
        .eq('cliente_id', clienteId)
        .eq('tipo', 'meta_lead_ads')
        .maybeSingle()

    if (!integration) return { ok: false, error: 'Activá Meta Lead Ads primero' }

    const summary = await syncMetaLeadsForCliente(base, integration)
    revalidatePath(`/report-utm/clientes/${clienteId}`)
    if (summary.error) return { ok: false, error: summary.error }
    return { ok: true, imported: summary.imported, forms: summary.forms }
}
