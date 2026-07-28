'use server'

import { createClient, createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { BetaAnalyticsDataClient } from '@google-analytics/data'
import type {
    ConversionesConfig, DriveSheet, SheetTabConfig, SheetTabInfo,
    DetectedColumn, SheetSyncStatus,
} from '@/lib/integrations/google-sheets-conversiones'
import type { GA4Property } from '@/lib/integrations/google-analytics'
import type { SheetCampoDef, SheetCampoVistaDef, CampoValorCrudo } from '@/lib/sheets/campos'
import type { FuenteColumnas } from '@/lib/sheets/campos-db'

export async function getClientes() {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    const adminSupabase = await createAdminClient()

    if (user) {
        const { data: profile } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('id', user.id)
            .single()

        const role = profile?.role ?? 'viewer'

        if (role === 'trafficker') {
            // Only return clients assigned to this user
            const { data: assignments } = await adminSupabase
                .from('user_client_assignments')
                .select('client_id')
                .eq('user_id', user.id)

            const clientIds = (assignments ?? []).map((a: { client_id: string }) => a.client_id)

            if (clientIds.length === 0) return []

            const { data: clientes, error } = await adminSupabase
                .from('clientes')
                .select('*, layout:layouts_reporte(id, nombre)')
                .in('id', clientIds)
                .order('created_at', { ascending: false })

            if (error) return []
            return clientes
        }
    }

    const { data: clientes, error } = await adminSupabase
        .from('clientes')
        .select('*, layout:layouts_reporte(id, nombre)')
        .order('created_at', { ascending: false })

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

    // ─── GA4 Private Key Sanitization ──────────────────────────────────────────
    if (config_api?.ga_private_key) {
        let key = config_api.ga_private_key
        // Si el frontend envía la llave con los caracteres literales "\n" (json escape), los transformamos a saltos reales
        if (key.includes('\\n')) {
            key = key.replace(/\\n/g, '\n')
        }
        
        // Validación básica de formato
        if (!key.includes('BEGIN PRIVATE KEY') || !key.includes('END PRIVATE KEY')) {
            return { error: 'El formato de la Private Key de GA4 es inválido. Sube el archivo JSON original.' }
        }
        config_api.ga_private_key = key
    }

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

    // TODO: Implement role-based access control
    // const { data: profile } = await supabaseStore.from('user_profiles').select('role').eq('id', user.id).single()
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

export async function createLayout(payload: { nombre: string; descripcion?: string; columnas: any[]; tarjetas: any[]; source_mapping?: Record<string, string>; attribution_strategy?: string }) {
    const supabase = await createAdminClient()
    const { data, error } = await supabase.from('layouts_reporte').insert([payload]).select().single()
    if (error) return { error: error.message }
    revalidatePath('/admin/settings')
    return { success: true, data }
}

export async function updateLayout(id: string, payload: { nombre?: string; descripcion?: string; columnas?: any[]; tarjetas?: any[]; source_mapping?: Record<string, string>; attribution_strategy?: string }) {
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

    // TODO: Implement role-based access control
    // const { data: profile } = await supabaseStore.from('user_profiles').select('role').eq('id', user.id).single()
    // if (profile?.role !== 'admin') return { error: 'Solo los administradores pueden borrar layouts' }

    const supabase = await createAdminClient()
    const { error } = await supabase.from('layouts_reporte').delete().eq('id', id)
    if (error) return { error: error.message }
    revalidatePath('/admin/settings')
    return { success: true }
}

// ─── Connection Tests ───────────────────────────────────────────────────────

export async function testGA4Connection(config: any) {
    if (!config.ga_property_id) {
        return { error: 'Falta el Property ID de Google Analytics 4.' }
    }

    // Misma precedencia que el worker: OAuth de agencia primero, service account
    // como fallback legacy. Antes esta prueba solo sabía usar service account, así
    // que fallaba en clientes configurados por OAuth (que son el modo recomendado).
    const { hasAgencyGoogleConnection, getAgencyAccessToken } = await import('@/lib/integrations/google-auth')
    const useAgencyOAuth = await hasAgencyGoogleConnection()
    const hasServiceAccount = !!(config.ga_client_email && config.ga_private_key)

    if (!useAgencyOAuth && !hasServiceAccount) {
        return { error: 'No hay conexión de Google de la agencia ni credenciales de Service Account. Conecta la cuenta en Ajustes → Conexión Google.' }
    }

    try {
        const propertyName = config.ga_property_id.startsWith('properties/')
            ? config.ga_property_id
            : `properties/${config.ga_property_id}`

        let client: BetaAnalyticsDataClient
        if (useAgencyOAuth) {
            client = new BetaAnalyticsDataClient({ authClient: await getAgencyAccessToken() as any })
        } else {
            let cleanKey = config.ga_private_key
            if (cleanKey.includes('\\n')) {
                cleanKey = cleanKey.replace(/\\n/g, '\n')
            }
            client = new BetaAnalyticsDataClient({
                credentials: {
                    client_email: config.ga_client_email,
                    private_key: cleanKey,
                    project_id: config.ga_project_id
                }
            })
        }

        // Llamada mínima: pedir 1 día de sesiones
        const [response] = await client.runReport({
            property: propertyName,
            dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
            metrics: [{ name: 'sessions' }],
        })

        const via = useAgencyOAuth ? 'OAuth de agencia' : 'Service Account'
        const sessions = response.rows?.[0]?.metricValues?.[0]?.value || '0'
        return {
            success: true,
            message: `Conexión exitosa vía ${via}. Sesiones ayer: ${sessions}`,
        }
    } catch (err: any) {
        // Mapeo de errores amigables
        const msg = err.message || ''
        if (msg.includes('PERMISSION_DENIED') || msg.includes('403')) {
            return useAgencyOAuth
                ? { error: `⛔ Sin permisos. La cuenta de Google de la agencia no tiene acceso a esta propiedad. Dale rol "Lector" en GA4 → Administrar → Gestión de acceso a la propiedad.` }
                : { error: '⛔ Sin permisos. Verifica que el email de servicio tenga rol "Lector" en GA4 → Admin → Gestión de acceso a la propiedad.' }
        }
        if (msg.includes('NOT_FOUND') || msg.includes('404')) {
            return { error: '❌ Property ID no encontrado. Verifica el ID numérico en GA4 → Administrar → Detalles de la propiedad.' }
        }
        if (msg.includes('UNAUTHENTICATED') || msg.includes('invalid_grant')) {
            return { error: '🔑 Credenciales inválidas. Verifica que el JSON de la cuenta de servicio sea correcto y no esté expirado.' }
        }
        return { error: `Error: ${msg}` }
    }
}

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

// Lista las ad accounts disponibles con el token guardado (sin re-hacer OAuth).
// Devuelve [{ account_id: 'act_XXX', name }] para que la UI las agregue a meta_accounts[].
export async function fetchMetaAdAccounts(token: string) {
    if (!token) return { error: 'Falta el token de Meta' }

    try {
        const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=account_id,name&limit=200&access_token=${token}`
        const res = await fetch(url)
        const data = await res.json()

        if (data.error) {
            return { error: data.error.message }
        }

        const accounts = (data.data ?? []).map((a: any) => {
            const actId = String(a.account_id || '').startsWith('act_') ? String(a.account_id) : `act_${a.account_id}`
            return { account_id: actId, name: a.name || actId }
        })
        return { success: true, accounts }
    } catch (err: any) {
        return { error: err.message }
    }
}

// Lista las cuentas publicitarias disponibles con el token de TikTok guardado (sin re-hacer OAuth).
// Devuelve [{ advertiser_id, name }] para que la UI las agregue a tiktok_accounts[].
// El token solo trae IDs, así que usamos oauth2/advertiser/get/ para obtener también el nombre.
export async function fetchTikTokAdAccounts(token: string) {
    if (!token) return { error: 'Falta el token de TikTok' }

    try {
        const appId = process.env.TIKTOK_APP_ID!
        const secret = process.env.TIKTOK_APP_SECRET!
        const url = `https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?app_id=${appId}&secret=${secret}&access_token=${token}`
        const res = await fetch(url)
        const data = await res.json()

        if (data.code !== 0) {
            return { error: data.message || 'Error obteniendo cuentas de TikTok' }
        }

        const accounts = (data.data?.list ?? []).map((a: any) => ({
            advertiser_id: a.advertiser_id,
            name: a.advertiser_name || `Cuenta ${a.advertiser_id}`,
        }))
        return { success: true, accounts }
    } catch (err: any) {
        return { error: err.message }
    }
}

export async function testHotmartConnection(config: any, clienteId?: string) {
    // Persiste hotmart_connection_status/last_checked_at en config_api del cliente
    // (read-modify-write para no clobberear otras claves). Best-effort: no rompe el test.
    const persistStatus = async (status: 'connected' | 'error') => {
        if (!clienteId) return
        try {
            const admin = await createAdminClient()
            const { data: row } = await admin.from('clientes').select('config_api').eq('id', clienteId).single()
            if (!row) return
            await admin.from('clientes').update({
                config_api: { ...row.config_api, hotmart_connection_status: status, hotmart_last_checked_at: new Date().toISOString() },
            }).eq('id', clienteId)
        } catch { /* best-effort */ }
    }

    let accessToken = config.hotmart_token

    // Auto-compute Basic Auth from client_id + client_secret if not explicitly set.
    // En modo HotConnect, se usa el access_token guardado directamente.
    const hotmartBasic = config.hotmart_auth_mode === 'hotconnect'
        ? null
        : config.hotmart_basic ||
        (config.hotmart_client_id && config.hotmart_client_secret
            ? Buffer.from(`${config.hotmart_client_id}:${config.hotmart_client_secret}`).toString('base64')
            : null)
    if (config.hotmart_auth_mode === 'hotconnect') {
        accessToken = config.hotmart_access_token || accessToken
    }

    try {
        if (hotmartBasic) {
            const params = new URLSearchParams()
            params.append('grant_type', 'client_credentials')

            const res = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${hotmartBasic}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: params.toString()
            })
            const data = await res.json()
            if (data.error) { await persistStatus('error'); return { error: data.error_description || data.error } }
            accessToken = data.access_token
        }

        if (!accessToken) { await persistStatus('error'); return { error: 'No hay token disponible. Configura Client ID y Client Secret.' } }

        // Hotmart requires start_date and end_date; use last 7 days as a probe
        const now = Date.now()
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
        const url = new URL('https://developers.hotmart.com/payments/api/v1/sales/history')
        url.searchParams.set('start_date', sevenDaysAgo.toString())
        url.searchParams.set('end_date', now.toString())
        url.searchParams.set('max_results', '1')

        const res = await fetch(url.toString(), {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        })
        const data = await res.json()
        if (res.status !== 200) { await persistStatus('error'); return { error: data.message || data.error_description || 'Error de conexión' } }

        await persistStatus('connected')
        return { success: true }
    } catch (err: any) {
        await persistStatus('error')
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
                        } else if (type.startsWith('offsite_conversion.custom.')) {
                            const key = type.replace('offsite_conversion.custom.', '').toLowerCase()
                            allCustomKeys.add(key)
                        }
                    })
                }
            })
        )

        if (allCustomKeys.size === 0) {
            return { success: true, count: 0, message: 'No se encontraron conversiones personalizadas con actividad en los últimos 30 días.' }
        }

        // Fetch custom conversion names to get friendly names
        const customConversionNames: Record<string, string> = {}
        await Promise.all(
            accountsToQuery.map(async ({ account_id, token }) => {
                try {
                    const actId = account_id.startsWith('act_') ? account_id : `act_${account_id}`
                    const ccUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/customconversions`)
                    ccUrl.searchParams.append('access_token', token)
                    ccUrl.searchParams.append('fields', 'id,name')
                    const res = await fetch(ccUrl.toString())
                    const ccData = await res.json()
                    if (ccData.data) {
                        ccData.data.forEach((cc: any) => {
                            customConversionNames[cc.id] = cc.name
                        })
                    }
                } catch (e: any) {
                    console.warn(`[refreshMeta customconversions] error:`, e?.message)
                }
            })
        )

        // Prepare data for upsert
        const catalogRows = Array.from(allCustomKeys).map((key) => {
            const isNumeric = /^\d+$/.test(key)
            let label = ''
            if (isNumeric && customConversionNames[key]) {
                label = customConversionNames[key]
            } else {
                const cleanKey = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim()
                label = `Lead ${cleanKey.replace('Lead', '').trim() || cleanKey}`
            }
            return {
                cliente_id: clienteId,
                conversion_key: key,
                label: label,
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

        // ── También sincronizar Google Sheets si el cliente lo tiene configurado ──
        const supabase = await createAdminClient()
        const { data: cliente } = await supabase
            .from('clientes')
            .select('config_api')
            .eq('id', clienteId)
            .single()

        const gsConfig = cliente?.config_api?.google_sheets
        if (gsConfig?.sheet_url) {
            try {
                await fetch(`${baseUrl}/api/admin/sync-google-sheets`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId: clienteId }),
                    cache: 'no-store',
                })
            } catch (gsErr) {
                console.error('[syncClienteMetrics] Google Sheets sync error:', gsErr)
                // No bloqueamos el resultado principal si falla GSheets
            }
        }

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

