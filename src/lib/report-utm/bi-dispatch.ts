// Despacho de una consulta BI ya parseada al motor correcto.
//
// Lo comparten el endpoint autenticado (/api/report-utm/bi/query) y el público
// por token (/api/report-utm/bi/public/[token]/query), de modo que ambos
// resuelven exactamente igual y no se desincronizan.

import { runBiQuery, runFunnelQuery, runComparison, runPivotQuery, runValores } from './bi-query';
import { aValoresPlanos } from './bi-valores';
import {
  supportsPivot,
  PIVOT_METRICS,
  METRIC_META,
  isSheetDim,
  hasNonAttributableFilter,
  NON_ATTRIBUTABLE_FIELDS,
} from './bi-metadata';
import { resolvePublicClienteId } from './campaign-resolver';
import { createAdminClient } from '@/utils/supabase/server';
import { monedaDeClienteUtm, type AvisoTasas } from '@/lib/moneda-reporte';
import { conAvisosDeTasas } from './bi/avisos-tasas';
import { computeDiagnostics } from './bi/diagnostics';
import type { QueryDiagnostics } from './bi/diagnostics';
import type { ParsedBiQuery } from './bi-query-params';
import { esConsultaDeValores } from './bi-query-params';

export interface DispatchResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  /**
   * Por qué un campo no se pudo medir. ADITIVO: los widgets que solo leen
   * `data` siguen funcionando igual. Es lo que permite pintar «—» con su
   * motivo en vez de un 0 que no significa cero.
   *
   * `moneda` es la moneda de reporte del cliente: con ella los widgets pintan
   * «CLP 233.487» en vez de un «$» que no dice qué moneda es.
   *
   * `tasas` lista los días que se convirtieron sin su tasa de cambio propia (o
   * sin ninguna): el widget lo avisa en vez de sustituirla en silencio.
   */
  meta?: MetaConsulta;
  error?: string;
  status?: number;
}

/**
 * Qué campos del filtro activo NO son atribuibles al gasto.
 *
 * `hasNonAttributableFilter` ya decide SI hay alguno (y el motor lo usa para
 * anular la consulta de gasto); aquí hace falta además CUÁLES, para poder
 * nombrarlos en el aviso en vez de dar una explicación genérica.
 */
function camposNoAtribuibles(p: ParsedBiQuery): string[] {
  const out = new Set<string>();
  const esNoAtribuible = (campo: string) =>
    NON_ATTRIBUTABLE_FIELDS.has(campo) ||
    campo.startsWith('field:') ||
    campo.startsWith('leadfield:') ||
    campo.startsWith('sheetdim:');

  for (const [k, v] of Object.entries(p.filters ?? {})) {
    if (v && String(v).trim() && esNoAtribuible(k)) out.add(k);
  }
  for (const g of p.advancedFilter?.groups ?? []) {
    for (const c of g.conditions ?? []) {
      if (c.value && c.value.trim() && esNoAtribuible(c.field)) out.add(c.field);
    }
  }
  return [...out];
}

/**
 * Calcula el diagnóstico de la consulta. No cambia ningún número: solo explica
 * los que el motor ya devuelve.
 *
 * Nunca hace fallar la consulta: si el diagnóstico revienta, se devuelven las
 * filas sin él. Un aviso roto no debe tumbar un informe.
 */
async function diagnosticarSeguro(p: ParsedBiQuery): Promise<QueryDiagnostics | undefined> {
  try {
    // Sin cliente no hay nada que diagnosticar (y sin él el motor tampoco
    // lee las fuentes que cuelgan del cliente público).
    if (!p.cliente_id) return undefined;
    const publicId = await resolvePublicClienteId(p.cliente_id);
    return computeDiagnostics({
      metrics: p.metrics as unknown as string[],
      dimension: p.dimension,
      dimension2: p.dimension2,
      calculated: p.calculated.map((c) => ({ name: c.name, expression: c.expression })),
      hasPublicLink: publicId !== null,
      unattributableFilters: hasNonAttributableFilter(p.filters, p.advancedFilter)
        ? camposNoAtribuibles(p)
        : undefined,
    });
  } catch {
    return undefined;
  }
}

/** Moneda de reporte del cliente, o `undefined` si no hay cliente o falla. */
async function monedaSegura(q: ParsedBiQuery): Promise<string | undefined> {
  if (!q.cliente_id) return undefined;
  try {
    return await monedaDeClienteUtm(await createAdminClient(), q.cliente_id);
  } catch {
    return undefined;
  }
}

/** El diagnóstico de siempre más la moneda de reporte, en paralelo. */
async function diagnosticarConMoneda(
  q: ParsedBiQuery
): Promise<(QueryDiagnostics & { moneda?: string }) | undefined> {
  const [diag, moneda] = await Promise.all([diagnosticarSeguro(q), monedaSegura(q)]);
  if (!diag) return undefined;
  return moneda ? { ...diag, moneda } : diag;
}

export type MetaConsulta = QueryDiagnostics & { moneda?: string; tasas?: AvisoTasas };

