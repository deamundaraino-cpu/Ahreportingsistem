import { NextRequest, NextResponse, after } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'
import { verifyWebhookSignature } from '@/lib/report-utm/webhook-auth'
import { cifrarSecreto, leerSecreto } from '@/lib/secretos'
import { ingestGhlContactById, type GhlIntegrationRow } from '@/lib/report-utm/ghl-leads'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Webhook de GoHighLevel (tiempo real) → `report_utm.lead_events`.
 *
 *   POST /api/report-utm/webhooks/ghl/{clienteId}
 *
 * A diferencia del webhook de Meta (URL única de app, ruteo por page_id), aquí
 * la ruta lleva el cliente: cada location pega SU propia URL en su Workflow.
 *
 * ── El payload es un AVISO, no el dato ──────────────────────────
 * Lo que manda un Workflow de GHL lo configura el usuario y no garantiza traer
 * `attributionSource` ni los campos personalizados resueltos. Por eso solo
 * extraemos el `contact_id`, respondemos 200 y **releemos el contacto completo**
 * con el PIT en `after()`. Un único camino de mapeo para webhook y polling.
 *
 * ── Firma ───────────────────────────────────────────────────────
 * El Workflow de GHL permite headers personalizados pero no firma el cuerpo, así
 * que la autenticación es un token compartido por cliente comparado en tiempo
 * constante (`X-Rutm-Ghl-Token`). Si algún día se emite desde un sitio que sí
 * pueda firmar, `X-Rutm-Ghl-Signature` (HMAC-SHA256 del cuerpo crudo) ya se
 * acepta y es preferible.
 */

/** Tope de cuerpo. Un contacto completo de GHL ronda 8-20 KB; 256 KB deja margen. */
const MAX_BODY_BYTES = 256 * 1024

// Rate limit en memoria POR CLIENTE. En serverless cada instancia lleva su propio
// contador, así que es una mitigación, no una garantía; la defensa real contra
// reentregas es el índice único (cliente_id, external_id).
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 300
const hits = new Map<string, number[]>()

function rateLimited(key: string): boolean {
    const now = Date.now()
    const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
    recent.push(now)
    hits.set(key, recent)
    if (hits.size > 5000) hits.clear() // techo de memoria
    return recent.length > RATE_MAX
}

type GhlWebhookBody = {
    contact_id?: string
    contactId?: string
    id?: string
    contact?: { id?: string }
    location?: { id?: string; name?: string }
    locationId?: string
    location_id?: string
    workflow?: { name?: string }
    workflow_name?: string
}

/** El id del contacto según cómo lo haya montado el Workflow. */
function contactIdDe(p: GhlWebhookBody): string | null {
    const v = p.contact_id ?? p.contactId ?? p.contact?.id ?? p.id
    const s = typeof v === 'string' ? v.trim() : ''
    return s === '' ? null : s
}

