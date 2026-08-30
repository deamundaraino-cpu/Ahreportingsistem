/**
 * Agregación del cubo de respuestas de formulario para un bloque del dashboard.
 *
 * Toma el `LeadAnswerDataset` que trae el servidor —(día × campaña × bucket)
 * codificado por diccionario— y lo reduce a las barras que se pintan, aplicando
 * en orden: filtro de campañas de la PESTAÑA, filtro propio del BLOQUE, recorte
 * de fechas de la pestaña, y por último Top-N.
 *
 * Puro: sin Supabase ni `next/*`, para poder comprobarlo desde `scripts/`. Misma
 * regla que `merge-metrics.ts`, y por la misma razón: es donde viven las
 * decisiones que cambian cifras.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { filterCampaignList } from '@/lib/campaign-filter';
import type { AnyCampaignFilter } from '@/lib/campaign-filter';
import type { CampaignFilterSpec, LeadAnswerBlockDef } from '@/lib/layout-types';
// `lead-campos` es puro (solo depende de `sheets/campos`, que no importa nada),
// así que se puede usar aquí sin romper la regla de este archivo. Se importa la
// regla de pertenencia en vez de copiarla: si divergiera, el mismo segmento
// contaría distinto en el dashboard y en los informes.
import { segmentoIncluyeBucket } from '@/lib/report-utm/lead-campos';
import type { LeadSegmentoLite } from '@/lib/report-utm/lead-campos';
export type { LeadSegmentoLite };

/** Etiqueta del diccionario reservada a los leads que no cruzaron campaña. */
export const SIN_CAMPANA = '(sin campaña)';

/** Etiqueta del bucket sintético que recoge la cola larga. */
export const BUCKET_RESTO = 'Otras respuestas';

export interface LeadAnswerCatalogoLite {
  clave: string;
  nombre: string;
  buckets: string[];
  claves_origen: string[];
  origen: 'catalogo' | 'auto';
  cobertura: number;
  /** Segmentos definidos sobre este campo. Un campo autodetectado no tiene. */
  segmentos?: LeadSegmentoLite[];
}

export interface LeadAnswerDatasetLite {
  campanas: string[];
  campanaIds: (string | null)[];
  campos: LeadAnswerCatalogoLite[];
  porFecha: Record<string, Array<Array<[number, number, number]>>>;
  totalesPorFecha?: Record<string, Array<[number, number]>>;
  incompleto: boolean;
  /**
   * Claves que un bloque pide y el catálogo activo no tiene. La agregación no
   * las usa —no aportan números— pero viajan hasta el componente, que las
   * necesita para dar el mensaje correcto. Ver `LeadAnswerDataset`.
   */
  camposAusentes?: string[];
}

// ── Claves de fórmula ─────────────────────────────────────────────────

/** Contactos del día según Report-UTM. NO es `meta_leads`: ver migración 072. */
export const CLAVE_TOTAL_LEADS = 'utm_leads';

/** Prefijo de las claves por respuesta: `lf__<campo>__<respuesta>`. */
export const PREFIJO_RESPUESTA = 'lf__';

/** Sufijo del bucket de los que no respondieron esa pregunta. */
export const SUFIJO_SIN_RESPUESTA = 'sin_respuesta';

/**
 * Prefijo de las claves de SEGMENTO: `lseg__<clave>`.
 *
 * Es la misma cadena que el alias del BI, a propósito: quien aprende
 * `lseg__desde_2m` en una pestaña lo escribe igual en un informe. Los campos de
 * Sheet divergen (`sf_` aquí, `sf__` allí) por una colisión histórica con el
 * prefijo `sheet_`; aquí no hay ninguna, así que no se hereda la incoherencia.
 *
 * Un segmento SOLAPA buckets, así que NO entra en la suma
 * «respuestas + sin_respuesta = utm_leads». Ver `clavesDelDia`.
 */
export const PREFIJO_SEGMENTO = 'lseg__';

/** Clave de fórmula de un segmento. */
export function claveSegmento(seg: Pick<LeadSegmentoLite, 'clave'>): string {
  return `${PREFIJO_SEGMENTO}${seg.clave}`;
}

