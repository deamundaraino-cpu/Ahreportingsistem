import { NextResponse } from 'next/server'
import { getGoogleOAuthClient, GOOGLE_OAUTH_SCOPES } from '@/lib/integrations/google-auth'

// Inicia el flujo OAuth de Google (Analytics + Sheets) a nivel AGENCIA.
// Conexión única: no requiere client_id. Uso: /api/auth/google
export async function GET() {
  try {
    const oauth = getGoogleOAuthClient()

    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline',        // necesario para recibir refresh_token
      prompt: 'consent',             // fuerza la entrega del refresh_token
      include_granted_scopes: true,
      scope: GOOGLE_OAUTH_SCOPES,
      state: 'agency',               // marcador: conexión a nivel agencia
    })

    return NextResponse.redirect(authUrl)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error al iniciar OAuth de Google'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
