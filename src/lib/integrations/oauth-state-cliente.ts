// `state` del flujo OAuth de Meta y TikTok (conexión POR CLIENTE).
//
// ── El agujero que cierra ───────────────────────────────────────
// `/api/auth/meta` y `/api/auth/tiktok` mandaban `state = clientId` — el UUID
// del cliente, que aparece en la URL del panel — y los callbacks lo usaban como
// id sin comprobar nada, en rutas públicas. Quien conociera un `cliente_id`
// podía montar el diálogo de Facebook/TikTok (el `app_id` es público), autorizar
// con SU cuenta y sobrescribir el token de ese cliente.
//
// Reutiliza la firma HMAC + nonce en cookie de `lib/hotmart/oauth-state.ts`.
// La carga lleva `<proveedor>:<cliente_id>`: el prefijo separa los dominios, así
// que un `state` firmado para Hotmart, Google o el otro proveedor no vale aquí.

import {
  firmarState,
  verificarState,
  VENTANA_STATE_MS,
  type StateFirmado,
  type VerificacionState,
} from '@/lib/hotmart/oauth-state';

export type ProveedorOAuth = 'meta' | 'tiktok';

export const COOKIE_STATE_OAUTH: Readonly<Record<ProveedorOAuth, string>> = {
  meta: 'meta_oauth_state',
  tiktok: 'tiktok_oauth_state',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ruta de la cookie: solo viaja al inicio y al callback de ese proveedor. */
export function pathCookieState(proveedor: ProveedorOAuth): string {
  return `/api/auth/${proveedor}`;
}

export function opcionesCookieState(proveedor: ProveedorOAuth) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // `lax` y no `strict`: la vuelta desde el proveedor es una navegación
    // top-level de otro sitio, y con `strict` la cookie no se enviaría.
    sameSite: 'lax' as const,
    path: pathCookieState(proveedor),
    maxAge: Math.floor(VENTANA_STATE_MS / 1000),
  };
}

/** Lanza si falta `CRON_SECRET`: el llamador debe fallar, no mandar el `state` sin firmar. */
export function firmarStateCliente(
  proveedor: ProveedorOAuth,
  clienteId: string,
  ahora: number = Date.now()
): StateFirmado {
  return firmarState(`${proveedor}:${clienteId}`, ahora);
}

/**
 * Verifica el `state` contra el nonce de la cookie y devuelve el `cliente_id`
 * sin el prefijo. Cualquier fallo debe abortar SIN tocar la base de datos.
 */
export function verificarStateCliente(
  proveedor: ProveedorOAuth,
  state: string | null | undefined,
  nonceCookie: string | null | undefined,
  ahora: number = Date.now()
): VerificacionState {
  const v = verificarState(state, nonceCookie, ahora);
  if (!v.ok) return v;
  const prefijo = `${proveedor}:`;
  if (!v.clienteId.startsWith(prefijo)) return { ok: false, motivo: 'formato' };
  const clienteId = v.clienteId.slice(prefijo.length);
  if (!UUID_RE.test(clienteId)) return { ok: false, motivo: 'formato' };
  return { ok: true, clienteId };
}
