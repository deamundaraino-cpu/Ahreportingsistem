/**
 * El cubo de ventas de Hotmart, adjunto a las filas de métricas por REFERENCIA.
 *
 * Mismo diseño y mismas razones que `lead-answer-row.ts` (léelo primero): las
 * claves `hm_*` se escriben como escalares en cada fila con el filtro de la
 * PESTAÑA, pero cada tarjeta y columna puede tener además su propio
 * `campaignFilter`, y `applyCompoundFilter` solo sabe recalcular lo que la fila
 * sabe recalcular. Sin la referencia, una tarjeta `meta_spend / hm_compras` con
 * filtro propio dividiría un gasto recortado entre las compras de toda la
 * pestaña.
 *
 * La referencia viaja en la fila (y no como parámetro) para sobrevivir a los
 * `{...row}` de los enriquecedores sin que ningún llamante pueda olvidarse de
 * pasarla. `__hotmartCubo` no es numérica: el motor de fórmulas la ignora.
 *
 * Vive en su propio módulo por el mismo ciclo de imports que `lead-answer-row`:
 * `campaign-filter` necesita esto, y esto acaba importando `campaign-filter`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { campanasPermitidas } from './lead-answer-aggregation';
import { clavesHotmartDelDia } from './hotmart-cubo';
import type { HotmartCuboLite } from './hotmart-cubo';
import type { AnyCampaignFilter } from '@/lib/campaign-filter';
import type { CampaignFilterSpec } from '@/lib/layout-types';

/** Propiedad de la fila que apunta al cubo. No numérica: invisible a las fórmulas. */
export const CLAVE_CUBO_HOTMART = '__hotmartCubo';

export interface CuboHotmartRef {
  ds: HotmartCuboLite;
  /** Filtro de la PESTAÑA, el que ya se aplicó a los escalares de la fila. */
  keyword: AnyCampaignFilter;
  campaignGroups: any[] | undefined;
}

// ── Memo del conjunto de campañas permitidas ──────────────────────────
// Por referencia y luego por filtro: la tabla diaria pide lo mismo filas ×
// columnas veces por render. Las dos identidades son estables (la referencia sale
// de un `useMemo` y el `campaignFilter` de `activeLayout`); el centinela cubre el
// caso sin filtro. Anidado —y no una sola clave como en `lead-answer-row`— para
// que el periodo actual y el anterior no se desalojen el uno al otro.

const SIN_FILTRO = Object.freeze({}) as object;
const memo = new WeakMap<CuboHotmartRef, WeakMap<object, Set<number>>>();

export function permitidasDelCuboHotmart(
  ref: CuboHotmartRef,
  campaignFilter: CampaignFilterSpec | undefined
): Set<number> {
  let porFiltro = memo.get(ref);
  if (!porFiltro) {
    porFiltro = new WeakMap();
    memo.set(ref, porFiltro);
  }
  const clave = (campaignFilter ?? SIN_FILTRO) as object;
  const hit = porFiltro.get(clave);
  if (hit) return hit;
  const permitidas = campanasPermitidas(ref.ds, ref.keyword, campaignFilter, ref.campaignGroups);
  porFiltro.set(clave, permitidas);
  return permitidas;
}

/**
 * Referencia lista para adjuntar a las filas, o null si no hay cubo que usar.
 *
 * Un cubo `incompleto` (la carga falló) NO se adjunta: las fórmulas `hm_*`
 * salen «—» en vez de un 0 que afirmaría que no hubo ventas. Un cubo vacío pero
 * completo SÍ: un rango sin ventas tiene 0 ventas.
 */
export function refDeCuboHotmart(
  ds: HotmartCuboLite | null | undefined,
  keyword: AnyCampaignFilter,
  campaignGroups: any[] | undefined
): CuboHotmartRef | null {
  if (!ds || ds.incompleto || !Array.isArray(ds.campanas)) return null;
  return { ds, keyword, campaignGroups };
}

/**
 * Re-deriva las claves `hm_*` de una fila para el filtro de un BLOQUE.
 *
 * `null` cuando la fila no lleva cubo, para que el llamante devuelva la fila tal
 * cual sin crear un objeto por nada.
 */
export function reDerivarHotmart(
  row: any,
  campaignFilter: CampaignFilterSpec | undefined
): Record<string, number> | null {
  const ref = row?.[CLAVE_CUBO_HOTMART] as CuboHotmartRef | undefined;
  if (!ref) return null;
  return clavesHotmartDelDia(
    ref.ds,
    String(row.fecha ?? ''),
    permitidasDelCuboHotmart(ref, campaignFilter)
  );
}

/**
 * Claves + referencia de un día, listas para volcar en una fila. Lo usan la
 * inyección inicial y la fila de relleno de los días sin `metricas_diarias`: un
 * día con ventas y sin inversión es un día real.
 */
export function clavesHotmartYRefDelDia(
  ref: CuboHotmartRef | null,
  fecha: string
): Record<string, unknown> {
  if (!ref) return {};
  return {
    [CLAVE_CUBO_HOTMART]: ref,
    ...clavesHotmartDelDia(ref.ds, fecha, permitidasDelCuboHotmart(ref, undefined)),
  };
}
