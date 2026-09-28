/**
 * Del cubo crudo de la base al dataset de respuestas del dashboard.
 *
 * Puro (sin Supabase ni `next/*`): recibe el cubo tal como lo devuelve la base
 * (`cubo-db.ts`), el catálogo y una función que resuelve la campaña de una
 * tupla, y produce el `LeadAnswerDataset` codificado por diccionario que viaja
 * al navegador. Es el ÚNICO sitio donde una respuesta cruda se convierte en su
 * bucket y su clave para el dashboard; el BI usa las mismas funciones
 * (`bucketsDeValor`, `clavesDeRespuestas`) sobre sus filas.
 *
 * Las reglas —todas heredadas de `lead-answers-db.ts` antes de la 090—:
 *   • el valor crudo pasa por el catálogo (`valores_map`, `sin_mapear`); un
 *     valor ignorado no cuenta como respuesta;
 *   • la campaña se resuelve UNA vez por tupla, nunca por fila;
 *   • el índice 0 del diccionario de campañas es SIEMPRE `(sin campaña)`;
 *   • orden de buckets: el configurado (`valores_orden`) o por frecuencia;
 *   • una pregunta de selección múltiple cuenta al lead en cada respuesta que
 *     eligió, y lleva aparte cuántos respondieron para que `(sin respuesta)`
 *     siga cerrando la cuenta contra el total.
 */

import { bucketsDeValor, ordenarBuckets } from '@/lib/report-utm/lead-campos';
import type { LeadCampoDef, LeadSegmentoLite } from '@/lib/report-utm/lead-campos';
import type {
  LeadAnswerCatalogo,
  LeadAnswerDataset,
  NivelesDataset,
} from '@/lib/report-utm/lead-answers-db';
import { clavesDeRespuestas } from './claves';
import type { CuboCrudo, TuplaCubo } from './cubo-db';

/** Etiqueta reservada del diccionario de campañas. */
export const SIN_CAMPANA_CUBO = '(sin campaña)';

export interface CampoPedido {
  campo: LeadCampoDef;
  origen: 'catalogo' | 'auto';
  segmentos?: LeadSegmentoLite[];
}

export interface OpcionesDataset {
  /** Nombre real de la campaña de una tupla, o '' si no cruza. null = sin resolver. */
  campanaDeTupla: ((t: TuplaCubo) => string) | null;
  /** Nombre de campaña → campaign_id, para los grupos de campaña. */
  idsCampana: Map<string, string | null>;
  /** ¿Traer el total diario? Si no, `totalesPorFecha` sale vacío. */
  conTotales: boolean;
  /** Algo se truncó o falló antes de llegar aquí. */
  incompleto?: boolean;
  /**
   * Construir también el cubo por conjunto y anuncio (`niveles`). Cada función
   * da el nombre real de la entidad de una tupla y su id si lo tiene.
   */
  niveles?: {
    conjuntoDe: (t: TuplaCubo) => { label: string; id: string | null };
    anuncioDe: (t: TuplaCubo) => { label: string; id: string | null };
  };
}

/** Etiquetas del índice 0 de los diccionarios de conjunto y anuncio. */
export const SIN_CONJUNTO_CUBO = '(sin conjunto)';
export const SIN_ANUNCIO_CUBO = '(sin anuncio)';

