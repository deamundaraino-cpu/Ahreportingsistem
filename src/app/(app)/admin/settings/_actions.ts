'use server'

import { createClient, createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

export async function getClientes() {
    const supabase = await createAdminClient()
    const { data: clientes, error } = await supabase.from('clientes').select('*, layout:layouts_reporte(id, nombre)').order('created_at', { ascending: false })

    if (error) {
        console.error('Error fetching clients:', error)
        return []
    }

    return clientes
}

export async function getCliente(id: string) {
    const supabase = await createAdminClient()
    const { data: cliente, error } = await supabase.from('clientes').select('*, layout:layouts_reporte(*)').eq('id', id).single()

    if (error) {
        console.error('Error fetching client:', error)
        return null
    }

    return cliente
}

export async function createCliente(data: { nombre: string }) {
    const supabase = await createAdminClient()

    const { data: newClient, error } = await supabase.from('clientes').insert([
        { nombre: data.nombre, config_api: {} }
    ]).select().single()

    if (error) {
        console.error('Error creating client:', error)
        return { error: error.message }
    }

    revalidatePath('/admin/clientes')
    return { success: true, data: newClient }
}

export async function updateClienteConfig(id: string, config_api: any) {
    const supabase = await createAdminClient()

    const { error } = await supabase.from('clientes').update({ config_api }).eq('id', id)

    if (error) {
        console.error('Error updating config:', error)
        return { error: error.message }
    }

    revalidatePath(`/admin/clientes/${id}`)
    revalidatePath('/admin/clientes')
    return { success: true }
}

export async function assignLayoutToCliente(clienteId: string, layoutId: string | null) {
    const supabase = await createAdminClient()
    const { error } = await supabase.from('clientes').update({ layout_id: layoutId }).eq('id', clienteId)
    if (error) return { error: error.message }
    revalidatePath(`/admin/settings/${clienteId}`)
    return { success: true }
}

export async function deleteCliente(id: string) {
    const supabaseStore = await createClient()
    const { data: { user } } = await supabaseStore.auth.getUser()

    if (!user) return { error: 'No autorizado' }

    const { data: profile } = await supabaseStore.from('user_profiles').select('role').eq('id', user.id).single()
    // if (profile?.role !== 'admin') return { error: 'Solo los administradores pueden borrar clientes' }

    const supabase = await createAdminClient()
    const { error } = await supabase.from('clientes').delete().eq('id', id)

    if (error) {
        console.error('Error deleting client:', error)
        return { error: error.message }
    }

    revalidatePath('/admin/clientes')
    return { success: true }
}

// ─── Layout CRUD ────────────────────────────────────────────────────────────

export async function getLayouts() {
    const supabase = await createAdminClient()
    const { data, error } = await supabase.from('layouts_reporte').select('*').order('nombre')
    if (error) return []
    return data
}

export async function createLayout(payload: { nombre: string; descripcion?: string; columnas: any[]; tarjetas: any[] }) {
    const supabase = await createAdminClient()
    const { data, error } = await supabase.from('layouts_reporte').insert([payload]).select().single()
    if (error) return { error: error.message }
    revalidatePath('/admin/settings')
    return { success: true, data }
}

export async function updateLayout(id: string, payload: { nombre?: string; descripcion?: string; columnas?: any[]; tarjetas?: any[] }) {
    const supabase = await createAdminClient()
    const { error } = await supabase.from('layouts_reporte').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) return { error: error.message }
    revalidatePath('/admin/settings')
    return { success: true }
}

export async function deleteLayout(id: string) {
    const supabaseStore = await createClient()
    const { data: { user } } = await supabaseStore.auth.getUser()

    if (!user) return { error: 'No autorizado' }

    const { data: profile } = await supabaseStore.from('user_profiles').select('role').eq('id', user.id).single()
    // if (profile?.role !== 'admin') return { error: 'Solo los administradores pueden borrar layouts' }

    const supabase = await createAdminClient()
    const { error } = await supabase.from('layouts_reporte').delete().eq('id', id)
    if (error) return { error: error.message }
    revalidatePath('/admin/settings')
    return { success: true }
}

// ─── Connection Tests ───────────────────────────────────────────────────────

export async function testMetaConnection(token: string, accountId: string) {
    if (!token || !accountId) return { error: 'Faltan credenciales' }

    try {
        const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`
        const url = `https://graph.facebook.com/v19.0/${actId}?fields=name&access_token=${token}`
        const res = await fetch(url)
        const data = await res.json()

        if (data.error) {
            return { error: data.error.message }
        }
        return { success: true, name: data.name }
    } catch (err: any) {
        return { error: err.message }
    }
}

export async function testHotmartConnection(config: any) {
    let accessToken = config.hotmart_token

    try {
        if (config.hotmart_basic) {
            const params = new URLSearchParams()
            params.append('grant_type', 'client_credentials')

            const res = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${config.hotmart_basic}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
            })
            const data = await res.json()
            if (data.error) return { error: data.error_description || data.error }
            accessToken = data.access_token
        }

        if (!accessToken) return { error: 'No hay token disponible' }

        const res = await fetch('https://developers.hotmart.com/payments/api/v1/sales/history?page_size=1', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        })
        const data = await res.json()
        if (res.status !== 200) return { error: data.error_description || 'Error de conexión' }

        return { success: true }
    } catch (err: any) {
        return { error: err.message }
    }
}

export async function testGA4Connection(config: any) {
    if (!config.ga_property_id || !config.ga_client_email || !config.ga_private_key) {
        return { error: 'Faltan credenciales de GA4' }
    }

    try {
        const { BetaAnalyticsDataClient } = require('@google-analytics/data')
        const formattedPrivateKey = config.ga_private_key.replace(/\\n/g, '\n')
        const analyticsDataClient = new BetaAnalyticsDataClient({
            credentials: {
                client_email: config.ga_client_email,
                private_key: formattedPrivateKey
            }
        })

        const [metadata] = await analyticsDataClient.getMetadata({
            name: `properties/${config.ga_property_id}/metadata`
        })

        return { success: true }
    } catch (err: any) {
        return { error: err.message }
    }
}
