import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { verifyS2SSignature } from '@/lib/report-utm/s2s-auth';
import { aplicarExclusion, cargarReglaExclusion } from '@/lib/report-utm/lead-exclusion';
import { adaptarIds, columnasIdDisponibles, idsPublicitarios } from '@/lib/report-utm/lead-ids';
import { normalizarPageUrl } from '@/lib/report-utm/page-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Endpoint S2S (server-to-server) del pixel Report-UTM.
 *
 *   POST /api/report-utm/pixel/s2s
 *
 * Diseñado para ser llamado desde PHP/WordPress sin depender del navegador.
 * Autenticado con HMAC-SHA256: X-Rutm-S2S-Signature: <hex>
 *
 * Cuando event_type='lead': inserta SOLO en lead_events (con datos de contacto).
 * Para otros tipos: inserta en pixel_events.
 *
 * Hasta el 2026-09-21 un lead escribía además una fila gemela en `pixel_events`
 * «para no romper dashboards existentes». No había tales dashboards: las 90.401
 * filas de esa tabla eran leads (`event_name='lead'`, el 100 %), el 98,7 % tenía
 * gemela en `lead_events` con el mismo `click_id` y `page_url`, y lo único que
 * las leía —la atribución multi-touch— no resolvió nunca nada porque
 * `visitor_id` estaba a NULL en el 100 % de las filas y `sales_events` seguía
 * vacía. Eran 122 MB, el 22 % de la base.
 */

type S2SPayload = {
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
  utm_id?: string;
  /** IDs de la entidad (`{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}`). Ver lead-ids.ts. */
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  click_id?: string;
  custom_data?: Record<string, unknown>;
  // Campos específicos de leads (formularios)
  lead_name?: string;
  lead_email?: string;
  lead_phone?: string;
  form_name?: string;
  form_id?: string;
  form_plugin?: string;
  raw_fields?: Record<string, unknown>;
};

/**
 * Extrae UTMs y click IDs de la query string de una URL.
 *
 * El plugin WordPress envía siempre `page_url` (el referer, que es la landing
 * con sus UTMs), pero no manda los UTMs como campos separados. Esta función los
 * recupera de la URL como fallback. URLSearchParams ya decodifica el percent-encoding.
 */
