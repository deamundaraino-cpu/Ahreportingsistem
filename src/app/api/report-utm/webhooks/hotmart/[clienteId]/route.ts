// ════════════════════════════════════════════════════════════════
// Webhook de Hotmart
// ════════════════════════════════════════════════════════════════
//
// Escribe en DOS sitios, y el reparto es deliberado:
//
//   public.hotmart_ventas     → la verdad para dinero y clasificación.
//   report_utm.sales_events   → el crudo, la atribución y el resto de pasarelas
//                               (Cartpanda, Shopify), que siguen dependiendo de
//                               esta tabla.
//
// ── Lo que se corrige respecto de la versión anterior ───────────
//  1. Eventos que NO son ventas (suscripciones, Hotmart Club) → 200, no 422.
//     Antes escribían `last_error` y la tarjeta de la integración quedaba en
//     rojo PERMANENTE aunque la ingesta funcionara.
//  2. Guarda de orden. Un PURCHASE_REFUNDED ya no machaca el importe del
//     PURCHASE_APPROVED, y un reintento tardío del APPROVED ya no resucita una
//     venta reembolsada.
//  3. Meta CAPI y Google Ads se RECLAMAN antes de enviarse. Antes se disparaban
//     sin consultar `capi_sent_at`, así que cada reintento de Hotmart (que
//     reintenta) duplicaba la conversión en ambas plataformas.
//  4. Tope de cuerpo y rate limit. No había ninguno de los dos.
//  5. El secreto del webhook se lee cifrado (y se migra al vuelo si venía en
//     claro).

import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { aEventoLegacy } from '@/lib/report-utm/hotmart-parser';
import { verifyWebhookSignature } from '@/lib/report-utm/webhook-auth';
import { applyAttributionToSale, resolveAttribution } from '@/lib/report-utm/attribution-resolver';
import { emitOutboundForSale, type OutboundEventType } from '@/lib/report-utm/outbound-emitter';
import { notifyOnSaleReceived } from '@/lib/report-utm/sale-notifications';
import { sendMetaConversionEvent } from '@/lib/report-utm/meta-capi';
import { uploadClickConversion } from '@/lib/report-utm/google-conversions';
import { decrypt } from '@/lib/report-utm/encryption';
import { cifrarSecreto, leerSecreto } from '@/lib/secretos';
import { NOTIFICATION_TYPES, type NotificationType } from '@/lib/whatsapp/types';
import { parsearWebhook } from '@/lib/hotmart/parser';
import { convertirLote } from '@/lib/hotmart/moneda';
import {
  cargarFunnels, clasificarLote, guardarVenta, publicClienteIdDe,
  reclamarEnvio, liberarEnvio,
} from '@/lib/hotmart/persistencia';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Tope de cuerpo. Un webhook 2.0.0 de Hotmart ronda 4-6 KB; 256 KB deja margen
 * de sobra y evita que un cuerpo enorme consuma memoria antes de validarse.
 */
const MAX_BODY_BYTES = 256 * 1024;

