import 'server-only';

/**
 * Herramientas de leads — la parte del agente que responde en TIEMPO REAL.
 *
 * El resto de herramientas de métricas leen `metricas_diarias`, que se llena al
 * sincronizar: cuando alguien preguntaba «¿cuántos leads van hoy?», el agente
 * contestaba con los `meta_leads` de la última sincronización, no con los leads
 * de verdad. Los leads reales están en `report_utm.lead_events` y entran por
 * webhook en segundos (GoHighLevel, Meta Lead Ads, formulario web).
 *
 * Por eso cada respuesta dice de dónde sale y a qué hora: `fuente` y
 * `actualizado_a`. Es la distinción que se pidió en la reunión del 2026-09-08
 * entre lo que se lee al instante y lo que hay que sincronizar.
 */

import { z } from 'zod';
import { createAdminClient } from '@/utils/supabase/server';
import { resolveRtmClienteId, loadResolver } from '@/lib/report-utm/campaign-resolver';
import { getCrossDiagnostics } from '@/lib/report-utm/campaign-data';
import { columnaExcluidoDisponible } from '@/lib/report-utm/lead-exclusion';
import { colombiaRangeBounds, colombiaDateOf } from '@/lib/colombia-date';
import { fetchAllRows } from '@/lib/supabase-paginate';
import { resolverPeriodo, PRESETS } from '@/lib/date-presets';
import type { AnyAgentTool } from '../types';
import { exigirCliente } from '../registry';

const FUENTE_TIEMPO_REAL = 'webhook (tiempo real: GoHighLevel, Meta Lead Ads, formulario web)';

const periodoSchema = {
  preset: z
    .enum(PRESETS as [string, ...string[]])
    .optional()
    .describe('Periodo con nombre (today, yesterday, last_7_days…). Por defecto today.'),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Fecha inicial YYYY-MM-DD (día Colombia).'),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Fecha final YYYY-MM-DD (día Colombia).'),
};

/** `today` por defecto: la pregunta típica es «¿cuántos van hoy?». */
function periodoDe(input: { preset?: string; from?: string; to?: string }) {
  if (!input.preset && !input.from && !input.to) return resolverPeriodo({ preset: 'today' });
  return resolverPeriodo(input);
}