function parseUtmsFromUrl(url: string | null | undefined) {
  if (!url) return {};
  try {
    const qs = new URL(url).searchParams;
    return {
      utm_source: qs.get('utm_source'),
      utm_medium: qs.get('utm_medium'),
      utm_campaign: qs.get('utm_campaign'),
      utm_content: qs.get('utm_content'),
      utm_term: qs.get('utm_term'),
      utm_id: qs.get('utm_id'),
      campaign_id: qs.get('campaign_id'),
      adset_id: qs.get('adset_id'),
      ad_id: qs.get('ad_id'),
      click_id: qs.get('fbclid') ?? qs.get('gclid') ?? qs.get('ttclid') ?? null,
    };
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  let body: S2SPayload;
  try {
    body = JSON.parse(rawBody) as S2SPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const slug = body.cliente_slug?.trim();
  if (!slug) {
    return NextResponse.json({ error: 'cliente_slug required' }, { status: 400 });
  }

  const eventType = String(body.event_type ?? 'custom').toLowerCase();
  const ALLOWED_TYPES = ['pageview', 'custom', 'click', 'lead'];
  if (!ALLOWED_TYPES.includes(eventType)) {
    return NextResponse.json({ error: 'Invalid event_type' }, { status: 400 });
  }

  const supabase = await createAdminClient();
  const db = supabase.schema('report_utm');

  // Buscar cliente por slug
  const { data: cliente } = await db
    .from('clientes')
    .select('id, status')
    .eq('slug', slug)
    .maybeSingle();

  if (!cliente) {
    return NextResponse.json({ error: 'Unknown cliente_slug' }, { status: 404 });
  }
  if (cliente.status !== 'active') {
    return NextResponse.json({ ok: true, skipped: true });
  }

  // Buscar integración S2S del cliente para obtener el token
  const { data: integration } = await db
    .from('integrations')
    .select('s2s_token, status')
    .eq('cliente_id', cliente.id)
    .eq('tipo', 's2s')
    .maybeSingle();

  if (!integration || !integration.s2s_token) {
    return NextResponse.json({ error: 'S2S integration not configured' }, { status: 403 });
  }
  if (integration.status !== 'active') {
    return NextResponse.json({ error: 'S2S integration is inactive' }, { status: 403 });
  }

  // Verificar firma HMAC
  const signatureHeader = req.headers.get('x-rutm-s2s-signature');
  const valid = verifyS2SSignature(rawBody, integration.s2s_token, signatureHeader);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const ipHeader = req.headers.get('x-forwarded-for') ?? '';
  const ip = ipHeader.split(',')[0]?.trim() || null;
  const ipCountry = req.headers.get('x-vercel-ip-country') ?? null;
  const userAgent = req.headers.get('user-agent') ?? null;

  // UTMs efectivos: lo que mande el body explícitamente tiene prioridad;
  // si no, se recuperan de la query string de page_url (caso WordPress).
  const urlUtms = parseUtmsFromUrl(body.page_url);
  const utm = {
    utm_source: body.utm_source ?? urlUtms.utm_source ?? null,
    utm_medium: body.utm_medium ?? urlUtms.utm_medium ?? null,
    utm_campaign: body.utm_campaign ?? urlUtms.utm_campaign ?? null,
    utm_content: body.utm_content ?? urlUtms.utm_content ?? null,
    utm_term: body.utm_term ?? urlUtms.utm_term ?? null,
    utm_id: body.utm_id ?? urlUtms.utm_id ?? null,
    click_id: body.click_id ?? urlUtms.click_id ?? null,
  };
  // Solo se guardan si son IDs de verdad: una macro sin rellenar (`{{ad.id}}`)
  // no es un ID y cruzaría con nada.
  const ids = idsPublicitarios(
    body.campaign_id ?? urlUtms.campaign_id,
    body.adset_id ?? urlUtms.adset_id,
    body.ad_id ?? urlUtms.ad_id
  );

  // Normalizar event_type: 'lead' se almacena como 'custom' con event_name
  const storedEventType = eventType === 'lead' ? 'custom' : eventType;
  const storedEventName =
    eventType === 'lead' ? (body.event_name ?? 'lead') : (body.event_name ?? null);

  // La query string se recorta ANTES de guardar: sus UTMs y su click id ya se
  // han extraído arriba a columnas propias. Ver page-url.ts.
  const pageUrl = normalizarPageUrl(body.page_url);

  // Un lead NO escribe en pixel_events: su sitio es `lead_events`, que guarda lo
  // mismo y además los datos de contacto. Los otros tipos de evento sí, porque
  // no tienen otra tabla donde ir.
  if (eventType !== 'lead') {
    const { error: pixelError } = await db.from('pixel_events').insert({
      cliente_id: cliente.id,
      event_type: storedEventType,
      event_name: storedEventName,
      visitor_id: body.visitor_id ?? null,
      session_id: body.session_id ?? null,
      page_url: pageUrl,
      page_title: body.page_title ?? null,
      referrer: body.referrer ?? null,
      utm_source: utm.utm_source,
      utm_medium: utm.utm_medium,
      utm_campaign: utm.utm_campaign,
      utm_content: utm.utm_content,
      utm_term: utm.utm_term,
      click_id: utm.click_id,
      user_agent: userAgent,
      ip_address: ip,
      ip_country: ipCountry,
      custom_data: body.custom_data ?? null,
      source: 's2s',
    });

    if (pixelError) {
      console.error('[s2s] pixel_events insert error', pixelError);
      return NextResponse.json({ error: 'Insert failed' }, { status: 500 });
    }
  }

  // Para leads: insertar adicionalmente en lead_events con datos de contacto y atribución
  if (eventType === 'lead') {
    // Regla de exclusión del cliente: el lead se guarda igual, marcado, si no
    // cuenta (ver lead-exclusion.ts). Misma regla que GHL y Meta Lead Ads.
    const regla = await cargarReglaExclusion(db, cliente.id);
    const conIds = await columnasIdDisponibles(db);

    // Atribución resuelta en el sitio, sin `resolveAttribution` ni UPDATE extra.
    //
    // Antes se insertaba el lead, se consultaba `pixel_events` buscando su
    // historia de navegación y se hacía un UPDATE con el resultado: tres viajes
    // a la base por lead. Ese rodeo no podía dar nada — el resolver cruza
    // `click_id → visitor_id` y `visitor_id` está a NULL en el 100 % de las
    // filas—, así que el método salía SIEMPRE de este mismo criterio de abajo,
    // que es el que aplicaba el fallback. Ahora se calcula y se guarda de una.
    const metodoAtribucion = utm.click_id
      ? 'click_id'
      : utm.utm_source || utm.utm_campaign
        ? 'utm_only'
        : 'none';
    const { error: leadError } = await db.from('lead_events').insert(
      adaptarIds(
        aplicarExclusion(
          {
            cliente_id: cliente.id,
            form_name: body.form_name ?? null,
            form_id: body.form_id ?? null,
            form_plugin: body.form_plugin ?? null,
            lead_name: body.lead_name ?? null,
            lead_email: body.lead_email ?? null,
            lead_phone: body.lead_phone ?? null,
            utm_source: utm.utm_source,
            utm_medium: utm.utm_medium,
            utm_campaign: utm.utm_campaign,
            utm_content: utm.utm_content,
            utm_term: utm.utm_term,
            utm_id: utm.utm_id,
            click_id: utm.click_id,
            visitor_id: body.visitor_id ?? null,
            session_id: body.session_id ?? null,
            page_url: pageUrl,
            referrer: body.referrer ?? null,
            ip_address: ip,
            ip_country: ipCountry,
            user_agent: userAgent,
            custom_data: body.custom_data ?? null,
            raw_fields: body.raw_fields ?? null,
            source: 's2s',
            attribution_method: metodoAtribucion,
            attribution_resolved_at: new Date().toISOString(),
            ...ids,
          },
          regla
        ),
        conIds
      )
    );

    if (leadError) {
      // Ahora SÍ es fatal: `lead_events` es la única escritura que queda, así que
      // tragarse el error aquí perdería el lead sin dejar rastro. Devolver 500
      // deja que quien envía lo reintente.
      console.error('[s2s] lead_events insert error', leadError);
      return NextResponse.json({ error: 'Insert failed' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'report-utm/pixel/s2s',
    message: 'Endpoint S2S listo. Enviá un POST autenticado con X-Rutm-S2S-Signature.',
  });
}
