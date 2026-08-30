import 'server-only';

/**
 * Herramientas de métricas — todas sobre `getMetricasCliente`.
 *
 * Los handlers del MCP calculaban por su cuenta y no coincidían con el
 * dashboard. Lo que cambia aquí:
 *
 *   · El gasto sale de sumar el array `meta_campaigns[]`, como en el dashboard,
 *     no de la columna `meta_spend`.
 *   · El filtro de pestaña se resuelve con `parseTabFilter`, así que entiende
 *     los filtros compuestos, las exclusiones y los grupos de campaña.
 *   · Las fechas por defecto se calculan en la zona de Colombia. `defaultDates`
 *     usaba UTC, lo que adelantaba el día cinco horas respecto al resto del
 *     sistema.
 *   · `ventas_cerradas` sale de `metricas_manuales`. La columna del mismo
 *     nombre está obsoleta desde la migración 045 y siempre vale 0, así que
 *     `get_metrics` informaba de cero ventas mientras `get_summary` daba el
 *     valor real.
 *   · CTR y CPC tienen UNA definición. Antes cambiaban de fórmula y de redondeo
 *     según se pasara o no una palabra clave.
 */

import { z } from 'zod';
import { getMetricasCliente, MAX_DIAS_RANGO } from '@/lib/metrics/client-metrics';
import { resolverPeriodo, PRESETS } from '@/lib/date-presets';
import type { AnyAgentTool } from '../types';
import { exigirCliente } from '../registry';

const periodoSchema = {
  preset: z
    .enum(PRESETS as [string, ...string[]])
    .optional()
    .describe('Periodo con nombre. Alternativa a from/to. Por defecto last_30_days.'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Fecha inicial YYYY-MM-DD.'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Fecha final YYYY-MM-DD.'),
};

const clienteIdSchema = z.string().uuid().describe('UUID del cliente.');

const tabIdSchema = z
  .string()
  .uuid()
  .optional()
  .describe(
    'UUID de la pestaña (estrategia), de get_tabs. Filtra a las campañas de esa estrategia. ' +
      'Es la forma correcta de acotar: no intentes pasar el texto del filtro.'
  );

/** Métricas que interesan en una lectura diaria, para no devolver 80 columnas. */
const CLAVES_DIA = [
  'fecha',
  'meta_spend',
  'meta_impressions',
  'meta_clicks',
  'meta_link_clicks',
  'meta_leads',
  'meta_purchases',
  'tiktok_spend',
  'tiktok_impressions',
  'tiktok_clicks',
  'ga_sessions',
  'hotmart_pagos_iniciados',
  'ventas_principal',
  'ventas_bump',
  'ventas_upsell',
];

function proyectar(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CLAVES_DIA) if (row[k] !== undefined) out[k] = row[k];
  // `ventas_cerradas` vive en `metricas_manuales`: la columna homónima quedó
  // obsoleta en la migración 045 y devuelve 0 siempre.
  const manuales = row.metricas_manuales;
  if (manuales && typeof manuales === 'object') {
    const v = (manuales as Record<string, unknown>).VENTAS_CERRADAS;
    if (v !== undefined) out.ventas_cerradas = Number(v) || 0;
  }
  return out;
}

function totalVentasCerradas(rows: Record<string, unknown>[]): number {
  let total = 0;
  for (const row of rows) {
    const manuales = row.metricas_manuales;
    if (manuales && typeof manuales === 'object') {
      total += Number((manuales as Record<string, unknown>).VENTAS_CERRADAS ?? 0) || 0;
    }
  }
  return total;
}

