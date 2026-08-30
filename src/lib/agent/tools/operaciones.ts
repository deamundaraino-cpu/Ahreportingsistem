import 'server-only';

/**
 * Operaciones del día a día: tareas del roadmap, bitácoras de cliente, reglas
 * de alerta y sincronización bajo demanda.
 *
 * Todas las escrituras pasan por aprobación. Ninguna es de riesgo alto salvo el
 * borrado, que sencillamente no existe: el agente no borra nada.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import type { AnyAgentTool } from '../types';
import { exigirCliente, idsVisibles } from '../registry';

const clienteIdSchema = z.string().uuid().describe('UUID del cliente.');

// ── Tareas (roadmap / soporte) ──────────────────────────────────────────────

const TIPOS = ['bug', 'feature', 'mejora', 'tarea'] as const;
const PRIORIDADES = ['baja', 'media', 'alta'] as const;

const listTasks: AnyAgentTool = {
  name: 'list_tasks',
  domain: 'operaciones',
  description:
    'Tareas y elementos del roadmap: incidencias, mejoras y peticiones. Se puede filtrar por ' +
    'cliente y por estado.',
  input: z.object({
    client_id: clienteIdSchema.optional(),
    estado: z.string().optional().describe('Filtra por estado exacto.'),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  scopes: ['read:clients'],
  handler: async (input: { client_id?: string; estado?: string; limit?: number }, ctx) => {
    let q = ctx.db
      .from('soporte_tickets')
      .select(
        'id, id_ticket_display, cliente_id, tipo, requerimiento, observaciones, responsable, prioridad, estado, fecha_solicitud, fecha_entrega'
      )
      .order('fecha_solicitud', { ascending: false })
      .limit(input.limit ?? 30);

    if (input.client_id) {
      exigirCliente(ctx, input.client_id);
      q = q.eq('cliente_id', input.client_id);
    } else {
      const ids = idsVisibles(ctx);
      if (ids) {
        if (ids.length === 0) return { tasks: [] };
        q = q.in('cliente_id', ids);
      }
    }
    if (input.estado) q = q.eq('estado', input.estado);

    const { data, error } = await q;
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudieron leer las tareas: ${error.message}`, 500);
    }
    return { tasks: data ?? [] };
  },
};

const createTask: AnyAgentTool = {
  name: 'create_task',
  domain: 'operaciones',
  description:
    'Crea una tarea o incidencia en el roadmap. Requiere aprobación de una persona antes de ' +
    'aplicarse.',
  input: z.object({
    client_id: clienteIdSchema,
    tipo: z.enum(TIPOS).describe('bug, feature, mejora o tarea.'),
    requerimiento: z.string().min(5).describe('Qué hay que hacer.'),
    observaciones: z.string().optional(),
    responsable: z.string().optional(),
    prioridad: z.enum(PRIORIDADES).optional(),
    nombre_solicitante: z.string().optional(),
  }),
  scopes: ['write:tasks'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { tipo: string; requerimiento: string }) =>
      `Crear ${i.tipo}: "${i.requerimiento.slice(0, 90)}"`,
  },
  handler: async (
    input: {
      client_id: string;
      tipo: string;
      requerimiento: string;
      observaciones?: string;
      responsable?: string;
      prioridad?: string;
      nombre_solicitante?: string;
    },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const { data, error } = await ctx.db
      .from('soporte_tickets')
      .insert({
        cliente_id: input.client_id,
        tipo: input.tipo,
        requerimiento: input.requerimiento,
        observaciones: input.observaciones ?? null,
        responsable: input.responsable ?? null,
        prioridad: input.prioridad ?? 'media',
        estado: 'pendiente',
        nombre_solicitante: input.nombre_solicitante ?? 'Agente',
        fecha_solicitud: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo crear la tarea: ${error.message}`, 500);
    }
    return { task: data };
  },
};

const updateTask: AnyAgentTool = {
  name: 'update_task',
  domain: 'operaciones',
  description:
    'Actualiza el estado, la prioridad, el responsable o las observaciones de una tarea. ' +
    'Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    task_id: z.string().uuid(),
    estado: z.string().optional(),
    prioridad: z.enum(PRIORIDADES).optional(),
    responsable: z.string().optional(),
    observaciones: z.string().optional(),
    fecha_entrega: z.string().optional(),
  }),
  scopes: ['write:tasks'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { task_id: string; estado?: string }) =>
      `Actualizar la tarea ${i.task_id}${i.estado ? ` a estado "${i.estado}"` : ''}`,
  },
  handler: async (input: { task_id: string } & Record<string, unknown>, ctx) => {
    // La tarea tiene que ser de un cliente que este contexto puede ver.
    const { data: tarea } = await ctx.db
      .from('soporte_tickets')
      .select('cliente_id')
      .eq('id', input.task_id)
      .maybeSingle();

    if (!tarea) {
      throw new ApiError('NOT_FOUND', `No existe la tarea ${input.task_id}.`, 404);
    }
    if (tarea.cliente_id) exigirCliente(ctx, tarea.cliente_id as string);

    const parche: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of ['estado', 'prioridad', 'responsable', 'observaciones', 'fecha_entrega']) {
      if (input[k] !== undefined) parche[k] = input[k];
    }

    const { data, error } = await ctx.db
      .from('soporte_tickets')
      .update(parche)
      .eq('id', input.task_id)
      .select()
      .single();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo actualizar la tarea: ${error.message}`, 500);
    }
    return { task: data };
  },
};

// ── Bitácoras ───────────────────────────────────────────────────────────────

const VISIBILIDADES = ['privado', 'trafficker', 'publico'] as const;

const listClientLogs: AnyAgentTool = {
  name: 'list_client_logs',
  domain: 'operaciones',
  description:
    'Bitácoras de un cliente: las notas que el equipo va dejando sobre lo que se hace en la ' +
    'cuenta. Buen sitio para entender por qué cambió algo antes de sacar conclusiones de una ' +
    'variación en las cifras.',
  input: z.object({
    client_id: clienteIdSchema,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  scopes: ['read:clients'],
  handler: async (input: { client_id: string; limit?: number }, ctx) => {
    exigirCliente(ctx, input.client_id);

    const { data, error } = await ctx.db
      .from('bitacoras')
      .select('id, titulo, contenido, visibilidad, author_name, created_at')
      .eq('cliente_id', input.client_id)
      .order('created_at', { ascending: false })
      .limit(input.limit ?? 15);

    if (error) {
      throw new ApiError(
        'DATABASE_ERROR',
        `No se pudieron leer las bitácoras: ${error.message}`,
        500
      );
    }
    return { logs: data ?? [] };
  },
};

const createClientLog: AnyAgentTool = {
  name: 'create_client_log',
  domain: 'operaciones',
  description:
    'Escribe una bitácora en la ficha de un cliente. Ojo con `visibilidad`: "publico" se ve en ' +
    'el informe compartido con el cliente. Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: clienteIdSchema,
    titulo: z.string().min(3),
    contenido: z.string().min(5),
    visibilidad: z
      .enum(VISIBILIDADES)
      .optional()
      .describe('Por defecto "trafficker" (interno). "publico" lo ve el cliente.'),
  }),
  scopes: ['write:logs'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { titulo: string; visibilidad?: string }) =>
      `Escribir bitácora "${i.titulo}" (visibilidad: ${i.visibilidad ?? 'trafficker'})`,
  },
  handler: async (
    input: { client_id: string; titulo: string; contenido: string; visibilidad?: string },
    ctx
  ) => {
    exigirCliente(ctx, input.client_id);

    const { data, error } = await ctx.db
      .from('bitacoras')
      .insert({
        cliente_id: input.client_id,
        titulo: input.titulo,
        contenido: input.contenido,
        // El valor por defecto es el interno: publicar de más ante la duda es
        // peor que quedarse corto.
        visibilidad: input.visibilidad ?? 'trafficker',
        author_id: ctx.userId,
        author_name: 'Agente',
      })
      .select()
      .single();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo crear la bitácora: ${error.message}`, 500);
    }
    return { log: data };
  },
};

// ── Reglas de alerta ────────────────────────────────────────────────────────

const listAlertRules: AnyAgentTool = {
  name: 'list_alert_rules',
  domain: 'operaciones',
  description:
    'Reglas de alerta configuradas: qué métrica se vigila, con qué umbral y por qué canal avisa.',
  input: z.object({ client_id: clienteIdSchema.optional() }),
  scopes: ['read:clients'],
  handler: async (input: { client_id?: string }, ctx) => {
    let q = ctx.db
      .from('notification_rules')
      .select(
        'id, cliente_id, tab_id, nombre, metric, operator, value, time_window, channels, enabled, cooldown_hours'
      )
      .order('nombre');

    if (input.client_id) {
      exigirCliente(ctx, input.client_id);
      q = q.eq('cliente_id', input.client_id);
    }

    const { data, error } = await q;
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudieron leer las reglas: ${error.message}`, 500);
    }
    return { rules: data ?? [] };
  },
};

const METRICAS_REGLA = ['budget_percentage', 'roas', 'cpl', 'spend', 'revenue', 'leads'] as const;
const OPERADORES = ['>', '<', '>=', '<='] as const;
const VENTANAS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'current_tab_period',
] as const;

const createAlertRule: AnyAgentTool = {
  name: 'create_alert_rule',
  domain: 'operaciones',
  description: 'Crea una regla de alerta. Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: clienteIdSchema
      .optional()
      .describe('Omítelo para que aplique a todos los clientes.'),
    nombre: z.string().min(3),
    metric: z.enum(METRICAS_REGLA),
    operator: z.enum(OPERADORES),
    value: z.number(),
    time_window: z.enum(VENTANAS).optional(),
    channels: z.array(z.enum(['in_app', 'whatsapp'])).optional(),
    cooldown_hours: z.number().int().min(1).max(168).optional(),
  }),
  scopes: ['write:tasks'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { nombre: string; metric: string; operator: string; value: number }) =>
      `Crear alerta "${i.nombre}": avisar cuando ${i.metric} ${i.operator} ${i.value}`,
  },
  handler: async (
    input: {
      client_id?: string;
      nombre: string;
      metric: string;
      operator: string;
      value: number;
      time_window?: string;
      channels?: string[];
      cooldown_hours?: number;
    },
    ctx
  ) => {
    if (input.client_id) exigirCliente(ctx, input.client_id);

    const { data, error } = await ctx.db
      .from('notification_rules')
      .insert({
        cliente_id: input.client_id ?? null,
        nombre: input.nombre,
        metric: input.metric,
        operator: input.operator,
        value: input.value,
        time_window: input.time_window ?? 'today',
        channels: input.channels ?? ['in_app'],
        cooldown_hours: input.cooldown_hours ?? 24,
        enabled: true,
      })
      .select()
      .single();

    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo crear la regla: ${error.message}`, 500);
    }
    return { rule: data };
  },
};

// ── Sincronización ──────────────────────────────────────────────────────────

const getSyncStatus: AnyAgentTool = {
  name: 'get_sync_status',
  domain: 'operaciones',
  description:
    'Estado de la sincronización de datos: trabajos en cola, en curso y con error. Útil cuando ' +
    'las cifras parecen desactualizadas — antes de interpretar una caída, conviene descartar que ' +
    'sea un problema de sincronización.',
  input: z.object({ client_id: clienteIdSchema.optional() }),
  scopes: ['read:metrics'],
  handler: async (input: { client_id?: string }, ctx) => {
    if (input.client_id) exigirCliente(ctx, input.client_id);

    let q = ctx.db
      .from('sync_jobs')
      .select('id, tipo, cliente_id, estado, intentos, last_error, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(20);

    if (input.client_id) q = q.eq('cliente_id', input.client_id);

    const { data, error } = await q;
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer el estado: ${error.message}`, 500);
    }

    const jobs = (data ?? []) as { estado: string }[];
    const porEstado: Record<string, number> = {};
    for (const j of jobs) porEstado[j.estado] = (porEstado[j.estado] ?? 0) + 1;

    return { resumen: porEstado, jobs: data ?? [] };
  },
};

const triggerSync: AnyAgentTool = {
  name: 'trigger_sync',
  domain: 'operaciones',
  description:
    'Encola una sincronización de datos para un cliente. NO es tiempo real: pone el trabajo en ' +
    'la cola y el worker lo procesa, así que los datos pasan a ser de hace un minuto en vez de ' +
    'hace unas horas. Requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: clienteIdSchema,
    desde: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    hasta: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  }),
  scopes: ['write:sync'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { client_id: string }) => `Sincronizar los datos del cliente ${i.client_id}`,
  },
  handler: async (input: { client_id: string; desde?: string; hasta?: string }, ctx) => {
    exigirCliente(ctx, input.client_id);

    const { enqueueJob } = await import('@/lib/sync/queue');
    const { colombiaToday, colombiaYesterday } = await import('@/lib/date-utils');

    const job = await enqueueJob(ctx.db, {
      tipo: 'metricas',
      clienteId: input.client_id,
      start: input.desde ?? colombiaYesterday(),
      end: input.hasta ?? colombiaToday(),
      prioridad: 1,
      triggeredBy: 'agente',
    });

    return {
      encolado: job !== null,
      job_id: job?.id ?? null,
      // Un duplicado no es un error: significa que ya había una sincronización
      // pendiente para ese mismo rango.
      nota: job
        ? 'Sincronización encolada. Tardará un momento en reflejarse.'
        : 'Ya había una sincronización pendiente para ese rango; no se ha duplicado.',
    };
  },
};

export const toolsOperaciones: AnyAgentTool[] = [
  listTasks,
  createTask,
  updateTask,
  listClientLogs,
  createClientLog,
  listAlertRules,
  createAlertRule,
  getSyncStatus,
  triggerSync,
];