export function construirDataset(
  crudo: CuboCrudo,
  pedidos: CampoPedido[],
  opts: OpcionesDataset
): LeadAnswerDataset {
  const campanas: string[] = [SIN_CAMPANA_CUBO];
  const campanaIds: (string | null)[] = [null];
  const idxCampana = new Map<string, number>([[SIN_CAMPANA_CUBO, 0]]);

  const indiceDeCampana = (label: string): number => {
    const ya = idxCampana.get(label);
    if (ya !== undefined) return ya;
    const i = campanas.length;
    campanas.push(label);
    campanaIds.push(opts.idsCampana.get(label) ?? null);
    idxCampana.set(label, i);
    return i;
  };

  // Tupla → índice de campaña, resuelto UNA vez por tupla.
  const campanaDe: number[] = crudo.tuplas.map((t) =>
    // Sin resolver no se puede afirmar a qué campaña pertenece un lead: se
    // etiqueta como tal en vez de inventar el cruce con el utm_campaign crudo.
    indiceDeCampana(
      opts.campanaDeTupla ? opts.campanaDeTupla(t) || SIN_CAMPANA_CUBO : SIN_CAMPANA_CUBO
    )
  );

  const porFecha: LeadAnswerDataset['porFecha'] = {};
  const respondidos: NonNullable<LeadAnswerDataset['respondidosPorFecha']> = {};
  const catalogo: LeadAnswerCatalogo[] = [];

  // Respuestas crudas agrupadas por pregunta, para no recorrer el cubo N veces.
  const porCampo = new Map<number, Array<[string, number, string, number]>>();
  for (const [dia, iT, iC, valor, n] of crudo.respuestas) {
    let l = porCampo.get(iC);
    if (!l) porCampo.set(iC, (l = []));
    l.push([dia, iT, valor, n]);
  }

  pedidos.forEach(({ campo, origen, segmentos }, iCampo) => {
    const multiple = campo.tipo === 'multiple';
    // fecha → bucket → campaña → n
    const acc = new Map<string, Map<string, Map<number, number>>>();
    // fecha → campaña → n (solo selección múltiple: los que respondieron algo)
    const accResp = new Map<string, Map<number, number>>();
    const bucketsVistos = new Map<string, number>();
    let cobertura = 0;

    for (const [dia, iT, valor, n] of porCampo.get(iCampo) ?? []) {
      if (!n || !dia) continue;
      const buckets = bucketsDeValor(campo, valor);
      if (buckets.length === 0) continue; // ignorado o vacío: no es respuesta
      const iCampana = campanaDe[iT] ?? 0;
      cobertura += n;
      if (multiple) {
        let m = accResp.get(dia);
        if (!m) accResp.set(dia, (m = new Map()));
        m.set(iCampana, (m.get(iCampana) ?? 0) + n);
      }
      for (const bucket of buckets) {
        bucketsVistos.set(bucket, (bucketsVistos.get(bucket) ?? 0) + n);
        let porBucket = acc.get(dia);
        if (!porBucket) acc.set(dia, (porBucket = new Map()));
        let porCampana = porBucket.get(bucket);
        if (!porCampana) porBucket.set(bucket, (porCampana = new Map()));
        porCampana.set(iCampana, (porCampana.get(iCampana) ?? 0) + n);
      }
    }

    // Orden: el configurado manda (rangos de menor a mayor); si no hay, por
    // frecuencia, que es lo más útil de leer.
    const tieneOrden = (campo.valores_orden ?? []).length > 0;
    const buckets = tieneOrden
      ? ordenarBuckets(campo, Array.from(bucketsVistos.keys()))
      : Array.from(bucketsVistos.entries())
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([b]) => b);
    const idxBucket = new Map(buckets.map((b, i) => [b, i]));

    for (const [dia, porBucket] of acc) {
      const tripletes: Array<[number, number, number]> = [];
      for (const [bucket, porCampana] of porBucket) {
        const iBucket = idxBucket.get(bucket);
        if (iBucket === undefined) continue;
        for (const [iCampana, n] of porCampana) tripletes.push([iBucket, iCampana, n]);
      }
      if (tripletes.length === 0) continue;
      const delDia = porFecha[dia] ?? (porFecha[dia] = []);
      // Hueco explícito: el índice del array TIENE que coincidir con el del
      // catálogo.
      while (delDia.length < iCampo) delDia.push([]);
      delDia[iCampo] = tripletes;
    }
    if (multiple) {
      for (const [dia, m] of accResp) {
        (respondidos[dia] ??= {})[iCampo] = [...m.entries()];
      }
    }

    catalogo.push({
      clave: campo.clave,
      nombre: campo.nombre,
      buckets,
      claves: clavesDeRespuestas(buckets, campo.respuestas ?? []),
      claves_origen: campo.claves_origen ?? [],
      origen,
      cobertura,
      segmentos,
      ...(multiple ? { multiple: true } : {}),
    });
  });

  // Rellena los huecos de cola: un día donde solo respondió el primer campo
  // deja el array corto.
  for (const dia of Object.keys(porFecha)) {
    const delDia = porFecha[dia];
    while (delDia.length < catalogo.length) delDia.push([]);
  }

  // Totales del día con el MISMO diccionario de campañas: si usaran índices
  // distintos, un filtro recortaría el total y el desglose por criterios que
  // no coinciden y `(sin respuesta)` podría salir negativo.
  const totalesPorFecha: LeadAnswerDataset['totalesPorFecha'] = {};
  if (opts.conTotales) {
    const acc = new Map<string, Map<number, number>>();
    for (const [dia, iT, n] of crudo.totales) {
      if (!dia || !n) continue;
      const iCampana = campanaDe[iT] ?? 0;
      let m = acc.get(dia);
      if (!m) acc.set(dia, (m = new Map()));
      m.set(iCampana, (m.get(iCampana) ?? 0) + n);
    }
    for (const [dia, m] of acc) totalesPorFecha[dia] = [...m.entries()];
  }

  const niveles = opts.niveles
    ? construirNiveles(crudo, pedidos, catalogo, campanaDe, opts.niveles)
    : undefined;

  return {
    campanas,
    campanaIds,
    campos: catalogo,
    porFecha,
    totalesPorFecha,
    incompleto: !!opts.incompleto || crudo.truncado,
    ...(Object.keys(respondidos).length > 0 ? { respondidosPorFecha: respondidos } : {}),
    ...(niveles ? { niveles } : {}),
  };
}

