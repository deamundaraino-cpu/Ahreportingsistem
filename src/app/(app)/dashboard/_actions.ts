'use server'

import { createAdminClient } from '@/utils/supabase/server'
import { getWeeksInRange } from '@/lib/date-utils'
import { revalidatePath } from 'next/cache'
import { format, addDays } from 'date-fns'

export async function getLeadsDiarios(clientId: string) {
    const supabase = await createAdminClient()
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const today = new Date().toISOString().split('T')[0]

    const { data, error } = await supabase
        .from('leads_diarios')
        .select('*')
        .eq('client_id', clientId)
        .gte('date', thirtyDaysAgo)
        .lte('date', today)
        .order('date', { ascending: true })

    if (error) return { data: null, error: error.message }
    return { data, error: null }
}

export async function getDashboardData(clientId: string, startStr: string, endStr: string) {
    const supabase = await createAdminClient()

    // Fetch client + global assigned layout + client tabs + conversions catalog + campaign groups
    const [clienteRes, clienteLayoutRes, tabsRes, conversionesRes, campaignGroupsRes] = await Promise.all([
        supabase.from('clientes')
            .select('*, global_layout:layouts_reporte(*)')
            .eq('id', clientId)
            .limit(1),
        supabase.from('clientes_layouts')
            .select('*')
            .eq('cliente_id', clientId)
            .maybeSingle(),
        supabase.from('cliente_tabs')
            .select('*')
            .eq('cliente_id', clientId)
            .order('orden', { ascending: true }),
        supabase.from('meta_conversiones_catalogo')
            .select('conversion_key, label, field_id')
            .eq('cliente_id', clientId)
            .order('label', { ascending: true }),
        supabase.from('campaign_groups')
            .select(`
                *,
                campaign_group_mappings (
                    id,
                    campaign_id,
                    campaign_name_pattern
                )
            `)
            .eq('cliente_id', clientId)
            .order('nombre', { ascending: true }),
    ])

    const cliente = clienteRes.data?.[0]
    if (!cliente) return null

    // Compute available platforms from client API config (used for attribution fallback)
    const cfg = (cliente.config_api as any) || {}
    const availablePlatforms = new Set<string>(['meta'])
    if (cfg.ga_property_id && cfg.ga_client_email) availablePlatforms.add('ga4')
    if (cfg.hotmart_basic || cfg.hotmart_token) availablePlatforms.add('hotmart')

    // Priority: client-specific layout → global assigned layout → null (classic)
    const layout = clienteLayoutRes.data || cliente.global_layout || null

    // Fetch all metrics + leads for that range
    const [metricsRes, leadsRes] = await Promise.all([
        supabase.from('metricas_diarias')
            .select('*')
            .eq('cliente_id', cliente.id)
            .gte('fecha', startStr)
            .lte('fecha', endStr)
            .order('fecha', { ascending: true }),
        supabase.from('leads_diarios')
            .select('*')
            .eq('client_id', cliente.id)
            .gte('date', startStr)
            .lte('date', endStr)
    ])

    // Merge leads data into metrics by date
    const leadsMap = new Map((leadsRes.data || []).map((l: any) => [l.date, l]))
    const metrics = (metricsRes.data || []).map((m: any) => {
        const leadDay = leadsMap.get(m.fecha)
        if (leadDay) {
            return {
                ...m,
                leads_totales: leadDay.leads_totales,
                leads_calificados: leadDay.leads_calificados,
                leads_no_calificados: leadDay.leads_no_calificados,
                tasa_calificacion: leadDay.tasa_calificacion,
            }
        }
        return m
    })

    // Fetch all global layouts so the selector modal has them available
    const { data: allLayouts } = await supabase.from('layouts_reporte').select('*').order('nombre')

    const weeks = getWeeksInRange(startStr, endStr)

    return {
        cliente,
        metrics: metrics || [],
        weeks,
        layout,
        allLayouts: allLayouts || [],
        clienteLayoutId: clienteLayoutRes.data?.id || null,
        tabs: tabsRes.data || [],
        conversionesCatalogo: conversionesRes.data || [],
        layoutPublico: cliente.layout_publico || null,
        availablePlatforms: Array.from(availablePlatforms),
        campaignGroups: campaignGroupsRes.data || [],
    }
}

