import { NextRequest, NextResponse, after } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'
import crypto from 'crypto'
import { parseShopifyPayload } from '@/lib/report-utm/shopify-parser'
import { applyAttributionToSale, resolveAttribution } from '@/lib/report-utm/attribution-resolver'
import { emitOutboundForSale, type OutboundEventType } from '@/lib/report-utm/outbound-emitter'
import { notifyOnSaleReceived } from '@/lib/report-utm/sale-notifications'
import { sendMetaConversionEvent } from '@/lib/report-utm/meta-capi'
import { uploadClickConversion } from '@/lib/report-utm/google-conversions'
import { decrypt } from '@/lib/report-utm/encryption'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Shopify usa Base64(HMAC-SHA256) en lugar de hex */
function verifyShopifySignature(rawBody: string, secret: string, header: string | null): boolean {
    if (!header || !secret) return false
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header.trim()))
    } catch {
        return false
    }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ clienteId: string }> },
) {
    const startedAt = Date.now()
    const { clienteId } = await params

    const rawBody = await req.text()
    if (!rawBody) {
        return NextResponse.json({ error: 'Empty body' }, { status: 400 })
    }

    let payload: unknown
    try {
        payload = JSON.parse(rawBody)
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const supabaseAdmin = await createAdminClient()
    const trackingDb = supabaseAdmin.schema('report_utm')

    const { data: integration, error: intError } = await trackingDb
        .from('integrations')
        .select('id, cliente_id, webhook_secret, config, status')
        .eq('cliente_id', clienteId)
        .eq('tipo', 'shopify')
        .maybeSingle()

    if (intError) {
        return NextResponse.json({ error: 'Integration lookup failed' }, { status: 500 })
    }
    if (!integration || !integration.webhook_secret) {
        return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
    }
    if (integration.status === 'inactive') {
        return NextResponse.json({ error: 'Integration paused' }, { status: 403 })
    }

    // Validar shop domain si está configurado
    const shopDomain = (integration.config as Record<string, unknown>)?.shop_domain
    const incomingDomain = req.headers.get('x-shopify-shop-domain')
    if (shopDomain && incomingDomain && incomingDomain !== shopDomain) {
        console.warn('[shopify webhook] shop domain mismatch', { expected: shopDomain, got: incomingDomain, clienteId })
        return NextResponse.json({ error: 'Shop domain mismatch' }, { status: 401 })
    }

    // Validar firma HMAC-SHA256 en Base64
    const valid = verifyShopifySignature(
        rawBody,
        integration.webhook_secret,
        req.headers.get('x-shopify-hmac-sha256'),
    )
    if (!valid) {
        console.warn('[shopify webhook] invalid signature', { clienteId })
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const parsed = parseShopifyPayload(payload)
    if ('error' in parsed) {
        await trackingDb
            .from('integrations')
            .update({ last_error: parsed.error })
            .eq('id', integration.id)
        return NextResponse.json({ error: parsed.error }, { status: 422 })
    }

    const { data: inserted, error: insertError } = await trackingDb
        .from('sales_events')
        .upsert(
            {
                cliente_id: clienteId,
                platform: 'shopify',
                platform_sale_id: parsed.platform_sale_id,
                amount: parsed.amount,
                currency: parsed.currency,
                status: parsed.status,
                sale_timestamp: parsed.sale_timestamp,
                transaction_type: parsed.transaction_type,
                product_id: parsed.product_id,
                product_name: parsed.product_name,
                customer_name: parsed.customer_name,
                customer_email: parsed.customer_email,
                customer_phone: parsed.customer_phone,
                customer_country: parsed.customer_country,
                utm_source: parsed.utm_source,
                utm_medium: parsed.utm_medium,
                utm_campaign: parsed.utm_campaign,
                utm_content: parsed.utm_content,
                utm_term: parsed.utm_term,
                utm_id: parsed.utm_id,
                click_id: parsed.click_id,
                raw_payload: payload as Record<string, unknown>,
                processed_at: new Date().toISOString(),
            },
            { onConflict: 'cliente_id,platform,platform_sale_id', ignoreDuplicates: false },
        )
        .select('id')
        .single()

    if (insertError) {
        await trackingDb
            .from('integrations')
            .update({ last_error: insertError.message })
            .eq('id', integration.id)
        return NextResponse.json({ error: 'DB insert failed' }, { status: 500 })
    }

    await trackingDb
        .from('integrations')
        .update({ status: 'active', last_sync_at: new Date().toISOString(), last_error: null })
        .eq('id', integration.id)

    const attribution = await resolveAttribution(trackingDb, {
        id: inserted.id,
        cliente_id: clienteId,
        click_id: parsed.click_id,
        utm_source: parsed.utm_source,
        utm_medium: parsed.utm_medium,
        utm_campaign: parsed.utm_campaign,
        utm_content: parsed.utm_content,
        utm_term: parsed.utm_term,
        sale_timestamp: parsed.sale_timestamp,
        received_at: new Date().toISOString(),
    })
    await applyAttributionToSale(trackingDb, inserted.id, attribution)

    const eventTypeMap: Record<string, OutboundEventType> = {
        approved: 'sale.approved',
        pending: 'sale.pending',
        refunded: 'sale.refunded',
        chargeback: 'sale.chargeback',
    }
    const outboundType = eventTypeMap[parsed.status]
    if (outboundType) {
        emitOutboundForSale(trackingDb, {
            clienteId,
            saleEventId: inserted.id,
            eventType: outboundType,
            salePayload: {
                id: inserted.id,
                platform: 'shopify',
                platform_sale_id: parsed.platform_sale_id,
                amount: parsed.amount,
                currency: parsed.currency,
                status: parsed.status,
                transaction_type: parsed.transaction_type,
                product_name: parsed.product_name,
                customer_email: parsed.customer_email,
                customer_name: parsed.customer_name,
                utm_source: parsed.utm_source,
                utm_campaign: parsed.utm_campaign,
                click_id: parsed.click_id,
                sale_timestamp: parsed.sale_timestamp,
            },
            attribution: {
                visitor_id: attribution.visitor_id,
                first_touch: attribution.first_touch as unknown as Record<string, unknown> | null,
                last_touch: attribution.last_touch as unknown as Record<string, unknown> | null,
                method: attribution.attribution_method,
            },
        }).catch((err) => console.error('[shopify webhook] outbound emit failed', err))

        after(async () => {
            await notifyOnSaleReceived({
                supabaseAdmin,
                trackingDb,
                clienteId,
                platform: 'shopify',
                parsed,
                insertedId: inserted.id,
                outboundType,
            })
        })
    }

    if (parsed.status === 'approved') {
        after(async () => {
            try {
                const { data: metaIntegration } = await trackingDb
                    .from('integrations')
                    .select('config, access_token_encrypted, status')
                    .eq('cliente_id', clienteId)
                    .eq('tipo', 'meta')
                    .maybeSingle()

                if (
                    metaIntegration?.status === 'active' &&
                    metaIntegration.config?.pixel_id &&
                    metaIntegration.access_token_encrypted
                ) {
                    const accessToken = decrypt(metaIntegration.access_token_encrypted as string)
                    const result = await sendMetaConversionEvent({
                        pixelId: String(metaIntegration.config.pixel_id),
                        accessToken,
                        sale: {
                            platformSaleId: parsed.platform_sale_id,
                            amount: parsed.amount,
                            currency: parsed.currency,
                        },
                        customer: {
                            email: parsed.customer_email,
                            phone: parsed.customer_phone,
                            name: parsed.customer_name,
                            country: parsed.customer_country,
                        },
                        attribution: {
                            visitorId: attribution.visitor_id,
                            fbclid: parsed.click_id,
                            ipAddress: null,
                            userAgent: null,
                        },
                        testEventCode: metaIntegration.config.test_event_code
                            ? String(metaIntegration.config.test_event_code)
                            : null,
                    })

                    await trackingDb
                        .from('sales_events')
                        .update({
                            capi_sent_at: new Date().toISOString(),
                            capi_response: result as unknown as Record<string, unknown>,
                        })
                        .eq('id', inserted.id)

                    if (!result.ok) {
                        console.error('[shopify webhook] Meta CAPI failed', result.error)
                    }
                }
            } catch (err) {
                console.error('[shopify webhook] Meta CAPI dispatch error', err)
            }
        })
    }

    // Google Ads Offline Conversions
    if (parsed.status === 'approved' && (parsed.click_id ?? attribution.first_touch)) {
        after(async () => {
            try {
                const { data: gadsIntegration } = await trackingDb
                    .from('integrations')
                    .select('config, access_token_encrypted, status')
                    .eq('cliente_id', clienteId)
                    .eq('tipo', 'google')
                    .maybeSingle()

                const gclid = parsed.click_id ?? (attribution.first_touch as Record<string, unknown> | null)?.click_id
                if (
                    gadsIntegration?.status === 'active' &&
                    gadsIntegration.config?.customer_id &&
                    gadsIntegration.config?.conversion_action &&
                    gadsIntegration.access_token_encrypted &&
                    typeof gclid === 'string'
                ) {
                    const accessToken = decrypt(gadsIntegration.access_token_encrypted as string)
                    const result = await uploadClickConversion({
                        accessToken,
                        customerId: String(gadsIntegration.config.customer_id),
                        loginCustomerId: gadsIntegration.config.login_customer_id
                            ? String(gadsIntegration.config.login_customer_id)
                            : null,
                        conversionAction: String(gadsIntegration.config.conversion_action),
                        gclid,
                        conversionDateTime: parsed.sale_timestamp ?? new Date().toISOString(),
                        conversionValue: parsed.amount,
                        currencyCode: parsed.currency,
                    })

                    await trackingDb
                        .from('sales_events')
                        .update({
                            gads_sent_at: new Date().toISOString(),
                            gads_response: result as unknown as Record<string, unknown>,
                        })
                        .eq('id', inserted.id)

                    if (!result.ok) {
                        console.error('[shopify webhook] Google Ads conversion failed', result.error)
                    }
                }
            } catch (err) {
                console.error('[shopify webhook] Google Ads dispatch error', err)
            }
        })
    }

    return NextResponse.json(
        {
            ok: true,
            event_id: inserted.id,
            attribution_method: attribution.attribution_method,
            processing_ms: Date.now() - startedAt,
        },
        { status: 201 },
    )
}

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ clienteId: string }> },
) {
    const { clienteId } = await params
    return NextResponse.json({
        ok: true,
        endpoint: 'report-utm/shopify',
        cliente_id: clienteId,
        message: 'Endpoint listo. Enviá un POST con el webhook firmado de Shopify.',
    })
}
