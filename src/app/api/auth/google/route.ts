import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { getGoogleOAuthClient, GOOGLE_OAUTH_SCOPES } from '@/lib/integrations/google-auth';
import { firmarState, VENTANA_STATE_MS } from '@/lib/hotmart/oauth-state';
import { COOKIE_STATE_GOOGLE, STATE_AGENCIA_GOOGLE } from '@/lib/integrations/google-oauth-state';

/**
 * Inicia el flujo OAuth de Google (Analytics + Sheets) a nivel AGENCIA.
 * Conexión única: no requiere client_id. Uso: /api/auth/google
 *
 * ── El agujero que cierra ───────────────────────────────────────
 * El `state` era la cadena fija `'agency'` y el callback no lo comprobaba, en
 * una ruta pública (`/api/auth/` no exige sesión en el middleware). Cualquiera
 * que completara el flujo con SU cuenta de Google sustituía la conexión de la
 * agencia: GA4 y Sheets de todos los clientes pasaban a leerse con esa cuenta.
 *
 * Ahora la ruta exige rol admin/superadmin y el `state` va firmado y ligado a
 * una cookie httpOnly de este navegador (mismo mecanismo que Hotmart).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  }
  const { data: perfil } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (!['admin', 'superadmin'].includes(perfil?.role ?? '')) {
    return NextResponse.json({ error: 'Sin permiso para conectar integraciones' }, { status: 403 });
  }

  let firmado: ReturnType<typeof firmarState>;
  try {
    firmado = firmarState(STATE_AGENCIA_GOOGLE);
  } catch {
    // Falta CRON_SECRET: mejor fallar que volver al `state` sin firmar.
    return NextResponse.json({ error: 'Servidor sin CRON_SECRET configurado' }, { status: 500 });
  }

  try {
    const oauth = getGoogleOAuthClient();

    const authUrl = oauth.generateAuthUrl({
      access_type: 'offline', // necesario para recibir refresh_token
      prompt: 'consent', // fuerza la entrega del refresh_token
      include_granted_scopes: true,
      scope: GOOGLE_OAUTH_SCOPES,
      state: firmado.state,
    });

    const res = NextResponse.redirect(authUrl);
    res.cookies.set(COOKIE_STATE_GOOGLE, firmado.nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      // `lax`: la vuelta desde Google es una navegación top-level de otro sitio.
      sameSite: 'lax',
      path: '/api/auth/google',
      maxAge: Math.floor(VENTANA_STATE_MS / 1000),
    });
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error al iniciar OAuth de Google';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
