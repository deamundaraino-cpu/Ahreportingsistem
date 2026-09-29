/**
 * Normaliza `page_url` antes de guardarla en `lead_events`.
 *
 * La URL de la landing llegaba entera, con su query string: 486 caracteres de
 * media y 42 MB en la tabla, el 29 % de sus datos. Casi todo era información
 * que ya está en columnas propias de la misma fila:
 *
 *   · `utm_*`  → columnas `utm_source`, `utm_medium`, `utm_campaign`, …
 *   · `fbclid` / `ttclid` / `gclid` → columna `click_id`
 *
 * Medido sobre las 89.851 filas con query string: `fbclid` aparecía en 85.087 y
 * `ttclid` en 4.171, y el 99,8 % de los leads ya tenía `click_id` poblado. O sea
 * que quitarlos no pierde nada — solo deja de guardarlo dos veces.
 *
 * Lo que NO se toca son los parámetros propios del cliente (`lpt`, `hsa_*`,
 * `brid`, los de previsualización de WordPress…). Aparecen en 3.565 filas y no
 * están duplicados en ninguna columna. Conservarlos cuesta 684 kB sobre los
 * 5,4 MB que ocuparía guardar solo el path, así que no hay nada que ganar
 * recortándolos: se guardan.
 */

/** Parámetros que ya viven en una columna propia de la fila. */
const YA_EN_COLUMNAS = /^(utm_[a-z_]+|fbclid|gclid|ttclid|msclkid|twclid|li_fat_id)$/i;

export function normalizarPageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // No es una URL absoluta (el plugin manda lo que tenga). Se guarda tal cual:
    // recortar a ciegas una cadena que no sabemos leer sí podría perder datos.
    return url;
  }
  // Se itera sobre una copia de las claves: borrar mientras se recorre el
  // iterador vivo de URLSearchParams se salta entradas.
  for (const clave of [...u.searchParams.keys()]) {
    if (YA_EN_COLUMNAS.test(clave)) u.searchParams.delete(clave);
  }
  // Si no queda ningún parámetro, `toString()` ya omite el `?` sobrante.
  return u.toString();
}

/** Etiqueta de las filas sin página (lead sin `page_url`, sesión `(not set)`). */
export const SIN_PAGINA = '(sin página)';

/**
 * Ruta canónica de una página, para cruzar GA4 con los leads.
 *
 * GA4 da `landingPage` sin host ni query y sin barra final
 * (`/asesoria-v2`), `pagePath` CON barra final (`/asesoria-v2/`), y un lead trae
 * la URL entera, a veces aún con `fbclid` (Eduversio: 38.000 URL distintas
 * para 19 rutas). Las tres tienen que caer en la misma clave o el cruce
 * «sesiones → leads por landing» no junta nada.
 *
 * Sin host a propósito: GA4 no lo da en `landingPage` y cada cliente usa un solo
 * dominio (medido el 2026-09-28). `''` = página desconocida.
 *
 * Idempotente: `rutaDePagina(rutaDePagina(x)) === rutaDePagina(x)`.
 */
export function rutaDePagina(v: string | null | undefined): string {
  let s = String(v ?? '').trim();
  if (!s || s.toLowerCase() === '(not set)') return '';
  if (s === '(other)') return s;
  // Esquema o `//host`: quedarse con la ruta.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('//')) {
    try {
      s = new URL(s.startsWith('//') ? `https:${s}` : s).pathname;
    } catch {
      s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').replace(/^\/\/[^/?#]*/, '');
    }
  }
  s = s.split(/[?#]/, 1)[0];
  try {
    s = decodeURIComponent(s);
  } catch {
    // Una secuencia `%` rota se deja tal cual: mejor una ruta fea que perderla.
  }
  s = s.toLowerCase().replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}
