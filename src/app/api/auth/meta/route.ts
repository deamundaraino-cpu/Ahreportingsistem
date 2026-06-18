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
  // Permisos: insights (ads_read), listar ad accounts (business_management),
  // leer leads de formularios (leads_retrieval), listar Páginas + sus tokens
  // (pages_show_list) y suscribir Páginas al webhook leadgen (pages_read_engagement).
  authUrl.searchParams.set(
    'scope',
    'ads_read,business_management,leads_retrieval,pages_show_list,pages_read_engagement',
  )

  return NextResponse.redirect(authUrl.toString())
}