// ─── Google Sheets Sync ────────────────────────────────────────────────────

// ─── Budget Alerts ────────────────────────────────────────────────────────────

export interface ActiveAlert {
  tabId: string
  tabNombre: string
  clienteId: string
  clienteNombre: string
  presupuestoObjetivo: number
  level: 90 | 100
  sentAt: string
}

export async function getActiveAlerts(): Promise<ActiveAlert[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const adminSupabase = await createAdminClient()

  let allowedClientIds: string[] | null = null

  if (user) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single()

    if (profile?.role === 'trafficker') {
      const { data: assignments } = await adminSupabase
        .from('user_client_assignments')
        .select('client_id')
        .eq('user_id', user.id)
      allowedClientIds = (assignments ?? []).map((a: { client_id: string }) => a.client_id)
      if (allowedClientIds.length === 0) return []
    }
  }

  let query = adminSupabase
    .from('cliente_tabs')
    .select('id, nombre, cliente_id, presupuesto_objetivo, alert_sent_at_90, alert_sent_at_100, clientes(nombre)')
    .eq('archived', false)
    .not('presupuesto_objetivo', 'is', null)
    .or('alert_sent_at_90.not.is.null,alert_sent_at_100.not.is.null')

  if (allowedClientIds) {
    query = query.in('cliente_id', allowedClientIds)
  }

  const { data, error } = await query.order('alert_sent_at_100', { ascending: false, nullsFirst: false })

  if (error || !data) return []

  return data.map((row: any) => ({
    tabId: row.id,
    tabNombre: row.nombre,
    clienteId: row.cliente_id,
    clienteNombre: (row.clientes as any)?.nombre ?? row.cliente_id,
    presupuestoObjetivo: row.presupuesto_objetivo,
    level: row.alert_sent_at_100 ? 100 : 90,
    sentAt: row.alert_sent_at_100 ?? row.alert_sent_at_90,
  }))
}