const getMetrics: AnyAgentTool = {
  name: 'get_metrics',
  domain: 'metricas',
  description:
    'Métricas diarias de un cliente en un periodo. Devuelve una fila por día. ' +
    'Para ver solo una estrategia, pasa `tab_id` (de get_tabs). ' +
    'Si buscas totales del periodo en vez de la serie diaria, usa get_summary.',
  input: z.object({
    client_id: clienteIdSchema,
    tab_id: tabIdSchema,
    ...periodoSchema,
  }),
  scopes: ['read:metrics'],
  handler: async (
    input: { client_id: string; tab_id?: string; preset?: string; from?: string; to?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const periodo = resolverPeriodo(input);
    const res = await getMetricasCliente({
      clienteId: input.client_id,
      from: periodo.from,
      to: periodo.to,
      tabId: input.tab_id,
      maxDias: MAX_DIAS_RANGO,
    });

    return {
      period: { from: res.rango.from, to: res.rango.to, etiqueta: periodo.etiqueta },
      tab: res.tab,
      metrics: res.rows.map(proyectar),
      warnings: res.warnings,
    };
  },
};

const getSummary: AnyAgentTool = {
  name: 'get_summary',
  domain: 'metricas',
  description:
    'Totales agregados de un cliente en un periodo: inversión, impresiones, clics, leads, ' +
    'ventas y las métricas derivadas (CPL, CPC, CPM, CTR, ROAS). Las derivadas se recalculan ' +
    'sobre los totales, no se promedian los valores diarios. ' +
    'Para ver solo una estrategia, pasa `tab_id` (de get_tabs).',
  input: z.object({
    client_id: clienteIdSchema,
    tab_id: tabIdSchema,
    ...periodoSchema,
  }),
  scopes: ['read:metrics'],
  handler: async (
    input: { client_id: string; tab_id?: string; preset?: string; from?: string; to?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const periodo = resolverPeriodo(input);
    const res = await getMetricasCliente({
      clienteId: input.client_id,
      from: periodo.from,
      to: periodo.to,
      tabId: input.tab_id,
      maxDias: MAX_DIAS_RANGO,
    });

    const t = res.totals;
    const ventasCerradas = totalVentasCerradas(res.rows);

    return {
      period: { from: res.rango.from, to: res.rango.to, etiqueta: periodo.etiqueta },
      tab: res.tab,
      dias_con_datos: res.rows.length,
      totales: {
        meta_spend: t.meta_spend ?? 0,
        meta_impressions: t.meta_impressions ?? 0,
        meta_clicks: t.meta_clicks ?? 0,
        meta_link_clicks: t.meta_link_clicks ?? 0,
        meta_leads: t.meta_leads ?? 0,
        meta_purchases: t.meta_purchases ?? 0,
        tiktok_spend: t.tiktok_spend ?? 0,
        ga_sessions: t.ga_sessions ?? 0,
        hotmart_pagos_iniciados: t.hotmart_pagos_iniciados ?? 0,
        ventas_principal: t.ventas_principal ?? 0,
        ventas_bump: t.ventas_bump ?? 0,
        ventas_upsell: t.ventas_upsell ?? 0,
        ventas_cerradas: ventasCerradas,
      },
      derivadas: {
        cpl: t.meta_cpl ?? null,
        cpc: t.meta_cpc ?? null,
        cpc_link: t.meta_cpc_link ?? null,
        cpm: t.meta_cpm ?? null,
        ctr: t.meta_ctr ?? null,
        ctr_link: t.meta_ctr_link ?? null,
        roas: t.meta_roas ?? null,
      },
      warnings: res.warnings,
    };
  },
};

const compararPeriodos: AnyAgentTool = {
  name: 'compare_periods',
  domain: 'metricas',
  description:
    'Compara los totales de un periodo con los del periodo inmediatamente anterior de la misma ' +
    'duración, y devuelve la variación porcentual de cada métrica. Es la herramienta para ' +
    'preguntas de tendencia: "cómo vamos respecto a la semana pasada", "qué ha cambiado".',
  input: z.object({
    client_id: clienteIdSchema,
    tab_id: tabIdSchema,
    ...periodoSchema,
  }),
  scopes: ['read:metrics'],
  handler: async (
    input: { client_id: string; tab_id?: string; preset?: string; from?: string; to?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const periodo = resolverPeriodo(input);
    const actual = await getMetricasCliente({
      clienteId: input.client_id,
      from: periodo.from,
      to: periodo.to,
      tabId: input.tab_id,
    });

    // Mismo número de días, terminando el día anterior al inicio del actual.
    const ini = new Date(actual.rango.from + 'T00:00:00Z');
    const fin = new Date(actual.rango.to + 'T00:00:00Z');
    const dias = Math.round((fin.getTime() - ini.getTime()) / 86400000) + 1;
    const finPrev = new Date(ini.getTime() - 86400000);
    const iniPrev = new Date(finPrev.getTime() - (dias - 1) * 86400000);

    const previo = await getMetricasCliente({
      clienteId: input.client_id,
      from: iniPrev.toISOString().slice(0, 10),
      to: finPrev.toISOString().slice(0, 10),
      tabId: input.tab_id,
    });

    const CLAVES = [
      'meta_spend',
      'meta_impressions',
      'meta_clicks',
      'meta_leads',
      'meta_cpl',
      'meta_ctr',
      'meta_cpc',
      'meta_roas',
      'ventas_principal',
    ];

    const variacion: Record<string, { actual: number; previo: number; cambio_pct: number | null }> =
      {};
    for (const k of CLAVES) {
      const a = Number(actual.totals[k] ?? 0);
      const p = Number(previo.totals[k] ?? 0);
      variacion[k] = {
        actual: a,
        previo: p,
        // Sin base previa el porcentaje no significa nada: mejor null que un
        // "+100 %" que el modelo narraría como un hito.
        cambio_pct: p > 0 ? ((a - p) / p) * 100 : null,
      };
    }

    return {
      periodo_actual: { from: actual.rango.from, to: actual.rango.to, etiqueta: periodo.etiqueta },
      periodo_previo: { from: previo.rango.from, to: previo.rango.to },
      tab: actual.tab,
      variacion,
      warnings: [...actual.warnings, ...previo.warnings],
    };
  },
};

export const toolsMetricas: AnyAgentTool[] = [getMetrics, getSummary, compararPeriodos];
