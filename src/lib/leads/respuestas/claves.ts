// ── Respuestas de formulario: el vocabulario ÚNICO de claves ──────────
//
// Una respuesta de un desplegable («$2M a $3M») es una MÉTRICA que se puede poner
// en cualquier tarjeta, columna o gráfica, tanto en las pestañas del dashboard
// como en los informes. Para que eso funcione las dos superficies tienen que
// nombrarla igual, y el nombre tiene que sobrevivir a que el analista renombre
// la respuesta o a que cambie el período. Este archivo es ese vocabulario:
//
//   | Qué                          | Alias de fórmula               | Token de widget (BI)          |
//   |------------------------------|--------------------------------|-------------------------------|
//   | Contactos del período        | `utm_leads`                    | `leads_count`                 |
//   | Una respuesta                | `lf__<campo>__<resp>`          | `leadans:<campo>:<resp>`      |
//   | Los que no respondieron      | `lf__<campo>__sin_respuesta`   | `leadans:<campo>:sin_respuesta` |
//   | Un segmento (varias resp.)   | `lseg__<seg>`                  | `leadseg:<seg>`               |
//   | La pregunta (dimensión)      | —                              | `leadfield:<campo>`           |
//
// Por qué la clave de una respuesta se GUARDA y no se deriva de la etiqueta cada
// vez (auditoría del 2026-09-26): derivarla (`slugRespuesta(etiqueta)`) hacía que
// renombrar «Calificadas» a «Calificados» cambiara la clave y dejara en 0, sin
// avisar, toda tarjeta que la usara; y el sufijo `_2` de dos etiquetas con el
// mismo slug dependía del orden por frecuencia, que cambia con el período. Ahora
// la clave vive en `lead_campos.respuestas` (migración 090) y solo se deriva para
// las respuestas que todavía no tienen una guardada, de forma determinista.
//
// Puro y sin dependencias de servidor: lo usan el motor del BI, el cubo del
// dashboard, los selectores de métricas, el escáner de referencias y el script
// de migración. Si cada uno tuviera su copia, la misma respuesta acabaría con dos
// claves según dónde se mirase.

/** Contactos del período según Report-UTM. NO es `meta_leads` (ver migración 072). */
export const CLAVE_TOTAL_LEADS = 'utm_leads';

/** Prefijo de las claves de fórmula por respuesta: `lf__<campo>__<respuesta>`. */
export const PREFIJO_RESPUESTA = 'lf__';

/** Prefijo de las claves de fórmula de segmento: `lseg__<segmento>`. */
export const PREFIJO_SEGMENTO = 'lseg__';

/** Clave de respuesta reservada a los leads que no contestaron la pregunta. */
export const SIN_RESPUESTA = 'sin_respuesta';

/** Token de widget del BI para una respuesta: `leadans:<campo>:<respuesta>`. */
export const PREFIJO_TOKEN_RESPUESTA = 'leadans:';

/**
 * Claves de respuesta que no puede tomar una respuesta real. `sin_respuesta` es
 * el complemento calculado; `respondieron` se reserva para un futuro total de
 * los que contestaron, que no debe poder chocar con una etiqueta.
 */
export const CLAVES_RESERVADAS: ReadonlySet<string> = new Set([SIN_RESPUESTA, 'respondieron']);

/** Una respuesta con su clave estable, tal como se guarda en `lead_campos.respuestas`. */
export interface RespuestaClave {
  /** Slug inmutable: `[a-z0-9]` en palabras unidas por un `_`. */
  clave: string;
  /** Etiqueta vigente del bucket (lo que produce `valores_map`). */
  nombre: string;
  /**
   * Claves anteriores de esta misma respuesta: la del slug derivado antes de la
   * 090, o la de otra respuesta que se fusionó con esta. Una fórmula guardada
   * con cualquiera de ellas sigue resolviendo aquí.
   */
  alias?: string[];
}

// ── Slugs ─────────────────────────────────────────────────────────────

/**
 * Etiqueta de respuesta → fragmento de clave. Es EXACTAMENTE la función que usaba
 * el dashboard antes de la 090 (`lead-answer-aggregation.ts`): la migración
 * congela como clave lo que esta función producía, así que ninguna fórmula
 * guardada cambia de significado.
 */
export function slugRespuesta(label: string): string {
  return String(label)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
}