export async function syncGoogleSheets(clienteId: string) {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const res = await fetch(`${baseUrl}/api/admin/sync-google-sheets`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ clientId: clienteId }),
            cache: 'no-store',
        })

        const data = await res.json()

        if (!res.ok) {
            return { error: data.error || 'Error al sincronizar Google Sheets' }
        }

        revalidatePath(`/admin/settings/${clienteId}`)
        return { success: true, ...data }
    } catch (e: any) {
        console.error('Google Sheets sync error:', e)
        return { error: e.message || 'Error al sincronizar Google Sheets' }
    }
}

// ─── Google OAuth (conexión a nivel agencia) ─────────────────────────────────

// Estado de la conexión OAuth global de Google (Analytics + Sheets).
export async function getGoogleConnectionStatus() {
    const { getGoogleIntegration } = await import('@/lib/integrations/google-auth')
    const row = await getGoogleIntegration()
    return {
        connected: !!row?.refresh_token && row.connection_status === 'connected',
        email: row?.connected_email ?? null,
    }
}

// Desconecta la cuenta de Google de la agencia (borra los tokens).
export async function disconnectGoogle(): Promise<{ success: boolean; error?: string }> {
    try {
        const { disconnectGoogleIntegration } = await import('@/lib/integrations/google-auth')
        await disconnectGoogleIntegration()
        revalidatePath('/admin/settings')
        return { success: true }
    } catch (e: any) {
        return { success: false, error: e.message || 'Error al desconectar' }
    }
}

