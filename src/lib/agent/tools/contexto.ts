import 'server-only';

/**
 * Herramientas de contexto: el perfil del cliente, el tipo de estrategia de
 * cada pestaña, las metas y el feedback acumulado.
 *
 * Esta es la capa que evita el fallo que hacía inútil el análisis automático.
 * Sin ella, una lectura de las métricas de un cliente que solo capta leads
 * concluye que "faltan los datos de ventas y de Google Analytics" y que "es
 * imposible calcular el ROAS" — todo cierto y todo irrelevante, porque ese
 * cliente nunca tuvo esas fuentes.
 *
 * `metricas_na` (del tipo de estrategia) y `fuentes_ausentes` (del perfil) son
 * las dos listas que convierten "falta un dato" en "ese dato no aplica aquí".
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import { evaluateGoal, type ClienteGoals } from '@/lib/report-utm/bi-metadata';
import { flagsConexion } from '@/lib/cliente-seguro';
import type { AnyAgentTool } from '../types';
import { exigirCliente } from '../registry';

const clienteIdSchema = z.string().uuid().describe('UUID del cliente.');

export type EstrategiaTipo = {
  id: string;
  categoria: string;
  subcategoria: string;
  nombre: string;
  descripcion: string | null;
  alcance: 'hasta_lead' | 'hasta_venta';
  temporal: boolean;
  metricas_clave: string[];
  metricas_na: string[];
  guia: string | null;
  activo: boolean;
};

export type PerfilCliente = {
  cliente_id: string;
  descripcion: string | null;
  productos: string | null;
  alcance_medicion: string | null;
  fuentes_activas: string[];
  fuentes_ausentes: string[];
  instrucciones: string | null;
};

const listStrategyTypes: AnyAgentTool = {
  name: 'list_strategy_types',
  domain: 'contexto',
  description:
    'Catálogo de tipos de estrategia de la agencia (evergreen o lanzamiento, de captación o de ' +
    'infoproducto). Cada tipo dice hasta dónde llega su medición, qué métricas son las clave y ' +
    'cuáles NO aplican. Consúltalo antes de juzgar el rendimiento de una pestaña.',
  input: z.object({}),
  scopes: ['read:clients'],
  handler: async (_input, ctx) => {
    const { data, error } = await ctx.db
      .from('estrategia_tipos')
      .select('*')
      .eq('activo', true)
      .order('orden');

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer el catálogo: ${error.message}`, 500);
    }
    return { tipos: (data ?? []) as EstrategiaTipo[] };
  },
};

const getClientProfile: AnyAgentTool = {
  name: 'get_client_profile',
  domain: 'contexto',
  description:
    'Perfil de un cliente: qué hace, qué vende, hasta dónde llega su medición y qué fuentes de ' +
    'datos NO tiene. Consúltalo SIEMPRE antes de analizar. Lo que aparezca en `fuentes_ausentes` ' +
    'no debe reportarse como una carencia: es cómo está montado ese cliente a propósito.',
  input: z.object({ client_id: clienteIdSchema }),
  scopes: ['read:clients'],
  handler: async (input: { client_id: string }, ctx) => {
    exigirCliente(ctx, input.client_id);

    const [perfilRes, clienteRes, feedbackRes] = await Promise.all([
      ctx.db.from('cliente_perfiles').select('*').eq('cliente_id', input.client_id).maybeSingle(),
      ctx.db
        .from('clientes')
        .select('id, nombre, config_api')
        .eq('id', input.client_id)
        .maybeSingle(),
      ctx.db
        .from('agent_feedback')
        .select('texto, tab_id')
        .or(`cliente_id.eq.${input.client_id},cliente_id.is.null`)
        .eq('activo', true),
    ]);

    if (clienteRes.error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudo leer el cliente: ${clienteRes.error.message}`,
        500
      );
    }
    if (!clienteRes.data) {
      throw new ApiError('NOT_FOUND', `No se encuentra el cliente ${input.client_id}.`, 404);
    }

    const perfil = perfilRes.data as PerfilCliente | null;
    // Las integraciones reales son la red de seguridad cuando el perfil aún no
    // se ha rellenado: al menos no se inventará fuentes que no existen.
    const conexiones = flagsConexion(clienteRes.data.config_api);
    const detectadasAusentes = Object.entries(conexiones)
      .filter(([, v]) => !v)
      .map(([k]) => k);

    return {
      client: { id: clienteRes.data.id, name: clienteRes.data.nombre },
      perfil_configurado: perfil !== null,
      descripcion: perfil?.descripcion ?? null,
      productos: perfil?.productos ?? null,
      alcance_medicion: perfil?.alcance_medicion ?? null,
      fuentes_activas: perfil?.fuentes_activas?.length
        ? perfil.fuentes_activas
        : Object.entries(conexiones)
            .filter(([, v]) => v)
            .map(([k]) => k),
      fuentes_ausentes: perfil?.fuentes_ausentes?.length
        ? perfil.fuentes_ausentes
        : detectadasAusentes,
      instrucciones: perfil?.instrucciones ?? null,
      feedback: (feedbackRes.data ?? []).map((f) => (f as { texto: string }).texto),
      aviso: perfil
        ? null
        : 'Este cliente no tiene perfil configurado: las fuentes se han deducido de sus integraciones. Dilo si el análisis depende de ese contexto.',
    };
  },
};

const getTabStrategy: AnyAgentTool = {
  name: 'get_tab_strategy',
  domain: 'contexto',
  description:
    'Qué estrategia lleva una pestaña: su tipo, si tiene fecha de fin, qué métricas son las ' +
    'clave, cuáles no aplican y cómo se interpreta. Úsala antes de valorar si una pestaña va ' +
    'bien o mal — una caída de inversión al final de un lanzamiento es el plan, no un problema.',
  input: z.object({
    client_id: clienteIdSchema,
    tab_id: z.string().uuid().describe('UUID de la pestaña, de get_tabs.'),
  }),
  scopes: ['read:clients'],
  handler: async (input: { client_id: string; tab_id: string }, ctx) => {
    exigirCliente(ctx, input.client_id);

    const { data: tab, error } = await ctx.db
      .from('cliente_tabs')
      .select(
        'id, nombre, estrategia_tipo_id, metas, fecha_inicio, fecha_finalizacion, presupuesto_objetivo'
      )
      .eq('id', input.tab_id)
      .eq('cliente_id', input.client_id)
      .maybeSingle();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer la pestaña: ${error.message}`, 500);
    }
    if (!tab) {
      throw new ApiError('NOT_FOUND', `La pestaña ${input.tab_id} no es de este cliente.`, 404);
    }

    let tipo: EstrategiaTipo | null = null;
    if (tab.estrategia_tipo_id) {
      const { data } = await ctx.db
        .from('estrategia_tipos')
        .select('*')
        .eq('id', tab.estrategia_tipo_id)
        .maybeSingle();
      tipo = (data as EstrategiaTipo) ?? null;
    }

    return {
      tab: { id: tab.id, nombre: tab.nombre },
      estrategia: tipo
        ? {
            nombre: tipo.nombre,
            categoria: tipo.categoria,
            subcategoria: tipo.subcategoria,
            alcance: tipo.alcance,
            temporal: tipo.temporal,
            metricas_clave: tipo.metricas_clave,
            metricas_na: tipo.metricas_na,
            guia: tipo.guia,
          }
        : null,
      periodo: {
        inicio: tab.fecha_inicio,
        fin: tab.fecha_finalizacion,
      },
      presupuesto_objetivo: tab.presupuesto_objetivo,
      aviso: tipo
        ? null
        : 'Esta pestaña no tiene tipo de estrategia asignado, así que no se sabe qué métricas son las relevantes ni hasta dónde llega su medición. Interprétala con cautela y sugiere configurarla.',
    };
  },
};

const getResolvedGoals: AnyAgentTool = {
  name: 'get_resolved_goals',
  domain: 'contexto',
  description:
    'Metas aplicables a una pestaña, resueltas en cascada: primero las suyas, si no las del ' +
    'cliente. Si pasas valores medidos, devuelve además si cada uno cumple, con el mismo ' +
    'criterio y la misma tolerancia que los semáforos de la interfaz.',
  input: z.object({
    client_id: clienteIdSchema,
    tab_id: z.string().uuid().optional(),
    medidos: z
      .record(z.string(), z.number())
      .optional()
      .describe('Opcional: { cpl: 2500, roas: 1.8 } para evaluar contra las metas.'),
  }),
  scopes: ['read:metrics'],
  handler: async (
    input: { client_id: string; tab_id?: string; medidos?: Record<string, number> },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    let metasTab: ClienteGoals = {};
    let presupuestoTab: number | null = null;

    if (input.tab_id) {
      const { data } = await ctx.db
        .from('cliente_tabs')
        .select('metas, presupuesto_objetivo')
        .eq('id', input.tab_id)
        .eq('cliente_id', input.client_id)
        .maybeSingle();
      metasTab = ((data?.metas ?? {}) as ClienteGoals) || {};
      presupuestoTab = (data?.presupuesto_objetivo as number | null) ?? null;
    }

    // Las del cliente viven en `report_utm.clientes.config.goals`, enlazadas por
    // `public_cliente_id`.
    let metasCliente: ClienteGoals = {};
    const { data: rtm } = await ctx.db
      .schema('report_utm')
      .from('clientes')
      .select('config')
      .eq('public_cliente_id', input.client_id)
      .maybeSingle();
    if (rtm?.config && typeof rtm.config === 'object') {
      metasCliente = ((rtm.config as Record<string, unknown>).goals ?? {}) as ClienteGoals;
    }

    // Cascada: la pestaña gana. `presupuesto_objetivo` es la columna que ya
    // existía y cumple el papel de `budget`, así que no se duplica.
    const efectivas: ClienteGoals = {
      ...metasCliente,
      ...metasTab,
      ...(presupuestoTab ? { budget: presupuestoTab } : {}),
    };

    const evaluacion: Record<string, unknown> = {};
    for (const [metrica, valor] of Object.entries(input.medidos ?? {})) {
      const r = evaluateGoal(metrica, valor, efectivas);
      if (r) {
        evaluacion[metrica] = {
          valor,
          objetivo: r.target,
          estado: r.status,
          no_debe_superar: r.mustNotExceed,
        };
      }
    }

    return {
      metas: efectivas,
      origen: {
        pestana: Object.keys(metasTab).length > 0 || presupuestoTab !== null,
        cliente: Object.keys(metasCliente).length > 0,
      },
      evaluacion: input.medidos ? evaluacion : undefined,
      aviso:
        Object.keys(efectivas).length === 0
          ? 'No hay metas configuradas para esta pestaña ni para este cliente: no se puede decir si una cifra es buena o mala, solo describirla.'
          : null,
    };
  },
};

const upsertClientProfile: AnyAgentTool = {
  name: 'upsert_client_profile',
  domain: 'contexto',
  description:
    'Crea o actualiza el perfil de un cliente. Solo se modifican los campos que se envían. ' +
    'Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: clienteIdSchema,
    descripcion: z.string().optional(),
    productos: z.string().optional(),
    alcance_medicion: z.string().optional(),
    fuentes_activas: z.array(z.string()).optional(),
    fuentes_ausentes: z.array(z.string()).optional(),
    instrucciones: z.string().optional(),
  }),
  scopes: ['write:context'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { client_id: string }) => `Actualizar el perfil del cliente ${i.client_id}`,
  },
  handler: async (input: { client_id: string } & Record<string, unknown>, ctx) => {
    exigirCliente(ctx, input.client_id);

    const parche: Record<string, unknown> = { cliente_id: input.client_id };
    for (const k of [
      'descripcion',
      'productos',
      'alcance_medicion',
      'fuentes_activas',
      'fuentes_ausentes',
      'instrucciones',
    ]) {
      if (input[k] !== undefined) parche[k] = input[k];
    }
    parche.updated_at = new Date().toISOString();
    parche.actualizado_por = ctx.userId;

    const { data, error } = await ctx.db
      .from('cliente_perfiles')
      .upsert(parche, { onConflict: 'cliente_id' })
      .select()
      .single();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo guardar el perfil: ${error.message}`, 500);
    }
    return { perfil: data };
  },
};

const setTabStrategy: AnyAgentTool = {
  name: 'set_tab_strategy',
  domain: 'contexto',
  description:
    'Asigna un tipo de estrategia a una pestaña, y opcionalmente sus metas. ' +
    'Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: clienteIdSchema,
    tab_id: z.string().uuid(),
    estrategia_tipo_id: z.string().uuid().describe('Id del tipo, de list_strategy_types.'),
    metas: z
      .object({
        cpl_max: z.number().optional(),
        cpa_max: z.number().optional(),
        roas_min: z.number().optional(),
        leads_target: z.number().optional(),
      })
      .optional(),
  }),
  scopes: ['write:context'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { tab_id: string }) => `Asignar tipo de estrategia a la pestaña ${i.tab_id}`,
  },
  handler: async (
    input: {
      client_id: string;
      tab_id: string;
      estrategia_tipo_id: string;
      metas?: Record<string, number>;
    },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const parche: Record<string, unknown> = {
      estrategia_tipo_id: input.estrategia_tipo_id,
      updated_at: new Date().toISOString(),
    };
    if (input.metas) parche.metas = input.metas;

    const { data, error } = await ctx.db
      .from('cliente_tabs')
      .update(parche)
      .eq('id', input.tab_id)
      .eq('cliente_id', input.client_id)
      .select('id, nombre, estrategia_tipo_id, metas')
      .single();

    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudo actualizar la pestaña: ${error.message}`,
        500
      );
    }
    return { tab: data };
  },
};

const recordFeedback: AnyAgentTool = {
  name: 'record_feedback',
  domain: 'contexto',
  description:
    'Guarda una corrección para futuros análisis ("no comentes la ausencia de GA4 en este ' +
    'cliente"). Se inyecta con el perfil en cada consulta posterior. ' +
    'Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: clienteIdSchema
      .optional()
      .describe('Omítelo para que aplique a todos los clientes.'),
    tab_id: z.string().uuid().optional(),
    texto: z.string().min(5).describe('La corrección, en una frase.'),
  }),
  scopes: ['write:context'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { texto: string }) => `Registrar aprendizaje: "${i.texto}"`,
  },
  handler: async (input: { client_id?: string; tab_id?: string; texto: string }, ctx) => {
    if (input.client_id) exigirCliente(ctx, input.client_id);

    const { data, error } = await ctx.db
      .from('agent_feedback')
      .insert({
        cliente_id: input.client_id ?? null,
        tab_id: input.tab_id ?? null,
        texto: input.texto,
        autor: ctx.userId,
      })
      .select()
      .single();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo guardar el feedback: ${error.message}`, 500);
    }
    return { feedback: data };
  },
};

export const toolsContexto: AnyAgentTool[] = [
  listStrategyTypes,
  getClientProfile,
  getTabStrategy,
  getResolvedGoals,
  upsertClientProfile,
  setTabStrategy,
  recordFeedback,
];
