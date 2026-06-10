import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'

const TOKEN_URL = 'https://api-sec-vlc.hotmart.com/security/oauth/token'

// Callback OAuth de Hotmart (HotConnect).
// Hotmart redirige aquí con ?code={CODE}&state={CLIENT_ID}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!

  const code = searchParams.get('code')
  const clientId = searchParams.get('state')
  const error = searchParams.get('error_description') || searchParams.get('error')

  if (error || !code || !clientId) {
    const msg = error ?? 'code o state faltante'
    return NextResponse.redirect(`${appUrl}/admin/settings?hotmart_error=${encodeURIComponent(msg)}`)
  }

  const appClientId = process.env.HOTMART_APP_CLIENT_ID!
  const appClientSecret = process.env.HOTMART_APP_CLIENT_SECRET!
  const redirectUri = `${appUrl}/api/auth/hotmart/callback`
  const settingsUrl = `${appUrl}/admin/settings/${clientId}`

  try {
    // Intercambiar code → access_token + refresh_token
    const params = new URLSearchParams()
    params.set('grant_type', 'authorization_code')
    params.set('client_id', appClientId)
    params.set('client_secret', appClientSecret)
    params.set('code', code)
    params.set('redirect_uri', redirectUri)

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const data = await res.json()

    if (data.error || !data.access_token) {
      const msg = data.error_description || data.error || 'No se obtuvo access_token'
      return NextResponse.redirect(`${settingsUrl}?hotmart_error=${encodeURIComponent(msg)}`)
    }

    const accessToken: string = data.access_token
    const refreshToken: string | undefined = data.refresh_token
    const expiresIn: number = data.expires_in ?? 6 * 60 * 60 // fallback 6 h
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // Guardar en config_api del cliente (modo HotConnect).
    const supabase = await createAdminClient()
    const { data: cliente, error: fetchError } = await supabase
      .from('clientes')
      .select('config_api')
      .eq('id', clientId)
      .single()

    if (fetchError || !cliente) {
      return NextResponse.redirect(`${appUrl}/admin/settings?hotmart_error=Cliente+no+encontrado`)
    }

    const newConfig = {
      ...cliente.config_api,
      hotmart_auth_mode: 'hotconnect',
      hotmart_access_token: accessToken,
      hotmart_refresh_token: refreshToken ?? cliente.config_api?.hotmart_refresh_token ?? '',
      hotmart_token_expires_at: expiresAt,
      hotmart_connection_status: 'connected',
      hotmart_last_checked_at: new Date().toISOString(),
    }

    const { error: updateError } = await supabase
      .from('clientes')
      .update({ config_api: newConfig })
      .eq('id', clientId)

    if (updateError) {
      return NextResponse.redirect(`${settingsUrl}?hotmart_error=${encodeURIComponent(updateError.message)}`)
    }

    return NextResponse.redirect(`${settingsUrl}?hotmart_connected=1`)
  } catch {
    return NextResponse.redirect(`${settingsUrl}?hotmart_error=Error+de+red+con+Hotmart`)
  }
}