/**
 * Etiqueta de respuesta → fragmento de clave de fórmula.
 *
 * Se deriva de la ETIQUETA y no de la posición: el orden de los buckets cambia
 * con el rango de fechas cuando la pregunta no tiene orden configurado, así que
 * una clave posicional apuntaría a otra respuesta al cambiar el período — y una
 * tarjeta guardada empezaría a medir otra cosa sin avisar.
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

/**
 * Claves de fórmula de un campo, en el orden de sus buckets.
 *
 * Devuelve pares (bucket, clave) ya desambiguados: dos respuestas distintas
 * pueden producir el mismo slug ("$2M a $3M" y "$2M – $3M" si no se agruparon),
 * y dos claves iguales harían que una tapara a la otra en silencio.
 */
export function clavesDeCampo(
  campo: Pick<LeadAnswerCatalogoLite, 'clave' | 'buckets'>
): Array<{ bucket: string; clave: string }> {
  const usadas = new Set<string>([SUFIJO_SIN_RESPUESTA]);
  return campo.buckets.map((bucket) => {
    const base = slugRespuesta(bucket) || 'respuesta';
    let slug = base;
    let i = 2;
    while (usadas.has(slug)) slug = `${base}_${i++}`;
    usadas.add(slug);
    return { bucket, clave: `${PREFIJO_RESPUESTA}${campo.clave}__${slug}` };
  });
}

/** Clave del bucket "no respondió" de un campo. */
export function claveSinRespuesta(campo: Pick<LeadAnswerCatalogoLite, 'clave'>): string {
  return `${PREFIJO_RESPUESTA}${campo.clave}__${SUFIJO_SIN_RESPUESTA}`;
}

/**
 * ¿Esta fórmula usa métricas de Report-UTM?
 *
 * `\b` alrededor de `utm_leads` para no capturar cosas como `total_utm_leads`.
 * Lo usan los bloques que no pueden servirlas —rankings por anuncio, gráficas por
 * dimensión— para decir «no aplica» en vez de pintar un cero.
 */
export function formulaUsaRespuestas(f: string | null | undefined): boolean {
  if (!f) return false;
  return (
    new RegExp(`\\b${CLAVE_TOTAL_LEADS}\\b`).test(f) ||
    f.includes(PREFIJO_RESPUESTA) ||
    f.includes(PREFIJO_SEGMENTO)
  );
}

/**
 * Claves de campo que menciona una fórmula, resueltas CONTRA EL CATÁLOGO real.
 *
 * No se parsea `lf__(.+?)__(.+)` con una expresión regular sola porque la clave y
 * el slug son ambos `[a-z0-9_]+`: en `lf__a__b__c` el corte es ambiguo. Con la
 * lista de claves conocidas la resolución es exacta.
 */
export function camposEnFormula(
  f: string | null | undefined,
  claves: string[],
  segmentos: { clave: string; campoClave: string }[] = []
): string[] {
  if (!f) return [];
  const out = new Set(claves.filter((c) => f.includes(`${PREFIJO_RESPUESTA}${c}__`)));
  // Un segmento se nombra por SU clave, no por la del campo, pero para contarlo
  // hace falta cargar el campo padre. Sin esto, una tarjeta cuya única métrica
  // es `lseg__desde_2m` pediría un dataset sin ese campo y mostraría 0.
  for (const s of segmentos) {
    if (f.includes(`${PREFIJO_SEGMENTO}${s.clave}`)) out.add(s.campoClave);
  }
  return [...out];
}

/** Todas las claves que emite un dataset, en orden estable. */
export function clavesDelDataset(ds: LeadAnswerDatasetLite): string[] {
  const claves: string[] = [];
  if (ds.totalesPorFecha) claves.push(CLAVE_TOTAL_LEADS);
  for (const campo of ds.campos) {
    for (const { clave } of clavesDeCampo(campo)) claves.push(clave);
    if (ds.totalesPorFecha) claves.push(claveSinRespuesta(campo));
    for (const seg of campo.segmentos ?? []) claves.push(claveSegmento(seg));
  }
  return claves;
}

/** Lo que aporta UNA campaña a UN día, ya filtrado. */
export interface AporteDeCampana {
  campaignId: string | null;
  nombre: string;
  valores: Record<string, number>;
  esSinCampana: boolean;
}

