// `state` del flujo OAuth de Google (conexión de AGENCIA).
//
// Reutiliza la firma HMAC + nonce en cookie de `lib/hotmart/oauth-state.ts`.
// La carga lleva un identificador fijo en lugar de un `cliente_id` porque la
// conexión es una sola para toda la agencia; el callback exige ese valor, así
// que un `state` firmado para Hotmart no sirve aquí (y la cookie es otra).

import { verificarState, type VerificacionState } from '@/lib/hotmart/oauth-state';

export const COOKIE_STATE_GOOGLE = 'google_oauth_state';
export const STATE_AGENCIA_GOOGLE = 'agencia:google';

export function verificarStateGoogle(
  state: string | null | undefined,
  nonceCookie: string | null | undefined,
  ahora: number = Date.now()
): VerificacionState {
  const v = verificarState(state, nonceCookie, ahora);
  if (v.ok && v.clienteId !== STATE_AGENCIA_GOOGLE) return { ok: false, motivo: 'formato' };
  return v;
}
