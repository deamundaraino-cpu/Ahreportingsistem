import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { MOTIVO_STATE } from '@/lib/hotmart/oauth-state';
import {
  COOKIE_STATE_OAUTH,
  pathCookieState,
  verificarStateCliente,
} from '@/lib/integrations/oauth-state-cliente';

const GRAPH = 'https://graph.facebook.com/v19.0';
const COOKIE = { name: COOKIE_STATE_OAUTH.meta, path: pathCookieState('meta') };

/**
 * Callback OAuth de Meta (Facebook) Ads.
 * Meta redirige aquí con ?code={CODE}&state={STATE FIRMADO}.
 *
 * Dos cambios frente a la versión anterior:
 *
 *  1. SE VALIDA EL `state` contra la cookie que dejó `/api/auth/meta`, ANTES de
 *     canjear el código. Antes se leía como `cliente_id` sin comprobar nada, en
 *     una ruta pública: cualquiera que conociera un UUID de cliente podía
 *     completar el flujo con su cuenta de Facebook y sustituir el token.
 *  2. La escritura es ATÓMICA vía `fusionar_config_api`. El read-modify-write
 *     anterior podía pisar lo que escribieran a la vez el cron de refresco o el
 *     worker.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const errorUrl = (msg: string, cliente?: string) => {
    const res = NextResponse.redirect(
      `${appUrl}/admin/settings${cliente ? `/${cliente}` : ''}?meta_error=${encodeURIComponent(msg)}`
    );
    res.cookies.delete(COOKIE);
    return res;
  };

  const code = searchParams.get('code');
  const error = searchParams.get('error_description') || searchParams.get('error');

  if (error) return errorUrl(error);
  if (!code) return errorUrl('Meta no devolvió el código de autorización');

  const nonce = request.cookies.get(COOKIE_STATE_OAUTH.meta)?.value ?? null;
  let verificacion: ReturnType<typeof verificarStateCliente>;
  try {
    verificacion = verificarStateCliente('meta', searchParams.get('state'), nonce);
  } catch {
    return errorUrl('Servidor sin CRON_SECRET configurado');
  }
  // Sin tocar Meta ni la base de datos: ese es el punto.
  if (!verificacion.ok) return errorUrl(MOTIVO_STATE[verificacion.motivo]);
  const clientId = verificacion.clienteId;

  const appId = process.env.META_APP_ID!;
  const appSecret = process.env.META_APP_SECRET!;
  const redirectUri = `${appUrl}/api/auth/meta/callback`;
  const settingsUrl = `${appUrl}/admin/settings/${clientId}`;

  try {
    // 1. Intercambiar code → token short-lived
    const shortUrl = new URL(`${GRAPH}/oauth/access_token`);
    shortUrl.searchParams.set('client_id', appId);
    shortUrl.searchParams.set('client_secret', appSecret);
    shortUrl.searchParams.set('redirect_uri', redirectUri);
    shortUrl.searchParams.set('code', code);
    const shortRes = await fetch(shortUrl.toString());
    const shortData = await shortRes.json();
    if (shortData.error) return errorUrl(shortData.error.message, clientId);
    const shortToken: string = shortData.access_token;

    // 2. Intercambiar short-lived → long-lived (~60 días)
    const longUrl = new URL(`${GRAPH}/oauth/access_token`);
    longUrl.searchParams.set('grant_type', 'fb_exchange_token');
    longUrl.searchParams.set('client_id', appId);
    longUrl.searchParams.set('client_secret', appSecret);
    longUrl.searchParams.set('fb_exchange_token', shortToken);
    const longRes = await fetch(longUrl.toString());
    const longData = await longRes.json();
    if (longData.error) return errorUrl(longData.error.message, clientId);
    const longToken: string = longData.access_token;
    const expiresIn: number = longData.expires_in ?? 60 * 24 * 60 * 60; // fallback 60 días
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // 3. Guardar SOLO el token en config_api del cliente.
    // Las cuentas publicitarias NO se auto-importan: el admin elige cuáles sincronizar
    // desde la UI (botón "Elegir cuentas"), porque el token concede acceso a todas
    // las cuentas del usuario de Facebook. `meta_accounts` no va en el parche:
    // `fusionar_config_api` conserva las que hubiera.
    const supabase = await createAdminClient();
    const { data: config, error: rpcError } = await supabase.rpc('fusionar_config_api', {
      p_cliente_id: clientId,
      p_parche: {
        meta_token: longToken,
        meta_token_expires_at: expiresAt,
        meta_connection_status: 'connected',
      },
    });

    if (rpcError) return errorUrl(rpcError.message, clientId);
    // La RPC devuelve NULL si el UPDATE no encontró la fila.
    if (!config) return errorUrl('Cliente no encontrado');

    const ok = NextResponse.redirect(`${settingsUrl}?meta_connected=1`);
    ok.cookies.delete(COOKIE);
    return ok;
  } catch {
    return errorUrl('Error de red con Meta', clientId);
  }
}
