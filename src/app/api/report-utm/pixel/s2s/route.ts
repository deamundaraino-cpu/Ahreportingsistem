import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'
import { verifyS2SSignature } from '@/lib/report-utm/s2s-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Endpoint S2S (server-to-server) del pixel Report-UTM.
 *
 *   POST /api/report-utm/pixel/s2s
 *
 * Diseñado para ser llamado desde PHP/WordPress sin depender del navegador.
 * Autenticado con HMAC-SHA256: X-Rutm-S2S-Signature: <hex>
 *
 * Sin CORS — es server-to-server. No requiere preflight.
 */

type S2SPayload = {
    cliente_slug?: string
    event_type?: string
    event_name?: string
    visitor_id?: string
    session_id?: string
    page_url?: string
    page_title?: string
    referrer?: string
    utm_source?: string
    utm_medium?: string
    utm_campaign?: string
    utm_content?: string
    utm_term?: string
    click_id?: string
    custom_data?: Record<string, unknown>
}

export async function POST(req: NextRequest) {
    const rawBody = await req.text()

    let body: S2SPayload
    try {
        body = JSON.parse(rawBody) as S2SPayload
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const slug = body.cliente_slug?.trim()
    if (!slug) {
        return NextResponse.json({ error: 'cliente_slug required' }, { status: 400 })
    }

    const eventType = String(body.event_type ?? 'custom').toLowerCase()
    const ALLOWED_TYPES = ['pageview', 'custom', 'click', 'lead']
    if (!ALLOWED_TYPES.includes(eventType)) {
        return NextResponse.json({ error: 'Invalid event_type' }, { status: 400 })
    }

    const supabase = await createAdminClient()
    const db = supabase.schema('report_utm')

    // Buscar cliente por slug
    const { data: cliente } = await db
        .from('clientes')
        .select('id, status')
        .eq('slug', slug)
        .maybeSingle()

    if (!cliente) {
        return NextResponse.json({ error: 'Unknown cliente_slug' }, { status: 404 })
    }
    if (cliente.status !== 'active') {
        return NextResponse.json({ ok: true, skipped: true })
    }

    // Buscar integración S2S del cliente para obtener el token
    const { data: integration } = await db
        .from('integrations')
        .select('s2s_token, status')
        .eq('cliente_id', cliente.id)
        .eq('tipo', 's2s')
        .maybeSingle()

    if (!integration || !integration.s2s_token) {
        return NextResponse.json({ error: 'S2S integration not configured' }, { status: 403 })
    }
    if (integration.status !== 'active') {
        return NextResponse.json({ error: 'S2S integration is inactive' }, { status: 403 })
    }

    // Verificar firma HMAC
    const signatureHeader = req.headers.get('x-rutm-s2s-signature')
    const valid = verifyS2SSignature(rawBody, integration.s2s_token, signatureHeader)
    if (!valid) {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }

    const ipHeader = req.headers.get('x-forwarded-for') ?? ''
    const ip = ipHeader.split(',')[0]?.trim() || null
    const ipCountry = req.headers.get('x-vercel-ip-country') ?? null

    // Normalizar event_type: 'lead' se almacena como 'custom' con event_name
    const storedEventType = eventType === 'lead' ? 'custom' : eventType
    const storedEventName = eventType === 'lead'
        ? (body.event_name ?? 'lead')
        : (body.event_name ?? null)

    const { error } = await db.from('pixel_events').insert({
        cliente_id: cliente.id,
        event_type: storedEventType,
        event_name: storedEventName,
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
        source: 's2s',
    })

    if (error) {
        console.error('[s2s] insert error', error)
        return NextResponse.json({ error: 'Insert failed' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
}
