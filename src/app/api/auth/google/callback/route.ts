import { NextRequest, NextResponse } from 'next/server';
import {
  getGoogleOAuthClient,
  saveGoogleIntegration,
  GOOGLE_OAUTH_SCOPES,
} from '@/lib/integrations/google-auth';
import { MOTIVO_STATE } from '@/lib/hotmart/oauth-state';
import { COOKIE_STATE_GOOGLE, verificarStateGoogle } from '@/lib/integrations/google-oauth-state';

// Callback OAuth de Google (conexión a nivel agencia).
// Google redirige aquí con ?code={CODE}&state={STATE FIRMADO}. El `state` se
// valida contra la cookie que dejó `/api/auth/google` ANTES de canjear el código:
// sin esa comprobación cualquiera podía sustituir la cuenta de la agencia.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const settingsUrl = `${appUrl}/admin/settings`;

  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error || !code) {
    const msg = error ?? 'code faltante';
    return NextResponse.redirect(`${settingsUrl}?google_error=${encodeURIComponent(msg)}`);
  }

  const nonce = request.cookies.get(COOKIE_STATE_GOOGLE)?.value ?? null;
  let verificacion: ReturnType<typeof verificarStateGoogle>;
  try {
    verificacion = verificarStateGoogle(searchParams.get('state'), nonce);
  } catch {
    return NextResponse.redirect(
      `${settingsUrl}?google_error=${encodeURIComponent('Servidor sin CRON_SECRET configurado')}`
    );
  }
  if (!verificacion.ok) {
    // Sin tocar la base de datos: ese es el punto.
    const res = NextResponse.redirect(
      `${settingsUrl}?google_error=${encodeURIComponent(MOTIVO_STATE[verificacion.motivo])}`
    );
    res.cookies.delete(COOKIE_STATE_GOOGLE);
    return res;
  }

  try {
    const oauth = getGoogleOAuthClient();

    // Intercambiar code → access_token + refresh_token
    const { tokens } = await oauth.getToken(code);

    if (!tokens.access_token) {
      return NextResponse.redirect(`${settingsUrl}?google_error=No+se+obtuvo+access_token`);
    }

    // Obtener el email de la cuenta que autorizó
    oauth.setCredentials(tokens);
    let email: string | null = null;
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const info = await res.json();
      email = info.email ?? null;
    } catch {
      // El email es informativo; no bloquea la conexión.
    }

    await saveGoogleIntegration({
      refreshToken: tokens.refresh_token ?? null,
      accessToken: tokens.access_token,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      email,
      scopes: GOOGLE_OAUTH_SCOPES,
    });

    const ok = NextResponse.redirect(`${settingsUrl}?google_connected=1`);
    ok.cookies.delete(COOKIE_STATE_GOOGLE);
    return ok;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error con Google';
    return NextResponse.redirect(`${settingsUrl}?google_error=${encodeURIComponent(msg)}`);
  }
}
