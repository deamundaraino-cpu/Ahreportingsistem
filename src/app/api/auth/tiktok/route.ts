import { NextRequest, NextResponse } from 'next/server'

// Inicia el flujo OAuth de TikTok Ads.
// Uso: /api/auth/tiktok?client_id={CLIENTE_ID}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  if (!clientId) {
    return NextResponse.json({ error: 'client_id requerido' }, { status: 400 })
  }

  const appId = process.env.TIKTOK_APP_ID
  if (!appId) {
    return NextResponse.json({ error: 'TIKTOK_APP_ID no configurado' }, { status: 500 })
  }

  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/tiktok/callback`
  const state = clientId

  const authUrl = new URL('https://ads.tiktok.com/marketing_api/auth')
  authUrl.searchParams.set('app_id', appId)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('redirect_uri', redirectUri)

  return NextResponse.redirect(authUrl.toString())
}
