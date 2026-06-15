/**
 * Parser para webhooks de Shopify (topic: orders/paid, orders/updated, refunds/create).
 * UTMs se extraen de note_attributes o parseando la URL de landing_site.
 */

export type ParsedShopifyEvent = {
    platform_sale_id: string
    amount: number
    currency: string
    status: 'approved' | 'pending' | 'refunded' | 'chargeback'
    sale_timestamp: string | null
    transaction_type: string | null
    product_id: string | null
    product_name: string | null
    customer_name: string | null
    customer_email: string | null
    customer_phone: string | null
    customer_country: string | null
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_content: string | null
    utm_term: string | null
    utm_id: string | null
    click_id: string | null
}

type PayloadError = { error: string }

const FINANCIAL_STATUS_MAP: Record<string, ParsedShopifyEvent['status'] | undefined> = {
    paid: 'approved',
    partially_paid: 'approved',
    refunded: 'refunded',
    partially_refunded: 'refunded',
    voided: 'refunded',
    pending: 'pending',
    authorized: 'pending',
}

function get(obj: unknown, key: string): unknown {
    if (typeof obj === 'object' && obj !== null) {
        return (obj as Record<string, unknown>)[key]
    }
    return undefined
}

function asString(v: unknown): string | null {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && !isNaN(v)) return String(v)
    return null
}

function asNumber(v: unknown): number | null {
    if (typeof v === 'number' && !isNaN(v)) return v
    if (typeof v === 'string') {
        const n = parseFloat(v)
        if (!isNaN(n)) return n
    }
    return null
}

/** Extrae UTMs de note_attributes: [{name, value}] */
function extractFromNoteAttributes(payload: unknown): Record<string, string | null> {
    const noteAttrs = get(payload, 'note_attributes')
    if (!Array.isArray(noteAttrs)) return {}

    const map: Record<string, string | null> = {}
    for (const attr of noteAttrs) {
        const name = asString(get(attr, 'name'))?.toLowerCase()
        const value = asString(get(attr, 'value'))
        if (name && value) map[name] = value
    }
    return map
}

/** Extrae UTMs del landing_site URL (Shopify lo almacena en landing_site) */
function extractFromLandingSite(payload: unknown): URLSearchParams | null {
    const landingSite = asString(get(payload, 'landing_site'))
    if (!landingSite) return null
    try {
        const url = new URL(
            landingSite.startsWith('http') ? landingSite : `https://placeholder.com${landingSite}`,
        )
        return url.searchParams
    } catch {
        return null
    }
}

export function parseShopifyPayload(payload: unknown): ParsedShopifyEvent | PayloadError {
    if (typeof payload !== 'object' || payload === null) {
        return { error: 'Payload no es un objeto' }
    }

    // ID de orden Shopify (puede ser número grande → string)
    const rawId = get(payload, 'id')
    const platform_sale_id = asString(rawId)
    if (!platform_sale_id) return { error: 'Falta id de orden' }

    // Monto y moneda
    const rawAmount = asString(get(payload, 'total_price')) ?? asString(get(payload, 'subtotal_price'))
    const amount = asNumber(rawAmount) ?? 0
    const currency = asString(get(payload, 'currency')) ?? 'USD'

    // Estado financiero
    const financialStatus = asString(get(payload, 'financial_status'))?.toLowerCase() ?? ''
    const status: ParsedShopifyEvent['status'] =
        FINANCIAL_STATUS_MAP[financialStatus] ?? 'pending'

    // Timestamp
    const sale_timestamp =
        asString(get(payload, 'processed_at')) ??
        asString(get(payload, 'created_at')) ??
        null

    // Tipo de transacción (distingue ordenes normales de reembolsos)
    const transaction_type =
        status === 'refunded'
            ? 'refund'
            : asString(get(payload, 'order_status_url'))?.includes('refund')
            ? 'refund'
            : 'principal'

    // Producto (primer line_item)
    const lineItems = get(payload, 'line_items')
    const firstItem = Array.isArray(lineItems) ? lineItems[0] : null
    const product_id = asString(get(firstItem, 'product_id')) ?? asString(get(firstItem, 'variant_id'))
    const product_name = asString(get(firstItem, 'name')) ?? asString(get(firstItem, 'title'))

    // Cliente
    const customer = get(payload, 'customer')
    const customer_email =
        asString(get(customer, 'email')) ??
        asString(get(payload, 'email')) ??
        null
    const customer_name =
        ([asString(get(customer, 'first_name')), asString(get(customer, 'last_name'))]
            .filter(Boolean)
            .join(' ') || null) ??
        asString(get(customer, 'name')) ??
        null
    const customer_phone =
        asString(get(customer, 'phone')) ??
        asString(get(get(payload, 'shipping_address'), 'phone')) ??
        null
    const customer_country =
        asString(get(get(payload, 'shipping_address'), 'country_code')) ??
        asString(get(get(payload, 'billing_address'), 'country_code')) ??
        null

    // UTMs: note_attributes primero, luego landing_site URL
    const noteAttrs = extractFromNoteAttributes(payload)
    const landingParams = extractFromLandingSite(payload)

    const utm_source =
        noteAttrs['utm_source'] ?? landingParams?.get('utm_source') ?? null
    const utm_medium =
        noteAttrs['utm_medium'] ?? landingParams?.get('utm_medium') ?? null
    const utm_campaign =
        noteAttrs['utm_campaign'] ?? landingParams?.get('utm_campaign') ?? null
    const utm_content =
        noteAttrs['utm_content'] ?? landingParams?.get('utm_content') ?? null
    const utm_term =
        noteAttrs['utm_term'] ?? landingParams?.get('utm_term') ?? null
    const utm_id =
        noteAttrs['utm_id'] ?? landingParams?.get('utm_id') ?? null

    // Click IDs: fbclid y gclid desde note_attributes o landing_site
    const click_id =
        noteAttrs['fbclid'] ??
        noteAttrs['gclid'] ??
        landingParams?.get('fbclid') ??
        landingParams?.get('gclid') ??
        null

    return {
        platform_sale_id,
        amount,
        currency,
        status,
        sale_timestamp,
        transaction_type,
        product_id,
        product_name,
        customer_name,
        customer_email,
        customer_phone,
        customer_country,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        utm_id,
        click_id,
    }
}
