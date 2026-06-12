import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createSSRClient } from '@/utils/supabase/server'
import { notifyUsers } from '@/lib/notifications/notify'

const TOKEN_URL = 'https://api-sec-vlc.hotmart.com/security/oauth/token'

// Umbral: refrescar tokens que vencen en menos de N minutos.
// Los tokens de Hotmart (HotConnect) son de vida corta, por eso el umbral es en minutos.
const REFRESH_THRESHOLD_MS = 30 * 60 * 1000 // 30 min

// Cron de auto-refresh de tokens de Hotmart (modo HotConnect / authorization_code).
// Usa el refresh_token para obtener un nuevo access_token antes de que caduque,
// de modo que la conexión rueda sin re-login del cliente.
// Solo aplica a clientes con hotmart_auth_mode === 'hotconnect'.
// El modo "pegar credenciales" (Basic / client_credentials) NO necesita refresh:
// el worker genera el token en cada corrida.
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const appClientId = process.env.HOTMART_APP_CLIENT_ID
  const appClientSecret = process.env.HOTMART_APP_CLIENT_SECRET
  if (!appClientId || !appClientSecret) {
    return NextResponse.json({ error: 'HOTMART_APP_CLIENT_ID/HOTMART_APP_CLIENT_SECRET no configurados' }, { status: 500 })
  }

  let supabase: any
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY)
  } else {
    supabase = await createSSRClient()
  }

  const { data: clientes, error } = await supabase.from('clientes').select('id, nombre, config_api')
  if (error || !clientes) {
    return NextResponse.json({ error: 'Failed to fetch clients' }, { status: 500 })
  }

  const now = Date.now()
  const results: { id: string; nombre: string; status: string; detail?: string }[] = []

  for (const cliente of clientes) {
    const config = cliente.config_api || {}

    // Solo clientes en modo HotConnect con refresh_token.
    if (config.hotmart_auth_mode !== 'hotconnect') continue
    const refreshToken: string | undefined = config.hotmart_refresh_token
    if (!refreshToken) continue

    const expiresAt: string | undefined = config.hotmart_token_expires_at
    const expiresMs = expiresAt ? new Date(expiresAt).getTime() : 0

    // Aún lejos de vencer → omitir.
    if (expiresMs && !Number.isNaN(expiresMs) && expiresMs - now > REFRESH_THRESHOLD_MS) {
      results.push({ id: cliente.id, nombre: cliente.nombre, status: 'skipped_valid' })
      continue
    }

    try {
      const params = new URLSearchParams()
      params.set('grant_type', 'refresh_token')
      params.set('client_id', appClientId)
      params.set('client_secret', appClientSecret)
      params.set('refresh_token', refreshToken)

      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      })
      const data = await res.json()

      if (data.error || !data.access_token) {
        // Refresh token vencido o revocado: marcar para que la UI pida reconexión.
        await supabase
          .from('clientes')
          .update({ config_api: { ...config, hotmart_connection_status: 'expired' } })
          .eq('id', cliente.id)
        results.push({ id: cliente.id, nombre: cliente.nombre, status: 'failed', detail: data.error_description || data.error || 'Sin access_token' })
        continue
      }

      const newToken: string = data.access_token
      const newRefresh: string = data.refresh_token ?? refreshToken
      const expiresIn: number = data.expires_in ?? 6 * 60 * 60
      const newExpiresAt = new Date(now + expiresIn * 1000).toISOString()

      await supabase
        .from('clientes')
        .update({
          config_api: {
            ...config,
            hotmart_access_token: newToken,
            hotmart_refresh_token: newRefresh,
            hotmart_token_expires_at: newExpiresAt,
            hotmart_connection_status: 'connected',
          },
        })
        .eq('id', cliente.id)

      results.push({ id: cliente.id, nombre: cliente.nombre, status: 'refreshed', detail: newExpiresAt })
    } catch (err: any) {
      results.push({ id: cliente.id, nombre: cliente.nombre, status: 'error', detail: err.message })
    }
  }

  const refreshed = results.filter((r) => r.status === 'refreshed').length
  const failures = results.filter((r) => r.status === 'failed' || r.status === 'error')

  // Aviso in-app a admins si algún token no pudo refrescarse (un solo aviso por corrida)
  if (failures.length > 0 && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    await notifyUsers({
      db: supabase,
      type: 'token_expiring',
      severity: 'error',
      audience: 'admins',
      title: `Fallo al refrescar tokens de Hotmart (${failures.length})`,
      message: failures.map((f) => `${f.nombre}: ${f.detail ?? f.status}`).join(' · ').slice(0, 300),
      link: '/admin/settings',
      metadata: { failures: failures.map((f) => ({ id: f.id, status: f.status })) },
    })
  }

  return NextResponse.json({ ok: true, refreshed, failed: failures.length, total: results.length, results })
}
