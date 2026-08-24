import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';

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

  const { error } = await db.from('pixel_events').insert({
    cliente_id: cliente.id,
    event_type: eventType,
    event_name: body.event_name ?? null,
    visitor_id: body.visitor_id ?? null,
    session_id: body.session_id ?? null,
    page_url: body.page_url ?? null,
    page_title: body.page_title ?? null,
    referrer: body.referrer ?? null,
    utm_source: body.utm_source ?? null,
    utm_medium: body.utm_medium ?? null,
    utm_campaign: body.utm_campaign ?? null,
    utm_content: body.utm_content ?? null,
    utm_term: body.utm_term ?? null,
    click_id: body.click_id ?? null,
    user_agent: req.headers.get('user-agent'),
    ip_address: ip,
    ip_country: ipCountry,
    custom_data: body.custom_data ?? null,
  });

  if (error) {
    console.error('[pixel] insert error', error);
    return NextResponse.json({ error: 'Insert failed' }, { status: 500, headers: CORS });
  }

  return NextResponse.json({ ok: true }, { headers: CORS });
}