/**
 * Desglose de un día repartido por campaña.
 *
 * Lo necesitan las tablas de ranking, cuyo grano es la campaña y no el día: sin
 * esto sus acumuladores no tenían por dónde recibir estas cifras y la columna
 * salía vacía.
 */
export function desglosePorCampana(
  ds: LeadAnswerDatasetLite,
  fecha: string,
  permitidas: Set<number>
): AporteDeCampana[] {
  const porCampana = new Map<number, Record<string, number>>();
  const dame = (i: number) => {
    let v = porCampana.get(i);
    if (!v) {
      v = {};
      porCampana.set(i, v);
    }
    return v;
  };

  const totales = ds.totalesPorFecha?.[fecha];
  for (const [iCampana, n] of totales ?? []) {
    if (!permitidas.has(iCampana)) continue;
    const v = dame(iCampana);
    v[CLAVE_TOTAL_LEADS] = (v[CLAVE_TOTAL_LEADS] ?? 0) + n;
  }

  const delDia = ds.porFecha[fecha];
  const respondieron = ds.campos.map(() => new Map<number, number>());
  ds.campos.forEach((campo, iCampo) => {
    const claves = clavesDeCampo(campo);
    const segmentos = campo.segmentos ?? [];
    for (const [iBucket, iCampana, n] of delDia?.[iCampo] ?? []) {
      if (!permitidas.has(iCampana)) continue;
      const c = claves[iBucket];
      if (!c) continue;
      const v = dame(iCampana);
      v[c.clave] = (v[c.clave] ?? 0) + n;
      respondieron[iCampo].set(iCampana, (respondieron[iCampo].get(iCampana) ?? 0) + n);
      // Igual que en `clavesDelDia`: los segmentos suman aparte y no entran
      // en `respondieron`, porque solapan buckets.
      for (const seg of segmentos) {
        if (!segmentoIncluyeBucket(seg, c.bucket)) continue;
        const k = claveSegmento(seg);
        v[k] = (v[k] ?? 0) + n;
      }
    }
  });

  // `(sin respuesta)` se resuelve POR CAMPAÑA y en una pasada aparte, cuando ya
  // se conocen todas las del día: una campaña puede aparecer por primera vez en
  // el último campo y quedarse sin el `(sin respuesta)` de los anteriores.
  if (totales) {
    for (const [iCampana, valores] of porCampana) {
      const total = valores[CLAVE_TOTAL_LEADS] ?? 0;
      ds.campos.forEach((campo, iCampo) => {
        valores[claveSinRespuesta(campo)] = Math.max(
          0,
          total - (respondieron[iCampo].get(iCampana) ?? 0)
        );
      });
    }
  }

  return [...porCampana.entries()].map(([iCampana, valores]) => ({
    campaignId: ds.campanaIds[iCampana] ?? null,
    nombre: ds.campanas[iCampana] ?? SIN_CAMPANA,
    valores,
    esSinCampana: iCampana === 0,
  }));
}

/**
 * Claves numéricas que aporta un DÍA a la fila de métricas, ya recortadas por el
 * filtro de campañas activo.
 *
 * Es lo que hace que estas cifras se puedan usar en cualquier tarjeta, gráfica o
 * columna: el motor de fórmulas registra automáticamente cualquier clave
 * numérica de la fila.
 *
 * El recorte se aplica AQUÍ, en el cliente, y no al construir el cubo en el
 * servidor, porque el filtro de campañas lo pone la pestaña y el servidor no
 * sabe cuál está activa. Es el mismo patrón que ya usan los campos `funnel_*`.
 * Sin esto, una tarjeta con `utm_leads` en una pestaña de campaña mostraría los
 * contactos de TODO el cliente junto a un `meta_spend` que sí está recortado —
 * y la división entre los dos no significaría nada.
 */
