import { headers, cookies } from 'next/headers';
import { codigoErrorDeRed, describirErrorDeRed } from '@/lib/fetch-json';

/**
 * Llamadas de la app a su propia API desde server actions.
 *
 * Existen porque varias rutas de `/api/admin` necesitan el service role y su
 * propio presupuesto de invocación (`maxDuration = 60`), cosa que una server
 * action no puede darles.
 *
 * Dos cosas que el patrón anterior (`fetch(\`${protocol}://${host}/api/...\`)`)
 * hacía mal y aquí se corrigen:
 *
 *  1. El destino salía del header `Host`, que lo controla quien llama. Ahora
 *     sale de `NEXT_PUBLIC_APP_URL` y solo cae al `Host` en desarrollo local.
 *  2. No reenviaba la sesión, así que la ruta destino llegaba sin cookies y
 *     no podía comprobar quién llamaba — que es justo por lo que esas rutas
 *     acabaron sin ningún control de acceso.
 */
export async function internalOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  // Sin origen configurado solo aceptamos localhost: en producción preferimos
  // fallar de forma visible antes que volver a confiar en el header `Host`.
  const host = (await headers()).get('host') || 'localhost:3000';
  if (!host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    throw new Error(
      'NEXT_PUBLIC_APP_URL no está configurada: no se puede resolver el origen interno de forma segura'
    );
  }
  return `http://${host}`;
}

/**
 * Pista para desarrollo cuando el origen configurado rechaza la conexión: dice
 * en qué dirección está respondiendo de verdad la app, según el `Host` de la
 * petición en curso.
 *
 * Es SOLO un texto. No se enruta por el `Host`: `next dev` escucha en todas las
 * interfaces, así que cualquiera en la red local lo controla, e `internalCronFetch`
 * acabaría mandando `CRON_SECRET` a donde él dijera. Cambiar de destino en silencio
 * además escondería la deriva de configuración, que reaparecería después como un
 * `redirect_uri_mismatch` de OAuth — la misma variable construye esos redirects.
 */
async function pistaPuertoDev(origin: string, e: unknown): Promise<string> {
  if (process.env.NODE_ENV !== 'development' || codigoErrorDeRed(e) !== 'ECONNREFUSED') return '';
  try {
    const host = (await headers()).get('host');
    if (!host || !(host.startsWith('localhost') || host.startsWith('127.0.0.1'))) return '';
    const real = `http://${host}`;
    if (real === origin) return '';
    return ` La app está respondiendo en ${real}: ajusta NEXT_PUBLIC_APP_URL en .env.local y reinicia \`npm run dev\`.`;
  } catch {
    // Sin petición en curso (p. ej. desde un cron) no hay Host que mirar.
    return '';
  }
}

/**
 * `fetch` al origen interno con los fallos de red traducidos.
 *
 * undici los resume en `fetch failed` y la causa real queda en `cause`, que
 * ningún `catch` de las server actions leía: la UI enseñaba `fetch failed` sin
 * más. Aquí se relanza con un mensaje que nombra el destino y el motivo. Los
 * timeouts pasan intactos para que `esTimeoutDeFetch` los siga reconociendo.
 */
async function fetchInterno(origin: string, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${origin}${path}`, init);
  } catch (e) {
    const descripcion = describirErrorDeRed(e, origin);
    if (!descripcion) throw e;
    const pista = await pistaPuertoDev(origin, e);
    // Sin cabeceras en el log: llevan la cookie de sesión o `CRON_SECRET`.
    console.error(
      `[internal-fetch] ${init.method ?? 'GET'} ${path}: ${descripcion}`,
      (e as { cause?: unknown }).cause
    );
    throw new Error(descripcion + pista, { cause: e });
  }
}

/** Cabecera `cookie` de la petición actual, para que la ruta destino vea la sesión. */
async function forwardedCookieHeader(): Promise<string> {
  const all = (await cookies()).getAll();
  return all.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * `fetch` a una ruta interna (`path` empieza por `/`) con el origen fijado y la
 * sesión del usuario reenviada.
 */
export async function internalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const origin = await internalOrigin();
  const cookie = await forwardedCookieHeader();

  const headersInit = new Headers(init.headers);
  if (cookie) headersInit.set('cookie', cookie);

  return fetchInterno(origin, path, {
    ...init,
    headers: headersInit,
    cache: init.cache ?? 'no-store',
  });
}

/**
 * `fetch` a una ruta interna autenticada con `CRON_SECRET` en vez de con la
 * sesión del usuario. Para los endpoints de `/api/worker` y `/api/cron`, que no
 * miran cookies.
 *
 * Existe para que el origen se resuelva en UN solo sitio. Antes había tres
 * caminos distintos —`NEXT_PUBLIC_APP_URL` en unos, el header `Host` en otros,
 * `internalFetch` en el resto—, así que un despliegue con el dominio a medio
 * propagar rompía unos y no otros, y era imposible razonar sobre qué URL usaba
 * cada botón.
 *
 * Lanza si falta `CRON_SECRET`: es preferible al 401 silencioso de después.
 */
export async function internalCronFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET no configurado en el servidor');

  const origin = await internalOrigin();
  const headersInit = new Headers(init.headers);
  headersInit.set('Authorization', `Bearer ${secret}`);

  return fetchInterno(origin, path, {
    ...init,
    headers: headersInit,
    cache: init.cache ?? 'no-store',
  });
}
