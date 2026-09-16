/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Lectura de respuestas de nuestros propios endpoints tolerando que el cuerpo
 * no sea JSON.
 *
 * Cuando una función se pasa de su `maxDuration` o se cae, quien responde es la
 * plataforma, no el handler: un cuerpo en texto plano del estilo
 * `An error occurred with this application.\n\nFUNCTION_INVOCATION_TIMEOUT`.
 * `res.json()` reventaba ahí con
 * `Unexpected token 'A', "An error o"... is not valid JSON`, un mensaje que no
 * le dice nada a nadie: lo que había pasado era un timeout.
 */

/** Mensaje por defecto cuando la plataforma cortó la petición por tiempo. */
export const MENSAJE_TIMEOUT =
  'La petición superó el tiempo máximo del servidor. Vuelve a intentarlo con menos datos de una vez.';

/** Discriminada por `ok` para que el llamador estreche `data` con un solo if. */
export type RespuestaJson<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * @param fallback       qué decir si el cuerpo no es JSON por otro motivo.
 * @param mensajeTimeout qué decir si la petición murió por tiempo.
 */
export async function leerJsonRespuesta<T = any>(
  res: Response,
  fallback: string,
  mensajeTimeout: string = MENSAJE_TIMEOUT
): Promise<RespuestaJson<T>> {
  const cuerpo = await res.text();
  try {
    return { ok: true, data: JSON.parse(cuerpo) as T };
  } catch {
    // 504 es el timeout de la función; el código va también en el cuerpo, y
    // algunos cortes (p. ej. el del proxy) llegan con otro status.
    const porTiempo = res.status === 504 || /TIMEOUT/i.test(cuerpo);
    return {
      ok: false,
      error: porTiempo
        ? mensajeTimeout
        : `${fallback} (el servidor respondió ${res.status} sin JSON)`,
    };
  }
}

/** `true` si el fetch murió por el `AbortSignal.timeout` del propio llamador. */
export function esTimeoutDeFetch(e: unknown): boolean {
  const nombre = (e as { name?: string } | null)?.name;
  return nombre === 'TimeoutError' || nombre === 'AbortError';
}

/**
 * Código de sistema que undici deja en la `cause` de un `TypeError: fetch failed`
 * (`ECONNREFUSED`, `ENOTFOUND`…), o null.
 *
 * Se baja hasta tres niveles y mira también `errors[0]`: `localhost` resuelve a
 * `::1` y a `127.0.0.1`, y cuando los dos rechazan la conexión la causa llega
 * como `AggregateError` sin `code` propio.
 */
export function codigoErrorDeRed(e: unknown): string | null {
  let actual: any = (e as any)?.cause;
  for (let nivel = 0; nivel < 3 && actual; nivel++) {
    const code = actual.code ?? actual.errors?.[0]?.code;
    if (typeof code === 'string' && code) return code;
    actual = actual.cause;
  }
  return null;
}

const CODIGOS_TLS = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Mensaje legible para un `fetch` que murió SIN respuesta, o null si `e` no es
 * un fallo de red.
 *
 * Existe porque undici resume cualquier fallo de conexión en `fetch failed`, y
 * ese texto llegaba tal cual a la UI: «Detectar pestañas» decía `fetch failed`
 * cuando lo que pasaba era que `NEXT_PUBLIC_APP_URL` apuntaba a un puerto donde
 * no corría nada. La razón real iba en `cause` y nadie la leía.
 *
 * Los timeouts devuelven null a propósito: los llamadores los reconocen con
 * `esTimeoutDeFetch` y tienen su propio mensaje.
 */
export function describirErrorDeRed(e: unknown, destino: string): string | null {
  if (esTimeoutDeFetch(e)) return null;
  const code = codigoErrorDeRed(e);
  const esFetchFailed = e instanceof TypeError && e.message === 'fetch failed';
  if (!code && !esFetchFailed) return null;

  switch (code) {
    case 'ECONNREFUSED':
      return (
        `No se pudo conectar con ${destino}: nadie escucha en esa dirección (ECONNREFUSED). ` +
        `Comprueba que NEXT_PUBLIC_APP_URL apunta al puerto donde corre la app.`
      );
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `No se pudo resolver el dominio de ${destino} (${code}): revisa NEXT_PUBLIC_APP_URL o el DNS.`;
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
      return `La conexión con ${destino} no respondió a tiempo (${code}).`;
    case 'ECONNRESET':
    case 'UND_ERR_SOCKET':
      return `La conexión con ${destino} se cortó antes de recibir respuesta (${code}).`;
    case 'ERR_INVALID_URL':
      return `NEXT_PUBLIC_APP_URL no es una URL válida (${code}): ${destino}`;
  }
  if (code && CODIGOS_TLS.has(code)) {
    return `El certificado TLS de ${destino} no es válido (${code}).`;
  }
  return `No se pudo conectar con ${destino}${code ? ` (${code})` : ''}.`;
}