export function clavesDelDia(
  ds: LeadAnswerDatasetLite,
  fecha: string,
  permitidas: Set<number>
): Record<string, number> {
  const out: Record<string, number> = {};

  const totales = ds.totalesPorFecha?.[fecha];
  let total = 0;
  if (totales) {
    for (const [iCampana, n] of totales) if (permitidas.has(iCampana)) total += n;
    out[CLAVE_TOTAL_LEADS] = total;
  }

  const delDia = ds.porFecha[fecha];
  ds.campos.forEach((campo, iCampo) => {
    const claves = clavesDeCampo(campo);
    // Todas las claves del campo se emiten SIEMPRE, incluso en cero: si una
    // respuesta apareciera solo los días que tuvo leads, una gráfica por
    // fecha dibujaría huecos en vez de ceros.
    for (const { clave } of claves) out[clave] = 0;
    const segmentos = campo.segmentos ?? [];
    for (const seg of segmentos) out[claveSegmento(seg)] = 0;

    let respondieron = 0;
    for (const [iBucket, iCampana, n] of delDia?.[iCampo] ?? []) {
      if (!permitidas.has(iCampana)) continue;
      const c = claves[iBucket];
      if (!c) continue;
      out[c.clave] += n;
      respondieron += n;
      // Los segmentos se acumulan aquí pero NO tocan `respondieron`: solapan
      // buckets a propósito, así que sumarlos rompería el invariante
      // «respuestas + sin_respuesta = utm_leads» y dejaría el
      // `(sin respuesta)` en negativo (tapado por el Math.max de abajo).
      for (const seg of segmentos) {
        if (segmentoIncluyeBucket(seg, c.bucket)) out[claveSegmento(seg)] += n;
      }
    }

    // El que cierra la cuenta: total del día − los que respondieron.
    // `Math.max(0, …)` es una red, no una corrección: los dos números salen
    // del mismo cubo, el mismo día y el mismo filtro, así que no debería
    // poder ser negativo. Si alguna vez lo fuera, un 0 es menos dañino que
    // un negativo en una gráfica apilada.
    if (totales) out[claveSinRespuesta(campo)] = Math.max(0, total - respondieron);
  });

  return out;
}

export interface BucketAgregado {
  label: string;
  leads: number;
  /** Porcentaje sobre `total` (los buckets visibles tras el filtro). */
  pct: number;
  /** Variación vs. período anterior, o null si no se puede calcular. */
  delta: number | null;
  /** Leads del período anterior, o null si no se pidió comparativo. */
  leadsPrevio: number | null;
  /** ¿Es el bucket sintético que agrupa la cola larga? */
  esResto?: boolean;
}

export interface ResultadoRespuestas {
  buckets: BucketAgregado[];
  /** Suma de los buckets mostrados. Es el denominador de los porcentajes. */
  total: number;
  /**
   * Leads que respondieron pero cuya campaña no se pudo identificar y que
   * quedaron FUERA por haber un filtro de campaña activo. Se declara en la UI:
   * un total que baja sin explicación parece un fallo.
   */
  sinCruce: number;
  /**
   * Leads recortados por Top-N cuando `agruparResto` está desactivado. Se
   * declara también: descartar en silencio es lo que convierte un Top-5 en una
   * cifra que no cuadra con nada.
   */
  omitidos: number;
  /** El campo no existe en el dataset (borrado del catálogo, o sin datos). */
  campoAusente: boolean;
  /** Nombre visible del campo resuelto. */
  nombreCampo: string;
}

function resultadoVacio(nombreCampo: string, campoAusente: boolean): ResultadoRespuestas {
  return { buckets: [], total: 0, sinCruce: 0, omitidos: 0, campoAusente, nombreCampo };
}

/**
 * ¿El filtro deja pasar absolutamente todo?
 *
 * Decide si los leads SIN campaña identificada cuentan. Se comprueba aparte —y no
 * dejando que el motor de filtros opine— porque `(sin campaña)` es una etiqueta
 * sintética, no el nombre de nada: pasarla por el comparador de texto la haría
 * coincidir por accidente. Un filtro tan corriente como «camp» la seleccionaría,
 * y una pestaña de campaña acabaría sumando leads que precisamente no se sabe de
 * qué campaña vienen.
 */
function filtroVacio(
  keyword: AnyCampaignFilter,
  campaignFilter: CampaignFilterSpec | undefined
): boolean {
  const specVacia = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v.length === 0 : String(v ?? '').trim() === '';

  if (campaignFilter && !specVacia(campaignFilter.value)) return false;
  if (!keyword) return true;
  if (typeof keyword === 'string') return keyword.trim() === '';
  if ('conditions' in keyword) return !keyword.conditions.some((c) => !specVacia(c.value));
  return specVacia(keyword.value);
}