/** ¿Es una clave de respuesta bien formada (sin `__`, que parte el alias)? */
export function esClaveRespuestaValida(clave: string): boolean {
  return /^[a-z0-9]+(_[a-z0-9]+)*$/.test(clave) && !CLAVES_RESERVADAS.has(clave);
}

/**
 * Claves de las respuestas de un campo, en el MISMO orden que `buckets`.
 *
 * Primero se respetan las guardadas (por nombre vigente). Las que faltan se
 * derivan del slug, desempatando en orden ALFABÉTICO de etiqueta y no en el de
 * los buckets: el orden de los buckets cambia con el período cuando la pregunta
 * no tiene orden configurado, y un sufijo que dependiera de él haría que la misma
 * tarjeta midiera otra respuesta al cambiar de mes.
 */
export function clavesDeRespuestas(
  buckets: readonly string[],
  guardadas: readonly RespuestaClave[] = []
): string[] {
  const porNombre = new Map<string, string>();
  for (const r of guardadas) if (r?.nombre && r?.clave) porNombre.set(r.nombre, r.clave);

  // Las claves guardadas (y sus alias) quedan reservadas aunque su bucket no
  // aparezca en este período: si no, una respuesta nueva podría quedarse con la
  // clave de una que solo está ausente este mes.
  const usadas = new Set<string>(CLAVES_RESERVADAS);
  for (const r of guardadas) {
    if (r?.clave) usadas.add(r.clave);
    for (const a of r?.alias ?? []) usadas.add(a);
  }

  const asignadas = new Map<string, string>();
  for (const b of buckets) {
    const g = porNombre.get(b);
    if (g) asignadas.set(b, g);
  }
  const pendientes = [...new Set(buckets.filter((b) => !asignadas.has(b)))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  for (const b of pendientes) {
    const base = slugRespuesta(b) || 'respuesta';
    let slug = base;
    let i = 2;
    while (usadas.has(slug)) slug = `${base}_${i++}`;
    usadas.add(slug);
    asignadas.set(b, slug);
  }
  return buckets.map((b) => asignadas.get(b)!);
}

/**
 * Clave de UNA etiqueta: la guardada o, si no tiene, su slug sin chocar con
 * ninguna guardada. Es `clavesDeRespuestas` para un solo bucket, y la usa el
 * motor del BI, que ve las etiquetas lead a lead y no como lista.
 */
export function claveDeEtiqueta(label: string, guardadas: readonly RespuestaClave[] = []): string {
  return clavesDeRespuestas([label], guardadas)[0];
}

/**
 * Resuelve una clave pedida (posiblemente antigua) a la clave vigente. Devuelve
 * la misma clave si no es un alias de nadie.
 */
export function claveVigente(clave: string, guardadas: readonly RespuestaClave[] = []): string {
  for (const r of guardadas) {
    if (r.clave === clave) return clave;
    if ((r.alias ?? []).includes(clave)) return r.clave;
  }
  return clave;
}

// ── Claves de fórmula ─────────────────────────────────────────────────

export function claveFormulaRespuesta(campo: string, resp: string): string {
  return `${PREFIJO_RESPUESTA}${campo}__${resp}`;
}

export function claveFormulaSinRespuesta(campo: string): string {
  return claveFormulaRespuesta(campo, SIN_RESPUESTA);
}

export function claveFormulaSegmento(seg: string): string {
  return `${PREFIJO_SEGMENTO}${seg}`;
}

/**
 * Alias `lf__<campo>__<resp>` → partes. Exacto porque la clave de un campo nunca
 * lleva `__` (es un `slugCampo`, que colapsa los guiones bajos): el primer `__`
 * tras el campo es el separador.
 */
const RE_ALIAS_RESPUESTA = /\blf__([a-z0-9]+(?:_[a-z0-9]+)*)__([a-z0-9]+(?:_[a-z0-9]+)*)\b/g;

export function parseClaveFormulaRespuesta(id: string): { campo: string; resp: string } | null {
  const m = /^lf__([a-z0-9]+(?:_[a-z0-9]+)*)__([a-z0-9]+(?:_[a-z0-9]+)*)$/.exec(id);
  return m ? { campo: m[1], resp: m[2] } : null;
}

// ── Tokens de widget (BI) ─────────────────────────────────────────────

export function tokenRespuesta(campo: string, resp: string): string {
  return `${PREFIJO_TOKEN_RESPUESTA}${campo}:${resp}`;
}

export function esTokenRespuesta(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith(PREFIJO_TOKEN_RESPUESTA);
}

export function parseTokenRespuesta(token: string): { campo: string; resp: string } | null {
  if (!esTokenRespuesta(token)) return null;
  const rest = token.slice(PREFIJO_TOKEN_RESPUESTA.length);
  const i = rest.indexOf(':');
  if (i <= 0 || i === rest.length - 1) return null;
  return { campo: rest.slice(0, i), resp: rest.slice(i + 1) };
}

// ── Referencias dentro de un texto (fórmula, layout serializado) ──────

export interface ReferenciasDeLead {
  /** `utm_leads` como palabra completa. */
  totales: boolean;
  /** Respuestas por alias `lf__` o token `leadans:`. */
  respuestas: { campo: string; resp: string; texto: string }[];
  /** Segmentos por alias `lseg__` o token `leadseg:`. */
  segmentos: { clave: string; texto: string }[];
  /** Preguntas por token `leadfield:`. */
  campos: { clave: string; texto: string }[];
}

/**
 * Todas las referencias de lead de un texto, como TOKENS EXACTOS.
 *
 * Sustituye a las búsquedas por subcadena (`txt.includes('lseg__desde_2')`), que
 * daban por usada `lseg__desde_2` cuando la fórmula decía `lseg__desde_2m`. Aquí
 * cada coincidencia termina en un límite de palabra, así que un prefijo nunca
 * cuenta como uso.
 */
export function extraerReferenciasDeLead(texto: string | null | undefined): ReferenciasDeLead {
  const out: ReferenciasDeLead = { totales: false, respuestas: [], segmentos: [], campos: [] };
  if (!texto) return out;
  out.totales = /(?<![a-z0-9_])utm_leads(?![a-z0-9_])/i.test(texto);

  for (const m of texto.matchAll(RE_ALIAS_RESPUESTA)) {
    out.respuestas.push({ campo: m[1], resp: m[2], texto: m[0] });
  }
  for (const m of texto.matchAll(/leadans:([a-z0-9_]+):([a-z0-9_]+)/g)) {
    out.respuestas.push({ campo: m[1], resp: m[2], texto: m[0] });
  }
  for (const m of texto.matchAll(/(?<![a-z0-9_])lseg__([a-z0-9_]+)(?![a-z0-9_])/g)) {
    out.segmentos.push({ clave: m[1], texto: m[0] });
  }
  for (const m of texto.matchAll(/leadseg:([a-z0-9_]+)(?![a-z0-9_])/g)) {
    out.segmentos.push({ clave: m[1], texto: m[0] });
  }
  for (const m of texto.matchAll(/leadfield:([a-z0-9_]+)(?![a-z0-9_])/g)) {
    out.campos.push({ clave: m[1], texto: m[0] });
  }
  return out;
}

/** ¿El texto menciona alguna métrica de lead (total, respuesta o segmento)? */
export function textoUsaMetricasDeLead(texto: string | null | undefined): boolean {
  const r = extraerReferenciasDeLead(texto);
  return r.totales || r.respuestas.length > 0 || r.segmentos.length > 0;
}

// ── Asignación de claves al guardar un campo ─────────────────────────

/**
 * Recalcula las claves de un campo al guardarlo, conservando las existentes y
 * detectando renombres.
 *
 * Un RENOMBRE es una etiqueta vieja cuyos valores crudos pasan, todos, a una
 * única etiqueta nueva que antes no existía: «Calificadas» → «Calificados» con
 * los mismos valores debajo. La respuesta conserva su clave, así que las
 * tarjetas no se enteran. Dos etiquetas viejas que acaban en la misma nueva son
 * una FUSIÓN: la nueva se queda con la clave de la más grande y la otra pasa a
 * alias, para que las fórmulas que la usaban sigan resolviendo.
 *
 * Devuelve también el mapa de renombres (etiqueta vieja → nueva) para reescribir
 * los segmentos, que guardan etiquetas.
 */
export function reasignarClaves(input: {
  mapaAnterior: Record<string, string | null | undefined>;
  mapaNuevo: Record<string, string | null | undefined>;
  respuestasAnteriores: readonly RespuestaClave[];
  /** Etiquetas del campo nuevo (valores del mapa ∪ orden ∪ `(otros)`). */
  etiquetasNuevas: readonly string[];
}): { respuestas: RespuestaClave[]; renombres: Map<string, string> } {
  const { mapaAnterior, mapaNuevo, respuestasAnteriores, etiquetasNuevas } = input;
  const nuevas = new Set(etiquetasNuevas.filter(Boolean));
  const anteriores = new Map(respuestasAnteriores.map((r) => [r.nombre, r]));

  // Valores crudos por etiqueta, en los dos mapas.
  const crudosPor = (mapa: Record<string, string | null | undefined>) => {
    const m = new Map<string, string[]>();
    for (const [crudo, et] of Object.entries(mapa ?? {})) {
      if (!et) continue;
      const l = m.get(et);
      if (l) l.push(crudo);
      else m.set(et, [crudo]);
    }
    return m;
  };
  const crudosAntes = crudosPor(mapaAnterior);

  // Etiqueta vieja → etiqueta nueva, solo si TODOS sus crudos van a la misma.
  const renombres = new Map<string, string>();
  for (const [vieja, crudos] of crudosAntes) {
    if (nuevas.has(vieja)) continue; // sigue existiendo: no es renombre
    const destinos = new Set(crudos.map((c) => mapaNuevo?.[c]).filter(Boolean) as string[]);
    if (destinos.size !== 1) continue;
    const [nueva] = destinos;
    if (anteriores.has(nueva) && nuevas.has(nueva) && crudosAntes.has(nueva)) {
      // Fusión con una etiqueta que ya existía: la vieja pasa a alias de ella.
      renombres.set(vieja, nueva);
      continue;
    }
    renombres.set(vieja, nueva);
  }

  const out = new Map<string, RespuestaClave>();
  const usadas = new Set<string>();
  const reservar = (r: RespuestaClave) => {
    usadas.add(r.clave);
    for (const a of r.alias ?? []) usadas.add(a);
  };

  // 1. Las que siguen con el mismo nombre conservan su clave.
  for (const et of nuevas) {
    const prev = anteriores.get(et);
    if (prev) {
      const r = { clave: prev.clave, nombre: et, alias: [...(prev.alias ?? [])] };
      out.set(et, r);
      reservar(r);
    }
  }
  // 2. Renombres y fusiones: la nueva hereda la clave, o la acumula como alias.
  const viejasPorVolumen = [...renombres.entries()].sort(
    (a, b) => (crudosAntes.get(b[0])?.length ?? 0) - (crudosAntes.get(a[0])?.length ?? 0)
  );
  for (const [vieja, nueva] of viejasPorVolumen) {
    const prev = anteriores.get(vieja);
    if (!prev || !nuevas.has(nueva)) continue;
    const ya = out.get(nueva);
    if (!ya) {
      const r = { clave: prev.clave, nombre: nueva, alias: [...(prev.alias ?? [])] };
      out.set(nueva, r);
      reservar(r);
    } else {
      const alias = new Set([...(ya.alias ?? []), prev.clave, ...(prev.alias ?? [])]);
      alias.delete(ya.clave);
      ya.alias = [...alias];
      reservar(ya);
    }
  }
  // 3. Las respuestas viejas que desaparecen del todo reservan su clave en un
  //    alias de nadie: no se reutilizan para otra respuesta (una tarjeta vieja
  //    mediría otra cosa). Se conservan como entradas sin bucket.
  const huerfanas: RespuestaClave[] = [];
  for (const prev of respuestasAnteriores) {
    if (out.has(prev.nombre)) continue;
    if (renombres.has(prev.nombre) && out.has(renombres.get(prev.nombre)!)) continue;
    huerfanas.push(prev);
    usadas.add(prev.clave);
    for (const a of prev.alias ?? []) usadas.add(a);
  }
  // 4. Las nuevas de verdad: slug determinista (orden alfabético).
  const pendientes = [...nuevas].filter((et) => !out.has(et)).sort();
  for (const et of pendientes) {
    const base = slugRespuesta(et) || 'respuesta';
    let slug = base;
    let i = 2;
    while (usadas.has(slug) || CLAVES_RESERVADAS.has(slug)) slug = `${base}_${i++}`;
    usadas.add(slug);
    out.set(et, { clave: slug, nombre: et });
  }

  const limpiar = (r: RespuestaClave): RespuestaClave =>
    r.alias && r.alias.length > 0 ? r : { clave: r.clave, nombre: r.nombre };
  return {
    respuestas: [
      ...[...out.values()].map(limpiar),
      // Las huérfanas se conservan al final: sin bucket no pintan nada, pero su
      // clave sigue reservada y resoluble.
      ...huerfanas.map(limpiar),
    ],
    renombres,
  };
}
