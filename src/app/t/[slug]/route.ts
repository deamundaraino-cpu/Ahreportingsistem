import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'
import {
    buildTouchFromUrl,
    readFirstTouch,
    readVisitor,
    setAttributionCookies,
} from '@/lib/report-utm/attribution-cookies'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Tracking link redirect: /t/:slug
 *
 *   1. Resuelve el slug a un destination_url + UTMs precargados.
 *   2. Increment clicks_count + last_click_at.
 *   3. Setea cookies de atribución (visitor, first-touch, last-touch).
 *   4. Loggea evento click en pixel_events.
 *   5. 302 → destination con UTMs y click_id propagados.
 */
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ slug: string }> },
) {
    const { slug } = await params
    const supabase = await createAdminClient()
    const db = supabase.schema('report_utm')

    const { data: link } = await db
        .from('tracking_links')
        .select('id, cliente_id, destination_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, enabled, clicks_count')
        .eq('slug', slug)
        .maybeSingle()

    if (!link || !link.enabled) {
        return new NextResponse('Link not found', { status: 404 })
    }

    // Construir URL destino: respetamos UTMs configurados pero permitimos
    // override desde la query (?utm_content=xxx en el link corto sobreescribe).
    let destination: URL
    try {
        destination = new URL(link.destination_url as string)
    } catch {
        return new NextResponse('Invalid destination', { status: 500 })
    }

    const incomingParams = req.nextUrl.searchParams

    const setIfMissing = (key: string, value: string | null) => {
        const incoming = incomingParams.get(key)
        if (incoming) destination.searchParams.set(key, incoming)
        else if (value) destination.searchParams.set(key, value)
    }

    setIfMissing('utm_source', link.utm_source as string | null)
    setIfMissing('utm_medium', link.utm_medium as string | null)
    setIfMissing('utm_campaign', link.utm_campaign as string | null)
    setIfMissing('utm_content', link.utm_content as string | null)
    setIfMissing('utm_term', link.utm_term as string | null)

    // Propagar click_ids si vienen
    for (const k of ['fbclid', 'gclid', 'ttclid', 'click_id']) {
        const v = incomingParams.get(k)
        if (v) destination.searchParams.set(k, v)
    }

    // Preparar response con redirect
    const res = NextResponse.redirect(destination, 302)

    // Atribución cookies
    const { visitorId, sessionId } = readVisitor(req)
    const existingFt = readFirstTouch(req)

    // Touch construido a partir de los UTMs efectivos del redirect
    const touch = buildTouchFromUrl(destination, req.headers.get('referer'))

    setAttributionCookies(res, {
        visitorId,
        sessionId,
        newTouch: touch,
        existingFirstTouch: existingFt,
    })

    // Increment click counter (fire-and-forget; no await para no demorar redirect)
    db.from('tracking_links')
        .update({
            clicks_count: ((link.clicks_count as number | undefined) ?? 0) + 1,
            last_click_at: new Date().toISOString(),
        })
        .eq('id', link.id)
        .then(() => {})

    // Log evento click
    db.from('pixel_events')
        .insert({
            cliente_id: link.cliente_id,
            link_id: link.id,
            event_type: 'click',
            visitor_id: visitorId,
            session_id: sessionId,
            page_url: req.nextUrl.toString(),
            referrer: req.headers.get('referer'),
            utm_source: destination.searchParams.get('utm_source'),
            utm_medium: destination.searchParams.get('utm_medium'),
            utm_campaign: destination.searchParams.get('utm_campaign'),
            utm_content: destination.searchParams.get('utm_content'),
            utm_term: destination.searchParams.get('utm_term'),
            click_id:
                destination.searchParams.get('fbclid') ??
                destination.searchParams.get('gclid') ??
                destination.searchParams.get('ttclid') ??
                null,
            user_agent: req.headers.get('user-agent'),
        })
        .then(() => {})

    return res
}
