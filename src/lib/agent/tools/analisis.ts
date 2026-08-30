import 'server-only';

/**
 * Análisis contextualizado.
 *
 * `analyze_performance` no redacta: reúne en una sola respuesta todo lo que
 * hace falta para leer bien unas cifras — quién es el cliente, qué estrategia
 * lleva esa pestaña, hasta dónde llega su medición, cuáles son sus metas y qué
 * dicen los números — y lo entrega ya cruzado.
 *
 * Reunirlo en el servidor y no dejar que el modelo lo vaya pidiendo pieza a
 * pieza es deliberado. El análisis que falló decía que "faltan los datos de
 * ventas y de Google Analytics" y que "es imposible calcular el ROAS" de un
 * cliente que no vende por la plataforma. Si el contexto es opcional, algún día
 * el modelo no lo pide, y ese día vuelve ese informe.
 *
 * Por eso el campo `no_aplican` viaja al lado de las cifras: un dato que no
 * aplica no es un dato que falta.
 */

import { z } from 'zod';
import { getMetricasCliente } from '@/lib/metrics/client-metrics';
import { resolverPeriodo, PRESETS } from '@/lib/date-presets';
import { evaluateGoal, type ClienteGoals } from '@/lib/report-utm/bi-metadata';
import { flagsConexion } from '@/lib/cliente-seguro';
import { ApiError } from '@/lib/error-handler';
import type { AnyAgentTool, AgentContext } from '../types';
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

type Contexto = {
  cliente: { id: string; nombre: string };
  perfil: {
    configurado: boolean;
    descripcion: string | null;
    productos: string | null;
    alcance_medicion: string | null;
    fuentes_activas: string[];
    fuentes_ausentes: string[];
    instrucciones: string | null;
  };
  estrategia: {
    nombre: string;
    alcance: 'hasta_lead' | 'hasta_venta';
    temporal: boolean;
    metricas_clave: string[];
    metricas_na: string[];
    guia: string | null;
    inicio: string | null;
    fin: string | null;
  } | null;
  metas: ClienteGoals;
  feedback: string[];
};

/**
 * Reúne el contexto de un cliente (y opcionalmente de una pestaña).
 *
 * Se exporta porque el motor conversacional lo llama ANTES del primer mensaje
 * al modelo, para inyectarlo en el prompt del sistema.
 */
export async function construirContextoCliente(
  ctx: AgentContext,
  clienteId: string,
  tabId?: string
): Promise<Contexto> {
  exigirCliente(ctx, clienteId);

  const [clienteRes, perfilRes, feedbackRes, rtmRes] = await Promise.all([
    ctx.db.from('clientes').select('id, nombre, config_api').eq('id', clienteId).maybeSingle(),
    ctx.db.from('cliente_perfiles').select('*').eq('cliente_id', clienteId).maybeSingle(),
    ctx.db
      .from('agent_feedback')
      .select('texto')
      .or(`cliente_id.eq.${clienteId},cliente_id.is.null`)
      .eq('activo', true),
    ctx.db
      .schema('report_utm')
      .from('clientes')
      .select('config')
      .eq('public_cliente_id', clienteId)
      .maybeSingle(),
  ]);

  if (clienteRes.error) {
    throw new ApiError(
      'DATABASE_ERROR',
      `No se pudo leer el cliente: ${clienteRes.error.message}`,
      500
    );
  }
  if (!clienteRes.data) {
    throw new ApiError('NOT_FOUND', `No se encuentra el cliente ${clienteId}.`, 404);
  }

  const conexiones = flagsConexion(clienteRes.data.config_api);
  const perfil = perfilRes.data as Record<string, unknown> | null;

  let estrategia: Contexto['estrategia'] = null;
  let metasTab: ClienteGoals = {};

  if (tabId) {
    const { data: tab } = await ctx.db
      .from('cliente_tabs')
      .select('estrategia_tipo_id, metas, fecha_inicio, fecha_finalizacion, presupuesto_objetivo')
      .eq('id', tabId)
      .eq('cliente_id', clienteId)
      .maybeSingle();

    if (tab) {
      metasTab = ((tab.metas ?? {}) as ClienteGoals) || {};
      if (tab.presupuesto_objetivo) metasTab = { ...metasTab, budget: tab.presupuesto_objetivo };

      if (tab.estrategia_tipo_id) {
        const { data: tipo } = await ctx.db
          .from('estrategia_tipos')
          .select('*')
          .eq('id', tab.estrategia_tipo_id)
          .maybeSingle();
        if (tipo) {
          estrategia = {
            nombre: tipo.nombre as string,
            alcance: tipo.alcance as 'hasta_lead' | 'hasta_venta',
            temporal: tipo.temporal as boolean,
            metricas_clave: (tipo.metricas_clave ?? []) as string[],
            metricas_na: (tipo.metricas_na ?? []) as string[],
            guia: (tipo.guia ?? null) as string | null,
            inicio: (tab.fecha_inicio ?? null) as string | null,
            fin: (tab.fecha_finalizacion ?? null) as string | null,
          };
        }
      }
    }
  }

  const cfgRtm = rtmRes.data?.config as Record<string, unknown> | undefined;
  const metasCliente = ((cfgRtm?.goals ?? {}) as ClienteGoals) || {};

  return {
    cliente: { id: clienteRes.data.id, nombre: clienteRes.data.nombre },
    perfil: {
      configurado: perfil !== null,
      descripcion: (perfil?.descripcion ?? null) as string | null,
      productos: (perfil?.productos ?? null) as string | null,
      alcance_medicion: (perfil?.alcance_medicion ?? null) as string | null,
      fuentes_activas: ((perfil?.fuentes_activas as string[] | undefined)?.length
        ? (perfil!.fuentes_activas as string[])
        : Object.entries(conexiones)
            .filter(([, v]) => v)
            .map(([k]) => k)) as string[],
      fuentes_ausentes: ((perfil?.fuentes_ausentes as string[] | undefined)?.length
        ? (perfil!.fuentes_ausentes as string[])
        : Object.entries(conexiones)
            .filter(([, v]) => !v)
            .map(([k]) => k)) as string[],
      instrucciones: (perfil?.instrucciones ?? null) as string | null,
    },
    estrategia,
    metas: { ...metasCliente, ...metasTab },
    feedback: (feedbackRes.data ?? []).map((f) => (f as { texto: string }).texto),
  };
}

