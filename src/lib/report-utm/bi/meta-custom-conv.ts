/**
 * Conversiones personalizadas de Meta en el BI de Report-UTM.
 *
 * Tres formas de pedirlas, todas resueltas contra el catálogo del cliente
 * (`public.meta_conversiones_catalogo`):
 *
 *   - `metacc:<clave>`            métrica de widget;
 *   - `mcc__<clave saneada>`      alias dentro de un campo calculado
 *                                 (`spend / mcc__lead_x` = coste por conversión);
 *   - `resultados_custom` y `coste_por_resultado_custom`: la suma de las
 *     marcadas como «resultado» del cliente y su coste.
 *
 * Los VALORES no se leen aquí: viajan con el gasto. El motor los acumula en el
 * mismo recorrido del JSONB que el gasto (`queryAdsFromJsonb` / `queryAdsScalar`),
 * así que heredan sin código propio el alcance de campañas del cliente (cuenta
 * compartida), los filtros de campaña/conjunto/anuncio y plataforma, el nombre
 * vigente de cada entidad y los desgloses por conjunto y anuncio. El lector
 * aparte de antes sumaba DESPUÉS de las fórmulas y se saltaba todo eso.
 *
 * Aquí solo vive lo puro: qué se pide y cómo se emite. Se comprueba sin Postgres.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { resolverClaveCc } from '@/lib/meta/conversiones-personalizadas';
import { extractMetaCcAliases, isMetaCcMetric, parseMetaCcMetric } from '../bi-metadata';

/** Prefijo de los acumuladores dentro de una entrada de gasto (`AdRow`). */
export const CC_ENTRY_PREFIX = 'cc:';

export interface CatalogoCcFila {
  conversion_key: string;
  es_resultado?: boolean | null;
}

export interface PeticionCc {
  /** Claves del catálogo que hay que acumular. */
  claves: string[];
  /** Cada salida pedida (token o alias) → su clave. */
  salidas: Array<{ out: string; key: string }>;
  /** Claves marcadas como resultado. Vacío = el cliente no marcó ninguna. */
  resultado: string[];
}

/** ¿La consulta pide algo de conversiones personalizadas? Puro. */
export function pideConversiones(params: {
  metrics: string[];
  calculated?: Array<{ expression: string }>;
}): { tokens: string[]; aliases: string[]; resultados: boolean } {
  const tokens = params.metrics.filter((m) => isMetaCcMetric(m));
  const aliases = new Set<string>();
  let resultados = params.metrics.some(
    (m) => m === 'resultados_custom' || m === 'coste_por_resultado_custom'
  );
  for (const cf of params.calculated ?? []) {
    for (const a of extractMetaCcAliases(cf.expression)) aliases.add(a.alias);
    if (/\b(resultados_custom|coste_por_resultado_custom)\b/.test(cf.expression)) {
      resultados = true;
    }
  }
  return { tokens, aliases: Array.from(aliases), resultados };
}

/** Qué hay que acumular, a partir de lo pedido y el catálogo. Puro. */
export function planConversiones(
  pedido: { tokens: string[]; aliases: string[]; resultados: boolean },
  catalogo: CatalogoCcFila[]
): PeticionCc | null {
  if (pedido.tokens.length === 0 && pedido.aliases.length === 0 && !pedido.resultados) {
    return null;
  }
  const claves = catalogo.map((c) => c.conversion_key);
  const salidas: PeticionCc['salidas'] = [];
  for (const t of pedido.tokens) {
    const k = parseMetaCcMetric(t)!;
    salidas.push({ out: t, key: resolverClaveCc(k, claves) ?? k });
  }
  for (const a of pedido.aliases) {
    const ref = a.slice('mcc__'.length);
    salidas.push({ out: a, key: resolverClaveCc(ref, claves) ?? ref });
  }
  const resultado = pedido.resultados
    ? catalogo.filter((c) => c.es_resultado).map((c) => c.conversion_key)
    : [];
  const todas = new Set<string>([...salidas.map((s) => s.key), ...resultado]);
  return { claves: Array.from(todas), salidas, resultado };
}

/** Suma las conversiones de un elemento del JSONB en su entrada de gasto. */
export function sumarConversiones(
  entry: Record<string, number>,
  customConversions: unknown,
  claves: readonly string[]
): void {
  const cc =
    customConversions && typeof customConversions === 'object'
      ? (customConversions as Record<string, unknown>)
      : null;
  for (const k of claves) {
    const campo = `${CC_ENTRY_PREFIX}${k}`;
    entry[campo] = (entry[campo] ?? 0) + (Number(cc?.[k] ?? 0) || 0);
  }
}

/**
 * Valores de una fila del informe: cada salida pedida, los resultados
 * personalizados (null si el cliente no marcó ninguna) y su coste (null sin
 * resultados o sin gasto de Meta, como el resto de ratios).
 */
export function valoresConversiones(
  ad: Record<string, unknown> | undefined,
  plan: PeticionCc | null,
  metaSpend: number
): {
  valores: Record<string, number>;
  resultados: number | null;
  coste: number | null;
} {
  const valores: Record<string, number> = {};
  if (!plan) return { valores, resultados: null, coste: null };
  const de = (k: string) => Number(ad?.[`${CC_ENTRY_PREFIX}${k}`] ?? 0) || 0;
  for (const { out, key } of plan.salidas) valores[out] = de(key);
  if (plan.resultado.length === 0) return { valores, resultados: null, coste: null };
  const resultados = plan.resultado.reduce((s, k) => s + de(k), 0);
  const coste =
    resultados > 0 && metaSpend > 0 ? Math.round((metaSpend / resultados) * 100) / 100 : null;
  return { valores, resultados, coste };
}

/**
 * Catálogo del cliente (id público). Sin la migración 096 no existe
 * `es_resultado`: se cae a las claves solas y nadie cuenta como resultado.
 */
export async function cargarCatalogoCc(db: any, publicId: string): Promise<CatalogoCcFila[]> {
  const completo = await db
    .from('meta_conversiones_catalogo')
    .select('conversion_key, es_resultado')
    .eq('cliente_id', publicId);
  if (!completo.error) return (completo.data ?? []) as CatalogoCcFila[];
  const antiguo = await db
    .from('meta_conversiones_catalogo')
    .select('conversion_key')
    .eq('cliente_id', publicId);
  return (antiguo.data ?? []) as CatalogoCcFila[];
}
