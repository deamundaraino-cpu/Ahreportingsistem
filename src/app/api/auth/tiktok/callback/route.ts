import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/utils/supabase/server'

// Callback OAuth de TikTok Ads.
// TikTok redirige aquí con ?auth_code={CODE}&state={CLIENT_ID}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!

  const authCode = searchParams.get('auth_code')
  const clientId = searchParams.get('state')
  const error = searchParams.get('error')

  if (error || !authCode || !clientId) {
    const msg = error ?? 'auth_code o state faltante'
    return NextResponse.redirect(`${appUrl}/admin/settings?tiktok_error=${encodeURIComponent(msg)}`)
  }

  const appId = process.env.TIKTOK_APP_ID!
  const appSecret = process.env.TIKTOK_APP_SECRET!

  // Intercambiar auth_code por access_token
  let tokenData: any
  try {
    const res = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, secret: appSecret, auth_code: authCode }),
    })
    tokenData = await res.json()
  } catch {
    return NextResponse.redirect(`${appUrl}/admin/settings/${clientId}?tiktok_error=Error+de+red+con+TikTok`)
  }

  if (tokenData.code !== 0) {
    const msg = tokenData.message ?? 'Error obteniendo token'
    return NextResponse.redirect(`${appUrl}/admin/settings/${clientId}?tiktok_error=${encodeURIComponent(msg)}`)
  }

  const accessToken: string = tokenData.data.access_token
  const advertiserIds: string[] = tokenData.data.advertiser_ids ?? []

  // Guardar token en config_api del cliente
  const supabase = await createAdminClient()
  const { data: cliente, error: fetchError } = await supabase
    .from('clientes')
    .select('config_api')
    .eq('id', clientId)
    .single()

  if (fetchError || !cliente) {
    return NextResponse.redirect(`${appUrl}/admin/settings?tiktok_error=Cliente+no+encontrado`)
  }

  const existingAccounts: any[] = Array.isArray(cliente.config_api?.tiktok_accounts) ? cliente.config_api.tiktok_accounts : []
  const newEntries = advertiserIds
    .filter((aid: string) => aid && !existingAccounts.some((a: any) => a.advertiser_id === aid))
    .map((aid: string) => ({
      id: crypto.randomUUID(),
      label: `Cuenta ${aid}`,
      advertiser_id: aid,
      access_token: '',
    }))

  const newConfig = {
    ...cliente.config_api,
    tiktok_access_token: accessToken,
    tiktok_accounts: [...existingAccounts, ...newEntries],
  }

  const { error: updateError } = await supabase
    .from('clientes')
    .update({ config_api: newConfig })
    .eq('id', clientId)

  if (updateError) {
    return NextResponse.redirect(`${appUrl}/admin/settings/${clientId}?tiktok_error=${encodeURIComponent(updateError.message)}`)
  }

  return NextResponse.redirect(`${appUrl}/admin/settings/${clientId}?tiktok_connected=1`)
}
