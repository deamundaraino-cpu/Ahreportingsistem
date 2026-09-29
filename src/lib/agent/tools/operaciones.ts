import 'server-only';

/**
 * Operaciones del día a día: tareas del roadmap, bitácoras de cliente, reglas
 * de alerta y sincronización bajo demanda.
 *
 * Todas las escrituras pasan por aprobación salvo `sync_client`: refrescar los
 * datos de un cliente desde sus plataformas no cambia nada que la siguiente
 * sincronización no vuelva a traer, y esperar a que alguien lo apruebe por
 * WhatsApp dejaba al agente contestando con cifras viejas. Ninguna es de riesgo
 * alto salvo el borrado, que sencillamente no existe: el agente no borra nada.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import type { AgentContext, AnyAgentTool } from '../types';
import type { SyncJobTipo } from '@/lib/sync/queue';
import {
  CANALES_SYNC,
  ETIQUETA_CANAL,
  MAX_DIAS_SYNC_AGENTE,
  MINUTOS_FRENO,
  TIPOS_DE_CANAL,
  canalesDeCliente,
  diasDeRango,
  encolarSyncCliente,
  frenoSync,
  leerContextoSync,
  planSyncCliente,
  type CanalSync,
  type ContextoSync,
  type EstadoCanal,
} from '@/lib/sync/cliente';
import { colombiaToday } from '@/lib/date-utils';
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
    } else {
      // Sin cliente se devolvían las reglas de TODOS: ahora, las de los clientes
      // visibles y las globales (sin cliente).
      const ids = idsVisibles(ctx);
      if (ids) {
        q = ids.length
          ? q.or(`cliente_id.is.null,cliente_id.in.(${ids.join(',')})`)
          : q.is('cliente_id', null);
      }
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

const canalesSchema = z
  .array(z.enum(CANALES_SYNC))
  .min(1)
  .optional()
  .describe(
    'Solo estos canales (por defecto, todos los conectados): metricas, sheets, ga4, hotmart, ' +
      'meta_leads, ghl, tiktok_leads.'
  );
const fechaSync = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Fecha YYYY-MM-DD (zona Colombia).');

const NOTA_ASINCRONA =
  'No es tiempo real: los trabajos entran en la cola y el worker los procesa en unos minutos. ' +
  'Consulta el avance con get_sync_status (client_id) antes de dar las cifras por actualizadas.';

/** Canal al que pertenece un tipo de job, para agrupar el estado por canal. */
const CANAL_DE_TIPO = new Map<string, CanalSync>(
  (Object.entries(TIPOS_DE_CANAL) as Array<[CanalSync, string[]]>).flatMap(([canal, tipos]) =>
    tipos.map((t) => [t, canal] as const)
  )
);

/**
 * Despierta al ejecutor de respaldo para no esperar al siguiente poll del VPS,
 * como hace el botón del dashboard. Nunca bloquea ni falla la herramienta.
 */
async function avisarWorker(): Promise<boolean> {
  if (!process.env.CRON_SECRET) return false;
  try {
    const { internalCronFetch } = await import('@/lib/internal-fetch');
    const empujar = () =>
      internalCronFetch('/api/worker/run-jobs', { method: 'POST' }).then(
        () => undefined,
        () => undefined
      );
    try {
      // Dentro de una petición, `after` deja terminar el empujón tras responder.
      const { after } = await import('next/server');
      after(empujar);
    } catch {
      void empujar();
    }
    return true;
  } catch {
    return false;
  }
}

/** Contexto del cliente, o NOT_FOUND. Comprueba antes el acceso. */
async function contextoDeSync(ctx: AgentContext, clientId: string): Promise<ContextoSync> {
  exigirCliente(ctx, clientId);
  const c = await leerContextoSync(ctx.db, clientId);
  if (!c) throw new ApiError('NOT_FOUND', `No se encuentra el cliente ${clientId}.`, 404);
  return c;
}

/** Canales pedidos y conectados; si no queda ninguno, lo explica. */
function canalesUtiles(estados: EstadoCanal[], pedidos?: CanalSync[]): EstadoCanal[] {
  const elegidos = pedidos?.length ? estados.filter((e) => pedidos.includes(e.canal)) : estados;
  const conectados = elegidos.filter((e) => e.conectado);
  if (conectados.length === 0) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'No hay nada que sincronizar: ' +
        elegidos.map((e) => `${e.canal} (${e.detalle})`).join('; ') +
        '. Las integraciones se conectan desde el panel del cliente.',
      400
    );
  }
  return conectados;
}

function fichaCanales(estados: EstadoCanal[]) {
  return estados.map((e) => ({
    canal: e.canal,
    nombre: ETIQUETA_CANAL[e.canal],
    conectado: e.conectado,
    detalle: e.detalle,
  }));
}

