/**
 * Medida y recorte de etiquetas de gráfico.
 *
 * Todo lo que se corta en un gráfico —el nombre de una barra, el tick de un eje,
 * la etiqueta de una porción— pasa por aquí, con una regla única: **el ancho
 * sale del texto real del gráfico, no de una constante**, y lo que aun así no
 * quepa se corta con «…» dejando SIEMPRE forma de recuperarlo (un `<title>` en
 * SVG, un `title=` en HTML o un tooltip).
 *
 * El problema que resuelve, tal cual estaba: el eje Y de las barras del BI tenía
 * `width={100}` fijo, así que «Entre $2.000.000 y $4.000.000» se cortaba igual en
 * un widget de un cuarto de ancho que en uno de ancho completo; y el eje X del
 * dashboard cortaba a 15 caracteres a pelo, sin tooltip, dejando irrecuperable el
 * nombre de la campaña.
 *
 * Módulo PURO: sin DOM, sin React, sin `window`. Es lo que permite verificarlo
 * con `scripts/verify-chart-labels.ts` sin navegador.
 */

/** Carácter de corte. Uno solo, no tres puntos: ocupa menos y se lee igual. */
const ELIPSIS = '…';

/**
 * Ancho de cada carácter como fracción del `fontSize`.
 *
 * Un factor plano (el clásico `0.6`) falla en los dos sentidos a la vez: sobra
 * en «informacion» y se queda muy corto en «CONV | LEADS | MÉXICO», que es
 * exactamente la forma de los nombres de campaña de este proyecto. Con una tabla
 * corta el error baja lo suficiente como para que el ancho del eje deje de
 * parecer arbitrario.
 *
 * Los valores son de una fuente sans de UI (Geist / system-ui). No pretenden ser
 * exactos: el tooltip es lo que hace inocuo un corte de más.
 */
const ULTRA_ESTRECHOS = new Set([...'iljtfr.,:;\'"!|()[]']);
const ANCHOS = new Set([...'mw']);
const EXTRA_ANCHOS = new Set([...'MW']);
const MAYUSCULAS = /[A-ZÁÉÍÓÚÑÜ@%]/;
const DIGITOS = /[0-9$]/;

function factorDe(c: string): number {
  if (c === ' ') return 0.28;
  if (ULTRA_ESTRECHOS.has(c)) return 0.32;
  if (EXTRA_ANCHOS.has(c)) return 0.92;
  if (ANCHOS.has(c)) return 0.85;
  if (DIGITOS.test(c)) return 0.58;
  if (MAYUSCULAS.test(c)) return 0.72;
  return 0.54; // minúsculas y acentuadas
}

/** Margen de seguridad: es peor quedarse corto (corta) que pasarse (hueco). */
const MARGEN = 1.02;

/** Ancho estimado del texto, en píxeles, para un `fontSize` dado. */
export function anchoTextoPx(texto: string, fontSize: number): number {
  if (!texto) return 0;
  let total = 0;
  for (const c of texto) total += factorDe(c);
  return total * fontSize * MARGEN;
}

/**
 * Corte por número de caracteres.
 *
 * Es el reemplazo del `truncateLabel` que vivía dentro de `ChartWidget.tsx`, con
 * el mismo comportamiento, para las leyendas donde no se conoce el ancho.
 */
export function truncarEtiqueta(texto: string, max = 28): string {
  if (max <= 0) return '';
  return texto.length > max ? texto.slice(0, max - 1) + ELIPSIS : texto;
}

/**
 * Corte por ancho disponible, que es lo que de verdad hace falta en un eje.
 *
 * Devuelve el texto intacto si cabe: una etiqueta corta NUNCA debe recibir «…»,
 * porque entonces el `<title>` del tick se vuelve ruido en todas las filas.
 */
export function truncarAAncho(texto: string, maxPx: number, fontSize: number): string {
  if (!texto) return '';
  if (maxPx <= 0) return '';
  if (anchoTextoPx(texto, fontSize) <= maxPx) return texto;

  const anchoElipsis = anchoTextoPx(ELIPSIS, fontSize);
  const disponible = maxPx - anchoElipsis;
  // Ni siquiera cabe un carácter junto a la elipsis. Se devuelve la elipsis
  // sola: es la respuesta honesta —«aquí hay texto que no cabe»— y el nombre
  // completo sigue estando en el tooltip. Devolver cadena vacía haría que la
  // fila pareciera no tener etiqueta.
  if (disponible <= 0) return ELIPSIS;

  let acc = 0;
  let corte = 0;
  const chars = [...texto];
  for (let i = 0; i < chars.length; i++) {
    acc += factorDe(chars[i]) * fontSize * MARGEN;
    if (acc > disponible) break;
    corte = i + 1;
  }
  // Al menos un carácter antes de la elipsis: «…» a secas no dice nada.
  return chars.slice(0, Math.max(1, corte)).join('') + ELIPSIS;
}

export interface AnchoEjeOpts {
  /** Tamaño real del tick. Ojo: NO es el mismo en los dos módulos (ver abajo). */
  fontSize?: number;
  /** Suelo, para que el eje no desaparezca en un widget diminuto. */
  minPx?: number;
  /** Techo duro, para que un nombre kilométrico no se coma el gráfico. */
  maxPx?: number;
  /** …y un techo relativo al contenedor, que es el que manda en widgets estrechos. */
  fraccionMax?: number;
  /** Hueco entre el texto y la línea del eje. */
  padPx?: number;
  /** Ancho medido del contenedor. Sin él solo actúa `maxPx`. */
  anchoContenedor?: number;
}

/**
 * Ancho para un `<YAxis type="category">`: lo que pide la etiqueta más larga,
 * acotado por arriba.
 *
 * El techo relativo (`fraccionMax`) es lo que impide el fallo obvio de "que
 * quepa todo": con nombres de campaña de 60 caracteres el eje se comería el área
 * de datos y el gráfico dejaría de ser un gráfico. Pasado ese punto se corta y
 * el nombre completo lo devuelve el tooltip.
 */
export function anchoEjeCategoria(etiquetas: string[], opts: AnchoEjeOpts = {}): number {
  const {
    fontSize = 11,
    minPx = 56,
    maxPx = 220,
    fraccionMax = 0.4,
    padPx = 8,
    anchoContenedor,
  } = opts;

  const natural =
    etiquetas.reduce((max, e) => Math.max(max, anchoTextoPx(String(e ?? ''), fontSize)), 0) + padPx;

  const techoRelativo =
    anchoContenedor && anchoContenedor > 0 ? Math.floor(anchoContenedor * fraccionMax) : maxPx;

  // `Math.max(minPx, …)` protege el caso patológico de un contenedor de 120 px,
  // donde el techo relativo caería por DEBAJO del suelo y el clamp se invertiría.
  const techo = Math.max(minPx, Math.min(maxPx, techoRelativo));

  return Math.min(Math.max(Math.round(natural), minPx), techo);
}
