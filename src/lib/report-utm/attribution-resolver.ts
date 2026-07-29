import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Cruza pixel_events ↔ sales_events para resolver atribución multi-touch.
 *
 * Estrategia (cascada):
 *   1) Match por click_id (fbclid/gclid/etc) — la señal más fuerte.
 *   2) Si encontramos pixel_events, sus visitor_id nos dan el mismo browser.
 *      Levantamos TODA la historia de ese visitor para first/last touch.
 *   3) Si no hay match, fallback a UTMs propios de la venta (utm_only).
 *   4) Si no hay nada, attribution_method = 'none'.
 */

type Touch = {
    source: string | null
    medium: string | null
    campaign: string | null
    content: string | null
    term: string | null
    click_id: string | null
    referrer: string | null
    page_url: string | null
    ts: string
}

type SaleSnapshot = {
    id: string
    cliente_id: string
    click_id: string | null
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_content: string | null
    utm_term: string | null
    sale_timestamp: string | null
    received_at: string
}

type ResolverDb = ReturnType<SupabaseClient['schema']>

export type AttributionResult = {
    visitor_id: string | null
    first_touch: Touch | null
    last_touch: Touch | null
    attribution_method: 'click_id' | 'visitor_cookie' | 'utm_only' | 'none'
    pixel_events_matched: number
}

export async function resolveAttribution(
    db: ResolverDb,
    sale: SaleSnapshot,
): Promise<AttributionResult> {
    // Toma todos los pixel_events del cliente con click_id matching o por visitor_id si lo conocemos
    let visitorIds: string[] = []
    let methodBase: 'click_id' | 'visitor_cookie' | 'utm_only' | 'none' = 'none'

    if (sale.click_id) {
        const { data: clickMatches } = await db
            .from('pixel_events')
            .select('visitor_id')
            .eq('cliente_id', sale.cliente_id)
            .eq('click_id', sale.click_id)
            .not('visitor_id', 'is', null)
            .limit(50)

        const ids = new Set<string>()
        for (const r of (clickMatches ?? []) as Array<{ visitor_id: string | null }>) {
            if (r.visitor_id) ids.add(r.visitor_id)
        }
        if (ids.size > 0) {
            visitorIds = Array.from(ids)
            methodBase = 'click_id'
        }
    }

    // Si no resolvimos por click_id, fallback a UTM-only
    if (methodBase === 'none') {
        const hasUtm = Boolean(
            sale.utm_source || sale.utm_campaign || sale.utm_medium || sale.utm_content,
        )
        if (hasUtm) {
            const utmTouch: Touch = {
                source: sale.utm_source,
                medium: sale.utm_medium,
                campaign: sale.utm_campaign,
                content: sale.utm_content,
                term: sale.utm_term,
                click_id: sale.click_id,
                referrer: null,
                page_url: null,
                ts: sale.sale_timestamp ?? sale.received_at,
            }
            return {
                visitor_id: null,
                first_touch: utmTouch,
                last_touch: utmTouch,
                attribution_method: 'utm_only',
                pixel_events_matched: 0,
            }
        }
        return {
            visitor_id: null,
            first_touch: null,
            last_touch: null,
            attribution_method: 'none',
            pixel_events_matched: 0,
        }
    }

    // Tenemos visitor_ids → traer historia completa ordenada por tiempo
    const cutoff = sale.sale_timestamp ?? sale.received_at
    const { data: history } = await db
        .from('pixel_events')
        .select('visitor_id, event_type, page_url, referrer, utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_id, created_at')
        .eq('cliente_id', sale.cliente_id)
        .in('visitor_id', visitorIds)
        .lte('created_at', cutoff)
        .order('created_at', { ascending: true })
        .limit(500)

    type Row = {
        visitor_id: string
        event_type: string
        page_url: string | null
        referrer: string | null
        utm_source: string | null
        utm_medium: string | null
        utm_campaign: string | null
        utm_content: string | null
        utm_term: string | null
        click_id: string | null
        created_at: string
    }
    const rows = (history ?? []) as Row[]

    // Solo eventos que aportaron una señal de atribución
    const signalRows = rows.filter(
        (r) => r.utm_source || r.utm_campaign || r.click_id || r.utm_medium,
    )

    if (signalRows.length === 0) {
        // Visitor reconocido pero sin touches útiles — degradar a utm_only si la venta tiene
        const hasUtm = Boolean(sale.utm_source || sale.utm_campaign)
        if (hasUtm) {
            const utmTouch: Touch = {
                source: sale.utm_source,
                medium: sale.utm_medium,
                campaign: sale.utm_campaign,
                content: sale.utm_content,
                term: sale.utm_term,
                click_id: sale.click_id,
                referrer: null,
                page_url: null,
                ts: cutoff,
            }
            return {
                visitor_id: visitorIds[0] ?? null,
                first_touch: utmTouch,
                last_touch: utmTouch,
                attribution_method: 'visitor_cookie',
                pixel_events_matched: rows.length,
            }
        }
        return {
            visitor_id: visitorIds[0] ?? null,
            first_touch: null,
            last_touch: null,
            attribution_method: 'visitor_cookie',
            pixel_events_matched: rows.length,
        }
    }

    const toTouch = (r: Row): Touch => ({
        source: r.utm_source,
        medium: r.utm_medium,
        campaign: r.utm_campaign,
        content: r.utm_content,
        term: r.utm_term,
        click_id: r.click_id,
        referrer: r.referrer,
        page_url: r.page_url,
        ts: r.created_at,
    })

    return {
        visitor_id: signalRows[0].visitor_id,
        first_touch: toTouch(signalRows[0]),
        last_touch: toTouch(signalRows[signalRows.length - 1]),
        attribution_method: methodBase,
        pixel_events_matched: rows.length,
    }
}

/**
 * Deja `last_touch` en NULL cuando no aporta nada sobre `first_touch`.
 *
 * En la mayoría de las rutas de atribución ambos touches son literalmente el
 * mismo objeto (ver la rama `utm_only` de arriba y meta-leads.ts): solo cuando se
 * resuelve por pixel_events pueden diferir, tomando el primero y el último de la
 * secuencia. Guardar la copia salía caro — los dos JSONB pesaban 39 MB en
 * `lead_events`, el 44 % de la tabla, y 47.301 de 48.004 filas los tenían
 * idénticos.
 *
 * Quien lea debe hacer `last_touch ?? first_touch`.
 */
export function dedupTouches<T>(
    first: T | null,
    last: T | null,
): { first_touch: T | null; last_touch: T | null } {
    const igual = first !== null && last !== null
        && JSON.stringify(first) === JSON.stringify(last)
    return { first_touch: first, last_touch: igual ? null : last }
}

export async function applyAttributionToSale(
    db: ResolverDb,
    saleId: string,
    result: AttributionResult,
): Promise<void> {
    const touches = dedupTouches(
        result.first_touch as unknown as Record<string, unknown> | null,
        result.last_touch as unknown as Record<string, unknown> | null,
    )
    await db
        .from('sales_events')
        .update({
            visitor_id: result.visitor_id,
            ...touches,
            attribution_method: result.attribution_method,
            attribution_resolved_at: new Date().toISOString(),
        })
        .eq('id', saleId)
}