// ─── Client layout mutation actions ─────────────────────────────────────────

/**
 * Clone a global layout template into clientes_layouts for a specific client.
 * If the client already has a custom layout, it gets replaced.
 */
export async function cloneLayoutForCliente(clienteId: string, globalLayoutId: string) {
    const supabase = await createAdminClient()

    // Fetch the global template
    const { data: template, error: tErr } = await supabase
        .from('layouts_reporte')
        .select('*')
        .eq('id', globalLayoutId)
        .single()

    if (tErr || !template) return { error: 'Plantilla no encontrada' }

    // Upsert into clientes_layouts (one row per client)
    const { data, error } = await supabase
        .from('clientes_layouts')
        .upsert(
            {
                cliente_id: clienteId,
                base_layout_id: globalLayoutId,
                nombre: template.nombre,
                columnas: template.columnas,
                tarjetas: template.tarjetas,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'cliente_id' }
        )
        .select()
        .single()

    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true, data }
}

/**
 * Save updated columns/cards for a client's personal layout.
 */
export async function saveClienteLayout(clienteId: string, payload: {
    columnas: any[];
    tarjetas: any[];
    graficos?: any[];
    text_blocks?: any[];
    custom_metrics?: any[];
    blocks_order?: string[];
}) {
    const supabase = await createAdminClient()

    const { error } = await supabase
        .from('clientes_layouts')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('cliente_id', clienteId)

    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

/**
 * Remove the client-specific layout so it falls back to global/classic.
 */
export async function resetClienteLayout(clienteId: string) {
    const supabase = await createAdminClient()
    await supabase.from('clientes_layouts').delete().eq('cliente_id', clienteId)
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

/**
 * Save or update a client tab.
 */
export async function saveClienteTab(clienteId: string, payload: {
    id?: string;
    nombre: string;
    keyword_meta: string;
    plantilla_id?: string;
    orden?: number;
    fecha_inicio?: string;
    fecha_finalizacion?: string;
    presupuesto_objetivo?: number;
    hotmart_funnel?: {
        enabled?: boolean
        principal_names?: string[]
        bump_names?: string[]
        upsell_names?: string[]
        payment_page_url?: string
        upsell_page_url?: string
    } | null;
}) {
    const supabase = await createAdminClient()

    // hotmart_funnel: undefined = no tocar (solo en edición); null o objeto = setear (incluyendo "deshabilitar")
    const baseFields: Record<string, any> = {
        nombre: payload.nombre,
        keyword_meta: payload.keyword_meta,
        plantilla_id: payload.plantilla_id || null,
        fecha_inicio: payload.fecha_inicio || null,
        fecha_finalizacion: payload.fecha_finalizacion || null,
        presupuesto_objetivo: payload.presupuesto_objetivo || null,
    }
    if (payload.hotmart_funnel !== undefined) {
        baseFields.hotmart_funnel = payload.hotmart_funnel
    }

    if (payload.id) {
        const { error } = await supabase
            .from('cliente_tabs')
            .update({ ...baseFields, updated_at: new Date().toISOString() })
            .eq('id', payload.id)
            .eq('cliente_id', clienteId)
        if (error) return { error: error.message }
    } else {
        const { error } = await supabase
            .from('cliente_tabs')
            .insert({
                cliente_id: clienteId,
                ...baseFields,
                orden: payload.orden || 0,
            })
        if (error) return { error: error.message }
    }

    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

/**
 * Delete a client tab.
 */
export async function deleteClienteTab(clienteId: string, tabId: string) {
    const supabase = await createAdminClient()
    const { error } = await supabase.from('cliente_tabs').delete().eq('id', tabId).eq('cliente_id', clienteId)
    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

/**
 * Save layout overrides (columns, cards) strictly for one tab.
 */
export async function saveTabOverrides(clienteId: string, tabId: string, payload: {
    columnas: any[] | null;
    tarjetas: any[] | null;
    graficos?: any[] | null;
    text_blocks?: any[] | null;
    custom_metrics?: any[] | null;
    blocks_order?: string[] | null;
}) {
    const supabase = await createAdminClient()
    const { error } = await supabase
        .from('cliente_tabs')
        .update({
            columnas: payload.columnas,
            tarjetas: payload.tarjetas,
            graficos: payload.graficos,
            text_blocks: payload.text_blocks,
            custom_metrics: payload.custom_metrics,
            blocks_order: payload.blocks_order,
            updated_at: new Date().toISOString()
        })
        .eq('id', tabId)
        .eq('cliente_id', clienteId)

    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

export async function updateLayoutPuzzleState(
    clienteId: string,
    tabId: string,
    payload: {
        blocks_order: string[]
        text_blocks: any[]
        full_layout?: {
            nombre: string
            columnas: any[]
            tarjetas: any[]
            graficos?: any[]
            custom_metrics?: any[]
            attribution_strategy?: string
        }
    }
) {
    const supabase = await createAdminClient()

    if (tabId && tabId !== 'general') {
        // Tab específico: solo actualizar puzzle state — no tocar columnas/tarjetas/graficos
        const { error } = await supabase
            .from('cliente_tabs')
            .update({
                blocks_order: payload.blocks_order,
                text_blocks: payload.text_blocks,
                updated_at: new Date().toISOString(),
            })
            .eq('id', tabId)
            .eq('cliente_id', clienteId)
        if (error) return { error: error.message }
        revalidatePath(`/dashboard/${clienteId}`)
        return { success: true }
    } else {
        // General tab: verificar si ya existe fila en clientes_layouts
        const { data: existing } = await supabase
            .from('clientes_layouts')
            .select('id')
            .eq('cliente_id', clienteId)
            .maybeSingle()

        if (existing) {
            // Fila existe: solo actualizar puzzle state
            const { error } = await supabase
                .from('clientes_layouts')
                .update({
                    blocks_order: payload.blocks_order,
                    text_blocks: payload.text_blocks,
                    updated_at: new Date().toISOString(),
                })
                .eq('cliente_id', clienteId)
            if (error) return { error: error.message }
        } else if (payload.full_layout) {
            // No existe fila: crear una copiando el layout activo + puzzle state
            const { error } = await supabase
                .from('clientes_layouts')
                .insert({
                    cliente_id: clienteId,
                    nombre: payload.full_layout.nombre || 'Dashboard',
                    columnas: payload.full_layout.columnas || [],
                    tarjetas: payload.full_layout.tarjetas || [],
                    graficos: payload.full_layout.graficos || null,
                    custom_metrics: payload.full_layout.custom_metrics || null,
                    attribution_strategy: payload.full_layout.attribution_strategy || null,
                    blocks_order: payload.blocks_order,
                    text_blocks: payload.text_blocks,
                })
            if (error) return { error: error.message }
        } else {
            return { error: 'No se pudo guardar: layout base no disponible' }
        }

        revalidatePath(`/dashboard/${clienteId}`)
        return { success: true }
    }
}


/**
 * Update a manual metric value in metricas_diarias.
 */
export async function updateManualMetric(clienteId: string, fecha: string, key: string, value: number) {
    const supabase = await createAdminClient()

    // Retrieve existing metric row for this date
    const { data: existing } = await supabase
        .from('metricas_diarias')
        .select('id, metricas_manuales')
        .eq('cliente_id', clienteId)
        .eq('fecha', fecha)
        .maybeSingle()

    const currentManuales = existing?.metricas_manuales || {}
    currentManuales[key] = value

    if (existing) {
        await supabase
            .from('metricas_diarias')
            .update({ metricas_manuales: currentManuales })
            .eq('id', existing.id)
    } else {
        await supabase
            .from('metricas_diarias')
            .insert({
                cliente_id: clienteId,
                fecha,
                metricas_manuales: currentManuales
            })
    }

    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

/**
 * Get total historical spend for a specific keyword filter (for budget calculations)
 */
export async function getTabTotalSpend(clienteId: string, keywordFilter: string, fechaInicio?: string, fechaFin?: string) {
    const supabase = await createAdminClient()
    let query = supabase
        .from('metricas_diarias')
        .select('meta_campaigns, meta_spend')
        .eq('cliente_id', clienteId)
    if (fechaInicio) query = query.gte('fecha', fechaInicio)
    if (fechaFin) query = query.lte('fecha', fechaFin)
    const { data: metrics } = await query

    if (!metrics) return 0

    let totalSpent = 0
    metrics.forEach(row => {
        if (!keywordFilter || !row.meta_campaigns) {
             totalSpent += parseFloat(row.meta_spend || '0')
        } else {
            const kw = keywordFilter.toLowerCase()
            const matching = (Array.isArray(row.meta_campaigns) ? row.meta_campaigns : [])
                .filter((c: any) => c.name?.toLowerCase().includes(kw))
            totalSpent += matching.reduce((s: number, c: any) => s + parseFloat(c.spend || '0'), 0)
        }
    })
    return totalSpent
}

/**
 * Support Tickets Actions
 */

export async function getSoporteTickets(clienteId: string) {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
        .from('soporte_tickets')
        .select('*')
        .eq('cliente_id', clienteId)
        .order('fecha_solicitud', { ascending: false })

    if (error) return { data: null, error: error.message }
    return { data, error: null }
}

export async function createSoporteTicket(payload: {
    cliente_id: string
    nombre_solicitante: string
    requerimiento: string
    observaciones?: string
    prioridad: number
}) {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
        .from('soporte_tickets')
        .insert({
            ...payload,
            estado: 'abierto'
        })
        .select()
        .single()

    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${payload.cliente_id}`)
    return { success: true, data }
}

export async function updateSoporteTicket(ticketId: string, clienteId: string, payload: {
    responsable?: string
    fecha_entrega?: string
    prioridad?: number
    estado?: string
    observaciones?: string
}) {
    const supabase = await createAdminClient()
    const { error } = await supabase
        .from('soporte_tickets')
        .update({
            ...payload,
            updated_at: new Date().toISOString()
        })
        .eq('id', ticketId)
        .eq('cliente_id', clienteId)

    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

/**
 * Public Mirror Dashboard data retrieval
 */
export async function getMirrorDashboardData(token: string, from?: string, to?: string) {
    const supabase = await createAdminClient()

    // 1. Resolve token: is it a tab-specific token?
    const { data: tab } = await supabase
        .from('cliente_tabs')
        .select('*, cliente:clientes(*, global_layout:layouts_reporte(*))')
        .eq('public_token', token)
        .maybeSingle()

    let cliente: any = null
    let activeTabObj: any = null
    let layout: any = null

    if (tab) {
        cliente = tab.cliente
        activeTabObj = tab
        // Use tab override if available
        if (tab.columnas && tab.tarjetas) {
            layout = {
                nombre: tab.nombre,
                columnas: tab.columnas,
                tarjetas: tab.tarjetas,
                graficos: tab.graficos,
                blocks_order: tab.blocks_order,
                text_blocks: tab.text_blocks,
                custom_metrics: tab.custom_metrics,
            }
        } else if (tab.plantilla_id) {
            const { data: global } = await supabase.from('layouts_reporte').select('*').eq('id', tab.plantilla_id).single()
            layout = global
        }
    } else {
        // 2. Resolve token: is it a client-specific (general tab) token?
        const { data: c } = await supabase
            .from('clientes')
            .select('*, global_layout:layouts_reporte(*)')
            .eq('public_token', token)
            .maybeSingle()
        
        if (!c) return { error: 'Enlace no válido o expirado' }
        
        cliente = c
        // Fetch client-specific layout
        const { data: cl } = await supabase.from('clientes_layouts').select('*').eq('cliente_id', cliente.id).maybeSingle()
        layout = cl || cliente.global_layout || null
    }

    if (!cliente) return { error: 'Cliente no encontrado' }

    // Use tab dates only if not provided in URL
    const startStr = from || activeTabObj?.fecha_inicio || format(addDays(new Date(), -30), 'yyyy-MM-dd')
    const endStr = to || activeTabObj?.fecha_finalizacion || format(new Date(), 'yyyy-MM-dd')

    // Fetch all metrics + leads for that range (identical to getDashboardData)
    const [metricsRes, leadsRes, conversionesRes, campaignGroupsRes, tabsRes, allLayoutsRes] = await Promise.all([
        supabase.from('metricas_diarias')
            .select('*')
            .eq('cliente_id', cliente.id)
            .gte('fecha', startStr)
            .lte('fecha', endStr)
            .order('fecha', { ascending: true }),
        supabase.from('leads_diarios')
            .select('*')
            .eq('client_id', cliente.id)
            .gte('date', startStr)
            .lte('date', endStr),
        supabase.from('meta_conversiones_catalogo')
            .select('conversion_key, label, field_id')
            .eq('cliente_id', cliente.id)
            .order('label', { ascending: true }),
        supabase.from('campaign_groups')
            .select(`
                *,
                campaign_group_mappings (id, campaign_id, campaign_name_pattern)
            `)
            .eq('cliente_id', cliente.id)
            .order('nombre', { ascending: true }),
        supabase.from('cliente_tabs').select('*').eq('cliente_id', cliente.id).order('position', { ascending: true }),
        supabase.from('layouts_reporte').select('*').order('nombre'),
    ])

    const leadsMap = new Map((leadsRes.data || []).map((l: any) => [l.date, l]))
    const metrics = (metricsRes.data || []).map((m: any) => {
        const leadDay = leadsMap.get(m.fecha)
        return leadDay ? { ...m, ...leadDay } : m
    })

    const weeks = getWeeksInRange(startStr, endStr)
    const availablePlatforms = new Set<string>(['meta'])
    const cfg = (cliente.config_api as any) || {}
    if (cfg.ga_property_id) availablePlatforms.add('ga4')
    if (cfg.hotmart_token) availablePlatforms.add('hotmart')

    // Filter tabs by public_tab_ids if configured on client token
    let allTabs = tabsRes.data || []
    let defaultActiveTabId: string = activeTabObj?.id || 'general'
    if (!activeTabObj) {
        const publicConfig = cliente.layout_publico as any
        if (publicConfig?.type === 'tab_mirror' && Array.isArray(publicConfig?.tab_ids) && publicConfig.tab_ids.length > 0) {
            allTabs = allTabs.filter((t: any) => publicConfig.tab_ids.includes(t.id))
            if (allTabs.length > 0) defaultActiveTabId = allTabs[0].id
        }
    }

    return {
        data: {
            cliente,
            metrics: metrics || [],
            weeks,
            layout,
            tabs: allTabs,
            activeTabId: defaultActiveTabId,
            allLayouts: allLayoutsRes.data || [],
            conversionesCatalogo: conversionesRes.data || [],
            availablePlatforms: Array.from(availablePlatforms),
            campaignGroups: campaignGroupsRes.data || [],
            isMirror: true
        },
        error: null
    }
}

export async function savePublicTabConfig(clienteId: string, tabIds: string[]) {
    const supabase = await createAdminClient()
    const payload = tabIds.length > 0 ? { type: 'tab_mirror', tab_ids: tabIds } : null
    const { error } = await supabase
        .from('clientes')
        .update({ layout_publico: payload })
        .eq('id', clienteId)
    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

export async function getOrCreatePublicToken(id: string, type: 'client' | 'tab') {
    const supabase = await createAdminClient()
    const table = type === 'client' ? 'clientes' : 'cliente_tabs'
    
    // 1. Try to fetch existing
    const { data: existing } = await supabase
        .from(table)
        .select('public_token')
        .eq('id', id)
        .maybeSingle()
    
    if (existing?.public_token) return { token: existing.public_token }

    // 2. Generate new one
    const newToken = crypto.randomUUID()
    const { error } = await supabase
        .from(table)
        .update({ public_token: newToken })
        .eq('id', id)
    
    if (error) return { error: error.message }
    return { token: newToken }
}