/**
 * El mismo cubo por TUPLA de atribución, con su conjunto y su anuncio resueltos.
 * Usa los buckets YA ordenados del catálogo, así que el índice de bucket es el
 * mismo que en `porFecha` y las claves de respuesta coinciden.
 */
function construirNiveles(
  crudo: CuboCrudo,
  pedidos: CampoPedido[],
  catalogo: LeadAnswerCatalogo[],
  campanaDe: number[],
  resolver: NonNullable<OpcionesDataset['niveles']>
): NivelesDataset {
  const dicc = (sin: string) => {
    const nombres: string[] = [sin];
    const ids: (string | null)[] = [null];
    const idx = new Map<string, number>([[sin, 0]]);
    const indice = (e: { label: string; id: string | null }) => {
      const label = e.label || sin;
      // El id entra en la clave: dos anuncios con el mismo nombre en campañas
      // distintas (Eduversio repite 83 de 91) son dos filas del ranking.
      const k = `${label}|${e.id ?? ''}`;
      const ya = idx.get(k);
      if (ya !== undefined) return ya;
      const i = nombres.length;
      nombres.push(label);
      ids.push(e.id);
      idx.set(k, i);
      return i;
    };
    return { nombres, ids, indice };
  };
  const conjuntos = dicc(SIN_CONJUNTO_CUBO);
  const anuncios = dicc(SIN_ANUNCIO_CUBO);
  const tuplas: NivelesDataset['tuplas'] = crudo.tuplas.map((t, i) => [
    campanaDe[i] ?? 0,
    conjuntos.indice(resolver.conjuntoDe(t)),
    anuncios.indice(resolver.anuncioDe(t)),
  ]);

  const porFecha: NivelesDataset['porFecha'] = {};
  const respondidos: NonNullable<NivelesDataset['respondidosPorFecha']> = {};
  pedidos.forEach(({ campo }, iCampo) => {
    const cat = catalogo[iCampo];
    const idxBucket = new Map(cat.buckets.map((b, i) => [b, i]));
    const acc = new Map<string, Map<string, number>>(); // fecha → "bucket|tupla" → n
    const accResp = new Map<string, Map<number, number>>();
    for (const [dia, iT, iC, valor, n] of crudo.respuestas) {
      if (iC !== iCampo || !n || !dia) continue;
      const bs = bucketsDeValor(campo, valor);
      if (bs.length === 0) continue;
      if (cat.multiple) {
        let m = accResp.get(dia);
        if (!m) accResp.set(dia, (m = new Map()));
        m.set(iT, (m.get(iT) ?? 0) + n);
      }
      let m = acc.get(dia);
      if (!m) acc.set(dia, (m = new Map()));
      for (const b of bs) {
        const iB = idxBucket.get(b);
        if (iB === undefined) continue;
        const k = `${iB}|${iT}`;
        m.set(k, (m.get(k) ?? 0) + n);
      }
    }
    for (const [dia, m] of acc) {
      const delDia = porFecha[dia] ?? (porFecha[dia] = []);
      while (delDia.length < iCampo) delDia.push([]);
      delDia[iCampo] = [...m.entries()].map(([k, n]) => {
        const [iB, iT] = k.split('|').map(Number);
        return [iB, iT, n] as [number, number, number];
      });
    }
    for (const [dia, m] of accResp) (respondidos[dia] ??= {})[iCampo] = [...m.entries()];
  });
  for (const dia of Object.keys(porFecha)) {
    while (porFecha[dia].length < catalogo.length) porFecha[dia].push([]);
  }

  const totalesPorFecha: NivelesDataset['totalesPorFecha'] = {};
  const accTot = new Map<string, Map<number, number>>();
  for (const [dia, iT, n] of crudo.totales) {
    if (!dia || !n) continue;
    let m = accTot.get(dia);
    if (!m) accTot.set(dia, (m = new Map()));
    m.set(iT, (m.get(iT) ?? 0) + n);
  }
  for (const [dia, m] of accTot) totalesPorFecha[dia] = [...m.entries()];

  return {
    tuplas,
    conjuntos: conjuntos.nombres,
    conjuntoIds: conjuntos.ids,
    anuncios: anuncios.nombres,
    anuncioIds: anuncios.ids,
    porFecha,
    totalesPorFecha,
    ...(Object.keys(respondidos).length > 0 ? { respondidosPorFecha: respondidos } : {}),
  };
}
