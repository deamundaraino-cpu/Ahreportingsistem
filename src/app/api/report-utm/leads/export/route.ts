import { NextRequest, NextResponse } from 'next/server'
import { reportUtmClient } from '@/lib/report-utm/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Exporta los leads (filtrados) a CSV.
 *
 *   GET /api/report-utm/leads/export?clienteId=&utm_source=&utm_campaign=&...
 *
 * Usa el cliente con sesión del usuario, por lo que RLS aplica:
 * solo superadmin/admin/trafficker autenticados pueden exportar.
 */

const EXPORT_CAP = 10000

const COLUMNS: { key: string; header: string }[] = [
    { key: 'created_at', header: 'Fecha' },
    { key: 'lead_name', header: 'Nombre' },
    { key: 'lead_email', header: 'Email' },
    { key: 'lead_phone', header: 'Teléfono' },
    { key: 'form_name', header: 'Formulario' },
    { key: 'form_plugin', header: 'Plugin' },
    { key: 'utm_source', header: 'UTM Source' },
    { key: 'utm_medium', header: 'UTM Medium' },
    { key: 'utm_campaign', header: 'UTM Campaign' },
    { key: 'utm_content', header: 'UTM Content' },
    { key: 'utm_term', header: 'UTM Term' },
    { key: 'utm_id', header: 'UTM ID' },
    { key: 'click_id', header: 'Click ID' },
    { key: 'attribution_method', header: 'Atribución' },
    { key: 'ip_country', header: 'País' },
    { key: 'page_url', header: 'Página de destino' },
]

const UTM_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'])

/** Decodifica percent-encoding solo si el valor todavía viene codificado. */
function dec(v: unknown): string {
    if (v == null) return ''
    const s = String(v)
    if (!/%[0-9A-Fa-f]{2}/.test(s)) return s
    try {
        return decodeURIComponent(s.replace(/\+/g, ' '))
    } catch {
        return s
    }
}

/** Escapa un campo para CSV (RFC 4180). */
function csvField(v: string): string {
    if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
    return v
}

export async function GET(req: NextRequest) {
    const sp = req.nextUrl.searchParams
    const supabase = await reportUtmClient()

    let query = supabase
        .from('lead_events')
        .select(
            'created_at, lead_name, lead_email, lead_phone, form_name, form_plugin, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, click_id, attribution_method, ip_country, page_url',
        )

    const clienteId = sp.get('clienteId')
    const formPlugin = sp.get('form_plugin')
    const utmSource = sp.get('utm_source')
    const utmCampaign = sp.get('utm_campaign')
    const utmContent = sp.get('utm_content')
    const from = sp.get('from')
    const to = sp.get('to')

    if (clienteId) query = query.eq('cliente_id', clienteId)
    if (formPlugin) query = query.eq('form_plugin', formPlugin)
    if (utmSource) query = query.ilike('utm_source', `%${utmSource}%`)
    if (utmCampaign) query = query.ilike('utm_campaign', `%${utmCampaign}%`)
    if (utmContent) query = query.ilike('utm_content', `%${utmContent}%`)
    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)

    const { data, error } = await query
        .order('created_at', { ascending: false })
        .limit(EXPORT_CAP)

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const rows = (data ?? []) as Record<string, unknown>[]

    const lines = [COLUMNS.map((c) => csvField(c.header)).join(',')]
    for (const row of rows) {
        lines.push(
            COLUMNS.map((c) => {
                const raw = row[c.key]
                const val = UTM_KEYS.has(c.key) ? dec(raw) : raw == null ? '' : String(raw)
                return csvField(val)
            }).join(','),
        )
    }

    // BOM para que Excel reconozca UTF-8 (acentos, emojis en utm_content)
    const csv = '﻿' + lines.join('\r\n')
    const stamp = new Date().toISOString().slice(0, 10)

    return new NextResponse(csv, {
        status: 200,
        headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="leads-${stamp}.csv"`,
            'Cache-Control': 'no-store',
        },
    })
}