/**
 * Índices de campaña que pasan el filtro.
 *
 * Se calcula UNA VEZ sobre el diccionario y no por triplete: un cliente tiene
 * decenas de campañas y miles de tripletes, así que evaluar el filtro por
 * triplete multiplicaría el trabajo por cien sin cambiar el resultado.
 *
 * Reutiliza `filterCampaignList`, que es el mismo motor que usan las tablas de
 * ranking y las gráficas. Eso trae gratis los grupos de campaña, los ocho
 * operadores y la combinación Y/O de los filtros compuestos de pestaña. Una
 * reimplementación aquí habría divergido a la primera pestaña con `__cf:`.
 */
export function campanasPermitidas(
  ds: LeadAnswerDatasetLite,
  keyword: AnyCampaignFilter,
  campaignFilter: CampaignFilterSpec | undefined,
  campaignGroups: any[] | undefined
): Set<number> {
  // El índice 0 —`(sin campaña)`— NO entra en el comparador; se decide arriba.
  // Sondas con la forma que espera el motor de filtros: `name` para los
  // operadores de texto y `campaign_id` para los grupos.
  const sondas = ds.campanas
    .map((name, i) => ({ name, campaign_id: ds.campanaIds[i] ?? null, __i: i }))
    .slice(1);

  let vivas = filterCampaignList(sondas, keyword, campaignGroups) as typeof sondas;
  if (campaignFilter) {
    // Encadenado SOBRE el subconjunto de la pestaña, no en paralelo: el
    // filtro del bloque acota lo que la pestaña ya dejó pasar, igual que
    // hacen las tablas de ranking.
    vivas = filterCampaignList(vivas, campaignFilter, campaignGroups) as typeof sondas;
  }

  const permitidas = new Set(vivas.map((s) => s.__i));
  if (filtroVacio(keyword, campaignFilter)) permitidas.add(0);
  return permitidas;
}

/** Fechas del cubo dentro del recorte de la pestaña. */
export function fechasEnRango(
  porFecha: Record<string, unknown>,
  fechaInicio?: string | null,
  fechaFin?: string | null
): string[] {
  // Comparación de strings `yyyy-MM-dd`, idéntica a la que hace el dashboard
  // sobre `metricas_diarias.fecha`. Si aquí se usara `Date`, un día de borde
  // caería en la pestaña equivocada respecto a las tarjetas de al lado.
  return Object.keys(porFecha).filter(
    (f) => (!fechaInicio || f >= fechaInicio) && (!fechaFin || f <= fechaFin)
  );
}

/** Suma cruda de leads por bucket, ya filtrada. Es la base de todo lo demás. */
function sumarPorBucket(
  ds: LeadAnswerDatasetLite,
  iCampo: number,
  permitidas: Set<number>,
  fechas: string[]
): { porBucket: Map<number, number>; sinCruce: number } {
  const porBucket = new Map<number, number>();
  let sinCruce = 0;

  for (const fecha of fechas) {
    const delDia = ds.porFecha[fecha];
    const tripletes = delDia?.[iCampo];
    if (!tripletes) continue;
    for (const [iBucket, iCampana, n] of tripletes) {
      if (!permitidas.has(iCampana)) {
        // Sin filtro activo, `filterCampaignList` deja pasar TODO —
        // incluido el índice 0—, así que los leads sin campaña
        // identificada cuentan: son leads reales del cliente. En cuanto
        // hay filtro, el índice 0 deja de pasar y se contabilizan aparte
        // para poder declararlos: no se puede afirmar que pertenezcan a
        // la campaña filtrada, pero un total que baja sin explicación
        // parece un fallo.
        if (iCampana === 0) sinCruce += n;
        continue;
      }
      porBucket.set(iBucket, (porBucket.get(iBucket) ?? 0) + n);
    }
  }
  return { porBucket, sinCruce };
}

/** Una fila del desglose diario: el total del día y su reparto por respuesta. */
export interface DiaAgregado {
  fecha: string;
  /** Contactos del día (todos, respondan o no). */
  total: number;
  /** Leads por bucket, en el mismo orden que `buckets`. */
  porBucket: number[];
  /** Los que no respondieron esta pregunta. Cierra la cuenta con `total`. */
  sinRespuesta: number;
}