const getSyncStatus: AnyAgentTool = {
  name: 'get_sync_status',
  domain: 'operaciones',
  description:
    'Estado de la sincronización de datos: trabajos en cola, en curso y con error. Útil cuando ' +
    'las cifras parecen desactualizadas — antes de interpretar una caída, conviene descartar que ' +
    'sea un problema de sincronización. Con `client_id` resume además el último trabajo de cada ' +
    'canal (`por_canal`), que es como se sigue una sync_client recién lanzada.',
  input: z.object({
    client_id: clienteIdSchema.optional(),
    solo_agente: z
      .boolean()
      .optional()
      .describe('Solo los trabajos lanzados desde el agente (sync_client / trigger_sync).'),
  }),
  scopes: ['read:metrics'],
  handler: async (input: { client_id?: string; solo_agente?: boolean }, ctx) => {
    if (input.client_id) exigirCliente(ctx, input.client_id);

    let q = ctx.db
      .from('sync_jobs')
      .select(
        'id, tipo, cliente_id, estado, intentos, last_error, fecha_inicio, fecha_fin, triggered_by, created_at, updated_at'
      )
      .order('created_at', { ascending: false })
      .limit(input.client_id ? 40 : 20);

    if (input.client_id) q = q.eq('cliente_id', input.client_id);
    else {
      // Sin cliente se veían los trabajos de todas las cuentas.
      const ids = idsVisibles(ctx);
      if (ids) {
        if (ids.length === 0) return { resumen: {}, jobs: [] };
        q = q.in('cliente_id', ids);
      }
    }
    if (input.solo_agente) q = q.eq('triggered_by', 'agente');

    const { data, error } = await q;
    if (error) {
      throw new ApiError('DATABASE_ERROR', `No se pudo leer el estado: ${error.message}`, 500);
    }

    const jobs = (data ?? []) as Array<{
      tipo: string;
      estado: string;
      last_error: string | null;
      created_at: string;
      updated_at: string;
    }>;
    const porEstado: Record<string, number> = {};
    for (const j of jobs) porEstado[j.estado] = (porEstado[j.estado] ?? 0) + 1;

    // El último job de cada canal (vienen ordenados del más reciente al más antiguo).
    const porCanal: Record<string, unknown> = {};
    if (input.client_id) {
      for (const j of jobs) {
        const canal = CANAL_DE_TIPO.get(j.tipo) ?? j.tipo;
        if (canal in porCanal) continue;
        porCanal[canal] = {
          tipo: j.tipo,
          estado: j.estado,
          actualizado: j.updated_at,
          ...(j.last_error ? { error: j.last_error } : {}),
        };
      }
    }

    return {
      resumen: porEstado,
      ...(input.client_id ? { por_canal: porCanal } : {}),
      jobs,
    };
  },
};

const syncClient: AnyAgentTool = {
  name: 'sync_client',
  domain: 'operaciones',
  description:
    'Sincroniza AHORA todos los canales conectados de un cliente con su ventana reciente: ' +
    'métricas de Meta/TikTok (ayer y hoy), Google Sheets, GA4, ventas de Hotmart y leads de Meta ' +
    'Lead Ads, GoHighLevel y TikTok. Úsala cuando pidan «sincroniza a X» o cuando las cifras ' +
    'parezcan desactualizadas. Se aplica al momento; no duplica si ya hay una sincronización en ' +
    `curso o se lanzó hace menos de ${MINUTOS_FRENO} minutos. Para un periodo concreto usa ` +
    'trigger_sync. No es tiempo real: sigue el avance con get_sync_status.',
  input: z.object({ client_id: clienteIdSchema, canales: canalesSchema }),
  scopes: ['write:sync'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    approval: 'directa',
    summarize: (i: { client_id: string; canales?: string[] }) =>
      `Sincronizar ${i.canales?.length ? i.canales.join(', ') : 'todos los canales'} del cliente ${i.client_id}`,
  },
  handler: async (input: { client_id: string; canales?: CanalSync[] }, ctx) => {
    const c = await contextoDeSync(ctx, input.client_id);
    const estados = canalesDeCliente(c);
    const utiles = canalesUtiles(estados, input.canales);

    // El freno: la instancia Micro no aguanta tormentas de sincronizaciones.
    const freno = await frenoSync(ctx.db, input.client_id);
    if (freno.recientesAgente.length > 0) {
      const ultimo = freno.recientesAgente[0];
      const minutos = Math.max(
        0,
        Math.round((Date.now() - Date.parse(ultimo.created_at)) / 60_000)
      );
      return {
        estado: 'reciente',
        nota:
          `Ya se lanzó una sincronización de este cliente hace ${minutos} min; no se repite hasta ` +
          `pasados ${MINUTOS_FRENO}. Su avance está abajo y en get_sync_status.`,
        jobs: freno.recientesAgente.map((j) => ({ tipo: j.tipo, estado: j.estado })),
        canales: fichaCanales(estados),
      };
    }

    const plan = planSyncCliente(c, utiles, {
      omitirTipos: freno.enCurso.map((j) => j.tipo as SyncJobTipo),
      triggeredBy: 'agente',
    });
    const res = await encolarSyncCliente(ctx.db, plan);
    const avisado = res.encolados.length > 0 ? await avisarWorker() : false;
    const enCurso = [...new Set(freno.enCurso.map((j) => j.tipo))];

    return {
      estado: res.encolados.length > 0 ? 'encolado' : 'ya_en_curso',
      canales: fichaCanales(estados),
      encolados: res.encolados,
      ...(enCurso.length || res.duplicados.length
        ? { ya_en_cola: [...new Set([...enCurso, ...res.duplicados.map((d) => d.tipo)])] }
        : {}),
      ...(res.errores.length ? { errores: res.errores } : {}),
      worker_avisado: avisado,
      nota: NOTA_ASINCRONA,
    };
  },
};

