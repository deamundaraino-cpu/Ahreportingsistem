import { NextRequest, NextResponse } from 'next/server'
import { getGoogleOAuthClient, saveGoogleIntegration, GOOGLE_OAUTH_SCOPES } from '@/lib/integrations/google-auth'

// Callback OAuth de Google (conexión a nivel agencia).
// Google redirige aquí con ?code={CODE}&state=agency
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!
  const settingsUrl = `${appUrl}/admin/settings`

  const code = searchParams.get('code')
  const error = searchParams.get('error')

  if (error || !code) {
    const msg = error ?? 'code faltante'
    return NextResponse.redirect(`${settingsUrl}?google_error=${encodeURIComponent(msg)}`)
  }

  try {
    const oauth = getGoogleOAuthClient()

    // Intercambiar code → access_token + refresh_token
    const { tokens } = await oauth.getToken(code)

    if (!tokens.access_token) {
      return NextResponse.redirect(`${settingsUrl}?google_error=No+se+obtuvo+access_token`)
    }

    // Obtener el email de la cuenta que autorizó
    oauth.setCredentials(tokens)
    let email: string | null = null
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
      const info = await res.json()
      email = info.email ?? null
    } catch {
      // El email es informativo; no bloquea la conexión.
    }

    await saveGoogleIntegration({
      refreshToken: tokens.refresh_token ?? null,
      accessToken: tokens.access_token,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      email,
      scopes: GOOGLE_OAUTH_SCOPES,
    })

    return NextResponse.redirect(`${settingsUrl}?google_connected=1`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error con Google'
    return NextResponse.redirect(`${settingsUrl}?google_error=${encodeURIComponent(msg)}`)
  }
}
