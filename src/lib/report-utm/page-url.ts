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