/** Valida el rango pedido a trigger_sync. Lanza con un mensaje que el modelo entiende. */
function exigirRango(desde: string, hasta: string): void {
  if (desde > hasta) throw new ApiError('VALIDATION_ERROR', '`desde` va después de `hasta`.', 400);
  if (desde > colombiaToday()) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'El rango empieza en el futuro: no hay nada que traer.',
      400
    );
  }
  const dias = diasDeRango(desde, hasta);
  if (dias > MAX_DIAS_SYNC_AGENTE) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Son ${dias} días; desde el agente se aceptan hasta ${MAX_DIAS_SYNC_AGENTE}. ` +
        'Para un histórico más largo usa el panel de sincronización.',
      400
    );
  }
}

const triggerSync: AnyAgentTool = {
  name: 'trigger_sync',
  domain: 'operaciones',
  description:
    'Vuelve a traer un PERIODO concreto (`desde`/`hasta`, hasta ' +
    `${MAX_DIAS_SYNC_AGENTE} días) de todos los canales conectados de un cliente, o de los que ` +
    'se indiquen: para rellenar un hueco o corregir días antiguos. Troceado en tramos, como el ' +
    'panel. Para refrescar lo reciente usa sync_client, que no necesita aprobación. Esta ' +
    'requiere aprobación de una persona antes de aplicarse.',
  input: z.object({
    client_id: clienteIdSchema,
    desde: fechaSync,
    hasta: fechaSync,
    canales: canalesSchema,
  }),
  scopes: ['write:sync'],
  minLevel: 'operador',
  mutation: {
    risk: 'low',
    summarize: (i: { client_id: string; desde: string; hasta: string; canales?: string[] }) =>
      `Sincronizar ${i.canales?.length ? i.canales.join(', ') : 'todos los canales'} del cliente ` +
      `${i.client_id} del ${i.desde} al ${i.hasta}`,
    // Lo comprobable se comprueba al PROPONER: rango, acceso y que haya algo
    // conectado. Si no, el modelo oía «pendiente» para algo que iba a fallar.
    precheck: async (
      i: { client_id: string; desde: string; hasta: string; canales?: CanalSync[] },
      ctx
    ) => {
      exigirRango(i.desde, i.hasta);
      const c = await contextoDeSync(ctx, i.client_id);
      canalesUtiles(canalesDeCliente(c), i.canales);
    },
  },
  handler: async (
    input: { client_id: string; desde: string; hasta: string; canales?: CanalSync[] },
    ctx
  ) => {
    exigirRango(input.desde, input.hasta);
    const c = await contextoDeSync(ctx, input.client_id);
    const estados = canalesDeCliente(c);
    const utiles = canalesUtiles(estados, input.canales);
    const plan = planSyncCliente(c, utiles, {
      rango: { desde: input.desde, hasta: input.hasta },
      triggeredBy: 'agente',
    });
    const res = await encolarSyncCliente(ctx.db, plan);
    const avisado = res.encolados.length > 0 ? await avisarWorker() : false;
    return {
      estado: res.encolados.length > 0 ? 'encolado' : 'ya_en_curso',
      canales: fichaCanales(estados),
      encolados: res.encolados,
      ...(res.duplicados.length ? { ya_en_cola: res.duplicados } : {}),
      ...(res.errores.length ? { errores: res.errores } : {}),
      worker_avisado: avisado,
      nota: NOTA_ASINCRONA,
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
  syncClient,
  triggerSync,
];
