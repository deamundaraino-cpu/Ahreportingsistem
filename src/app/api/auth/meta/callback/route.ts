import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'

const GRAPH = 'https://graph.facebook.com/v19.0'

// Callback OAuth de Meta (Facebook) Ads.
// Meta redirige aquí con ?code={CODE}&state={CLIENT_ID}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!

  const code = searchParams.get('code')
  const clientId = searchParams.get('state')
  const error = searchParams.get('error_description') || searchParams.get('error')

  if (error || !code || !clientId) {
    const msg = error ?? 'code o state faltante'
    return NextResponse.redirect(`${appUrl}/admin/settings?meta_error=${encodeURIComponent(msg)}`)
  }

  const appId = process.env.META_APP_ID!
  const appSecret = process.env.META_APP_SECRET!
  const redirectUri = `${appUrl}/api/auth/meta/callback`
  const settingsUrl = `${appUrl}/admin/settings/${clientId}`

  try {
    // 1. Intercambiar code → token short-lived
    const shortUrl = new URL(`${GRAPH}/oauth/access_token`)
    shortUrl.searchParams.set('client_id', appId)
    shortUrl.searchParams.set('client_secret', appSecret)
    shortUrl.searchParams.set('redirect_uri', redirectUri)
    shortUrl.searchParams.set('code', code)
    const shortRes = await fetch(shortUrl.toString())
    const shortData = await shortRes.json()
    if (shortData.error) {
      return NextResponse.redirect(`${settingsUrl}?meta_error=${encodeURIComponent(shortData.error.message)}`)
    }
    const shortToken: string = shortData.access_token

    // 2. Intercambiar short-lived → long-lived (~60 días)
    const longUrl = new URL(`${GRAPH}/oauth/access_token`)
    longUrl.searchParams.set('grant_type', 'fb_exchange_token')
    longUrl.searchParams.set('client_id', appId)
    longUrl.searchParams.set('client_secret', appSecret)
    longUrl.searchParams.set('fb_exchange_token', shortToken)
    const longRes = await fetch(longUrl.toString())
    const longData = await longRes.json()
    if (longData.error) {
      return NextResponse.redirect(`${settingsUrl}?meta_error=${encodeURIComponent(longData.error.message)}`)
    }
    const longToken: string = longData.access_token
    const expiresIn: number = longData.expires_in ?? 60 * 24 * 60 * 60 // fallback 60 días
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()

    // 3. Listar ad accounts del usuario
    const accountsUrl = new URL(`${GRAPH}/me/adaccounts`)
    accountsUrl.searchParams.set('fields', 'account_id,name')
    accountsUrl.searchParams.set('limit', '200')
    accountsUrl.searchParams.set('access_token', longToken)
    const accountsRes = await fetch(accountsUrl.toString())
    const accountsData = await accountsRes.json()
    if (accountsData.error) {
      return NextResponse.redirect(`${settingsUrl}?meta_error=${encodeURIComponent(accountsData.error.message)}`)
    }
    const fetchedAccounts: { account_id: string; name?: string }[] = accountsData.data ?? []

    // 4. Guardar token + cuentas en config_api del cliente
    const supabase = await createAdminClient()
    const { data: cliente, error: fetchError } = await supabase
      .from('clientes')
      .select('config_api')
      .eq('id', clientId)
      .single()

    if (fetchError || !cliente) {
      return NextResponse.redirect(`${appUrl}/admin/settings?meta_error=Cliente+no+encontrado`)
    }

    const existingAccounts: any[] = Array.isArray(cliente.config_api?.meta_accounts) ? cliente.config_api.meta_accounts : []
    const newEntries = fetchedAccounts
      .map((a) => {
        const actId = String(a.account_id || '').startsWith('act_') ? String(a.account_id) : `act_${a.account_id}`
        return { actId, name: a.name }
      })
      .filter(({ actId }) => actId && actId !== 'act_' && !existingAccounts.some((e: any) => e.account_id === actId))
      .map(({ actId, name }) => ({
        id: crypto.randomUUID(),
        label: name || `Cuenta ${actId}`,
        account_id: actId,
        token: '',
      }))

    const newConfig = {
      ...cliente.config_api,
      meta_token: longToken,
      meta_token_expires_at: expiresAt,
      meta_connection_status: 'connected',
      meta_accounts: [...existingAccounts, ...newEntries],
    }

    const { error: updateError } = await supabase
      .from('clientes')
      .update({ config_api: newConfig })
      .eq('id', clientId)

    if (updateError) {
      return NextResponse.redirect(`${settingsUrl}?meta_error=${encodeURIComponent(updateError.message)}`)
    }

    return NextResponse.redirect(`${settingsUrl}?meta_connected=1`)
  } catch {
    return NextResponse.redirect(`${settingsUrl}?meta_error=Error+de+red+con+Meta`)
  }
}
