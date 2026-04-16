'use server'

import { createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { format, startOfMonth, endOfMonth, parseISO } from 'date-fns'

// ─── Templates ───────────────────────────────────────────────────────────────

export async function getReportTemplates() {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
        .from('report_templates')
        .select('*')
        .order('tipo', { ascending: true })
    if (error) return []
    return data || []
}

// ─── Monthly Reports List ─────────────────────────────────────────────────────

export async function getMonthlyReports(clienteId?: string) {
    const supabase = await createAdminClient()
    let query = supabase
        .from('monthly_reports')
        .select('*, cliente:clientes(id, nombre), template:report_templates(id, nombre, tipo)')
        .order('periodo', { ascending: false })
        .order('created_at', { ascending: false })

    if (clienteId) {
        query = query.eq('cliente_id', clienteId)
    }

    const { data, error } = await query
    if (error) return []
    return data || []
}

export async function getMonthlyReport(id: string) {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
        .from('monthly_reports')
        .select('*, cliente:clientes(id, nombre, config_api), template:report_templates(*)')
        .eq('id', id)
        .maybeSingle()
    if (error || !data) return null
    return data
}

// ─── Campaign Discovery ───────────────────────────────────────────────────────

/**
 * Scans meta_campaigns JSONB for a client/month, groups by campaign_id,
 * filters spend > 0, and returns a deduplicated campaign list.
 */
export async function discoverCampaigns(clienteId: string, periodo: string) {
    const supabase = await createAdminClient()

    const monthStart = format(startOfMonth(parseISO(`${periodo}-01`)), 'yyyy-MM-dd')
    const monthEnd = format(endOfMonth(parseISO(`${periodo}-01`)), 'yyyy-MM-dd')

    const { data: rows, error } = await supabase
        .from('metricas_diarias')
        .select('fecha, meta_campaigns')
        .eq('cliente_id', clienteId)
        .gte('fecha', monthStart)
        .lte('fecha', monthEnd)

    if (error || !rows) return []

    // Aggregate by campaign_id across all days in the month
    const campaignMap = new Map<string, {
        campaign_id: string | null
        name: string
        account_id: string
        spend: number
        leads: number
        purchases: number
        impressions: number
        days_active: number
    }>()

    for (const row of rows) {
        const campaigns = Array.isArray(row.meta_campaigns) ? row.meta_campaigns : []
        for (const c of campaigns) {
            const key = c.campaign_id || c.name || 'unknown'
            if (!campaignMap.has(key)) {
                campaignMap.set(key, {
                    campaign_id: c.campaign_id || null,
                    name: c.name || 'Desconocida',
                    account_id: c.account_id || '',
                    spend: 0,
                    leads: 0,
                    purchases: 0,
                    impressions: 0,
                    days_active: 0,
                })
            }
            const entry = campaignMap.get(key)!
            entry.spend += parseFloat(c.spend || '0') || 0
            entry.leads += parseInt(c.leads || '0') || 0
            entry.purchases += parseInt(c.purchases || '0') || 0
            entry.impressions += parseInt(c.impressions || '0') || 0
            if ((parseFloat(c.spend || '0') || 0) > 0) entry.days_active++
        }
    }

    // Filter: only campaigns with actual spend
    return Array.from(campaignMap.values())
        .filter(c => c.spend > 0)
        .sort((a, b) => b.spend - a.spend)
}

// ─── Create Report ────────────────────────────────────────────────────────────

export async function createMonthlyReport(payload: {
    cliente_id: string
    periodo: string
    template_id?: string
}) {
    const supabase = await createAdminClient()

    // Discover campaigns for this period
    const campaigns = await discoverCampaigns(payload.cliente_id, payload.periodo)

    const { data, error } = await supabase
        .from('monthly_reports')
        .insert({
            cliente_id: payload.cliente_id,
            periodo: payload.periodo,
            template_id: payload.template_id || null,
            estado: 'borrador',
            campaigns_discovered: campaigns,
            campaigns_included: campaigns, // all included by default
        })
        .select()
        .single()

    if (error) return { error: error.message }
    revalidatePath('/admin/reports')
    return { success: true, data }
}

// ─── Update Report ────────────────────────────────────────────────────────────

export async function updateMonthlyReport(id: string, payload: {
    template_id?: string
    campaigns_included?: any[]
    kpis_snapshot?: Record<string, any>
}) {
    const supabase = await createAdminClient()
    const { error } = await supabase
        .from('monthly_reports')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', id)
    if (error) return { error: error.message }
    revalidatePath('/admin/reports')
    revalidatePath(`/admin/reports/${id}`)
    return { success: true }
}

// ─── Workflow State Machine ───────────────────────────────────────────────────

const VALID_TRANSITIONS: Record<string, string> = {
    borrador: 'revision',
    revision: 'aprobado',
    aprobado: 'publicado',
}

export async function updateReportStatus(id: string, newStatus: string) {
    const supabase = await createAdminClient()

    const { data: report, error: fetchErr } = await supabase
        .from('monthly_reports')
        .select('estado, periodo, cliente_id, campaigns_included, template_id')
        .eq('id', id)
        .single()

    if (fetchErr || !report) return { error: 'Reporte no encontrado' }

    const expectedNext = VALID_TRANSITIONS[report.estado]
    if (newStatus !== expectedNext) {
        return { error: `Transición inválida: ${report.estado} → ${newStatus}` }
    }

    const updateData: Record<string, any> = {
        estado: newStatus,
        updated_at: new Date().toISOString(),
    }

    // On publish: generate a public_slug
    if (newStatus === 'publicado') {
        updateData.public_slug = `${report.cliente_id.slice(0, 8)}-${report.periodo}`
    }

    const { error } = await supabase
        .from('monthly_reports')
        .update(updateData)
        .eq('id', id)

    if (error) return { error: error.message }
    revalidatePath('/admin/reports')
    revalidatePath(`/admin/reports/${id}`)
    return { success: true, newStatus }
}

export async function revertReportStatus(id: string) {
    const supabase = await createAdminClient()
    const { data: report } = await supabase
        .from('monthly_reports')
        .select('estado')
        .eq('id', id)
        .single()
    if (!report) return { error: 'Reporte no encontrado' }

    const REVERSE: Record<string, string> = {
        revision: 'borrador',
        aprobado: 'revision',
        publicado: 'aprobado',
    }
    const prev = REVERSE[report.estado]
    if (!prev) return { error: 'Ya está en el estado inicial' }

    const updateData: Record<string, any> = { estado: prev, updated_at: new Date().toISOString() }
    if (report.estado === 'publicado') updateData.public_slug = null

    const { error } = await supabase
        .from('monthly_reports')
        .update(updateData)
        .eq('id', id)

    if (error) return { error: error.message }
    revalidatePath('/admin/reports')
    revalidatePath(`/admin/reports/${id}`)
    return { success: true }
}

export async function deleteMonthlyReport(id: string) {
    const supabase = await createAdminClient()
    const { error } = await supabase.from('monthly_reports').delete().eq('id', id)
    if (error) return { error: error.message }
    revalidatePath('/admin/reports')
    return { success: true }
}
