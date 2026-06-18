import { NextRequest, NextResponse } from 'next/server'

// Inicia el flujo OAuth de Meta (Facebook) Ads.
// Uso: /api/auth/meta?client_id={CLIENTE_ID}
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const clientId = searchParams.get('client_id')

  if (!clientId) {
    return NextResponse.json({ error: 'client_id requerido' }, { status: 400 })
  }

  const appId = process.env.META_APP_ID
  if (!appId) {
    return NextResponse.json({ error: 'META_APP_ID no configurado' }, { status: 500 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL no configurado' }, { status: 500 })
  }

  const redirectUri = `${appUrl}/api/auth/meta/callback`
  const state = clientId

  const authUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth')
  authUrl.searchParams.set('client_id', appId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('response_type', 'code')
  // Permisos:
  //  · ads_read              → insights de campañas
  //  · business_management   → listar ad accounts
  //  · leads_retrieval       → leer los leads de los formularios
  //  · pages_show_list       → listar Páginas + sus tokens (/me/accounts)
  //  · pages_read_engagement → suscribir Páginas al webhook leadgen
  //  · pages_manage_ads      → acceder a los leadgen_forms de la Página
  authUrl.searchParams.set(
    'scope',
    'ads_read,business_management,leads_retrieval,pages_show_list,pages_read_engagement,pages_manage_ads',
  )

  return NextResponse.redirect(authUrl.toString())
}
