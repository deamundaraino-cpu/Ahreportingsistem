import crypto from 'crypto'

/**
 * Meta Conversions API (CAPI) — envío server-side de conversiones.
 *
 * Documentación: https://developers.facebook.com/docs/marketing-api/conversions-api
 */

const META_API_VERSION = process.env.META_GRAPH_API_VERSION ?? 'v19.0'

export type CAPIResult =
    | { ok: true; events_received: number; fbtrace_id: string }
    | { ok: false; error: string; code?: number }

type SendArgs = {
    pixelId: string
    accessToken: string
    sale: {
        platformSaleId: string
        amount: number
        currency: string
    }
    customer: {
        email: string | null
        phone: string | null
        name: string | null
        country: string | null
    }
    attribution: {
        visitorId: string | null
        fbclid: string | null
        ipAddress: string | null
        userAgent: string | null
    }
    testEventCode?: string | null
}

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

function hashPhone(phone: string | null): string | null {
    if (!phone) return null
    const digits = phone.replace(/\D/g, '')
    if (!digits) return null
    return sha256(digits)
}

function buildFbc(fbclid: string): string {
    // Formato requerido por Meta: fb.1.{timestamp}.{fbclid}
    return `fb.1.${Date.now()}.${fbclid}`
}

/**
 * Envía un evento Purchase a la Conversions API de Meta.
 * Solo se llama para ventas con status='approved'.
 */
export async function sendMetaConversionEvent(args: SendArgs): Promise<CAPIResult> {
    const { pixelId, accessToken, sale, customer, attribution, testEventCode } = args

    // event_id = sha256(clienteId+platform_sale_id) para deduplicación
    const eventId = crypto
        .createHash('sha256')
        .update(`${pixelId}:${sale.platformSaleId}`)
        .digest('hex')

    // Hashear PII según spec de Meta
    const userData: Record<string, unknown> = {
        external_id: attribution.visitorId ? [sha256(attribution.visitorId)] : undefined,
        em: customer.email ? [sha256(customer.email)] : undefined,
        ph: customer.phone ? [hashPhone(customer.phone)] : undefined,
        country: customer.country ? [sha256(customer.country.toLowerCase())] : undefined,
        client_ip_address: attribution.ipAddress ?? undefined,
        client_user_agent: attribution.userAgent ?? undefined,
        fbc: attribution.fbclid ? buildFbc(attribution.fbclid) : undefined,
    }

    // Nombre del cliente: dividir en fn/ln
    if (customer.name) {
        const parts = customer.name.trim().split(/\s+/)
        if (parts.length >= 2) {
            userData['fn'] = [sha256(parts[0])]
            userData['ln'] = [sha256(parts.slice(1).join(' '))]
        } else {
            userData['fn'] = [sha256(parts[0])]
        }
    }

    // Limpiar undefined
    const cleanUserData = Object.fromEntries(
        Object.entries(userData).filter(([, v]) => v !== undefined),
    )

    const body: Record<string, unknown> = {
        data: [
            {
                event_name: 'Purchase',
                event_time: Math.floor(Date.now() / 1000),
                event_id: eventId,
                action_source: 'website',
                user_data: cleanUserData,
                custom_data: {
                    currency: sale.currency,
                    value: sale.amount,
                    order_id: sale.platformSaleId,
                },
            },
        ],
    }

    if (testEventCode) {
        body['test_event_code'] = testEventCode
    }

    try {
        const url = `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })

        const json = (await res.json()) as Record<string, unknown>

        if (!res.ok) {
            const errMsg =
                (json.error as Record<string, unknown>)?.message ??
                `HTTP ${res.status}`
            return {
                ok: false,
                error: String(errMsg),
                code: (json.error as Record<string, unknown>)?.code as number | undefined,
            }
        }

        return {
            ok: true,
            events_received: Number(json.events_received ?? 0),
            fbtrace_id: String(json.fbtrace_id ?? ''),
        }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}

/**
 * Envía un evento Lead a Meta CAPI (para test de configuración).
 */
export async function sendMetaLeadEvent(args: Omit<SendArgs, 'sale'> & {
    eventName?: string
}): Promise<CAPIResult> {
    const { pixelId, accessToken, customer, attribution, testEventCode, eventName } = args

    const eventId = crypto.randomBytes(16).toString('hex')

    const userData: Record<string, unknown> = {
        em: customer.email ? [sha256(customer.email)] : undefined,
        external_id: attribution.visitorId ? [sha256(attribution.visitorId)] : undefined,
        client_ip_address: attribution.ipAddress ?? undefined,
        client_user_agent: attribution.userAgent ?? undefined,
        fbc: attribution.fbclid ? buildFbc(attribution.fbclid) : undefined,
    }
    const cleanUserData = Object.fromEntries(
        Object.entries(userData).filter(([, v]) => v !== undefined),
    )

    const body: Record<string, unknown> = {
        data: [
            {
                event_name: eventName ?? 'Lead',
                event_time: Math.floor(Date.now() / 1000),
                event_id: eventId,
                action_source: 'website',
                user_data: cleanUserData,
            },
        ],
    }
    if (testEventCode) body['test_event_code'] = testEventCode

    try {
        const url = `https://graph.facebook.com/${META_API_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        const json = (await res.json()) as Record<string, unknown>
        if (!res.ok) {
            const errMsg = (json.error as Record<string, unknown>)?.message ?? `HTTP ${res.status}`
            return { ok: false, error: String(errMsg) }
        }
        return {
            ok: true,
            events_received: Number(json.events_received ?? 0),
            fbtrace_id: String(json.fbtrace_id ?? ''),
        }
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
}
