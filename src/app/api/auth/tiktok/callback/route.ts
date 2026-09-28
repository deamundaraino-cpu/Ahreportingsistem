import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { MOTIVO_STATE } from '@/lib/hotmart/oauth-state';
import {
  COOKIE_STATE_OAUTH,
  pathCookieState,
  verificarStateCliente,
} from '@/lib/integrations/oauth-state-cliente';

const COOKIE = { name: COOKIE_STATE_OAUTH.tiktok, path: pathCookieState('tiktok') };

/**
 * Callback OAuth de TikTok Ads.
 * TikTok redirige aquí con ?auth_code={CODE}&state={STATE FIRMADO}.
 *
 * Dos cambios frente a la versión anterior:
 *
 *  1. SE VALIDA EL `state` contra la cookie que dejó `/api/auth/tiktok`, ANTES
 *     de canjear el código. Antes solo se comprobaba que el `state` fuera un
 *     cliente existente, en una ruta pública: cualquiera que conociera un UUID
 *     de cliente podía completar el flujo con su cuenta y sustituir el token.
 *  2. La escritura es ATÓMICA vía `fusionar_config_api`, en vez del
 *     read-modify-write de `config_api` entero.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const errorUrl = (msg: string, cliente?: string) => {
    const res = NextResponse.redirect(
      `${appUrl}/admin/settings${cliente ? `/${cliente}` : ''}?tiktok_error=${encodeURIComponent(msg)}`
    );
    res.cookies.delete(COOKIE);
    return res;
  };

  const authCode = searchParams.get('auth_code');
  const error = searchParams.get('error');

  if (error) return errorUrl(error);
  if (!authCode) return errorUrl('TikTok no devolvió el código de autorización');

  const nonce = request.cookies.get(COOKIE_STATE_OAUTH.tiktok)?.value ?? null;
  let verificacion: ReturnType<typeof verificarStateCliente>;
  try {
    verificacion = verificarStateCliente('tiktok', searchParams.get('state'), nonce);
  } catch {
    return errorUrl('Servidor sin CRON_SECRET configurado');
  }
  // Sin tocar TikTok ni la base de datos: ese es el punto.
  if (!verificacion.ok) return errorUrl(MOTIVO_STATE[verificacion.motivo]);
  const clientId = verificacion.clienteId;

  const appId = process.env.TIKTOK_APP_ID!;
  const appSecret = process.env.TIKTOK_APP_SECRET!;

  // Intercambiar auth_code por access_token.
  // Nota: los access tokens de TikTok Business API no caducan, por lo que no se requiere
  // un cron de refresh (a diferencia de Meta, cuyos tokens long-lived duran ~60 días).
  let tokenData: { code?: number; message?: string; data?: { access_token?: string } };
  try {
    const res = await fetch('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, secret: appSecret, auth_code: authCode }),
    });
    tokenData = await res.json();
  } catch {
    return errorUrl('Error de red con TikTok', clientId);
  }

  const accessToken = tokenData.data?.access_token;
  if (tokenData.code !== 0 || !accessToken) {
    return errorUrl(tokenData.message ?? 'Error obteniendo token', clientId);
  }

  // Guardar SOLO el token en config_api del cliente.
  // Las cuentas publicitarias NO se auto-importan: el admin elige cuáles sincronizar
  // desde la UI (botón "Elegir cuentas"), porque el token concede acceso a todas
  // las cuentas que el usuario autorizó en TikTok. `tiktok_accounts` no va en el
  // parche: `fusionar_config_api` conserva las que hubiera.
  const supabase = await createAdminClient();
  const { data: config, error: rpcError } = await supabase.rpc('fusionar_config_api', {
    p_cliente_id: clientId,
    p_parche: { tiktok_access_token: accessToken },
  });

  if (rpcError) return errorUrl(rpcError.message, clientId);
  // La RPC devuelve NULL si el UPDATE no encontró la fila.
  if (!config) return errorUrl('Cliente no encontrado');

  const ok = NextResponse.redirect(`${appUrl}/admin/settings/${clientId}?tiktok_connected=1`);
  ok.cookies.delete(COOKIE);
  return ok;
}
