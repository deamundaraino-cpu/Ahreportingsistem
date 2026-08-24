import { OAuth2Client } from 'google-auth-library';
import { createAdminClient } from '@/utils/supabase/server';

// Scopes que pide la conexión OAuth de la agencia.
// analytics.readonly: leer datos de GA4 (Data API) y listar propiedades (Admin API).
// spreadsheets.readonly: leer hojas de cálculo de leads.
// drive.readonly: listar/elegir Sheets desde la UI (fase 2 opcional).
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

const PROVIDER = 'google';

/**
 * Construye un OAuth2Client de Google con el client id/secret de la app
 * y el redirect URI derivado de NEXT_PUBLIC_APP_URL.
 */
export function getGoogleOAuthClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET no configurados');
  }
  if (!appUrl) {
    throw new Error('NEXT_PUBLIC_APP_URL no configurado');
  }

  return new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri: `${appUrl}/api/auth/google/callback`,
  });
}

interface GoogleIntegrationRow {
  provider: string;
  refresh_token: string | null;
  access_token: string | null;
  token_expires_at: string | null;
  connected_email: string | null;
  connection_status: string | null;
}

/**
 * Lee la fila de integración global de Google (provider='google'), o null si no existe.
 */
export async function getGoogleIntegration(): Promise<GoogleIntegrationRow | null> {
  const supabase = await createAdminClient();
  const { data } = await supabase
    .from('app_integrations')
    .select(
      'provider, refresh_token, access_token, token_expires_at, connected_email, connection_status'
    )
    .eq('provider', PROVIDER)
    .maybeSingle();
  return (data as GoogleIntegrationRow) ?? null;
}

/**
 * ¿Hay una conexión OAuth de agencia activa (con refresh token)?
 */
export async function hasAgencyGoogleConnection(): Promise<boolean> {
  const row = await getGoogleIntegration();
  return !!row?.refresh_token && row.connection_status === 'connected';
}

/**
 * Devuelve un OAuth2Client de la agencia listo para usar con las APIs de Google.
 * Lee el refresh_token global, refresca el access_token si venció (cacheándolo en
 * app_integrations) y deja el client autenticado. Lanza si no hay conexión.
 *
 * Mismo espíritu que el refresh de Hotmart en el worker: refrescar antes de usar.
 */
export async function getAgencyAccessToken(): Promise<OAuth2Client> {
  const row = await getGoogleIntegration();
  if (!row?.refresh_token) {
    throw new Error('No hay conexión OAuth de Google a nivel agencia');
  }

  const oauth = getGoogleOAuthClient();
  oauth.setCredentials({ refresh_token: row.refresh_token });

  // Margen de 2 min para evitar usar un token a punto de expirar.
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
  const stillValid = row.access_token && expiresAt - 2 * 60 * 1000 > Date.now();

  if (stillValid) {
    oauth.setCredentials({ refresh_token: row.refresh_token, access_token: row.access_token! });
    return oauth;
  }

  // Refrescar el access token usando el refresh token.
  const { token } = await oauth.getAccessToken();
  const creds = oauth.credentials;
  const newAccessToken = token || creds.access_token || null;
  const newExpiry = creds.expiry_date ? new Date(creds.expiry_date).toISOString() : null;

  if (newAccessToken) {
    const supabase = await createAdminClient();
    await supabase
      .from('app_integrations')
      .update({
        access_token: newAccessToken,
        token_expires_at: newExpiry,
        connection_status: 'connected',
        updated_at: new Date().toISOString(),
      })
      .eq('provider', PROVIDER);
  }

  return oauth;
}

/**
 * Persiste las credenciales OAuth obtenidas en el callback (provider='google').
 * Conserva el refresh_token previo si Google no devuelve uno nuevo.
 */
export async function saveGoogleIntegration(params: {
  refreshToken?: string | null;
  accessToken?: string | null;
  expiresAt?: string | null;
  email?: string | null;
  scopes?: string[];
}): Promise<void> {
  const supabase = await createAdminClient();
  const existing = await getGoogleIntegration();

  await supabase.from('app_integrations').upsert(
    {
      provider: PROVIDER,
      refresh_token: params.refreshToken ?? existing?.refresh_token ?? null,
      access_token: params.accessToken ?? null,
      token_expires_at: params.expiresAt ?? null,
      connected_email: params.email ?? existing?.connected_email ?? null,
      scopes: params.scopes ?? GOOGLE_OAUTH_SCOPES,
      connection_status: 'connected',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'provider' }
  );
}

/**
 * Marca la integración como desconectada (borra los tokens).
 */
export async function disconnectGoogleIntegration(): Promise<void> {
  const supabase = await createAdminClient();
  await supabase
    .from('app_integrations')
    .update({
      refresh_token: null,
      access_token: null,
      token_expires_at: null,
      connection_status: 'disconnected',
      updated_at: new Date().toISOString(),
    })
    .eq('provider', PROVIDER);
}