/**
 * Corre la consulta recogiendo los días sin tasa y, en paralelo, el diagnóstico
 * con la moneda. Sin diagnóstico (consulta sin cliente) no hay conversión que
 * avisar, así que tampoco hace falta `meta`.
 */
async function conMeta<T>(p: ParsedBiQuery, correr: () => Promise<T>): Promise<DispatchResult> {
  const [{ resultado, tasas }, meta] = await Promise.all([
    conAvisosDeTasas(correr),
    diagnosticarConMoneda(p),
  ]);
  return { data: resultado, meta: meta && tasas ? { ...meta, tasas } : meta };
}

export async function dispatchBiQuery(rawParams: ParsedBiQuery): Promise<DispatchResult> {
  // "Campaña (cruzada)" tuvo su propio motor (`runCampaignQuery`), que solo
  // emitía ~20 de las 72 métricas e ignoraba los campos calculados. Hoy la
  // dimensión `utm_campaign` del motor principal hace el mismo cruce con todo
  // el catálogo, así que el alias se normaliza aquí y sigue el camino normal:
  // los informes guardados con `dimension: 'campaign'` no se enteran.
  const p: ParsedBiQuery = {
    ...rawParams,
    dimension: rawParams.dimension === 'campaign' ? 'utm_campaign' : rawParams.dimension,
    dimension2: rawParams.dimension2 === 'campaign' ? 'utm_campaign' : rawParams.dimension2,
  };

  const base = {
    cliente_id: p.cliente_id,
    metrics: p.metrics,
    dimension: p.dimension,
    dimension2: p.dimension2,
    date_from: p.date_from,
    date_to: p.date_to,
    date_grouping: p.date_grouping,
    filters: p.filters,
    limit: p.limit,
    sort: p.sort,
    calculated: p.calculated.length ? p.calculated : undefined,
    advancedFilter: p.advancedFilter,
  };

  if (p.type === 'funnel') {
    return conMeta(p, () =>
      runFunnelQuery({
        cliente_id: p.cliente_id,
        date_from: p.date_from,
        date_to: p.date_to,
        filters: p.filters,
        advancedFilter: p.advancedFilter,
        metrics: p.metrics,
      })
    );
  }

  if (esConsultaDeValores(p.type)) {
    // Enumerar valores alimenta un desplegable: no hay métricas que
    // explicar, así que no se diagnostica.
    //
    // `source` y `limit` se reenvían de verdad. Antes se perdían aquí: el
    // slicer los mandaba en la URL, el parseo no los leía y esta llamada no
    // los pasaba, así que un slicer sobre ventas listaba valores de leads.
    const r = await runValores({
      cliente_id: p.cliente_id,
      dimension: p.dimension,
      date_from: p.date_from,
      date_to: p.date_to,
      filters: p.filters,
      source: p.source,
      search: p.search,
      limit: p.limit,
      incluir_excluidos: p.incluir_excluidos,
    });
    // `distinct` conserva su contrato histórico —un array de nombres— para
    // que un widget servido desde la caché del navegador siga funcionando.
    return { data: p.type === 'distinct' ? aValoresPlanos(r) : r };
  }

  if (p.type === 'pivot') {
    if (!p.metrics.length || !p.dimension2) {
      return { error: 'pivot requires metric + dimension2', status: 400 };
    }
    // El pivot agrupa filas de lead_events/sales_events: solo puede contar filas
    // o sumar `amount`. Con cualquier otra métrica devolvería un conteo de filas
    // disfrazado de gasto/alcance, así que se rechaza explícitamente.
    // Un campo de Sheet no puede ser eje de una tabla dinámica: su desglose
    // vive en su propia tabla y no cruza con las filas de leads/ventas que
    // agrupa el pivot. Se dice explícitamente en vez de devolver ceros.
    if (isSheetDim(p.dimension) || isSheetDim(p.dimension2)) {
      return {
        error:
          'Un campo de Sheet no se puede usar como eje de una tabla dinámica. ' +
          'Úsalo como dimensión principal en una tabla o una gráfica.',
        status: 400,
      };
    }
    if (!supportsPivot(p.metrics[0])) {
      const validas = PIVOT_METRICS.map((m) => METRIC_META[m]?.label ?? m).join(', ');
      return {
        error: `La dimensión secundaria solo admite: ${validas} y los segmentos de campo de lead.`,
        status: 400,
      };
    }
    return conMeta(p, () => runPivotQuery(base, p.metrics[0]));
  }

  // Un widget de FÓRMULA no pide métricas: pide una expresión (calc[...]) que el
  // motor resuelve leyendo los identificadores que referencia. Exigir `metrics`
  // aquí lo rechazaba con un 400 que el widget mostraba como un simple 0.
  if (!p.metrics.length && !p.calculated.length) {
    return { error: 'metrics is required', status: 400 };
  }

  if (p.type === 'compare') {
    return conMeta(p, () => runComparison(base));
  }

  return conMeta(p, () => runBiQuery(base));
}
