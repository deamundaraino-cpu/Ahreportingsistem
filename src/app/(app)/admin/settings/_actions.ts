'use server'

import { createClient, createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

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

    revalidatePath('/admin/settings')
    return { success: true, data: newClient }
}

export async function updateClienteConfig(id: string, config_api: any) {
    const supabase = await createAdminClient()

    const { error } = await supabase.from('clientes').update({ config_api }).eq('id', id)

    if (error) {
        console.error('Error updating config:', error)
        return { error: error.message }
    }

    revalidatePath(`/admin/settings/${id}`)
    revalidatePath('/admin/settings')
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

    revalidatePath('/admin/settings')
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

export async function refreshMetaCustomConversions(clienteId: string, metaConfig: any) {
    const hasMulti = metaConfig?.meta_accounts?.length > 0
    const hasLegacy = metaConfig?.meta_token && metaConfig?.meta_account_id
    if (!hasMulti && !hasLegacy) {
        return { error: 'El cliente no tiene conectada la API de Meta Ads.' }
    }

    const accountsToQuery: { account_id: string; token: string }[] = hasMulti
        ? metaConfig.meta_accounts
            .filter((a: any) => a.account_id)
            .map((a: any) => ({ account_id: a.account_id, token: a.token || metaConfig.meta_token || '' }))
        : [{ account_id: metaConfig.meta_account_id, token: metaConfig.meta_token }]

    try {
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
        const until = new Date().toISOString().split('T')[0]

        const allCustomKeys = new Set<string>()

        await Promise.all(
            accountsToQuery.map(async ({ account_id, token }) => {
                const actId = account_id.startsWith('act_') ? account_id : `act_${account_id}`
                const url = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                url.searchParams.append('access_token', token)
                url.searchParams.append('time_range', JSON.stringify({ since, until }))
                url.searchParams.append('fields', 'conversions')
                url.searchParams.append('level', 'account')

                const res = await fetch(url.toString())
                const data = await res.json()

                if (data.error) {
                    console.warn(`[refreshMeta] ${account_id} error: ${data.error.message}`)
                    return
                }

                if (data.data?.[0]?.conversions) {
                    data.data[0].conversions.forEach((cv: any) => {
                        const type: string = cv.action_type || ''
                        if (type.startsWith('offsite_conversion.fb_pixel_custom.')) {
                            const key = type.replace('offsite_conversion.fb_pixel_custom.', '').toLowerCase()
                            allCustomKeys.add(key)
                        }
                    })
                }
            })
        )

        if (allCustomKeys.size === 0) {
            return { success: true, count: 0, message: 'No se encontraron conversiones personalizadas con actividad en los últimos 30 días.' }
        }

        // Prepare data for upsert
        const catalogRows = Array.from(allCustomKeys).map((key) => {
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
            return {
                cliente_id: clienteId,
                conversion_key: key,
                label: `Lead ${label.replace('Lead', '').trim() || label}`,
                field_id: `meta_custom_${key}`,
                last_seen: new Date().toISOString().split('T')[0],
            }
        })

        const supabase = await createAdminClient()
        const { error: catErr } = await supabase
            .from('meta_conversiones_catalogo')
            .upsert(catalogRows, { onConflict: 'cliente_id,conversion_key' })

        if (catErr) {
            return { error: `Error guardando en BD: ${catErr.message}` }
        }

        return { 
            success: true, 
            count: allCustomKeys.size, 
            conversions: Array.from(allCustomKeys),
            message: `Se actualizaron ${allCustomKeys.size} conversiones personalizadas exitosamente.`
        }
    } catch (e: any) {
        return { error: e.message }
    }
}

export async function testTikTokConnection(accessToken: string, advertiserId: string) {
    if (!accessToken || !advertiserId) return { error: 'Faltan credenciales de TikTok' }

    try {
        const url = `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=["${advertiserId}"]`
        const res = await fetch(url, {
            headers: { 'Access-Token': accessToken }
        })
        const data = await res.json()

        if (data.code !== 0) {
            return { error: data.message || 'Error de conexión con TikTok' }
        }
        const advertiser = data.data?.list?.[0]
        return { success: true, name: advertiser?.advertiser_name }
    } catch (err: any) {
        return { error: err.message }
    }
}

// ─── Public Layout (Executive View) ──────────────────────────────────────────

export async function savePublicLayout(clienteId: string, payload: {
    tarjetas: any[]
    graficos: any[]
}) {
    const supabase = await createAdminClient()
    const { error } = await supabase
        .from('clientes')
        .update({ layout_publico: payload })
        .eq('id', clienteId)

    if (error) return { error: error.message }
    revalidatePath(`/report/${clienteId}`)
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}

export async function syncClienteMetrics(clienteId: string, startDate: string, endDate: string) {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const url = `${baseUrl}/api/worker?client_id=${clienteId}&start=${startDate}&end=${endDate}`
        const cronSecret = process.env.CRON_SECRET

        const res = await fetch(url, {
            headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
            cache: 'no-store',
        })

        const data = await res.json()

        if (!res.ok) return { error: data.error || 'Error al sincronizar' }

        const logs = (data.debugLogs || []) as string[]
        const metaLog = logs.find((l: string) => l.includes('[Meta]') && l.includes('Datos de campañas')) || ''
        const dbLog = logs.find((l: string) => l.includes('Mass Upsert exitoso')) || ''
        const errorLog = logs.find((l: string) => l.includes('❌')) || ''

        if (errorLog) return { error: errorLog }

        revalidatePath(`/dashboard/${clienteId}`)
        return {
            success: true,
            message: dbLog
                ? `✓ Sincronizado correctamente. ${metaLog}`
                : `Sync completado. Revisa los datos en el dashboard.`
        }
    } catch (e: any) {
        return { error: e.message }
    }
}

export async function getPublicLayout(clienteId: string) {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
        .from('clientes')
        .select('layout_publico')
        .eq('id', clienteId)
        .single()

    if (error) return null
    return data?.layout_publico || null
}
