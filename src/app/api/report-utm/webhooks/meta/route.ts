import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createAdminClient } from '@/utils/supabase/server';
import {
  fetchLeadById,
  getMetaAccountsForCliente,
  ingestMetaLead,
} from '@/lib/report-utm/meta-leads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Webhook de Meta Lead Ads (tiempo real). URL única a nivel de app:
 *   GET  /api/report-utm/webhooks/meta   → verificación de suscripción
 *   POST /api/report-utm/webhooks/meta   → recepción de leads (campo `leadgen`)
 *
 * Meta envía el `leadgen_id` + `page_id`. Mapeamos page_id → cliente (vía
 * integrations.config.pages, poblado al activar) y traemos el lead completo con
 * GET /{leadgen_id}. La dedup por external_id evita duplicar con el polling.
 *
 * Verificación de firma: X-Hub-Signature-256 = sha256 HMAC con META_APP_SECRET.
 */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? '', { status: 200 });
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

function verifySignature(rawBody: string, signatureHeader: string | null): boolean {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

type MetaWebhookBody = {
  object?: string;
  entry?: Array<{
    id?: string; // page_id
    time?: number;
    changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
  }>;
};

type MetaLeadsIntegrationRow = {
  id: string;
  cliente_id: string;
  config: {
    pages?: Array<{ page_id?: string; page_token?: string }>;
    scoped_forms?: Array<{ form_id?: string; form_name?: string }> | null;
  } | null;
};

/**
 * Se procesa ANTES de responder. Antes se respondía 200 al instante y el lead se
 * leía en `after()`: si ese paso fallaba (token de Página vencido, Graph caído),
 * Meta ya tenía su 200 y no reintentaba, y el lead dependía de que el polling lo
 * recogiera. Ahora un fallo devuelve 500 y Meta reintenta; la dedup por
 * `external_id` hace inocuo el reintento de un lead que sí entró.
 *
 * Y se aceptan integraciones en `error`: el polling marca `error` ante cualquier
 * fallo (una Página sin permiso, un límite de Graph), y el webhook descartaba en
 * silencio todos los leads del cliente mientras tanto.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifySignature(rawBody, req.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: MetaWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Recolectar los eventos leadgen del payload.
  const events: { pageId: string; leadgenId: string }[] = [];
  for (const entry of body.entry ?? []) {
    const pageId = entry.id ? String(entry.id) : '';
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') continue;
      const v = change.value ?? {};
      const leadgenId = v.leadgen_id ? String(v.leadgen_id) : '';
      const effectivePage = v.page_id ? String(v.page_id) : pageId;
      if (leadgenId && effectivePage) events.push({ pageId: effectivePage, leadgenId });
    }
  }
  if (events.length === 0) return NextResponse.json({ ok: true });

  let fallidos = 0;
  try {
    const supabase = await createAdminClient();
    const db = supabase.schema('report_utm');

    const { data, error } = await db
      .from('integrations')
      .select('id, cliente_id, config')
      .eq('tipo', 'meta_lead_ads')
      .in('status', ['active', 'error']);
    if (error) throw new Error(error.message);
    const integrations = (data ?? []) as MetaLeadsIntegrationRow[];

    for (const { pageId, leadgenId } of events) {
      // Resolver qué cliente posee esta página.
      const match = integrations.find(
        (i) =>
          Array.isArray(i.config?.pages) &&
          i.config!.pages!.some((p) => String(p.page_id) === pageId)
      );
      if (!match) {
        // No es un fallo reintentable: esa Página no es de ningún cliente.
        console.warn('[meta webhook] page sin cliente mapeado', pageId);
        continue;
      }

      // Token: el page token guardado; fallback al token de cuenta del cliente.
      const page = match.config!.pages!.find((p) => String(p.page_id) === pageId);
      let token: string | undefined = page?.page_token;
      if (!token) {
        const { accounts } = await getMetaAccountsForCliente(supabase, match.cliente_id);
        token = accounts[0]?.token;
      }
      if (!token) {
        console.warn('[meta webhook] sin token para cliente', match.cliente_id);
        fallidos++;
        continue;
      }

      const lead = await fetchLeadById(leadgenId, token);
      if (!lead) {
        console.warn('[meta webhook] no se pudo leer el lead', leadgenId);
        fallidos++;
        continue;
      }
      // El nombre del formulario sale de la caché del polling: sin él,
      // `form_name` quedaba en null y la regla «excluir formulario» no aplicaba.
      const formName =
        match.config?.scoped_forms?.find((f) => f?.form_id && f.form_id === lead.form_id)
          ?.form_name ?? null;
      const r = await ingestMetaLead(db, match.cliente_id, lead, formName);
      if (r.error) {
        console.error('[meta webhook] no se pudo guardar el lead', leadgenId, r.error);
        fallidos++;
      }
    }
  } catch (err) {
    console.error('[meta webhook] processing error', err);
    return NextResponse.json({ error: 'processing_error' }, { status: 500 });
  }

  if (fallidos > 0) {
    return NextResponse.json({ error: 'partial', fallidos }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
