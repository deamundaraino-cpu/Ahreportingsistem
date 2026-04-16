import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'

function safeNum(v: any, fallback = 0): number {
    const n = parseFloat(v)
    return isNaN(n) ? fallback : n
}
function safeInt(v: any, fallback = 0): number {
    const n = parseInt(v)
    return isNaN(n) ? fallback : n
}

// Aggregate all campaigns from an array of metricas_diarias rows
function aggregateCampaigns(rows: any[]): Map<string, any> {
    const map = new Map<string, any>()
    for (const row of rows) {
        const camps: any[] = row.meta_campaigns || []
        for (const c of camps) {
            const key = c.campaign_id || c.name || 'Desconocida'
            const existing = map.get(key) || {
                name: c.name || c.campaign_name || 'Desconocida',
                campaign_id: c.campaign_id || null,
                spend: 0, reach: 0, impressions: 0, clicks: 0,
                link_clicks: 0, leads: 0, purchases: 0,
                initiates_checkout: 0, landing_page_views: 0,
                results: 0,
                thumbnail_url: c.thumbnail_url || null,
            }
            existing.spend += safeNum(c.spend)
            existing.reach += safeInt(c.reach)
            existing.impressions += safeInt(c.impressions)
            existing.clicks += safeInt(c.clicks)
            existing.link_clicks += safeInt(c.link_clicks)
            existing.leads += safeInt(c.leads)
            existing.purchases += safeInt(c.purchases)
            existing.initiates_checkout += safeInt(c.initiates_checkout)
            existing.landing_page_views += safeInt(c.landing_page_views)
            existing.results += safeInt(c.results || c.leads || c.purchases || 0)
            if (!existing.thumbnail_url && c.thumbnail_url) existing.thumbnail_url = c.thumbnail_url
            map.set(key, existing)
        }
    }
    return map
}