const analyzePerformance: AnyAgentTool = {
  name: 'analyze_performance',
  domain: 'analisis',
  description:
    'Dossier completo para analizar a un cliente o una de sus estrategias: su perfil, el tipo de ' +
    'estrategia, las métricas del periodo, la comparación con el periodo anterior y la ' +
    'evaluación contra sus metas. USA ESTA HERRAMIENTA antes de opinar sobre el rendimiento de ' +
    'un cliente: trae el contexto que evita interpretar mal las cifras. ' +
    'Respeta el campo `no_aplican`: lo que aparezca ahí no es un dato que falte, es un dato que ' +
    'no tiene sentido en esa estrategia, y NO debe reportarse como carencia.',
  input: z.object({
    client_id: z.string().uuid(),
    tab_id: z
      .string()
      .uuid()
      .optional()
      .describe('Pestaña a analizar. Si se omite, se analiza el cliente entero.'),
    ...periodoSchema,
  }),
  scopes: ['read:metrics'],
  handler: async (
    input: { client_id: string; tab_id?: string; preset?: string; from?: string; to?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const contexto = await construirContextoCliente(ctx, input.client_id, input.tab_id);
    const periodo = resolverPeriodo(input);

    const actual = await getMetricasCliente({
      clienteId: input.client_id,
      from: periodo.from,
      to: periodo.to,
      tabId: input.tab_id,
    });

    // Periodo anterior de la misma duración.
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

    // Si la estrategia declara métricas clave, se priorizan; si no, un conjunto
    // razonable por defecto.
    const clave = contexto.estrategia?.metricas_clave?.length
      ? contexto.estrategia.metricas_clave
      : ['meta_spend', 'meta_leads', 'meta_cpl', 'meta_ctr', 'meta_clicks'];

    const noAplican = new Set(contexto.estrategia?.metricas_na ?? []);

    const metricas: Record<string, unknown> = {};
    for (const k of clave) {
      if (noAplican.has(k)) continue;
      const a = Number(actual.totals[k] ?? 0);
      const p = Number(previo.totals[k] ?? 0);
      const meta = evaluateGoal(k.replace(/^meta_/, ''), a, contexto.metas);
      metricas[k] = {
        actual: a,
        previo: p,
        cambio_pct: p > 0 ? ((a - p) / p) * 100 : null,
        meta: meta ? { objetivo: meta.target, estado: meta.status } : null,
      };
    }

    const avisos = [...actual.warnings];

    if (!contexto.perfil.configurado) {
      avisos.push(
        'Este cliente no tiene perfil configurado. El contexto se ha deducido de sus integraciones, así que conviene ser prudente al interpretar.'
      );
    }
    if (input.tab_id && !contexto.estrategia) {
      avisos.push(
        'Esta pestaña no tiene tipo de estrategia asignado: no se sabe qué métricas son las relevantes ni hasta dónde llega su medición.'
      );
    }
    if (contexto.estrategia?.temporal && contexto.estrategia.fin) {
      avisos.push(
        `Es una estrategia con fecha de fin (${contexto.estrategia.fin}). La inversión se concentra y decae al acercarse el cierre: esa caída forma parte del plan.`
      );
    }
    if (Object.keys(contexto.metas).length === 0) {
      avisos.push(
        'No hay metas configuradas: se pueden describir las cifras, pero no decir si son buenas o malas.'
      );
    }

    return {
      cliente: contexto.cliente,
      periodo: {
        actual: { from: actual.rango.from, to: actual.rango.to, etiqueta: periodo.etiqueta },
        previo: { from: previo.rango.from, to: previo.rango.to },
      },
      contexto: {
        descripcion: contexto.perfil.descripcion,
        productos: contexto.perfil.productos,
        alcance_medicion: contexto.perfil.alcance_medicion,
        fuentes_activas: contexto.perfil.fuentes_activas,
        // Estas dos listas son la diferencia entre un análisis útil y uno que
        // reporta como problema el diseño de la cuenta.
        fuentes_ausentes: contexto.perfil.fuentes_ausentes,
        instrucciones_del_equipo: contexto.perfil.instrucciones,
        feedback_acumulado: contexto.feedback,
      },
      estrategia: contexto.estrategia,
      metas: contexto.metas,
      metricas,
      no_aplican: [...noAplican],
      dias_con_datos: actual.rows.length,
      avisos,
    };
  },
};

const dailyTrafficReport: AnyAgentTool = {
  name: 'daily_traffic_report',
  domain: 'analisis',
  description:
    'Dossier del día para todos los clientes activos (o para uno concreto): cifras de ayer, ' +
    'comparación con el día anterior y evaluación contra metas, con el contexto de cada cliente. ' +
    'Es la materia prima del reporte diario de tráfico.',
  input: z.object({
    client_id: z.string().uuid().optional().describe('Omítelo para incluir a todos los clientes.'),
    fecha: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('Día a reportar. Por defecto, ayer.'),
  }),
  scopes: ['read:metrics'],
  handler: async (input: { client_id?: string; fecha?: string }, ctx) => {
    const { colombiaYesterday } = await import('@/lib/date-utils');
    const dia = input.fecha ?? colombiaYesterday();

    let ids: string[];
    if (input.client_id) {
      exigirCliente(ctx, input.client_id);
      ids = [input.client_id];
    } else {
      let q = ctx.db.from('clientes').select('id');
      if (ctx.allowedClientIds !== 'all') q = q.in('id', ctx.allowedClientIds);
      const { data, error } = await q;
      if (error) {
        throw new ApiError(
          'DATABASE_ERROR',
          `No se pudieron listar los clientes: ${error.message}`,
          500
        );
      }
      ids = (data ?? []).map((c) => (c as { id: string }).id);
    }

    const informes = [];
    for (const id of ids) {
      try {
        const contexto = await construirContextoCliente(ctx, id);
        const hoy = await getMetricasCliente({ clienteId: id, from: dia, to: dia });
        const ayerFecha = new Date(new Date(dia + 'T00:00:00Z').getTime() - 86400000)
          .toISOString()
          .slice(0, 10);
        const ayer = await getMetricasCliente({
          clienteId: id,
          from: ayerFecha,
          to: ayerFecha,
        });

        const spend = Number(hoy.totals.meta_spend ?? 0);
        // Un cliente sin inversión ese día no aporta nada al reporte y solo
        // gasta espacio y atención.
        if (spend <= 0) continue;

        informes.push({
          cliente: contexto.cliente,
          fuentes_ausentes: contexto.perfil.fuentes_ausentes,
          instrucciones: contexto.perfil.instrucciones,
          metricas: {
            spend,
            leads: Number(hoy.totals.meta_leads ?? 0),
            cpl: hoy.totals.meta_cpl ?? null,
            ctr: hoy.totals.meta_ctr ?? null,
            spend_ayer: Number(ayer.totals.meta_spend ?? 0),
            leads_ayer: Number(ayer.totals.meta_leads ?? 0),
            cpl_ayer: ayer.totals.meta_cpl ?? null,
          },
          metas: contexto.metas,
          avisos: hoy.warnings,
        });
      } catch (e) {
        // Un cliente que falla no puede dejar sin reporte a los demás.
        informes.push({
          cliente: { id, nombre: '(no se pudo leer)' },
          error: e instanceof Error ? e.message : 'Error desconocido',
        });
      }
    }

    return { fecha: dia, clientes_con_actividad: informes.length, informes };
  },
};

export const toolsAnalisis: AnyAgentTool[] = [analyzePerformance, dailyTrafficReport];