// ─── Conversiones Offline ────────────────────────────────────────────────────

export async function detectConversionesColumns(sheetConfig: ConversionesConfig, tab?: SheetTabConfig) {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const res = await fetch(`${baseUrl}/api/admin/detect-sheet-columns`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sheetConfig, tab }),
            cache: 'no-store',
        })

        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al detectar columnas' }
        return { headers: (data.headers ?? []) as string[], columns: data.columns as DetectedColumn[] }
    } catch (e: any) {
        return { error: e.message || 'Error al detectar columnas' }
    }
}

// Pestañas reales del documento, para elegirlas en vez de teclear el nombre.
export async function listConversionesTabs(sheetConfig: ConversionesConfig) {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const res = await fetch(`${baseUrl}/api/admin/list-sheet-tabs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sheetConfig }),
            cache: 'no-store',
        })

        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al listar las pestañas' }
        return { tabs: data.tabs as SheetTabInfo[] }
    } catch (e: any) {
        return { error: e.message || 'Error al listar las pestañas' }
    }
}

// Estado del último sync por sheet (filas ok/descartadas y avisos por pestaña).
export async function getConversionesSyncStatus(clienteId: string) {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const res = await fetch(
            `${baseUrl}/api/admin/sync-conversiones-offline?clientId=${encodeURIComponent(clienteId)}`,
            { cache: 'no-store' }
        )

        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al consultar el estado del sync' }
        return { lastSync: (data.lastSync ?? {}) as Record<string, SheetSyncStatus> }
    } catch (e: any) {
        return { error: e.message || 'Error al consultar el estado del sync' }
    }
}

export async function listDriveSheets() {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const res = await fetch(`${baseUrl}/api/admin/list-google-sheets`, {
            cache: 'no-store',
        })

        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al listar Sheets' }
        return { sheets: data.sheets as DriveSheet[] }
    } catch (e: any) {
        return { error: e.message || 'Error al listar Sheets' }
    }
}

// Propiedades GA4 visibles para la cuenta OAuth de la agencia, para el selector
// por cliente (evita teclear el ID numérico a mano).
export async function listGa4Properties() {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const res = await fetch(`${baseUrl}/api/admin/list-ga4-properties`, {
            cache: 'no-store',
        })

        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al listar propiedades de GA4' }
        return { properties: data.properties as GA4Property[] }
    } catch (e: any) {
        return { error: e.message || 'Error al listar propiedades de GA4' }
    }
}

// ─── Campos de Sheet ─────────────────────────────────────────────────────────
// Definiciones por cliente que unifican columnas equivalentes de varias
// pestañas. Todo pasa por /api/admin/sheet-campos*, que usa el service role.

async function baseUrl() {
    const headersList = await headers()
    const host = headersList.get('host') || 'localhost:3001'
    const protocol = host.includes('localhost') ? 'http' : 'https'
    return `${protocol}://${host}`
}

export interface SheetCamposPayload {
    campos: SheetCampoDef[]
    vistas: SheetCampoVistaDef[]
}

export async function listSheetCampos(clienteId: string) {
    try {
        const res = await fetch(
            `${await baseUrl()}/api/admin/sheet-campos?cliente_id=${encodeURIComponent(clienteId)}`,
            { cache: 'no-store' }
        )
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al leer los campos' }
        return { campos: (data.campos ?? []) as SheetCampoDef[], vistas: (data.vistas ?? []) as SheetCampoVistaDef[] }
    } catch (e: any) {
        return { error: e.message || 'Error al leer los campos' }
    }
}

/** Guarda el campo y devuelve el catálogo ya recalculado (el POST recalcula). */
export async function saveSheetCampo(clienteId: string, campo: Partial<SheetCampoDef>) {
    try {
        const res = await fetch(`${await baseUrl()}/api/admin/sheet-campos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...campo, cliente_id: clienteId }),
            cache: 'no-store',
        })
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al guardar el campo' }
        revalidatePath(`/admin/settings/${clienteId}`)
        return {
            campo: data.campo as SheetCampoDef | null,
            campos: (data.campos ?? []) as SheetCampoDef[],
            vistas: (data.vistas ?? []) as SheetCampoVistaDef[],
            recalculo: data.recalculo as { campos: number; dias: number; valores: number; avisos: string[] },
        }
    } catch (e: any) {
        return { error: e.message || 'Error al guardar el campo' }
    }
}

export async function deleteSheetCampo(clienteId: string, campoId: string) {
    try {
        const url = `${await baseUrl()}/api/admin/sheet-campos` +
            `?id=${encodeURIComponent(campoId)}&cliente_id=${encodeURIComponent(clienteId)}`
        const res = await fetch(url, { method: 'DELETE', cache: 'no-store' })
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al borrar el campo' }
        revalidatePath(`/admin/settings/${clienteId}`)
        return { success: true }
    } catch (e: any) {
        return { error: e.message || 'Error al borrar el campo' }
    }
}

export async function saveSheetVista(clienteId: string, vista: Partial<SheetCampoVistaDef>) {
    try {
        const res = await fetch(`${await baseUrl()}/api/admin/sheet-campos/vistas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...vista, cliente_id: clienteId }),
            cache: 'no-store',
        })
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al guardar la vista' }
        revalidatePath(`/admin/settings/${clienteId}`)
        return { campos: (data.campos ?? []) as SheetCampoDef[], vistas: (data.vistas ?? []) as SheetCampoVistaDef[] }
    } catch (e: any) {
        return { error: e.message || 'Error al guardar la vista' }
    }
}

