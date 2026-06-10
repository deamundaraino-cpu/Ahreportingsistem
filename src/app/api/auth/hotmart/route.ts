import { NextRequest, NextResponse } from 'next/server'

// Inicia el flujo OAuth de Hotmart (HotConnect — authorization code / 3-legged).
// Uso: /api/auth/hotmart?client_id={CLIENTE_ID}
// El cliente hace login en Hotmart y autoriza; Hotmart redirige a /api/auth/hotmart/callback.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  if (!clientId) {
    return NextResponse.json({ error: 'client_id requerido' }, { status: 400 })
  }

  const appClientId = process.env.HOTMART_APP_CLIENT_ID
  if (!appClientId) {
    return NextResponse.json({ error: 'HOTMART_APP_CLIENT_ID no configurado' }, { status: 500 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL no configurado' }, { status: 500 })
  }

  const redirectUri = `${appUrl}/api/auth/hotmart/callback`
  // Usamos el id del cliente como `state` para recuperar el contexto en el callback.
  const state = clientId

  const authUrl = new URL('https://api-sec-vlc.hotmart.com/security/oauth/authorize')
  authUrl.searchParams.set('client_id', appClientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('state', state)

  return NextResponse.redirect(authUrl.toString())
}
