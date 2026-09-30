import { NextRequest, NextResponse, after } from 'next/server';
import { createHash } from 'node:crypto';
import { preguntasDeFieldsMeta } from '@/lib/leads/respuestas/wordpress';
import { guardarPreguntas, sincronizarOpcionesEnCampos } from '@/lib/leads/respuestas/preguntas-db';
import { createAdminClient } from '@/utils/supabase/server';
import { verifyS2SSignature } from '@/lib/report-utm/s2s-auth';
import { aplicarExclusion, cargarReglaExclusion } from '@/lib/report-utm/lead-exclusion';
import { excluirDuplicadosLote } from '@/lib/report-utm/lead-duplicados';
import { adaptarIds, columnasIdDisponibles, insertarLeads } from '@/lib/report-utm/lead-ids';
import { normalizarPageUrl } from '@/lib/report-utm/page-url';
import {
  customDataConIds,
  externalIdS2S,
  ipPublica,
  paisVisitante,
  resolverCampos,
} from '@/lib/report-utm/s2s-captura';

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
 *
 * Idempotente para leads (2026-09-28): el plugin 0.5.0 reintenta desde WP-Cron
 * si no recibe un 2xx, y un lead repetido (mismo `external_id`) responde
 * `{ ok: true, duplicate: true }` en vez de guardarse dos veces.
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
  /** Tipo y opciones de las preguntas de opción del formulario (plugin 0.4.0). */
  fields_meta?: Record<string, unknown>;
  /**
   * IP y país del VISITANTE (plugin 0.5.0; `ip` ya lo mandaba antes y se
   * ignoraba). Las cabeceras de esta petición son las del servidor de WordPress.
   */
  ip?: string;
  visitor_ip?: string;
  visitor_country?: string;
  /** Idempotencia del reintento (plugin 0.5.0). Ver `externalIdS2S`. */
  external_id?: string;
  // Las cookies de toque del pixel también llegan en el body (plugin 0.5.0),
  // pero solo las lee `resolverCampos`: no se guardan en el lead.
};

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

  // IP y país: las cabeceras de esta petición son las del servidor de
  // WordPress, no las del visitante. Si el plugin manda la IP del visitante y es
  // pública, manda ella; si no, queda lo de antes. El país solo es del visitante
  // si el sitio está detrás de Cloudflare (`CF-IPCountry`): sin él sigue siendo
  // el del servidor, que es lo que la exportación rotula «País (IP servidor)».
  const ipHeader = req.headers.get('x-forwarded-for') ?? '';
  const ip =
    ipPublica(body.visitor_ip) ?? ipPublica(body.ip) ?? (ipHeader.split(',')[0]?.trim() || null);
  const ipCountry =
    paisVisitante(body.visitor_country) ?? paisVisitante(req.headers.get('cf-ipcountry'));
  const userAgent = req.headers.get('user-agent') ?? null;

  // UTMs e IDs efectivos: el primer valor NO VACÍO entre el body y la query
  // string de page_url (con `??` un `""` del body tapaba la URL); si el evento
  // no trae ninguna señal, la cookie de último toque que reenvía el plugin. Los
  // IDs de la entidad solo si son IDs de verdad: una macro sin rellenar
  // (`{{ad.id}}`) cruzaría con nada. Todo antes de normalizar page_url.
  const { campaign_id, adset_id, ad_id, ...utm } = resolverCampos(body);
  const ids = { campaign_id, adset_id, ad_id };

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
      // `pixel_events` no tiene columnas de IDs: van dentro de custom_data.
      custom_data: customDataConIds(body.custom_data, { utm_id: utm.utm_id, ...ids }),
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
    // Idempotencia: el plugin 0.5.0 reintenta si no recibe un 2xx, con el mismo
    // `external_id`. El índice único (cliente_id, external_id) de la 035 rechaza
    // la segunda copia en vez de duplicar el lead. Ver s2s-captura.ts.
    const externalId = externalIdS2S(body, new Date());
    const [filaLead] = await excluirDuplicadosLote(
      db,
      cliente.id,
      [
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
              external_id: externalId,
              source: 's2s',
              attribution_method: metodoAtribucion,
              attribution_resolved_at: new Date().toISOString(),
              ...ids,
            },
            regla
          ),
          conIds
        ),
      ],
      regla
    );
    const { error: leadError } = await insertarLeads(db, filaLead);

    if (leadError) {
      // 23505 = unique_violation: ese `external_id` ya está guardado, así que es
      // un reintento o un doble envío. Responder error haría reintentar otra vez
      // al plugin por un lead que ya tenemos: es un éxito.
      if (leadError.code === '23505') {
        return NextResponse.json({ ok: true, duplicate: true });
      }
      // Ahora SÍ es fatal: `lead_events` es la única escritura que queda, así que
      // tragarse el error aquí perdería el lead sin dejar rastro. Devolver 500
      // deja que quien envía lo reintente.
      console.error('[s2s] lead_events insert error', leadError);
      return NextResponse.json({ error: 'Insert failed' }, { status: 500 });
    }

    // Tipo y opciones de las preguntas del formulario (plugin 0.4.0). Después de
    // responder y sin tocar la base si la definición no cambió desde la última
    // vez: el lead ya está guardado y esto es un extra.
    if (body.fields_meta) {
      const clienteId = cliente.id;
      after(() => registrarPreguntasWordpress(db, clienteId, body));
    }
  }

  return NextResponse.json({ ok: true });
}

// Huellas recientes de `fields_meta` por cliente y formulario: el mismo
// formulario manda la misma definición con cada lead, y basta con guardarla una
// vez cada pocas horas.
const HUELLA_TTL_MS = 6 * 3600_000;
const huellasRecientes = new Map<string, number>();

async function registrarPreguntasWordpress(
  db: ReturnType<Awaited<ReturnType<typeof createAdminClient>>['schema']>,
  clienteId: string,
  body: S2SPayload
): Promise<void> {
  try {
    const huella = `${clienteId}|${body.form_id ?? ''}|${createHash('sha1')
      .update(JSON.stringify(body.fields_meta))
      .digest('hex')}`;
    const vista = huellasRecientes.get(huella);
    if (vista && Date.now() - vista < HUELLA_TTL_MS) return;
    if (huellasRecientes.size > 2000) huellasRecientes.clear();
    huellasRecientes.set(huella, Date.now());

    const preguntas = preguntasDeFieldsMeta(body.fields_meta, {
      form_id: body.form_id ?? null,
      form_name: body.form_name ?? null,
    });
    if (!preguntas || preguntas.length === 0) return;
    if ((await guardarPreguntas(db, clienteId, 'wordpress', preguntas)) > 0) {
      await sincronizarOpcionesEnCampos(db, clienteId);
    }
  } catch (err) {
    console.error('[s2s] no se pudieron registrar las preguntas del formulario', err);
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: 'report-utm/pixel/s2s',
    message: 'Endpoint S2S listo. Enviá un POST autenticado con X-Rutm-S2S-Signature.',
  });
}
