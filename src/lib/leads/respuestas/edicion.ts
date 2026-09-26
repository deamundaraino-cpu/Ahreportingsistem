// ── Edición de las respuestas de un campo, en términos de su definición ──
//
// La pantalla de Leads deja trabajar sobre RESPUESTAS («renombrar», «unir»,
// «apartar»), pero lo que se guarda es el mapa valor crudo → respuesta
// (`valores_map`) y el orden (`valores_orden`). Estas funciones hacen esa
// traducción, puras, para que la pantalla no tenga lógica propia y para poder
// comprobarlas sin navegador.
//
// Ninguna toca las claves de respuesta: las reasigna el servidor al guardar
// (`reasignarClaves`), que detecta renombres y fusiones por los valores crudos.
// Por eso aquí basta con mover valores de una etiqueta a otra.

import {
  bucketsDeValor,
  etiquetasDeCampo,
  normalizarValorCrudo,
  BUCKET_OTROS,
} from '@/lib/report-utm/lead-campos';
import type { CampoValorCrudo, LeadCampoDef } from '@/lib/report-utm/lead-campos';
import { limpiarEtiqueta, ordenarRespuestas, respuestasSinClasificar } from './catalogo';

export type DefinicionRespuestas = Pick<
  LeadCampoDef,
  'valores_map' | 'valores_orden' | 'sin_mapear' | 'tipo'
>;

type Cambio = Pick<LeadCampoDef, 'valores_map' | 'valores_orden'>;

/** Orden explícito vigente: el guardado o, si no hay, el que se está viendo. */
function ordenBase(c: DefinicionRespuestas): string[] {
  return c.valores_orden && c.valores_orden.length > 0 ? c.valores_orden : etiquetasDeCampo(c);
}

/** Renombra una respuesta: todos sus valores crudos pasan a la etiqueta nueva. */
export function renombrarRespuesta(c: DefinicionRespuestas, vieja: string, nueva: string): Cambio {
  const n = nueva.trim();
  const mapa = { ...(c.valores_map ?? {}) };
  if (!n || n === vieja) return { valores_map: mapa, valores_orden: [...(c.valores_orden ?? [])] };
  for (const [k, v] of Object.entries(mapa)) if (v === vieja) mapa[k] = n;
  const orden = ordenBase(c).map((l) => (l === vieja ? n : l));
  return { valores_map: mapa, valores_orden: [...new Set(orden)] };
}

/**
 * Une varias respuestas en una: sus valores crudos pasan a `nombre`, que ocupa
 * el sitio de la primera de ellas en el orden.
 */
export function unirRespuestas(
  c: DefinicionRespuestas,
  etiquetas: string[],
  nombre: string,
  /** Valores crudos vistos (para las respuestas sin mapear, que no están en el mapa). */
  crudosVistos: CampoValorCrudo[] = []
): Cambio {
  const n = nombre.trim();
  const unir = new Set(etiquetas);
  const mapa = { ...(c.valores_map ?? {}) };
  if (!n || unir.size === 0) return { valores_map: mapa, valores_orden: [...ordenBase(c)] };
  for (const [k, v] of Object.entries(mapa)) if (v && unir.has(v)) mapa[k] = n;
  // Una respuesta «tal cual» (sin mapear) no está en el mapa: se añade.
  for (const v of crudosVistos) {
    const norm = normalizarValorCrudo(v.valor_crudo);
    if (!norm || Object.prototype.hasOwnProperty.call(mapa, norm)) continue;
    const b = bucketsDeValor(c, v.valor_crudo);
    if (b.length === 1 && unir.has(b[0])) mapa[norm] = n;
  }
  const orden: string[] = [];
  for (const l of ordenBase(c)) {
    const destino = unir.has(l) ? n : l;
    if (!orden.includes(destino)) orden.push(destino);
  }
  if (!orden.includes(n)) orden.push(n);
  return { valores_map: mapa, valores_orden: orden };
}

