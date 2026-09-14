import { NextRequest, NextResponse, after } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { verifyWebhookSignature } from '@/lib/report-utm/webhook-auth';
import { leerSecreto } from '@/lib/secretos';
import type { GhlIntegrationRow } from '@/lib/report-utm/ghl-leads';
import { registrarVentaGhl, type GhlVentaPayload } from '@/lib/report-utm/ghl-ventas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Venta cerrada en el CRM de GoHighLevel → `report_utm.sales_events`.
 *
 *   POST /api/report-utm/webhooks/ghl/venta/{clienteId}
 *
 * Se monta en GHL como un Workflow aparte del de contactos: trigger
 * «Opportunity Status Changed» (estado Won) o «Pipeline Stage Changed» a la
 * etapa que el cliente use como venta, y acción Webhook a esta URL con el MISMO
 * header `X-Rutm-Ghl-Token` que el de contactos. Ver docs/20.
 *
 * Mismo esquema que el webhook de contactos: el cuerpo es un aviso; la venta se
 * registra después de responder, releyendo el contacto para atribuirla.
 */

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clienteId: string }> }
) {
  const { clienteId } = await params;

  const declarado = Number(req.headers.get('content-length') ?? 0);
  if (declarado > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload demasiado grande' }, { status: 413 });
  }
  const rawBody = await req.text();
  if (!rawBody) return NextResponse.json({ error: 'Empty body' }, { status: 400 });
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload demasiado grande' }, { status: 413 });
  }

  let payload: GhlVentaPayload;
  try {
    payload = JSON.parse(rawBody) as GhlVentaPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const supabaseAdmin = await createAdminClient();
  const db = supabaseAdmin.schema('report_utm');
  const { data: integration, error: intError } = await db
    .from('integrations')
    .select(
      'id, cliente_id, webhook_secret, webhook_secret_enc, access_token_encrypted, config, status'
    )
    .eq('cliente_id', clienteId)
    .eq('tipo', 'gohighlevel')
    .maybeSingle();

  if (intError) return NextResponse.json({ error: 'Integration lookup failed' }, { status: 500 });
  if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 });

  const secreto = leerSecreto(integration.webhook_secret_enc, integration.webhook_secret);
  if (!secreto.valor) return NextResponse.json({ error: 'Integration not found' }, { status: 404 });
  if (integration.status === 'inactive') {
    return NextResponse.json({ error: 'Integration paused' }, { status: 403 });
  }

  const { valid, method } = verifyWebhookSignature({
    rawBody,
    secret: secreto.valor,
    signatureHeader: req.headers.get('x-rutm-ghl-signature'),
    hottokHeader: req.headers.get('x-rutm-ghl-token'),
    hottokQuery: req.nextUrl.searchParams.get('token'),
    payload,
  });
  if (!valid) return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });

  // Otra location apuntando por error a esta URL no puede meter ventas aquí.
  const config = (integration.config ?? {}) as Record<string, unknown>;
  const esperada = typeof config.location_id === 'string' ? config.location_id : null;
  const recibida = payload.location?.id ?? payload.locationId ?? null;
  if (esperada && recibida && recibida !== esperada) {
    return NextResponse.json({ ok: true, ignorado: 'location_no_coincide' }, { status: 200 });
  }

  after(async () => {
    try {
      const r = await registrarVentaGhl(supabaseAdmin, integration as GhlIntegrationRow, payload);
      if (!r.guardada) console.info('[ghl venta] no registrada', { clienteId, motivo: r.motivo });
    } catch (e) {
      console.error('[ghl venta] fallo registrando la venta', e instanceof Error ? e.message : e);
    }
  });

  return NextResponse.json({ ok: true, method }, { status: 200 });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clienteId: string }> }
) {
  const { clienteId } = await params;
  return NextResponse.json({
    ok: true,
    endpoint: 'report-utm/ghl/venta',
    cliente_id: clienteId,
    message:
      'Endpoint listo. Enviá un POST con el header X-Rutm-Ghl-Token, opportunity_id, contact_id y monetary_value.',
  });
}
