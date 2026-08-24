/**
 * El cubo de respuestas, adjunto a las filas de métricas por REFERENCIA.
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────
 * Las claves de Report-UTM (`utm_leads`, `lf__<campo>__<respuesta>`) se calculan
 * aplicando el filtro de campañas de la PESTAÑA y se escriben como escalares en
 * cada fila. Pero cada tarjeta y cada columna pueden tener ADEMÁS su propio
 * `campaignFilter`, y quien lo aplica —`applyCompoundFilter`— solo sabe
 * recalcular las claves `meta_*` y `tiktok_*` a partir de `row.meta_campaigns`.
 * El resto de la fila pasa intacta.
 *
 * Resultado: una tarjeta `meta_spend / utm_leads` con filtro propio dividía un
 * gasto ya recortado entre los contactos de toda la pestaña. El CPL salía
 * sistemáticamente hundido y nada lo delataba.
 *
 * ── Por qué una referencia y no una copia del desglose ───────────────────────
 * La tentación es hacer que la fila lleve su desglose por campaña, como hace
 * `meta_campaigns`. Pero ese array viene de la base y es dato PROPIO de la fila,
 * mientras que el cubo de respuestas está codificado por diccionario y es
 * COMPARTIDO entre todas las filas justamente para no repetir nombres de campaña
 * ni de clave. Materializarlo por día×campaña deshace ese diseño y multiplica el
 * payload, en el mejor de los casos por cinco.
 *
 * `filteredMetrics` se construye en el navegador, donde `data.leadAnswers` ya
 * está en memoria: basta con que cada fila apunte al MISMO objeto. Coste de
 * payload: cero.
 *
 * ── Por qué viaja en la fila y no como parámetro ─────────────────────────────
 * Un parámetro opcional al final de `applyCompoundFilter` reproduciría el mismo
 * modo de fallo que estamos arreglando: basta que un llamante se olvide de
 * pasarlo para que las cifras vuelvan a mentir en silencio. Viajando con la fila
 * sobrevive a los `{...row}` de los enriquecedores y no se puede olvidar.
 *
 * La clave `__leadAnswers` NO es numérica, así que el motor de fórmulas la ignora
 * (`evaluateFormula` solo absorbe claves con `typeof === 'number'`), igual que
 * ignora `meta_campaigns`.
 *
 * Vive en su propio módulo para romper el ciclo de imports:
 * `lead-answer-aggregation` importa de `campaign-filter`, y `campaign-filter`
 * necesita esto.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { campanasPermitidas, clavesDelDia } from './lead-answer-aggregation';
import type { LeadAnswerDatasetLite } from './lead-answer-aggregation';
import type { AnyCampaignFilter } from '@/lib/campaign-filter';
import type { CampaignFilterSpec } from '@/lib/layout-types';

/** Propiedad de la fila que apunta al cubo. No numérica: invisible a las fórmulas. */
export const CLAVE_CUBO = '__leadAnswers';

export interface CuboRespuestasRef {
  ds: LeadAnswerDatasetLite;
  /** Filtro de la PESTAÑA, el que ya se aplicó a los escalares de la fila. */
  keyword: AnyCampaignFilter;
  campaignGroups: any[] | undefined;
}

// ── Memo del conjunto de campañas permitidas ──────────────────────────
// Sin esto, la tabla diaria evalúa el filtro `filas × columnas` veces (31 días ×
// 8 columnas ≈ 250 pasadas sobre el diccionario por render). La identidad del
// objeto `campaignFilter` es estable porque viene de `activeLayout`, así que
// sirve de clave; el centinela cubre el caso `undefined`.

const SIN_FILTRO = Object.freeze({}) as object;
const memo = new WeakMap<object, { ref: CuboRespuestasRef; permitidas: Set<number> }>();

export function permitidasDelCubo(
  ref: CuboRespuestasRef,
  campaignFilter: CampaignFilterSpec | undefined
): Set<number> {
  const clave = (campaignFilter ?? SIN_FILTRO) as object;
  const hit = memo.get(clave);
  // Se compara `ref` por identidad: `data.leadAnswers` y el keyword de la
  // pestaña son memos estables, así que cambian solo cuando de verdad cambian.
  if (hit && hit.ref === ref) return hit.permitidas;

  const permitidas = campanasPermitidas(ref.ds, ref.keyword, campaignFilter, ref.campaignGroups);
  memo.set(clave, { ref, permitidas });
  return permitidas;
}

/**
 * Adjunta el cubo a una fila. Se hace una sola vez por tanda de filas.
 *
 * `keyword` es el filtro que ya se aplicó a los escalares: la re-derivación lo
 * encadena con el del bloque, igual que hace `applyCompoundFilter` con
 * `meta_campaigns`.
 */
export function refDeCubo(
  ds: LeadAnswerDatasetLite | null | undefined,
  keyword: AnyCampaignFilter,
  campaignGroups: any[] | undefined
): CuboRespuestasRef | null {
  if (!ds) return null;
  const hayDatos = ds.campos.length > 0 || Object.keys(ds.totalesPorFecha ?? {}).length > 0;
  return hayDatos ? { ds, keyword, campaignGroups } : null;
}

/**
 * Re-deriva las claves de Report-UTM de una fila para el filtro de un BLOQUE.
 *
 * Devuelve `null` —y no un objeto vacío— cuando la fila no lleva cubo: así el
 * llamante puede devolver la fila tal cual y no crear un objeto por nada. Es el
 * caso del archivo de pestañas, que no carga respuestas a propósito.
 */
export function reDerivarRespuestas(
  row: any,
  campaignFilter: CampaignFilterSpec | undefined
): Record<string, number> | null {
  const ref = row?.[CLAVE_CUBO] as CuboRespuestasRef | undefined;
  if (!ref) return null;
  return clavesDelDia(ref.ds, String(row.fecha ?? ''), permitidasDelCubo(ref, campaignFilter));
}

/**
 * Claves + referencia de un día, listas para volcar en una fila.
 *
 * Lo usan tanto la inyección inicial como la fila de relleno de los días que no
 * existen en `metricas_diarias`: un día con formularios y sin inversión es un día
 * real, y sin esto mostraba `—` en vez de sus contactos.
 */
export function clavesYRefDelDia(
  ref: CuboRespuestasRef | null,
  fecha: string
): Record<string, unknown> {
  if (!ref) return {};
  return {
    [CLAVE_CUBO]: ref,
    ...clavesDelDia(ref.ds, fecha, permitidasDelCubo(ref, undefined)),
  };
}