/**
 * Desglose día a día: «hoy se registraron 40, de los cuales 15 A, 5 B, 3 C».
 *
 * Comparte filtro y recorte de fechas con `agregarRespuestas`, así que la suma de
 * los días cuadra con el total que muestra el modo de barras.
 */
export function serieDiaria(
  ds: LeadAnswerDatasetLite | null | undefined,
  def: LeadAnswerBlockDef,
  keyword: AnyCampaignFilter,
  campaignGroups: any[] | undefined,
  opts?: { fechaInicio?: string | null; fechaFin?: string | null }
): { dias: DiaAgregado[]; buckets: string[] } {
  if (!ds || ds.campos.length === 0) return { dias: [], buckets: [] };

  const iCampo = indiceDeCampo(ds, def);
  if (iCampo === -1) return { dias: [], buckets: [] };

  const campo = ds.campos[iCampo];
  const permitidas = campanasPermitidas(ds, keyword, def.campaignFilter, campaignGroups);
  const fechas = fechasEnRango(ds.porFecha, opts?.fechaInicio, opts?.fechaFin);

  // Los días con contactos pero SIN ninguna respuesta también son días: si solo
  // se recorrieran las fechas de `porFecha`, un día en que nadie contestó
  // desaparecería de la tabla en vez de salir con su total y todo en
  // «(sin respuesta)».
  const todasLasFechas = new Set<string>(fechas);
  for (const f of fechasEnRango(ds.totalesPorFecha ?? {}, opts?.fechaInicio, opts?.fechaFin)) {
    todasLasFechas.add(f);
  }

  const dias: DiaAgregado[] = [...todasLasFechas].sort().map((fecha) => {
    const porBucket = new Array<number>(campo.buckets.length).fill(0);
    let respondieron = 0;
    for (const [iBucket, iCampana, n] of ds.porFecha[fecha]?.[iCampo] ?? []) {
      if (!permitidas.has(iCampana)) continue;
      if (iBucket >= porBucket.length) continue;
      porBucket[iBucket] += n;
      respondieron += n;
    }
    let total = 0;
    for (const [iCampana, n] of ds.totalesPorFecha?.[fecha] ?? []) {
      if (permitidas.has(iCampana)) total += n;
    }
    return {
      fecha,
      // Sin totales cargados, el total honesto es lo que sí se sabe: los
      // que respondieron. Nunca menos que la suma de sus partes.
      total: Math.max(total, respondieron),
      porBucket,
      sinRespuesta: Math.max(0, total - respondieron),
    };
  });

  return { dias, buckets: campo.buckets };
}

/** Localiza el campo del bloque dentro del cubo, o -1. */
function indiceDeCampo(ds: LeadAnswerDatasetLite, def: LeadAnswerBlockDef): number {
  // Un bloque del catálogo se localiza por `clave`; uno auto-detectado, por sus
  // claves de origen, porque su clave es sintética y podría chocar.
  return def.origen === 'catalogo'
    ? ds.campos.findIndex((c) => c.clave === def.clave)
    : ds.campos.findIndex(
        (c) =>
          c.claves_origen.length === (def.clavesOrigen ?? []).length &&
          c.claves_origen.every((k) => (def.clavesOrigen ?? []).includes(k))
      );
}

/**
 * Agrega el cubo para un bloque concreto.
 *
 * `prev` es el mismo dataset del período anterior. Se agrega SIN el recorte de
 * fechas de la pestaña: ese rango ya es otro, y aplicarle las fechas de la
 * pestaña actual lo dejaría sistemáticamente vacío.
 */
