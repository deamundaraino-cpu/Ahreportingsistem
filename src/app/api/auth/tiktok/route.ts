import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/report-utm/auth';
import {
  COOKIE_STATE_OAUTH,
  firmarStateCliente,
  opcionesCookieState,
} from '@/lib/integrations/oauth-state-cliente';

/**
 * Inicia el flujo OAuth de TikTok Ads.
 * Uso: /api/auth/tiktok?client_id={CLIENTE_ID}
 *
 * ── El agujero que cierra ───────────────────────────────────────
 * La ruta era PÚBLICA y el `state` era el `cliente_id` a secas; el callback
 * solo comprobaba que el cliente existiera. Cualquiera que conociera un UUID de
 * cliente podía autorizar con SU cuenta de TikTok y sustituir el token.
 *
 * Ahora exige rol admin/superadmin y el `state` va firmado y ligado a una
 * cookie httpOnly de este navegador (mismo mecanismo que Hotmart y Google).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const clientId = searchParams.get('client_id');

  if (!clientId) {
    return NextResponse.json({ error: 'client_id requerido' }, { status: 400 });
  }

  const denegado = await requireAdminRole();
  if (denegado) return denegado;

  const appId = process.env.TIKTOK_APP_ID;
  if (!appId) {
    return NextResponse.json({ error: 'TIKTOK_APP_ID no configurado' }, { status: 500 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL no configurado' }, { status: 500 });
  }

  let firmado: ReturnType<typeof firmarStateCliente>;
  try {
    firmado = firmarStateCliente('tiktok', clientId);
  } catch {
    // Falta CRON_SECRET: mejor fallar que volver al `state` sin firmar.
    return NextResponse.json({ error: 'Servidor sin CRON_SECRET configurado' }, { status: 500 });
  }

  const redirectUri = `${appUrl}/api/auth/tiktok/callback`;

  const authUrl = new URL('https://ads.tiktok.com/marketing_api/auth');
  authUrl.searchParams.set('app_id', appId);
  authUrl.searchParams.set('state', firmado.state);
  authUrl.searchParams.set('redirect_uri', redirectUri);

  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set(COOKIE_STATE_OAUTH.tiktok, firmado.nonce, opcionesCookieState('tiktok'));
  return res;
}
