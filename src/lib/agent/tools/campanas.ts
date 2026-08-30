import 'server-only';

/**
 * Herramientas de campañas — SOLO LECTURA.
 *
 * No hay `pause_campaign` ni `update_campaign_budget` y no es un olvido: el
 * agente no ejecuta nada fuera de la plataforma. Sobre las campañas recomienda,
 * y el equipo decide y ejecuta.
 *
 * Eso, además de ser la política acordada, evita tener que pedir el permiso
 * `ads_management` en el OAuth de Meta y reconectar todas las cuentas de
 * clientes — el token actual solo tiene `ads_read`.
 */

import { z } from 'zod';
import { getMetricasCliente } from '@/lib/metrics/client-metrics';
import { resolverPeriodo, PRESETS } from '@/lib/date-presets';
import type { AnyAgentTool } from '../types';
import { exigirCliente } from '../registry';

const periodoSchema = {
  preset: z.enum(PRESETS as [string, ...string[]]).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
};

type Campana = {
  campaign_id?: string;
  name?: string;
  spend?: number | string;
  impressions?: number | string;
  clicks?: number | string;
  link_clicks?: number | string;
  leads?: number | string;
};

type Acumulado = {
  campaign_id: string | null;
  name: string;
  spend: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  leads: number;
  dias: number;
};

const num = (v: unknown): number => Number(v ?? 0) || 0;

/** Agrega el array diario de campañas a un total por campaña en el periodo. */
function agregarPorCampana(rows: Record<string, unknown>[]): Acumulado[] {
  const mapa = new Map<string, Acumulado>();

  for (const row of rows) {
    const campanas = Array.isArray(row.meta_campaigns) ? (row.meta_campaigns as Campana[]) : [];
    for (const c of campanas) {
      // El id es más estable que el nombre, que alguien puede renombrar a
      // mitad de un periodo y partiría la campaña en dos filas.
      const clave = c.campaign_id ?? c.name ?? '(sin nombre)';
      const acc = mapa.get(clave) ?? {
        campaign_id: c.campaign_id ?? null,
        name: c.name ?? '(sin nombre)',
        spend: 0,
        impressions: 0,
        clicks: 0,
        link_clicks: 0,
        leads: 0,
        dias: 0,
      };
      acc.spend += num(c.spend);
      acc.impressions += num(c.impressions);
      acc.clicks += num(c.clicks);
      acc.link_clicks += num(c.link_clicks);
      acc.leads += num(c.leads);
      acc.dias += 1;
      mapa.set(clave, acc);
    }
  }

  return [...mapa.values()].sort((a, b) => b.spend - a.spend);
}

const listCampaigns: AnyAgentTool = {
  name: 'list_campaigns',
  domain: 'campanas',
  description:
    'Campañas de Meta con actividad en el periodo, con su inversión, impresiones, clics y leads ' +
    'acumulados, ordenadas por gasto. Pasa `tab_id` para ver solo las de una estrategia. ' +
    'Es de solo lectura: para pausar una campaña o cambiar un presupuesto hay que hacerlo en Meta.',
  input: z.object({
    client_id: z.string().uuid(),
    tab_id: z.string().uuid().optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Máximo de campañas. Por defecto 50.'),
    ...periodoSchema,
  }),
  scopes: ['read:campaigns'],
  handler: async (
    input: {
      client_id: string;
      tab_id?: string;
      limit?: number;
      preset?: string;
      from?: string;
      to?: string;
    },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const periodo = resolverPeriodo(input);
    const res = await getMetricasCliente({
      clienteId: input.client_id,
      from: periodo.from,
      to: periodo.to,
      tabId: input.tab_id,
    });

    const todas = agregarPorCampana(res.rows);
    const limite = input.limit ?? 50;

    return {
      period: { from: res.rango.from, to: res.rango.to, etiqueta: periodo.etiqueta },
      tab: res.tab,
      total_campanas: todas.length,
      campaigns: todas.slice(0, limite).map((c) => ({
        ...c,
        cpl: c.leads > 0 ? c.spend / c.leads : null,
        ctr: c.impressions > 0 ? (c.link_clicks / c.impressions) * 100 : null,
        cpc: c.link_clicks > 0 ? c.spend / c.link_clicks : null,
      })),
      warnings:
        todas.length > limite
          ? [...res.warnings, `Se muestran ${limite} de ${todas.length} campañas, por gasto.`]
          : res.warnings,
    };
  },
};

const getCampaignPerformance: AnyAgentTool = {
  name: 'get_campaign_performance',
  domain: 'campanas',
  description:
    'Evolución diaria de UNA campaña concreta, para ver cómo se ha comportado en el tiempo. ' +
    'El identificador se obtiene de list_campaigns.',
  input: z.object({
    client_id: z.string().uuid(),
    campaign_id: z.string().min(1).describe('campaign_id devuelto por list_campaigns.'),
    ...periodoSchema,
  }),
  scopes: ['read:campaigns'],
  handler: async (
    input: { client_id: string; campaign_id: string; preset?: string; from?: string; to?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const periodo = resolverPeriodo(input);
    const res = await getMetricasCliente({
      clienteId: input.client_id,
      from: periodo.from,
      to: periodo.to,
    });

    const serie: Record<string, unknown>[] = [];
    let nombre: string | null = null;

    for (const row of res.rows) {
      const campanas = Array.isArray(row.meta_campaigns) ? (row.meta_campaigns as Campana[]) : [];
      const c = campanas.find(
        (x) => x.campaign_id === input.campaign_id || x.name === input.campaign_id
      );
      if (!c) continue;
      nombre = c.name ?? nombre;
      serie.push({
        fecha: row.fecha,
        spend: num(c.spend),
        impressions: num(c.impressions),
        clicks: num(c.clicks),
        link_clicks: num(c.link_clicks),
        leads: num(c.leads),
      });
    }

    return {
      period: { from: res.rango.from, to: res.rango.to, etiqueta: periodo.etiqueta },
      campaign: { id: input.campaign_id, name: nombre },
      dias: serie.length,
      serie,
      warnings:
        serie.length === 0
          ? [...res.warnings, 'Esa campaña no tiene actividad en el periodo consultado.']
          : res.warnings,
    };
  },
};

export const toolsCampanas: AnyAgentTool[] = [listCampaigns, getCampaignPerformance];
