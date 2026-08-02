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
  'La petición superó el tiempo máximo del servidor. Vuelve a intentarlo con menos datos de una vez.'

/** Discriminada por `ok` para que el llamador estreche `data` con un solo if. */
export type RespuestaJson<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * @param fallback       qué decir si el cuerpo no es JSON por otro motivo.
 * @param mensajeTimeout qué decir si la petición murió por tiempo.
 */
export async function leerJsonRespuesta<T = any>(
  res: Response,
  fallback: string,
  mensajeTimeout: string = MENSAJE_TIMEOUT
): Promise<RespuestaJson<T>> {
  const cuerpo = await res.text()
  try {
    return { ok: true, data: JSON.parse(cuerpo) as T }
  } catch {
    // 504 es el timeout de la función; el código va también en el cuerpo, y
    // algunos cortes (p. ej. el del proxy) llegan con otro status.
    const porTiempo = res.status === 504 || /TIMEOUT/i.test(cuerpo)
    return {
      ok: false,
      error: porTiempo ? mensajeTimeout : `${fallback} (el servidor respondió ${res.status} sin JSON)`,
    }
  }
}

/** `true` si el fetch murió por el `AbortSignal.timeout` del propio llamador. */
export function esTimeoutDeFetch(e: unknown): boolean {
  const nombre = (e as { name?: string } | null)?.name
  return nombre === 'TimeoutError' || nombre === 'AbortError'
}