export function agregarRespuestas(
  ds: LeadAnswerDatasetLite | null | undefined,
  def: LeadAnswerBlockDef,
  keyword: AnyCampaignFilter,
  campaignGroups: any[] | undefined,
  opts?: {
    fechaInicio?: string | null;
    fechaFin?: string | null;
    prev?: LeadAnswerDatasetLite | null;
  }
): ResultadoRespuestas {
  const nombreFallback = def.label || def.title || 'Respuestas';
  if (!ds || ds.campos.length === 0) return resultadoVacio(nombreFallback, true);

  const iCampo = indiceDeCampo(ds, def);
  if (iCampo === -1) return resultadoVacio(nombreFallback, true);

  const campo = ds.campos[iCampo];
  const nombreCampo = def.label || campo.nombre || nombreFallback;

  const permitidas = campanasPermitidas(ds, keyword, def.campaignFilter, campaignGroups);
  const fechas = fechasEnRango(ds.porFecha, opts?.fechaInicio, opts?.fechaFin);
  const { porBucket, sinCruce } = sumarPorBucket(ds, iCampo, permitidas, fechas);

  // ── Período anterior ──────────────────────────────────────────────
  let previoPorBucket: Map<string, number> | null = null;
  if (def.showDelta && opts?.prev) {
    const prev = opts.prev;
    const iPrev = prev.campos.findIndex((c) => c.clave === campo.clave);
    if (iPrev !== -1) {
      const permPrev = campanasPermitidas(prev, keyword, def.campaignFilter, campaignGroups);
      const { porBucket: crudo } = sumarPorBucket(
        prev,
        iPrev,
        permPrev,
        Object.keys(prev.porFecha)
      );
      // Se indexa por ETIQUETA y no por índice: el catálogo del período
      // anterior puede tener otros buckets (una respuesta nueva, o una que
      // dejó de usarse), y cruzarlos por posición emparejaría barras
      // distintas sin que nada lo delatara.
      previoPorBucket = new Map();
      for (const [i, n] of crudo) {
        const label = prev.campos[iPrev].buckets[i];
        if (label) previoPorBucket.set(label, (previoPorBucket.get(label) ?? 0) + n);
      }
    }
  }

  // ── Buckets en el orden del catálogo ──────────────────────────────
  let filas = campo.buckets
    .map((label, i) => ({ label, leads: porBucket.get(i) ?? 0 }))
    .filter((f) => !def.ocultarVacios || f.leads > 0);

  const totalCompleto = filas.reduce((s, f) => s + f.leads, 0);

  // ── Top-N ─────────────────────────────────────────────────────────
  const topN = def.topN && def.topN > 0 ? def.topN : 12;
  let omitidos = 0;
  if (filas.length > topN) {
    // El recorte es por VOLUMEN, pero el orden de presentación se conserva:
    // si el analista ordenó los rangos de menor a mayor, quitar la cola no
    // debe reordenar lo que queda.
    const top = new Set(
      [...filas]
        .sort((a, b) => b.leads - a.leads)
        .slice(0, topN)
        .map((f) => f.label)
    );
    const resto = filas.filter((f) => !top.has(f.label));
    const restoLeads = resto.reduce((s, f) => s + f.leads, 0);
    filas = filas.filter((f) => top.has(f.label));
    if (def.agruparResto !== false) {
      if (restoLeads > 0) {
        filas.push({ label: `${BUCKET_RESTO} (${resto.length})`, leads: restoLeads });
      }
    } else {
      omitidos = restoLeads;
    }
  }

  // El denominador es el total de los buckets MOSTRADOS, no el del cliente:
  // con un filtro de pestaña activo, dividir por el total del cliente daría
  // porcentajes que no suman 100 y que nadie sabría interpretar.
  const total = def.agruparResto !== false ? totalCompleto : totalCompleto - omitidos;

  const buckets: BucketAgregado[] = filas.map((f) => {
    const esResto = f.label.startsWith(`${BUCKET_RESTO} (`);
    const leadsPrevio = previoPorBucket && !esResto ? (previoPorBucket.get(f.label) ?? 0) : null;
    // Un denominador en cero devuelve null, no Infinity ni +100%: es la misma
    // regla que CPL/CPA/ROAS en el BI. Un guion significa "no se puede
    // calcular", que no es lo mismo que "no cambió".
    const delta =
      leadsPrevio && leadsPrevio > 0 ? ((f.leads - leadsPrevio) / leadsPrevio) * 100 : null;
    return {
      label: f.label,
      leads: f.leads,
      pct: total > 0 ? (f.leads / total) * 100 : 0,
      delta,
      leadsPrevio,
      ...(esResto ? { esResto: true } : {}),
    };
  });

  return { buckets, total, sinCruce, omitidos, campoAusente: false, nombreCampo };
}