export async function deleteSheetVista(clienteId: string, vistaId: string) {
    try {
        const url = `${await baseUrl()}/api/admin/sheet-campos/vistas` +
            `?id=${encodeURIComponent(vistaId)}&cliente_id=${encodeURIComponent(clienteId)}`
        const res = await fetch(url, { method: 'DELETE', cache: 'no-store' })
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al borrar la vista' }
        revalidatePath(`/admin/settings/${clienteId}`)
        return { campos: (data.campos ?? []) as SheetCampoDef[], vistas: (data.vistas ?? []) as SheetCampoVistaDef[] }
    } catch (e: any) {
        return { error: e.message || 'Error al borrar la vista' }
    }
}

/** Valores crudos detectados de un campo, para el agrupador. */
export async function listCampoValores(clienteId: string, campoId: string, limite = 500) {
    try {
        const url = `${await baseUrl()}/api/admin/sheet-campos/valores` +
            `?cliente_id=${encodeURIComponent(clienteId)}&campo_id=${encodeURIComponent(campoId)}&limite=${limite}`
        const res = await fetch(url, { cache: 'no-store' })
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al leer los valores' }
        return {
            valores: (data.valores ?? []) as CampoValorCrudo[],
            totalDistintos: (data.total_distintos ?? 0) as number,
        }
    } catch (e: any) {
        return { error: e.message || 'Error al leer los valores' }
    }
}

