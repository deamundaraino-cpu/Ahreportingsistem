import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { parseHotmartPayload } from '@/lib/report-utm/hotmart-parser';
import { verifyWebhookSignature } from '@/lib/report-utm/webhook-auth';
import { applyAttributionToSale, resolveAttribution } from '@/lib/report-utm/attribution-resolver';
import { emitOutboundForSale, type OutboundEventType } from '@/lib/report-utm/outbound-emitter';
import { notifyOnSaleReceived } from '@/lib/report-utm/sale-notifications';
import { sendMetaConversionEvent } from '@/lib/report-utm/meta-capi';
import { uploadClickConversion } from '@/lib/report-utm/google-conversions';
import { decrypt } from '@/lib/report-utm/encryption';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import { NOTIFICATION_TYPES, type NotificationType } from '@/lib/whatsapp/types';
import { notifyUsers } from '@/lib/notifications/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clienteId: string }> }
) {
  const startedAt = Date.now();
  const { clienteId } = await params;

  // 1) Body crudo (lo necesitamos exacto para validar HMAC)
  const rawBody = await req.text();
  if (!rawBody) {
    return NextResponse.json({ error: 'Empty body' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 2) Buscar integración Hotmart del cliente (admin client = bypass RLS)
  const supabaseAdmin = await createAdminClient();
  const trackingDb = supabaseAdmin.schema('report_utm');

  const { data: integration, error: intError } = await trackingDb
    .from('integrations')
    .select('id, cliente_id, webhook_secret, status')
    .eq('cliente_id', clienteId)
    .eq('tipo', 'hotmart')
    .maybeSingle();

  if (intError) {
    console.error('[report-utm webhook] integration lookup error', intError);
    return NextResponse.json({ error: 'Integration lookup failed' }, { status: 500 });
  }
  if (!integration || !integration.webhook_secret) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }
  if (integration.status === 'inactive') {
    return NextResponse.json({ error: 'Integration paused' }, { status: 403 });
  }

  // 3) Validar firma
  const { valid, method } = verifyWebhookSignature({
    rawBody,
    secret: integration.webhook_secret,
    signatureHeader: req.headers.get('x-hotmart-signature'),
    hottokHeader: req.headers.get('x-hotmart-hottok'),
    hottokQuery: req.nextUrl.searchParams.get('hottok'),
    payload,
  });

  if (!valid) {
    console.warn('[report-utm webhook] invalid signature', { clienteId });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // 4) Parsear payload
  const parsed = parseHotmartPayload(payload);
  if ('error' in parsed) {
    // Guardamos en la integración el último error para diagnóstico,
    // pero respondemos 422 (Hotmart no debería reintentar mal payload).
    await trackingDb
      .from('integrations')
      .update({ last_error: parsed.error })
      .eq('id', integration.id);
    return NextResponse.json({ error: parsed.error }, { status: 422 });
  }

  // 5) Insertar (UNIQUE cliente_id + platform + platform_sale_id evita dup)
  const { data: inserted, error: insertError } = await trackingDb
    .from('sales_events')
    .upsert(
      {
        cliente_id: clienteId,
        platform: 'hotmart',
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
      {
        onConflict: 'cliente_id,platform,platform_sale_id',
        ignoreDuplicates: false, // actualizamos si reaparece (refunds, etc)
      }
    )
    .select('id')
    .single();

  if (insertError) {
    console.error('[report-utm webhook] insert error', insertError);
    await trackingDb
      .from('integrations')
      .update({ last_error: insertError.message })
      .eq('id', integration.id);
    return NextResponse.json({ error: 'DB insert failed' }, { status: 500 });
  }

  // 6) Marcar integración como saludable
  await trackingDb
    .from('integrations')
    .update({
      status: 'active',
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', integration.id);

  // 7) Resolver atribución multi-touch (cruzar pixel_events)
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
  });
  await applyAttributionToSale(trackingDb, inserted.id, attribution);

  // 8) Emitir webhooks salientes a suscriptores del cliente (fire-and-forget)
  const eventTypeMap: Record<string, OutboundEventType> = {
    approved: 'sale.approved',
    pending: 'sale.pending',
    refunded: 'sale.refunded',
    chargeback: 'sale.chargeback',
  };
  const outboundType = eventTypeMap[parsed.status];
  if (outboundType) {
    emitOutboundForSale(trackingDb, {
      clienteId,
      saleEventId: inserted.id,
      eventType: outboundType,
      salePayload: {
        id: inserted.id,
        platform: 'hotmart',
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
    }).catch((err) => console.error('[report-utm webhook] outbound emit failed', err));
  }

  // 8b) Notificaciones WhatsApp + in-app + Meta CAPI (post-response via after())
  if (outboundType && NOTIFICATION_TYPES.includes(outboundType as NotificationType)) {
    after(async () => {
      await notifyOnSaleReceived({
        supabaseAdmin,
        trackingDb,
        clienteId,
        platform: 'hotmart',
        parsed,
        insertedId: inserted.id,
        outboundType,
      });
    });
  }

  // Meta CAPI: enviar Purchase si la venta es aprobada
  if (parsed.status === 'approved') {
    after(async () => {
      try {
        const { data: metaIntegration } = await trackingDb
          .from('integrations')
          .select('config, access_token_encrypted, status')
          .eq('cliente_id', clienteId)
          .eq('tipo', 'meta')
          .maybeSingle();

        if (
          metaIntegration?.status === 'active' &&
          metaIntegration.config?.pixel_id &&
          metaIntegration.access_token_encrypted
        ) {
          const accessToken = decrypt(metaIntegration.access_token_encrypted as string);
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
          });

          await trackingDb
            .from('sales_events')
            .update({
              capi_sent_at: new Date().toISOString(),
              capi_response: result as unknown as Record<string, unknown>,
            })
            .eq('id', inserted.id);

          if (!result.ok) {
            console.error('[hotmart webhook] Meta CAPI failed', result.error);
          }
        }
      } catch (err) {
        console.error('[hotmart webhook] Meta CAPI dispatch error', err);
      }
    });
  }

  // Google Ads Offline Conversions: solo si hay gclid en la atribución
  if (parsed.status === 'approved' && (parsed.click_id ?? attribution.first_touch)) {
    after(async () => {
      try {
        const { data: gadsIntegration } = await trackingDb
          .from('integrations')
          .select('config, access_token_encrypted, status')
          .eq('cliente_id', clienteId)
          .eq('tipo', 'google')
          .maybeSingle();

        const gclid = parsed.click_id ?? (attribution.first_touch as Record<string, unknown> | null)?.click_id;
        if (
          gadsIntegration?.status === 'active' &&
          gadsIntegration.config?.customer_id &&
          gadsIntegration.config?.conversion_action &&
          gadsIntegration.access_token_encrypted &&
          typeof gclid === 'string'
        ) {
          const accessToken = decrypt(gadsIntegration.access_token_encrypted as string);
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
          });

          await trackingDb
            .from('sales_events')
            .update({
              gads_sent_at: new Date().toISOString(),
              gads_response: result as unknown as Record<string, unknown>,
            })
            .eq('id', inserted.id);

          if (!result.ok) {
            console.error('[hotmart webhook] Google Ads conversion failed', result.error);
          }
        }
      } catch (err) {
        console.error('[hotmart webhook] Google Ads dispatch error', err);
      }
    });
  }

  return NextResponse.json(
    {
      ok: true,
      event_id: inserted.id,
      method,
      attribution_method: attribution.attribution_method,
      processing_ms: Date.now() - startedAt,
    },
    { status: 201 }
  );
}

// GET para health-check / verificación manual (útil al configurar Hotmart)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clienteId: string }> }
) {
  const { clienteId } = await params;
  return NextResponse.json({
    ok: true,
    endpoint: 'report-utm/hotmart',
    cliente_id: clienteId,
    message: 'Endpoint listo. Enviá un POST con el webhook firmado.',
  });
}
