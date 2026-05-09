/**
 * Parser tolerante de payloads de Hotmart.
 *
 * Hotmart cambia el shape entre versiones (1.x vs 2.x) y entre
 * eventos (PURCHASE_APPROVED, PURCHASE_REFUNDED, etc). Aceptamos
 * varias formas y guardamos siempre el raw_payload completo.
 */

type AnyObj = Record<string, unknown>

function get(obj: unknown, path: (string | number)[]): unknown {
    let cur: unknown = obj
    for (const k of path) {
        if (cur == null || typeof cur !== 'object') return undefined
        cur = (cur as AnyObj)[k as string]
    }
    return cur
}

function asString(v: unknown): string | null {
    if (v == null) return null
    if (typeof v === 'string') return v.trim() || null
    if (typeof v === 'number') return String(v)
    return null
}

function asNumber(v: unknown): number | null {
    if (v == null) return null
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'string') {
        const n = parseFloat(v)
        return Number.isFinite(n) ? n : null
    }
    return null
}

const STATUS_MAP: Record<string, 'approved' | 'pending' | 'refunded' | 'chargeback'> = {
    PURCHASE_APPROVED: 'approved',
    PURCHASE_COMPLETE: 'approved',
    PURCHASE_BILLET_PRINTED: 'pending',
    PURCHASE_PROTEST: 'pending',
    PURCHASE_REFUNDED: 'refunded',
    PURCHASE_CHARGEBACK: 'chargeback',
    PURCHASE_DELAYED: 'pending',
    PURCHASE_CANCELED: 'refunded',
}

export type ParsedHotmartEvent = {
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

export function parseHotmartPayload(payload: unknown): ParsedHotmartEvent | { error: string } {
    if (!payload || typeof payload !== 'object') {
        return { error: 'Payload no es un objeto' }
    }

    // Acepta v2 (data.purchase) y v1 (event.data.purchase) y formas custom
    const purchase =
        get(payload, ['data', 'purchase']) ??
        get(payload, ['event', 'data', 'purchase']) ??
        get(payload, ['purchase'])

    if (!purchase || typeof purchase !== 'object') {
        return { error: 'No se encontró data.purchase' }
    }

    const data = (get(payload, ['data']) ?? get(payload, ['event', 'data']) ?? {}) as AnyObj

    // ID de la transacción (varios nombres posibles)
    const platform_sale_id =
        asString(get(purchase, ['transaction'])) ??
        asString(get(purchase, ['id'])) ??
        asString(get(purchase, ['order_id'])) ??
        asString(get(purchase, ['order_ref']))

    if (!platform_sale_id) {
        return { error: 'No se encontró transaction id' }
    }

    // Precio
    const amount =
        asNumber(get(purchase, ['price', 'value'])) ??
        asNumber(get(purchase, ['price'])) ??
        asNumber(get(purchase, ['full_price', 'value'])) ??
        0

    const currency =
        asString(get(purchase, ['price', 'currency_value'])) ??
        asString(get(purchase, ['price', 'currency_code'])) ??
        asString(get(purchase, ['currency'])) ??
        'BRL'

    // Status del evento
    const eventName = asString(get(payload, ['event'])) ?? asString(get(payload, ['event_type'])) ?? ''
    const purchaseStatus = asString(get(purchase, ['status']))
    const status = STATUS_MAP[eventName] ?? STATUS_MAP[purchaseStatus ?? ''] ?? 'approved'

    // Timestamp
    const sale_timestamp =
        asString(get(purchase, ['approved_date'])) ??
        asString(get(purchase, ['order_date'])) ??
        asString(get(purchase, ['date'])) ??
        asString(get(payload, ['creation_date']))

    // Tipo de transacción (principal / bump / upsell / subscription)
    const isBump = Boolean(get(purchase, ['is_bump']) ?? get(purchase, ['bump']))
    const isUpsell = Boolean(get(purchase, ['is_upsell']) ?? get(purchase, ['upsell']))
    const isSub = Boolean(get(purchase, ['is_subscription']) ?? get(data, ['subscription']))
    const transaction_type = isBump ? 'bump' : isUpsell ? 'upsell' : isSub ? 'subscription' : 'principal'

    // Producto
    const product_id = asString(get(data, ['product', 'id'])) ?? asString(get(data, ['product', 'ucode']))
    const product_name = asString(get(data, ['product', 'name']))

    // Cliente
    const buyer = (get(data, ['buyer']) ?? get(payload, ['buyer'])) as AnyObj | undefined
    const customer_name = asString(buyer?.name)
    const customer_email = asString(buyer?.email)
    const customer_phone =
        asString(buyer?.checkout_phone) ?? asString(buyer?.phone) ?? asString(buyer?.document)
    const customer_country =
        asString(get(buyer, ['address', 'country'])) ?? asString(buyer?.country) ?? null

    // UTMs — Hotmart los pasa en varios sitios:
    //   purchase.tracking.* (v2),
    //   purchase.customData.* (v1),
    //   data.purchase.utm_* (custom checkouts)
    const tracking = (get(purchase, ['tracking']) ?? {}) as AnyObj
    const customData = (get(purchase, ['customData']) ?? get(purchase, ['custom_data']) ?? {}) as AnyObj

    const pickUtm = (key: string, ...altKeys: string[]): string | null => {
        const candidates = [key, ...altKeys]
        for (const k of candidates) {
            const v =
                asString(customData[k]) ??
                asString(tracking[k]) ??
                asString(get(purchase, [k])) ??
                asString(get(data, [k]))
            if (v) return v
        }
        return null
    }

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
        utm_source: pickUtm('utm_source', 'source_sck', 'src'),
        utm_medium: pickUtm('utm_medium'),
        utm_campaign: pickUtm('utm_campaign', 'source'),
        utm_content: pickUtm('utm_content', 'sck'),
        utm_term: pickUtm('utm_term'),
        utm_id: pickUtm('utm_id'),
        click_id: pickUtm('fbclid', 'gclid', 'ttclid', 'click_id', 'xcod'),
    }
}