/** Recalcula desde `sheet_filas`. Nunca llama a Google. */
export async function recalcularSheetCampos(clienteId: string, campoId?: string) {
    try {
        const res = await fetch(`${await baseUrl()}/api/admin/sheet-campos/recalcular`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cliente_id: clienteId, campo_id: campoId }),
            cache: 'no-store',
        })
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al recalcular' }
        revalidatePath(`/admin/settings/${clienteId}`)
        return data as { campos: number; dias: number; valores: number; avisos: string[] }
    } catch (e: any) {
        return { error: e.message || 'Error al recalcular' }
    }
}

/** Columnas por pestaña ya sincronizada, con muestras. No llama a Google. */
export async function listSheetColumnas(clienteId: string) {
    try {
        const res = await fetch(
            `${await baseUrl()}/api/admin/sheet-columnas?cliente_id=${encodeURIComponent(clienteId)}`,
            { cache: 'no-store' }
        )
        const data = await res.json()
        if (!res.ok) return { error: data.error || 'Error al leer las columnas' }
        return { fuentes: (data.fuentes ?? []) as Array<FuenteColumnas & { sheet_nombre: string }> }
    } catch (e: any) {
        return { error: e.message || 'Error al leer las columnas' }
    }
}

export async function syncConversionesOffline(clienteId: string) {
    try {
        const headersList = await headers()
        const host = headersList.get('host') || 'localhost:3001'
        const protocol = host.includes('localhost') ? 'http' : 'https'
        const baseUrl = `${protocol}://${host}`

        const res = await fetch(`${baseUrl}/api/admin/sync-conversiones-offline`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: clienteId }),
            cache: 'no-store',
        })

        const data = await res.json()

        if (!res.ok) {
            return { error: data.error || 'Error al sincronizar conversiones offline' }
        }

        revalidatePath(`/admin/settings/${clienteId}`)
        return { success: true, ...data }
    } catch (e: any) {
        console.error('Conversiones offline sync error:', e)
        return { error: e.message || 'Error al sincronizar conversiones offline' }
    }
}
