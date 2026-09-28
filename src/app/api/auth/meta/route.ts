import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/report-utm/auth';
import {
  COOKIE_STATE_OAUTH,
  firmarStateCliente,
  opcionesCookieState,
} from '@/lib/integrations/oauth-state-cliente';

/**
 * Inicia el flujo OAuth de Meta (Facebook) Ads.
 * Uso: /api/auth/meta?client_id={CLIENTE_ID}
 *
 * ── El agujero que cierra ───────────────────────────────────────
 * La ruta era PÚBLICA y el `state` era el `cliente_id` a secas, que el callback
 * no validaba. Cualquiera que conociera un UUID de cliente podía autorizar con
 * SU cuenta de Facebook y sustituir el token de ese cliente.
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

  const appId = process.env.META_APP_ID;
  if (!appId) {
    return NextResponse.json({ error: 'META_APP_ID no configurado' }, { status: 500 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL no configurado' }, { status: 500 });
  }

  let firmado: ReturnType<typeof firmarStateCliente>;
  try {
    firmado = firmarStateCliente('meta', clientId);
  } catch {
    // Falta CRON_SECRET: mejor fallar que volver al `state` sin firmar.
    return NextResponse.json({ error: 'Servidor sin CRON_SECRET configurado' }, { status: 500 });
  }

  const redirectUri = `${appUrl}/api/auth/meta/callback`;

  const authUrl = new URL('https://www.facebook.com/v19.0/dialog/oauth');
  authUrl.searchParams.set('client_id', appId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', firmado.state);
  authUrl.searchParams.set('response_type', 'code');
  // Permisos:
  //  · ads_read              → insights de campañas
  //  · business_management   → listar ad accounts
  //  · leads_retrieval       → leer los leads de los formularios
  //  · pages_show_list       → listar Páginas + sus tokens (/me/accounts)
  //  · pages_read_engagement → suscribir Páginas al webhook leadgen
  //  · pages_manage_ads      → acceder a los leadgen_forms de la Página
  authUrl.searchParams.set(
    'scope',
    'ads_read,business_management,leads_retrieval,pages_show_list,pages_read_engagement,pages_manage_ads'
  );

  const res = NextResponse.redirect(authUrl.toString());
  res.cookies.set(COOKIE_STATE_OAUTH.meta, firmado.nonce, opcionesCookieState('meta'));
  return res;
}
