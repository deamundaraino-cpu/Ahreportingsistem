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
import { cargarEstadoGa4 } from '@/lib/ga4/estado';
import { ga4PaginasSinDatos, ga4SinDatos } from '@/lib/ga4/metricas';
import { leadFieldLabel, leadAnsLabel, leadSegLabel, ga4EvLabel } from './bi-metadata';
import { loadLeadCampos, loadLeadSegmentos } from './lead-campos-db';
import { createAdminClient } from '@/utils/supabase/server';
import { avisoMonedaGasto, monedaDeClienteUtm, type AvisoTasas } from '@/lib/moneda-reporte';
import { conAvisosDeTasas } from './bi/avisos-tasas';
import { conZonaDeCliente } from '@/lib/zona-activa';
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
    // GA4 por campaña sin propiedad o sin una sincronización correcta: el «—»
    // de sus celdas se explica como «no configurado», no como falta de datos.
    const pideGa4 = [
      ...(p.metrics as unknown as string[]),
      ...p.calculated.map((c) => c.expression),
    ].some((t) => /\bga4(_|ev:|ev__)/.test(t));
    let notConfigured: Set<string> | undefined;
    if (pideGa4 && publicId) {
      const estado = await cargarEstadoGa4(publicId);
      const nc = new Set<string>();
      if (ga4SinDatos(estado)) nc.add('ga4');
      // Vistas por página (migración 100): su propia sincronización.
      if (ga4PaginasSinDatos(estado)) nc.add('ga4_paginas');
      if (nc.size) notConfigured = nc;
    }
    return computeDiagnostics({
      notConfigured,
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

/** Aviso de gasto en otra moneda (moneda-reporte.ts), o null. Nunca lanza. */
async function avisoMonedaSeguro(
  q: ParsedBiQuery,
  moneda: string | undefined
): Promise<string | null> {
  if (!q.cliente_id || !moneda) return null;
  try {
    const publicId = await resolvePublicClienteId(q.cliente_id);
    if (!publicId) return null;
    const { data } = await (
      await createAdminClient()
    )
      .from('clientes')
      .select('config_api')
      .eq('id', publicId)
      .maybeSingle();
    return avisoMonedaGasto(moneda, data?.config_api ?? null);
  } catch {
    return null;
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

export type MetaConsulta = QueryDiagnostics & {
  moneda?: string;
  tasas?: AvisoTasas;
  /** Degradaciones de la consulta que el widget debe decir (ver avisos-tasas.ts). */
  avisos_consulta?: string[];
  /**
   * Nombre legible de cada token de lead que usa la consulta (pregunta,
   * respuesta, segmento): «Rango de ingresos: $2M a $3M» en vez de
   * `leadans:rango_de_ingresos:2m_3m`. Viaja con la respuesta —y no en un fetch
   * aparte— para que también lo tengan los informes públicos, que no tienen
   * sesión para pedir el catálogo.
   */
  etiquetas?: Record<string, string>;
};

/** Tokens de lead que nombra la consulta (métricas, dimensiones y filtros). */
function tokensDeLead(p: ParsedBiQuery): string[] {
  const out = new Set<string>();
  const ver = (t: string | undefined) => {
    if (t && (t.startsWith('leadfield:') || t.startsWith('leadans:') || t.startsWith('leadseg:')))
      out.add(t);
  };
  for (const m of p.metrics as unknown as string[]) ver(m);
  ver(p.dimension);
  ver(p.dimension2);
  for (const k of Object.keys(p.filters ?? {})) ver(k);
  return [...out];
}

/** Etiquetas del catálogo de Leads para los tokens de la consulta. Nunca lanza. */
async function etiquetasSeguras(p: ParsedBiQuery): Promise<Record<string, string> | undefined> {
  // Eventos clave de GA4: la etiqueta sale del propio token, sin catálogo.
  const ga4: Record<string, string> = {};
  for (const t of p.metrics as unknown as string[]) {
    const e = ga4EvLabel(t);
    if (e) ga4[t] = e;
  }
  const lead = await etiquetasDeLead(p);
  const out = { ...ga4, ...(lead ?? {}) };
  return Object.keys(out).length ? out : undefined;
}

async function etiquetasDeLead(p: ParsedBiQuery): Promise<Record<string, string> | undefined> {
  const tokens = tokensDeLead(p);
  if (tokens.length === 0 || !p.cliente_id) return undefined;
  try {
    const db = (await createAdminClient()).schema('report_utm');
    const campos = await loadLeadCampos(db, p.cliente_id);
    const segs = tokens.some((t) => t.startsWith('leadseg:'))
      ? await loadLeadSegmentos(db, p.cliente_id, campos)
      : [];
    const metaCampos = campos.map((c) => ({
      clave: c.clave,
      nombre: c.nombre,
      valores: [],
      claves_origen: c.claves_origen,
      cobertura: 0,
      alta_cardinalidad: false,
      respuestas: c.respuestas ?? [],
    }));
    const porClave = new Map(campos.map((c) => [c.clave, c.nombre]));
    const metaSegs = segs.map((s) => ({
      clave: s.clave,
      nombre: s.nombre,
      campo_clave: s.campo_clave,
      campo_nombre: porClave.get(s.campo_clave),
      operador: s.operador,
      valores: s.valores,
      cobertura: 0,
    }));
    const out: Record<string, string> = {};
    for (const t of tokens) {
      const e =
        leadFieldLabel(t, metaCampos) ?? leadAnsLabel(t, metaCampos) ?? leadSegLabel(t, metaSegs);
      if (e) out[t] = e;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Corre la consulta recogiendo los días sin tasa y, en paralelo, el diagnóstico
 * con la moneda. Sin diagnóstico (consulta sin cliente) no hay conversión que
 * avisar, así que tampoco hace falta `meta`.
 */
async function conMeta<T>(p: ParsedBiQuery, correr: () => Promise<T>): Promise<DispatchResult> {
  const [{ resultado, tasas, avisos }, meta, etiquetas] = await Promise.all([
    conAvisosDeTasas(correr),
    diagnosticarConMoneda(p),
    etiquetasSeguras(p),
  ]);
  if (!meta) return { data: resultado };
  const avisoMoneda = await avisoMonedaSeguro(p, meta.moneda);
  const todos = avisoMoneda ? [...avisos, avisoMoneda] : avisos;
  return {
    data: resultado,
    meta: {
      ...meta,
      ...(tasas ? { tasas } : {}),
      ...(etiquetas ? { etiquetas } : {}),
      ...(todos.length ? { avisos_consulta: todos } : {}),
    },
  };
}

/**
 * Toda consulta de un cliente corre en SU zona horaria (ver zona-activa.ts): los
 * días de leads y ventas se cortan igual que Meta corta el gasto de su cuenta.
 */
export async function dispatchBiQuery(rawParams: ParsedBiQuery): Promise<DispatchResult> {
  return conZonaDeCliente({ rtm: rawParams.cliente_id ?? null }, () => despacharEnZona(rawParams));
}

async function despacharEnZona(rawParams: ParsedBiQuery): Promise<DispatchResult> {
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