function locationIdDe(p: GhlWebhookBody): string | null {
    const v = p.location?.id ?? p.locationId ?? p.location_id
    const s = typeof v === 'string' ? v.trim() : ''
    return s === '' ? null : s
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ clienteId: string }> }) {
    const startedAt = Date.now()
    const { clienteId } = await params

    // 0) Tope de cuerpo y rate limit, ANTES de leer nada.
    const declarado = Number(req.headers.get('content-length') ?? 0)
    if (declarado > MAX_BODY_BYTES) {
        return NextResponse.json({ error: 'Payload demasiado grande' }, { status: 413 })
    }
    if (rateLimited(clienteId)) {
        return NextResponse.json(
            { error: 'Demasiadas peticiones' },
            { status: 429, headers: { 'Retry-After': '60' } },
        )
    }

    // 1) Cuerpo crudo (hace falta exacto para validar un HMAC).
    const rawBody = await req.text()
    if (!rawBody) return NextResponse.json({ error: 'Empty body' }, { status: 400 })
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
        return NextResponse.json({ error: 'Payload demasiado grande' }, { status: 413 })
    }

    let payload: GhlWebhookBody
    try {
        payload = JSON.parse(rawBody) as GhlWebhookBody
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    // 2) Integración del cliente (admin client = bypass RLS).
    const supabaseAdmin = await createAdminClient()
    const db = supabaseAdmin.schema('report_utm')

    const { data: integration, error: intError } = await db
        .from('integrations')
        .select('id, cliente_id, webhook_secret, webhook_secret_enc, access_token_encrypted, config, status')
        .eq('cliente_id', clienteId)
        .eq('tipo', 'gohighlevel')
        .maybeSingle()

    if (intError) {
        console.error('[ghl webhook] integration lookup error', intError)
        return NextResponse.json({ error: 'Integration lookup failed' }, { status: 500 })
    }
    if (!integration) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })

    const secreto = leerSecreto(integration.webhook_secret_enc, integration.webhook_secret)
    if (!secreto.valor) return NextResponse.json({ error: 'Integration not found' }, { status: 404 })
    if (integration.status === 'inactive') {
        return NextResponse.json({ error: 'Integration paused' }, { status: 403 })
    }

    // Migración perezosa del secreto: se cifra la primera vez que se usa.
    if (secreto.necesitaMigracion) {
        after(async () => {
            try {
                await db
                    .from('integrations')
                    .update({ webhook_secret_enc: cifrarSecreto(secreto.valor), webhook_secret: null })
                    .eq('id', integration.id)
            } catch (e) {
                console.error('[ghl webhook] no se pudo cifrar el webhook_secret', e)
            }
        })
    }

    // 3) Autenticación.
    const { valid, method } = verifyWebhookSignature({
        rawBody,
        secret: secreto.valor,
        signatureHeader: req.headers.get('x-rutm-ghl-signature'),
        hottokHeader: req.headers.get('x-rutm-ghl-token'),
        hottokQuery: req.nextUrl.searchParams.get('token'),
        payload,
    })
    if (!valid) {
        console.warn('[ghl webhook] invalid signature', { clienteId })
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    // 4) Guarda de location. Si el Workflow de OTRA location apunta por error a
    // esta URL, sus contactos entrarían como leads de este cliente.
    const config = (integration.config ?? {}) as Record<string, unknown>
    const locationEsperada = typeof config.location_id === 'string' ? config.location_id : null
    const locationRecibida = locationIdDe(payload)
    if (locationEsperada && locationRecibida && locationRecibida !== locationEsperada) {
        console.warn('[ghl webhook] location no coincide', { clienteId, locationRecibida })
        return NextResponse.json({ ok: true, ignorado: 'location_no_coincide' }, { status: 200 })
    }

    const contactId = contactIdDe(payload)
    if (!contactId) {
        // 200 a propósito: es un Workflow mal montado, no un fallo nuestro, y un
        // 4xx dejaría a GHL reintentando el mismo payload inútil para siempre.
        return NextResponse.json(
            { ok: true, ignorado: 'sin_contact_id', ayuda: 'El webhook debe incluir contact_id.' },
            { status: 200 },
        )
    }

    const formName = payload.workflow?.name ?? payload.workflow_name ?? null

    // 5) Releer el contacto completo e ingerir, después de responder.
    after(async () => {
        try {
            const r = await ingestGhlContactById(
                supabaseAdmin,
                integration as GhlIntegrationRow,
                contactId,
                formName,
            )
            if (r.inserted) {
                await db
                    .from('integrations')
                    .update({ status: 'active', last_sync_at: new Date().toISOString(), last_error: null })
                    .eq('id', integration.id)
            } else if (r.motivo) {
                console.info('[ghl webhook] contacto no ingerido', { clienteId, contactId, motivo: r.motivo })
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            console.error('[ghl webhook] fallo ingiriendo el contacto', msg)
            await db
                .from('integrations')
                .update({ status: 'error', last_error: msg.slice(0, 500) })
                .eq('id', integration.id)
        }
    })

    return NextResponse.json(
        { ok: true, contact_id: contactId, method, processing_ms: Date.now() - startedAt },
        { status: 200 },
    )
}

// GET para health-check / verificación manual al configurar el Workflow.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ clienteId: string }> }) {
    const { clienteId } = await params
    return NextResponse.json({
        ok: true,
        endpoint: 'report-utm/ghl',
        cliente_id: clienteId,
        message: 'Endpoint listo. Enviá un POST con el header X-Rutm-Ghl-Token y un contact_id.',
    })
}