// Rate limit en memoria POR CLIENTE (no por IP: Hotmart sale de un pool de
// direcciones). En serverless cada instancia lleva su propio contador, así que
// es una mitigación, no una garantía; la defensa real contra reentregas es la
// guarda de orden de `guardar_hotmart_venta`.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 300;
const hits = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();   // techo de memoria
  return recent.length > RATE_MAX;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clienteId: string }> }
) {
  const startedAt = Date.now();
  const { clienteId } = await params;

  // 0) Tope de cuerpo y rate limit, ANTES de leer nada.
  const declarado = Number(req.headers.get('content-length') ?? 0);
  if (declarado > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload demasiado grande' }, { status: 413 });
  }
  if (rateLimited(clienteId)) {
    // 429 con Retry-After: Hotmart reintenta, así que no se pierde el evento.
    return NextResponse.json(
      { error: 'Demasiadas peticiones' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  // 1) Body crudo (lo necesitamos exacto para validar HMAC)
  const rawBody = await req.text();
  if (!rawBody) {
    return NextResponse.json({ error: 'Empty body' }, { status: 400 });
  }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload demasiado grande' }, { status: 413 });
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
    .select('id, cliente_id, webhook_secret, webhook_secret_enc, status')
    .eq('cliente_id', clienteId)
    .eq('tipo', 'hotmart')
    .maybeSingle();

  if (intError) {
    console.error('[report-utm webhook] integration lookup error', intError);
    return NextResponse.json({ error: 'Integration lookup failed' }, { status: 500 });
  }
  if (!integration) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }
  const secreto = leerSecreto(integration.webhook_secret_enc, integration.webhook_secret);
  if (!secreto.valor) {
    return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  }
  if (integration.status === 'inactive') {
    return NextResponse.json({ error: 'Integration paused' }, { status: 403 });
  }

  // Migración perezosa del secreto: se cifra la primera vez que se usa.
  if (secreto.necesitaMigracion) {
    after(async () => {
      try {
        await trackingDb
          .from('integrations')
          .update({ webhook_secret_enc: cifrarSecreto(secreto.valor), webhook_secret: null })
          .eq('id', integration.id);
      } catch (e) {
        console.error('[report-utm webhook] no se pudo cifrar el webhook_secret', e);
      }
    });
  }

  // 3) Validar firma
  const { valid, method } = verifyWebhookSignature({
    rawBody,
    secret: secreto.valor,
    signatureHeader: req.headers.get('x-hotmart-signature'),
    hottokHeader: req.headers.get('x-hotmart-hottok'),
    hottokQuery: req.nextUrl.searchParams.get('hottok'),
    payload,
  });

  if (!valid) {
    console.warn('[report-utm webhook] invalid signature', { clienteId });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // 4) Parsear con el parser compartido
  const resultado = parsearWebhook(payload);

  if (!resultado.ok && resultado.motivo === 'no_venta') {
    // 200 y a otra cosa. Son eventos legítimos de Hotmart (SUBSCRIPTION_*,
    // CLUB_*) que simplemente no traen `data.purchase`, además de cualquier
    // evento nuevo que la plataforma añada. Responder 422 y marcar la
    // integración como errónea era lo que dejaba la UI en rojo para siempre.
    return NextResponse.json(
      { ok: true, ignorado: 'evento_no_venta', evento: resultado.evento },
      { status: 200 },
    );
  }
  if (!resultado.ok) {
    // Esto sí merece registrarse: el payload es ilegible de verdad.
    await trackingDb
      .from('integrations')
      .update({ last_error: resultado.detalle })
      .eq('id', integration.id);
    return NextResponse.json({ error: resultado.detalle }, { status: 422 });
  }

  const venta = resultado.venta;

  // 5) Escribir en la tabla de hechos.
  //
  // `hotmart_ventas` cuelga de `public.clientes`, pero aquí llega el id de
  // `report_utm.clientes`: hace falta el puente. Sin él la venta no puede entrar
  // en la tabla de hechos, pero el evento NO se pierde — sigue yendo a
  // `sales_events` y el panel de salud ya reporta el puente ausente como
  // crítico.
  const publicClienteId = await publicClienteIdDe(supabaseAdmin, clienteId);
  let hotmartVentaId: string | null = null;

  if (publicClienteId) {
    try {
      const funnels = await cargarFunnels(supabaseAdmin, publicClienteId);
      clasificarLote([venta], funnels);
      await convertirLote(supabaseAdmin, [venta], venta.fecha_venta);
      const guardada = await guardarVenta(supabaseAdmin, publicClienteId, venta);
      hotmartVentaId = guardada.id;
      if (!guardada.escrita) {
        // La guarda de orden descartó el evento por ser más viejo que el
        // guardado. No es un error: es el comportamiento correcto.
        console.info('[hotmart webhook] evento descartado por orden', {
          clienteId, transaction: venta.transaction_id,
        });
      }
    } catch (e) {
      // Un fallo aquí no debe hacer que Hotmart reintent e indefinidamente: el
      // evento se sigue guardando en sales_events más abajo.
      console.error('[hotmart webhook] fallo guardando en hotmart_ventas', e);
    }
  }

  // 6) Espejo en sales_events (crudo + atribución + resto de pasarelas)
  const parsed = aEventoLegacy(venta);
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
        hotmart_venta_id: hotmartVentaId,
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

  // Enlace inverso, para poder navegar de la tabla de hechos al crudo.
  if (hotmartVentaId) {
    after(async () => {
      await supabaseAdmin
        .from('hotmart_ventas')
        .update({ sales_event_id: inserted.id })
        .eq('id', hotmartVentaId);
    });
  }

  // 7) Marcar integración como saludable
  await trackingDb
    .from('integrations')
    .update({
      status: 'active',
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', integration.id);

  // 8) Resolver atribución multi-touch (cruzar pixel_events)
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

  // 9) Emitir webhooks salientes a suscriptores del cliente (fire-and-forget)
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

  // 9b) Notificaciones WhatsApp + in-app (post-response via after())
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

  // ── Meta CAPI ─────────────────────────────────────────────────
  // Solo si la venta está aprobada Y conseguimos RECLAMAR el envío. Sin la
  // reclamación, cada reintento de Hotmart mandaba otra conversión.
  if (parsed.status === 'approved' && hotmartVentaId) {
    after(async () => {
      const reclamado = await reclamarEnvio(supabaseAdmin, hotmartVentaId, 'capi_enviado_at');
      if (!reclamado) return;   // otro proceso ya la envió
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
              // El documento fiscal ya NO viaja aquí: iba hasheado como teléfono
              // y nunca casaba con nadie.
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
            // Se libera la reclamación para poder reintentar.
            await liberarEnvio(supabaseAdmin, hotmartVentaId, 'capi_enviado_at');
          }
        } else {
          // No había integración activa: la reclamación no debe quedarse tomada.
          await liberarEnvio(supabaseAdmin, hotmartVentaId, 'capi_enviado_at');
        }
      } catch (err) {
        console.error('[hotmart webhook] Meta CAPI dispatch error', err);
        await liberarEnvio(supabaseAdmin, hotmartVentaId, 'capi_enviado_at');
      }
    });
  }

  // ── Google Ads Offline Conversions ────────────────────────────
  if (parsed.status === 'approved' && hotmartVentaId && (parsed.click_id ?? attribution.first_touch)) {
    after(async () => {
      const reclamado = await reclamarEnvio(supabaseAdmin, hotmartVentaId, 'gads_enviado_at');
      if (!reclamado) return;
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
            await liberarEnvio(supabaseAdmin, hotmartVentaId, 'gads_enviado_at');
          }
        } else {
          await liberarEnvio(supabaseAdmin, hotmartVentaId, 'gads_enviado_at');
        }
      } catch (err) {
        console.error('[hotmart webhook] Google Ads dispatch error', err);
        await liberarEnvio(supabaseAdmin, hotmartVentaId, 'gads_enviado_at');
      }
    });
  }

  return NextResponse.json(
    {
      ok: true,
      event_id: inserted.id,
      hotmart_venta_id: hotmartVentaId,
      method,
      tipo: venta.tipo,
      clasificacion_origen: venta.clasificacion_origen,
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
