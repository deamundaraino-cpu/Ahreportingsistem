import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export const maxDuration = 300

/**
 * POST /api/backfill-forms
 * Body: { clienteId?: string, days?: number }
 *
 * Populates meta_forms for existing metricas_diarias rows that have empty arrays.
 * Fetches form names from /leadgen_forms and metrics from insights breakdown.
 */
export async function POST(request: Request) {
    const adminSupabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    let body: any = {}
    try { body = await request.json() } catch (_) {}

    const clienteId: string | undefined = body.clienteId
    const days: number = Math.min(body.days ?? 60, 365)

    const since = new Date()
    since.setDate(since.getDate() - days)
    const sinceStr = since.toISOString().slice(0, 10)

    // Fetch clients
    let clientesQuery = adminSupabase.from('clientes').select('id, nombre, config_api')
    if (clienteId) clientesQuery = clientesQuery.eq('id', clienteId)
    const { data: clientes, error: clientesErr } = await clientesQuery
    if (clientesErr || !clientes) {
        return NextResponse.json({ error: 'Error fetching clients' }, { status: 500 })
    }

    const results: { cliente: string; updated: number; skipped: number; error?: string }[] = []

    for (const cliente of clientes) {
        const config = cliente.config_api as any
        if (!config) { results.push({ cliente: cliente.nombre, updated: 0, skipped: 0, error: 'No config' }); continue }

        // Build account list
        type Account = { account_id: string; token: string }
        let accounts: Account[] = []
        if (config.meta_accounts && Array.isArray(config.meta_accounts) && config.meta_accounts.length > 0) {
            accounts = config.meta_accounts
                .filter((a: any) => a.account_id)
                .map((a: any) => ({ account_id: String(a.account_id), token: a.token || config.meta_token || '' }))
        } else if (config.meta_token && config.meta_account_id) {
            accounts = [{ account_id: String(config.meta_account_id), token: config.meta_token }]
        }

        if (accounts.length === 0) {
            results.push({ cliente: cliente.nombre, updated: 0, skipped: 0, error: 'No Meta accounts configured' })
            continue
        }

        // Fetch rows that have empty meta_forms
        const { data: rows, error: rowsErr } = await adminSupabase
            .from('metricas_diarias')
            .select('id, fecha, meta_forms')
            .eq('cliente_id', cliente.id)
            .gte('fecha', sinceStr)
            .order('fecha', { ascending: false })

        if (rowsErr || !rows) {
            results.push({ cliente: cliente.nombre, updated: 0, skipped: 0, error: 'Error fetching rows' })
            continue
        }

        // Only process rows with empty meta_forms
        const emptyRows = rows.filter(r => {
            const f = r.meta_forms
            return !f || (Array.isArray(f) && f.length === 0)
        })

        if (emptyRows.length === 0) {
            results.push({ cliente: cliente.nombre, updated: 0, skipped: rows.length })
            continue
        }

        // Build form name catalog (once per account)
        const nameMap = new Map<string, string>()
        for (const { account_id, token } of accounts) {
            const actId = account_id.startsWith('act_') ? account_id : `act_${account_id}`
            try {
                const url = new URL(`https://graph.facebook.com/v19.0/${actId}/leadgen_forms`)
                url.searchParams.append('access_token', token)
                url.searchParams.append('fields', 'id,name')
                url.searchParams.append('limit', '200')
                const res = await fetch(url.toString())
                const data = await res.json()
                if (data.data && Array.isArray(data.data)) {
                    for (const f of data.data) {
                        if (f.id && f.name) nameMap.set(String(f.id), f.name)
                    }
                }
            } catch (_) {}
        }

        let updated = 0
        let skipped = 0

        for (const row of emptyRows) {
            const date = row.fecha

            // Fetch form metrics for this date across all accounts
            const formsMap = new Map<string, any>()

            for (const { account_id, token } of accounts) {
                const actId = account_id.startsWith('act_') ? account_id : `act_${account_id}`
                try {
                    const url = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                    url.searchParams.append('access_token', token)
                    url.searchParams.append('time_range', JSON.stringify({ since: date, until: date }))
                    url.searchParams.append('fields', 'leadgen_form_id,spend,impressions,clicks,actions')
                    url.searchParams.append('breakdowns', 'leadgen_form_id')
                    url.searchParams.append('level', 'ad')
                    url.searchParams.append('limit', '500')

                    const res = await fetch(url.toString())
                    const data = await res.json()

                    if (data.data && Array.isArray(data.data)) {
                        for (const item of data.data) {
                            const formId: string = item.leadgen_form_id || ''
                            if (!formId) continue

                            const existing = formsMap.get(formId) || {
                                form_id:     formId,
                                form_name:   nameMap.get(formId) || formId,
                                leads:       0,
                                spend:       0,
                                impressions: 0,
                                clicks:      0,
                            }

                            existing.spend       += parseFloat(item.spend || '0')
                            existing.impressions += parseInt(item.impressions || '0')
                            existing.clicks      += parseInt(item.clicks || '0')

                            if (item.actions) {
                                for (const a of item.actions) {
                                    if (a.action_type === 'lead') {
                                        existing.leads += parseInt(a.value || '0')
                                    }
                                }
                            }

                            formsMap.set(formId, existing)
                        }
                    }
                } catch (_) {}
            }

            const forms = Array.from(formsMap.values())

            const { error: updateErr } = await adminSupabase
                .from('metricas_diarias')
                .update({ meta_forms: forms })
                .eq('id', row.id)

            if (updateErr) { skipped++; continue }
            updated++
        }

        results.push({ cliente: cliente.nombre, updated, skipped: rows.length - emptyRows.length })
    }

    return NextResponse.json({ ok: true, results })
}
