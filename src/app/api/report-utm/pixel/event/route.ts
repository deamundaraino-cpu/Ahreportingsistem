import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { normalizarPageUrl } from '@/lib/report-utm/page-url';
import { customDataConIds, resolverCampos } from '@/lib/report-utm/s2s-captura';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Endpoint público de ingesta del pixel.
 *
 *   POST /api/report-utm/pixel/event
 *   Body: { cliente_slug, event_type, event_name?, page_url?, ... }
 *
 * CORS abierto: el script vive en el sitio del cliente, distinto dominio.
 * Validamos cliente_slug → cliente_id (no exponemos UUIDs en el frontend).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

type PixelEventPayload = {
  cliente_slug?: string;
  event_type?: string;
  event_name?: string;
  visitor_id?: string;
  session_id?: string;
  page_url?: string;
  page_title?: string;
  referrer?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  /** IDs que el pixel manda desde la v1.1 (`utm_id` y los de la entidad). */
  utm_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  click_id?: string;
  custom_data?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  let body: PixelEventPayload;
  try {
    body = (await req.json()) as PixelEventPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS });
  }

  const slug = body.cliente_slug?.trim();
  if (!slug) {
    return NextResponse.json({ error: 'cliente_slug required' }, { status: 400, headers: CORS });
  }

  const eventType = String(body.event_type ?? 'pageview').toLowerCase();
  const ALLOWED_TYPES = ['pageview', 'custom', 'click'];
  if (!ALLOWED_TYPES.includes(eventType)) {
    return NextResponse.json({ error: 'Invalid event_type' }, { status: 400, headers: CORS });
  }

  const supabase = await createAdminClient();
  const db = supabase.schema('report_utm');

  const { data: cliente } = await db
    .from('clientes')
    .select('id, status')
    .eq('slug', slug)
    .maybeSingle();

  if (!cliente) {
    return NextResponse.json({ error: 'Unknown cliente_slug' }, { status: 404, headers: CORS });
  }
  if (cliente.status !== 'active') {
    // Silenciamos en 200 para no romper el sitio del cliente
    return NextResponse.json({ ok: true, skipped: true }, { headers: CORS });
  }

  const ipHeader = req.headers.get('x-forwarded-for') ?? '';
  const ip = ipHeader.split(',')[0]?.trim() || null;
  const ipCountry = req.headers.get('x-vercel-ip-country') ?? null;

  // UTMs e IDs: primer valor no vacío entre el body y la query string de
  // page_url, leída ANTES de `normalizarPageUrl` (que recorta `utm_*`, también
  // `utm_id`). Un pixel viejo en caché no manda `utm_id` y así no se pierde.
  // Mismo criterio que el S2S (ver s2s-captura.ts).
  const c = resolverCampos({
    utm_source: body.utm_source,
    utm_medium: body.utm_medium,
    utm_campaign: body.utm_campaign,
    utm_content: body.utm_content,
    utm_term: body.utm_term,
    utm_id: body.utm_id,
    click_id: body.click_id,
    campaign_id: body.campaign_id,
    adset_id: body.adset_id,
    ad_id: body.ad_id,
    page_url: body.page_url,
  });

  const { error } = await db.from('pixel_events').insert({
    cliente_id: cliente.id,
    event_type: eventType,
    event_name: body.event_name ?? null,
    visitor_id: body.visitor_id ?? null,
    session_id: body.session_id ?? null,
    // Misma normalización que el S2S: las UTM de la query string ya van en sus
    // columnas, guardarlas otra vez dentro de la URL era el 29 % de lead_events.
    page_url: normalizarPageUrl(body.page_url),
    page_title: body.page_title ?? null,
    referrer: body.referrer ?? null,
    utm_source: c.utm_source,
    utm_medium: c.utm_medium,
    utm_campaign: c.utm_campaign,
    utm_content: c.utm_content,
    utm_term: c.utm_term,
    click_id: c.click_id,
    user_agent: req.headers.get('user-agent'),
    ip_address: ip,
    ip_country: ipCountry,
    // `pixel_events` no tiene columnas para `utm_id` ni los IDs de la entidad
    // (migraciones 013 y 026): van en custom_data, bajo `_rutm_ids`.
    custom_data: customDataConIds(body.custom_data, c),
  });

  if (error) {
    console.error('[pixel] insert error', error);
    return NextResponse.json({ error: 'Insert failed' }, { status: 500, headers: CORS });
  }

  return NextResponse.json({ ok: true }, { headers: CORS });
}
