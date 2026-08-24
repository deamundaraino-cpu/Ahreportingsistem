// ════════════════════════════════════════════════════════════════
// `state` firmado para el flujo OAuth de Hotmart
// ════════════════════════════════════════════════════════════════
//
// ── El agujero que cierra ───────────────────────────────────────
// `/api/auth/hotmart` mandaba `state = clientId` — el UUID del cliente, que
// aparece en la URL del panel de administración. Y el callback NO lo validaba
// EN ABSOLUTO (`callback/route.ts:13`: lo leía y lo usaba como id sin más), en
// una ruta pública sin autenticación.
//
// Consecuencia: cualquiera que conociera (o adivinara) un `cliente_id` podía
// abrir el flujo de Hotmart con SU PROPIA cuenta, completar el callback y
// SOBRESCRIBIR los tokens de ese cliente. A partir de ahí, el reporting de ese
// cliente mostraría las ventas del atacante.
//
// ── La defensa: doble envío ─────────────────────────────────────
// El `state` viaja firmado con HMAC y caduca a los 10 minutos, y su `nonce` se
// deja además en una cookie httpOnly. Para falsificarlo hay que tener a la vez
// el secreto del servidor (firma) y la cookie del navegador que inició el flujo
// (nonce). No hace falta tabla ni almacenamiento de estado.

import crypto from 'crypto';

export const COOKIE_STATE = 'hotmart_oauth_state';
/** 10 minutos: de sobra para autorizar en Hotmart, poco para reutilizar. */
export const VENTANA_STATE_MS = 10 * 60 * 1000;

type Carga = { clienteId: string; nonce: string; exp: number };

function clave(): string {
  // Se reutiliza CRON_SECRET en vez de inventar otra variable de entorno: ya
  // es un secreto del servidor, ya está desplegado y ya protege endpoints.
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error('CRON_SECRET no configurado: no se puede firmar el state de OAuth');
  return s;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function firma(cargaB64: string, secreto: string): string {
  return b64url(crypto.createHmac('sha256', secreto).update(cargaB64).digest());
}

export type StateFirmado = { state: string; nonce: string };

/** Crea un `state` firmado y el `nonce` que hay que dejar en la cookie. */
export function firmarState(clienteId: string, ahora: number = Date.now()): StateFirmado {
  const nonce = crypto.randomBytes(16).toString('hex');
  const carga: Carga = { clienteId, nonce, exp: ahora + VENTANA_STATE_MS };
  const cargaB64 = b64url(Buffer.from(JSON.stringify(carga), 'utf8'));
  return { state: `${cargaB64}.${firma(cargaB64, clave())}`, nonce };
}

export type VerificacionState =
  | { ok: true; clienteId: string }
  | { ok: false; motivo: 'formato' | 'firma' | 'expirado' | 'nonce' };

/**
 * Verifica un `state` contra el `nonce` de la cookie.
 *
 * Las cuatro comprobaciones, en orden: formato → firma → caducidad → nonce.
 * Cualquier fallo debe abortar SIN tocar la base de datos.
 */
export function verificarState(
  state: string | null | undefined,
  nonceCookie: string | null | undefined,
  ahora: number = Date.now()
): VerificacionState {
  if (!state) return { ok: false, motivo: 'formato' };

  const punto = state.lastIndexOf('.');
  if (punto <= 0) return { ok: false, motivo: 'formato' };

  const cargaB64 = state.slice(0, punto);
  const recibida = state.slice(punto + 1);
  const esperada = firma(cargaB64, clave());

  // Comparación en tiempo constante: comparar con === filtra el secreto por
  // el tiempo de respuesta.
  const a = Buffer.from(recibida);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, motivo: 'firma' };
  }

  let carga: Carga;
  try {
    carga = JSON.parse(deB64url(cargaB64).toString('utf8'));
  } catch {
    return { ok: false, motivo: 'formato' };
  }
  if (!carga?.clienteId || !carga?.nonce || typeof carga.exp !== 'number') {
    return { ok: false, motivo: 'formato' };
  }
  if (carga.exp < ahora) return { ok: false, motivo: 'expirado' };

  if (!nonceCookie) return { ok: false, motivo: 'nonce' };
  const n1 = Buffer.from(carga.nonce);
  const n2 = Buffer.from(nonceCookie);
  if (n1.length !== n2.length || !crypto.timingSafeEqual(n1, n2)) {
    return { ok: false, motivo: 'nonce' };
  }

  return { ok: true, clienteId: carga.clienteId };
}

export type MotivoState = Extract<VerificacionState, { ok: false }>['motivo'];

/**
 * Texto para la UI.
 *
 * `formato` y `firma` comparten mensaje a propósito: distinguirlos le diría a
 * quien esté probando si acertó la estructura pero falló la clave.
 */
export const MOTIVO_STATE: Readonly<Record<MotivoState, string>> = {
  formato: 'La solicitud de conexión no es válida. Vuelve a intentarlo desde el panel.',
  firma: 'La solicitud de conexión no es válida. Vuelve a intentarlo desde el panel.',
  expirado: 'La solicitud de conexión caducó. Vuelve a intentarlo desde el panel.',
  nonce:
    'La solicitud de conexión no coincide con este navegador. Vuelve a intentarlo desde el panel.',
};
