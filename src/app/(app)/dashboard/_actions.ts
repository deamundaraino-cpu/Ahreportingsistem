'use server'

import { createAdminClient } from '@/utils/supabase/server'
import { getWeeksInRange } from '@/lib/date-utils'
import { revalidatePath } from 'next/cache'

export async function getDashboardData(clientId: string, startStr: string, endStr: string) {
    const supabase = await createAdminClient()

    // Fetch client + global assigned layout + client tabs + conversions catalog
    const [clienteRes, clienteLayoutRes, tabsRes, conversionesRes] = await Promise.all([
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
    ])

    const cliente = clienteRes.data?.[0]
    if (!cliente) return null

    // Priority: client-specific layout → global assigned layout → null (classic)
    const layout = clienteLayoutRes.data || cliente.global_layout || null

    // Fetch all metrics for that range
    const { data: metrics } = await supabase.from('metricas_diarias')
        .select('*')
        .eq('cliente_id', cliente.id)
        .gte('fecha', startStr)
        .lte('fecha', endStr)
        .order('fecha', { ascending: true })

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
}) {
    const supabase = await createAdminClient()

    if (payload.id) {
        const { error } = await supabase
            .from('cliente_tabs')
            .update({
                nombre: payload.nombre,
                keyword_meta: payload.keyword_meta,
                plantilla_id: payload.plantilla_id || null,
                fecha_inicio: payload.fecha_inicio || null,
                fecha_finalizacion: payload.fecha_finalizacion || null,
                presupuesto_objetivo: payload.presupuesto_objetivo || null,
                updated_at: new Date().toISOString()
            })
            .eq('id', payload.id)
            .eq('cliente_id', clienteId)
        if (error) return { error: error.message }
    } else {
        const { error } = await supabase
            .from('cliente_tabs')
            .insert({
                cliente_id: clienteId,
                nombre: payload.nombre,
                keyword_meta: payload.keyword_meta,
                plantilla_id: payload.plantilla_id || null,
                fecha_inicio: payload.fecha_inicio || null,
                fecha_finalizacion: payload.fecha_finalizacion || null,
                presupuesto_objetivo: payload.presupuesto_objetivo || null,
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
}) {
    const supabase = await createAdminClient()
    const { error } = await supabase
        .from('cliente_tabs')
        .update({
            columnas: payload.columnas,
            tarjetas: payload.tarjetas,
            graficos: payload.graficos,
            updated_at: new Date().toISOString()
        })
        .eq('id', tabId)
        .eq('cliente_id', clienteId)

    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
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
export async function getTabTotalSpend(clienteId: string, keywordFilter: string) {
    const supabase = await createAdminClient()
    const { data: metrics } = await supabase
        .from('metricas_diarias')
        .select('meta_campaigns, meta_spend')
        .eq('cliente_id', clienteId)

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