/**
 * Aparta una respuesta: sus valores cuentan como «sin respuesta» (se mapean a
 * vacío). Es lo que se hace con «Seleccione una opción» o con respuestas de
 * prueba.
 */
export function apartarRespuesta(
  c: DefinicionRespuestas,
  etiqueta: string,
  crudosVistos: CampoValorCrudo[] = []
): Cambio {
  const mapa = { ...(c.valores_map ?? {}) };
  for (const [k, v] of Object.entries(mapa)) if (v === etiqueta) mapa[k] = '';
  for (const v of crudosVistos) {
    const norm = normalizarValorCrudo(v.valor_crudo);
    if (!norm || Object.prototype.hasOwnProperty.call(mapa, norm)) continue;
    const b = bucketsDeValor(c, v.valor_crudo);
    if (b.length === 1 && b[0] === etiqueta) mapa[norm] = '';
  }
  return {
    valores_map: mapa,
    valores_orden: ordenBase(c).filter((l) => l !== etiqueta),
  };
}

/** Recupera un valor apartado: vuelve como respuesta propia con nombre limpio. */
export function recuperarValor(c: DefinicionRespuestas, valorCrudo: string): Cambio {
  const mapa = { ...(c.valores_map ?? {}) };
  const norm = normalizarValorCrudo(valorCrudo);
  const label = limpiarEtiqueta(valorCrudo);
  mapa[norm] = label;
  const orden = ordenBase(c);
  return { valores_map: mapa, valores_orden: orden.includes(label) ? orden : [...orden, label] };
}

/** Da nombre propio (limpio) a las respuestas vistas que el campo aún no clasifica. */
export function anadirSinClasificar(c: DefinicionRespuestas, valores: CampoValorCrudo[]): Cambio {
  const mapa = { ...(c.valores_map ?? {}) };
  const orden = [...ordenBase(c)];
  for (const v of respuestasSinClasificar(c, valores)) {
    const label = limpiarEtiqueta(v.valor_crudo);
    mapa[normalizarValorCrudo(v.valor_crudo)] = label;
    if (!orden.includes(label)) orden.push(label);
  }
  return { valores_map: mapa, valores_orden: orden };
}

/** Orden automático: de menor a mayor si son rangos; si no, se deja como está. */
export function ordenAutomatico(c: DefinicionRespuestas): string[] {
  return ordenarRespuestas(ordenBase(c));
}

/**
 * Respuestas del campo con cuántos leads trae cada una en lo visto. Incluye las
 * que el catálogo conoce aunque nadie las haya elegido (0) y las que salen «tal
 * cual» de los datos. `(otros)` al final.
 */
export function respuestasConConteo(
  c: DefinicionRespuestas,
  valores: CampoValorCrudo[]
): { etiqueta: string; leads: number }[] {
  const n = new Map<string, number>();
  for (const e of etiquetasDeCampo(c)) n.set(e, 0);
  for (const v of valores) {
    for (const b of bucketsDeValor(c, v.valor_crudo)) n.set(b, (n.get(b) ?? 0) + v.filas);
  }
  const orden = ordenBase(c);
  const pos = (l: string) => {
    if (l === BUCKET_OTROS) return Number.MAX_SAFE_INTEGER;
    const i = orden.indexOf(l);
    return i === -1 ? orden.length : i;
  };
  return [...n.entries()]
    .map(([etiqueta, leads]) => ({ etiqueta, leads }))
    .sort((a, b) => pos(a.etiqueta) - pos(b.etiqueta) || b.leads - a.leads);
}

/** Valores crudos apartados (mapeados a vacío o a la etiqueta reservada). */
export function valoresApartados(
  c: DefinicionRespuestas,
  valores: CampoValorCrudo[]
): CampoValorCrudo[] {
  const mapa = c.valores_map ?? {};
  return valores.filter((v) => {
    const norm = normalizarValorCrudo(v.valor_crudo);
    return (
      Object.prototype.hasOwnProperty.call(mapa, norm) &&
      bucketsDeValor(c, v.valor_crudo).length === 0
    );
  });
}