function computeCampaignMetrics(c: any, roasTarget: number) {
    const ctr = c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0
    const cpa = c.results > 0 ? c.spend / c.results : null
    const roas = c.spend > 0 ? (c.results * 0) : null // ROAS needs revenue; use cost_per_result proxy
    return {
        ...c,
        ctr: parseFloat(ctr.toFixed(2)),
        cpa: cpa !== null ? parseFloat(cpa.toFixed(2)) : null,
        roas,
        roasStatus: roasTarget > 0 && roas !== null
            ? roas >= roasTarget ? 'good' : roas >= roasTarget * 0.8 ? 'warning' : 'bad'
            : 'neutral',
    }
}

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url)
    const clientId = searchParams.get('clientId')
    const year = parseInt(searchParams.get('year') || '')
    const month = parseInt(searchParams.get('month') || '')

    if (!clientId || isNaN(year) || isNaN(month)) {
        return NextResponse.json({ error: 'clientId, year, month required' }, { status: 400 })
    }

    const supabase = await createAdminClient()

    // Fetch client
    const { data: clienteRows, error: clienteError } = await supabase
        .from('clientes')
        .select('id, nombre, config_api')
        .eq('id', clientId)
        .limit(1)

    if (clienteError) return NextResponse.json({ error: `DB error: ${clienteError.message}` }, { status: 500 })
    const cliente = clienteRows?.[0]
    if (!cliente) return NextResponse.json({ error: `Client not found (id: ${clientId})` }, { status: 404 })

    const cfg = (cliente.config_api as any) || {}
    const roasTarget = safeNum(cfg.roas_target, 0)
    const currency = cfg.currency || 'USD'

    // Date range for current month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`
    const endDate = new Date(year, month, 0).toISOString().split('T')[0] // last day of month

    // Previous month
    const prevDate = new Date(year, month - 2, 1)
    const prevYear = prevDate.getFullYear()
    const prevMonth = prevDate.getMonth() + 1
    const prevStart = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`
    const prevEnd = new Date(prevYear, prevMonth, 0).toISOString().split('T')[0]

    // Fetch current + previous month rows in parallel
    // Note: meta_reach, meta_leads, meta_purchases, meta_link_clicks, meta_landing_page_views
    // do NOT exist as top-level columns — they must be derived from meta_campaigns JSON.
    const [{ data: currentRows }, { data: prevRows }, { data: notasRow }] = await Promise.all([
        supabase
            .from('metricas_diarias')
            .select('fecha, meta_spend, meta_impressions, meta_clicks, ventas_principal, ventas_bump, ventas_upsell, meta_campaigns')
            .eq('cliente_id', clientId)
            .gte('fecha', startDate)
            .lte('fecha', endDate)
            .order('fecha'),
        supabase
            .from('metricas_diarias')
            .select('meta_spend, meta_impressions, meta_clicks, meta_campaigns')
            .eq('cliente_id', clientId)
            .gte('fecha', prevStart)
            .lte('fecha', prevEnd),
        supabase
            .from('reportes_mensuales')
            .select('notas')
            .eq('cliente_id', clientId)
            .eq('year', year)
            .eq('month', month)
            .maybeSingle(),
    ])

    const rows = currentRows || []
    const prev = prevRows || []

    // Helper: sum a field from all campaigns in a row's meta_campaigns array
    function sumCampaignField(row: any, field: string): number {
        const camps: any[] = row.meta_campaigns || []
        return camps.reduce((s: number, c: any) => s + safeInt(c[field]), 0)
    }

    // ── Summary aggregation ──────────────────────────────────────────────────
    const totSpend = rows.reduce((s, r) => s + safeNum(r.meta_spend), 0)
    const totImpressions = rows.reduce((s, r) => s + safeInt(r.meta_impressions), 0)
    const totClicks = rows.reduce((s, r) => s + safeInt(r.meta_clicks), 0)
    const totReach = rows.reduce((s, r) => s + sumCampaignField(r, 'reach'), 0)
    const totLeads = rows.reduce((s, r) => s + sumCampaignField(r, 'leads'), 0)
    const totPurchases = rows.reduce((s, r) => s + sumCampaignField(r, 'purchases'), 0)
    const totLandingViews = rows.reduce((s, r) => s + sumCampaignField(r, 'landing_page_views'), 0)
    const totLinkClicks = rows.reduce((s, r) => s + sumCampaignField(r, 'link_clicks'), 0)
    const totRevenue = rows.reduce((s, r) => s + safeNum(r.ventas_principal) + safeNum(r.ventas_bump) + safeNum(r.ventas_upsell), 0)

    const totResults = totLeads > 0 ? totLeads : totPurchases
    const cpa = totResults > 0 ? totSpend / totResults : null
    const roas = totSpend > 0 && totRevenue > 0 ? totRevenue / totSpend : null
    const ctr = totImpressions > 0 ? (totClicks / totImpressions) * 100 : null
    const cpm = totImpressions > 0 ? (totSpend / totImpressions) * 1000 : null

    // ── Daily series ─────────────────────────────────────────────────────────
    const daily = rows.map(r => {
        const dayLeads = sumCampaignField(r, 'leads')
        const dayPurchases = sumCampaignField(r, 'purchases')
        return {
            date: r.fecha,
            spend: parseFloat(safeNum(r.meta_spend).toFixed(2)),
            results: dayLeads > 0 ? dayLeads : dayPurchases,
        }
    })

    // ── Campaign breakdown ────────────────────────────────────────────────────
    const campaignMap = aggregateCampaigns(rows)
    const campaigns = Array.from(campaignMap.values())
        .filter(c => c.spend > 0)
        .map(c => computeCampaignMetrics(c, roasTarget))
        .sort((a, b) => b.spend - a.spend)

    // ── Top/Bottom creatives ──────────────────────────────────────────────────
    const sortedByCpa = [...campaigns].filter(c => c.cpa !== null).sort((a, b) => (a.cpa ?? 0) - (b.cpa ?? 0))
    const top3 = sortedByCpa.slice(0, 3).map(c => ({
        name: c.name, thumbnail_url: c.thumbnail_url,
        cpa: c.cpa, ctr: c.ctr, results: c.results,
    }))
    const bottom3 = sortedByCpa.slice(-3).reverse().map(c => ({
        name: c.name, thumbnail_url: c.thumbnail_url,
        cpa: c.cpa, ctr: c.ctr, results: c.results,
    }))

    // ── Donut: spend distribution by campaign ──────────────────────────────────
    const spendDist = campaigns.slice(0, 8).map(c => ({
        name: c.name.length > 30 ? c.name.substring(0, 30) + '…' : c.name,
        value: parseFloat(c.spend.toFixed(2)),
        pct: totSpend > 0 ? parseFloat(((c.spend / totSpend) * 100).toFixed(1)) : 0,
    }))

    // ── Audience: aggregate from campaign-level age/gender if available ────────
    const ageMap = new Map<string, { spend: number; results: number }>()
    const genderMap = new Map<string, { spend: number; results: number }>()

    for (const row of rows) {
        const camps: any[] = row.meta_campaigns || []
        for (const c of camps) {
            if (c.age_gender_breakdown) {
                for (const entry of c.age_gender_breakdown) {
                    const age = entry.age || 'Desconocido'
                    const gender = entry.gender || 'unknown'
                    const s = safeNum(entry.spend)
                    const r = safeInt(entry.results || entry.leads || 0)
                    const ag = ageMap.get(age) || { spend: 0, results: 0 }
                    ag.spend += s; ag.results += r
                    ageMap.set(age, ag)
                    const gd = genderMap.get(gender) || { spend: 0, results: 0 }
                    gd.spend += s; gd.results += r
                    genderMap.set(gender, gd)
                }
            }
        }
    }

    const totalAudienceSpend = Array.from(ageMap.values()).reduce((s, v) => s + v.spend, 0)
    const totalAudienceResults = Array.from(ageMap.values()).reduce((s, v) => s + v.results, 0)

    const byAge = Array.from(ageMap.entries()).map(([group, v]) => ({
        group,
        spend_pct: totalAudienceSpend > 0 ? parseFloat(((v.spend / totalAudienceSpend) * 100).toFixed(1)) : 0,
        results_pct: totalAudienceResults > 0 ? parseFloat(((v.results / totalAudienceResults) * 100).toFixed(1)) : 0,
    }))

    const genderLabels: Record<string, string> = { male: 'Hombre', female: 'Mujer', unknown: 'Indeterminado' }
    const byGender = Array.from(genderMap.entries()).map(([g, v]) => ({
        gender: genderLabels[g] || g,
        spend_pct: totalAudienceSpend > 0 ? parseFloat(((v.spend / totalAudienceSpend) * 100).toFixed(1)) : 0,
        results_pct: totalAudienceResults > 0 ? parseFloat(((v.results / totalAudienceResults) * 100).toFixed(1)) : 0,
    }))

    // ── Previous month summary ─────────────────────────────────────────────────
    const pSpend = prev.reduce((s, r) => s + safeNum(r.meta_spend), 0)
    const pImpressions = prev.reduce((s, r) => s + safeInt(r.meta_impressions), 0)
    const pClicks = prev.reduce((s, r) => s + safeInt(r.meta_clicks), 0)
    const pReach = prev.reduce((s, r) => s + sumCampaignField(r, 'reach'), 0)
    const pLeads = prev.reduce((s, r) => s + sumCampaignField(r, 'leads'), 0)
    const pPurchases = prev.reduce((s, r) => s + sumCampaignField(r, 'purchases'), 0)
    const pResults = pLeads > 0 ? pLeads : pPurchases
    const pCpa = pResults > 0 ? pSpend / pResults : null
    const pCtr = pImpressions > 0 ? (pClicks / pImpressions) * 100 : null

    return NextResponse.json({
        client: {
            name: cliente.nombre,
            logo_url: cfg.logo_url || null,
            currency,
            roas_target: roasTarget,
        },
        summary: {
            spend: parseFloat(totSpend.toFixed(2)),
            reach: totReach,
            impressions: totImpressions,
            clicks: totClicks,
            link_clicks: totLinkClicks,
            results: totResults,
            leads: totLeads,
            purchases: totPurchases,
            landing_views: totLandingViews,
            cpa: cpa !== null ? parseFloat(cpa.toFixed(2)) : null,
            roas: roas !== null ? parseFloat(roas.toFixed(2)) : null,
            ctr: ctr !== null ? parseFloat(ctr.toFixed(2)) : null,
            cpm: cpm !== null ? parseFloat(cpm.toFixed(2)) : null,
        },
        daily,
        campaigns,
        spend_distribution: spendDist,
        audience: { by_age: byAge, by_gender: byGender },
        creatives: { top: top3, bottom: bottom3 },
        previous_month: {
            spend: parseFloat(pSpend.toFixed(2)),
            results: pResults,
            cpa: pCpa !== null ? parseFloat(pCpa.toFixed(2)) : null,
            roas: null,
            ctr: pCtr !== null ? parseFloat(pCtr.toFixed(2)) : null,
            reach: pReach,
        },
        notes: notasRow?.notas || null,
    })
}

export async function POST(req: NextRequest) {
    const { clientId, year, month, notas } = await req.json()
    if (!clientId || !year || !month) {
        return NextResponse.json({ error: 'clientId, year, month required' }, { status: 400 })
    }
    const supabase = await createAdminClient()
    const { error } = await supabase
        .from('reportes_mensuales')
        .upsert({ cliente_id: clientId, year, month, notas }, { onConflict: 'cliente_id,year,month' })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true })
}