const getLeads: AnyAgentTool = {
  name: 'get_leads',
  domain: 'metricas',
  description:
    'Leads REALES de un cliente, en tiempo real: los contactos que entraron por GoHighLevel, ' +
    'Meta Lead Ads o el formulario web, sin esperar a ninguna sincronización. Úsala para ' +
    '«¿cuántos leads van hoy?» o «¿qué campaña está trayendo leads?». Devuelve el total, el ' +
    'desglose por día y por campaña real, y cuántos quedaron fuera por la regla del cliente. ' +
    'No la confundas con `meta_leads` de get_metrics, que es lo que Meta reportó en la última ' +
    'sincronización.',
  input: z.object({
    client_id: z.string().uuid().describe('UUID del cliente (el de list_clients).'),
    ...periodoSchema,
  }),
  scopes: ['read:metrics'],
  handler: async (
    input: { client_id: string; preset?: string; from?: string; to?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);
    const periodo = periodoDe(input);
    const rtmId = await resolveRtmClienteId(input.client_id);
    const actualizado_a = new Date().toISOString();
    if (!rtmId) {
      return {
        period: periodo,
        total: 0,
        fuente: FUENTE_TIEMPO_REAL,
        actualizado_a,
        warnings: ['El cliente no tiene captación de leads conectada en Report-UTM.'],
      };
    }

    const db = await createAdminClient();
    const rtm = db.schema('report_utm');
    const bounds = colombiaRangeBounds(periodo.from, periodo.to);
    const conExclusion = await columnaExcluidoDisponible(db);

    const filas = (await fetchAllRows(
      () => {
        const q = rtm
          .from('lead_events')
          .select(
            `id,created_at,utm_id,utm_campaign,utm_content,utm_term,source${conExclusion ? ',excluido' : ''}`
          )
          .eq('cliente_id', rtmId)
          .gte('created_at', bounds.gte)
          .lt('created_at', bounds.lt);
        return q;
      },
      1000,
      50_000
    )) as Array<Record<string, unknown>>;

    const cuentan = filas.filter((f) => f.excluido !== true);
    const excluidos = filas.length - cuentan.length;

    const resolver = await loadResolver(rtmId, periodo.from, periodo.to);
    const porDia = new Map<string, number>();
    const porCampana = new Map<string, number>();
    const porFuente = new Map<string, number>();
    for (const f of cuentan) {
      const dia = colombiaDateOf(new Date(String(f.created_at)));
      porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
      const camp = resolver
        ? resolver.campaignOf(f as Record<string, string | null>).label
        : String(f.utm_campaign ?? '(sin campaña)') || '(sin campaña)';
      porCampana.set(camp, (porCampana.get(camp) ?? 0) + 1);
      const fuente = String(f.source ?? 'desconocida');
      porFuente.set(fuente, (porFuente.get(fuente) ?? 0) + 1);
    }

    const ordenar = (m: Map<string, number>, n: number) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => ({ nombre: k, leads: v }));

    return {
      period: { from: periodo.from, to: periodo.to, etiqueta: periodo.etiqueta },
      total: cuentan.length,
      excluidos_por_regla: excluidos,
      por_dia: [...porDia.entries()].sort().map(([dia, leads]) => ({ dia, leads })),
      por_campana: ordenar(porCampana, 15),
      por_origen: ordenar(porFuente, 10),
      fuente: FUENTE_TIEMPO_REAL,
      actualizado_a,
    };
  },
};

const getUtmCrossing: AnyAgentTool = {
  name: 'get_utm_crossing',
  domain: 'metricas',
  description:
    'Qué tanto de los leads de un cliente cruza con sus campañas de Meta/TikTok (por ID o por ' +
    'nombre), cuánto gasto quedó sin leads atribuidos y qué UTMs no cruzan. Úsala para «¿por qué ' +
    'el CPL por campaña no cuadra?» o antes de mandar un informe por campaña.',
  input: z.object({
    client_id: z.string().uuid().describe('UUID del cliente.'),
    ...periodoSchema,
  }),
  scopes: ['read:metrics'],
  handler: async (
    input: { client_id: string; preset?: string; from?: string; to?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);
    const periodo =
      input.preset || input.from || input.to
        ? resolverPeriodo(input)
        : resolverPeriodo({ preset: 'last_30_days' });
    const rtmId = await resolveRtmClienteId(input.client_id);
    if (!rtmId) {
      return { period: periodo, warnings: ['El cliente no tiene Report-UTM conectado.'] };
    }
    const d = await getCrossDiagnostics({
      cliente_id: rtmId,
      date_from: periodo.from,
      date_to: periodo.to,
    });
    const total = d.coverage.total;
    const sinCruzar = d.coverage.methods.none ?? 0;
    return {
      period: { from: periodo.from, to: periodo.to, etiqueta: periodo.etiqueta },
      leads_que_cuentan: total,
      leads_excluidos: d.excluidos,
      pct_leads_cruzados: total > 0 ? Math.round(((total - sinCruzar) / total) * 100) : null,
      pct_gasto_con_leads: d.spend?.pct ?? null,
      conjuntos: d.niveles.adset.cobertura,
      anuncios: d.niveles.ad.cobertura,
      utms_sin_cruzar: d.suggestions.slice(0, 10).map((s) => ({ valor: s.value, leads: s.count })),
      campanas_con_gasto_sin_leads: d.spend?.orphans.slice(0, 10) ?? [],
      fuente: FUENTE_TIEMPO_REAL,
      actualizado_a: new Date().toISOString(),
    };
  },
};

export const toolsLeads: AnyAgentTool[] = [getLeads, getUtmCrossing];
