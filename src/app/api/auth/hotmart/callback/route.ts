import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { cifrarSecreto, hayClaveDeCifrado } from '@/lib/secretos';
import { verificarState, COOKIE_STATE, MOTIVO_STATE } from '@/lib/hotmart/oauth-state';
import { HOTMART_AUTH_BASE } from '@/lib/hotmart/cliente';

const TOKEN_URL = `${HOTMART_AUTH_BASE}/security/oauth/token`;

/**
 * Callback OAuth de Hotmart (HotConnect).
 *
 * Tres cambios frente a la versión anterior:
 *
 *  1. SE VALIDA EL `state`. Antes se leía como `cliente_id` sin comprobar nada,
 *     en una ruta pública: cualquiera que conociera un UUID de cliente podía
 *     completar el flujo con su propia cuenta de Hotmart y quedarse con el
 *     reporting de ese cliente.
 *  2. Los tokens se guardan CIFRADOS (AES-256-GCM). Antes iban en texto plano
 *     dentro de `clientes.config_api`.
 *  3. La escritura es ATÓMICA vía `fusionar_config_api`. El read-modify-write
 *     anterior pisaba lo que hubieran escrito a la vez el cron de refresco o el
 *     worker, perdiendo tokens recién renovados.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const errorUrl = (msg: string, cliente?: string) =>
    NextResponse.redirect(
      `${appUrl}/admin/settings${cliente ? `/${cliente}` : ''}?hotmart_error=${encodeURIComponent(msg)}`
    );

  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const errorOAuth = searchParams.get('error_description') || searchParams.get('error');

  if (errorOAuth) return errorUrl(errorOAuth);
  if (!code) return errorUrl('Hotmart no devolvió el código de autorización');

  // ── La validación que no existía ────────────────────────────
  const nonce = request.cookies.get(COOKIE_STATE)?.value ?? null;
  let verificacion: ReturnType<typeof verificarState>;
  try {
    verificacion = verificarState(state, nonce);
  } catch {
    return errorUrl('Servidor sin CRON_SECRET configurado');
  }
  if (!verificacion.ok) {
    // Sin tocar la base de datos: ese es el punto.
    const res = errorUrl(MOTIVO_STATE[verificacion.motivo]);
    res.cookies.delete(COOKIE_STATE);
    return res;
  }
  const clienteId = verificacion.clienteId;
  const settingsUrl = `${appUrl}/admin/settings/${clienteId}`;

  if (!hayClaveDeCifrado()) {
    // Guardar el token en claro pensando que quedó cifrado es peor que no
    // conectar: se falla de forma visible.
    return errorUrl('RUTM_ENCRYPTION_KEY no configurada en el servidor', clienteId);
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.HOTMART_APP_CLIENT_ID!,
      client_secret: process.env.HOTMART_APP_CLIENT_SECRET!,
      code,
      redirect_uri: `${appUrl}/api/auth/hotmart/callback`,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = await res.json();

    if (data.error || !data.access_token) {
      const msg = data.error_description || data.error || 'No se obtuvo access_token';
      return errorUrl(msg, clienteId);
    }

    const expiresIn: number = data.expires_in ?? 6 * 60 * 60; // fallback 6 h
    const parche: Record<string, unknown> = {
      hotmart_auth_mode: 'hotconnect',
      hotmart_access_token_enc: cifrarSecreto(data.access_token),
      hotmart_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      hotmart_connection_status: 'connected',
      hotmart_last_checked_at: new Date().toISOString(),
      // Se borran las claves en claro que pudiera haber de antes: dejarlas
      // convertiría el cifrado en decorativo.
      hotmart_access_token: null,
    };
    if (data.refresh_token) {
      parche.hotmart_refresh_token_enc = cifrarSecreto(data.refresh_token);
      parche.hotmart_refresh_token = null;
    }

    const supabase = await createAdminClient();
    const { error: rpcError } = await supabase.rpc('fusionar_config_api', {
      p_cliente_id: clienteId,
      p_parche: parche,
    });

    if (rpcError) return errorUrl(rpcError.message, clienteId);

    const okRes = NextResponse.redirect(`${settingsUrl}?hotmart_connected=1`);
    okRes.cookies.delete(COOKIE_STATE);
    return okRes;
  } catch {
    return errorUrl('Error de red con Hotmart', clienteId);
  }
}
