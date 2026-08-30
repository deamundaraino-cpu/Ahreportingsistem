import 'server-only';

/**
 * Propuestas de escritura pendientes de aprobación.
 *
 * El agente no ejecuta escrituras por su cuenta: las propone y una persona
 * autorizada las confirma. La comprobación de quién puede aprobar vive en el
 * servidor y no en el prompt, porque un prompt se puede convencer.
 *
 * Regla que no se negocia: nadie aprueba su propia propuesta. Así la escritura
 * siempre pasa por dos personas.
 */

import { ApiError } from '@/lib/error-handler';
import { getTool } from './registry';
import { nivelAlcanza, type AgentContext, type AnyAgentTool } from './types';

/** Horas que una propuesta sigue siendo válida. */
export const HORAS_VALIDEZ = 24;

export type EstadoPropuesta = 'pendiente' | 'aprobada' | 'rechazada' | 'ejecutada' | 'expirada';

export type Propuesta = {
  id: string;
  tool_name: string;
  input: Record<string, unknown>;
  summary: string;
  risk: 'low' | 'high';
  status: EstadoPropuesta;
  requested_by: string;
  approved_by: string | null;
  created_at: string;
  expires_at: string;
};

/** Guarda una propuesta y devuelve su identificador. */
export async function crearPropuesta(
  ctx: AgentContext,
  tool: AnyAgentTool,
  input: unknown
): Promise<string> {
  if (!tool.mutation) {
    throw new ApiError('INTERNAL_ERROR', `'${tool.name}' no es una herramienta de escritura.`, 500);
  }

  const expira = new Date(Date.now() + HORAS_VALIDEZ * 3600_000).toISOString();

  const { data, error } = await ctx.db
    .from('agent_action_approvals')
    .insert({
      tool_name: tool.name,
      input: input as Record<string, unknown>,
      summary: tool.mutation.summarize(input),
      risk: tool.mutation.risk,
      status: 'pendiente',
      requested_by: ctx.userId,
      conversation_id: ctx.conversationId,
      origin: ctx.origin,
      expires_at: expira,
    })
    .select('id')
    .single();

  if (error) {
    throw new ApiError(
      'DATABASE_ERROR',
      `No se pudo registrar la propuesta: ${error.message}`,
      500
    );
  }

  return (data as { id: string }).id;
}

/** Propuestas pendientes que este contexto puede ver. */
export async function listarPendientes(ctx: AgentContext): Promise<Propuesta[]> {
  const { data, error } = await ctx.db
    .from('agent_action_approvals')
    .select('*')
    .eq('status', 'pendiente')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    throw new ApiError(
      'DATABASE_ERROR',
      `No se pudieron leer las propuestas: ${error.message}`,
      500
    );
  }
  return (data ?? []) as Propuesta[];
}

/**
 * Aprueba y ejecuta una propuesta.
 *
 * Comprueba, en este orden: que existe, que sigue pendiente, que no ha
 * caducado, que quien aprueba no es quien la propuso, y que su nivel alcanza al
 * riesgo de la acción.
 */
export async function aprobarYEjecutar(
  ctx: AgentContext,
  propuestaId: string
): Promise<{ ok: boolean; resultado?: unknown; error?: string }> {
  const { data, error } = await ctx.db
    .from('agent_action_approvals')
    .select('*')
    .eq('id', propuestaId)
    .maybeSingle();

  if (error) {
    throw new ApiError('DATABASE_ERROR', `No se pudo leer la propuesta: ${error.message}`, 500);
  }
  const p = data as Propuesta | null;
  if (!p) throw new ApiError('NOT_FOUND', `No existe la propuesta ${propuestaId}.`, 404);

  if (p.status !== 'pendiente') {
    throw new ApiError('VALIDATION_ERROR', `La propuesta ya está ${p.status}.`, 400);
  }
  if (new Date(p.expires_at) < new Date()) {
    await ctx.db.from('agent_action_approvals').update({ status: 'expirada' }).eq('id', p.id);
    throw new ApiError('VALIDATION_ERROR', 'La propuesta ha caducado.', 400);
  }

  // Dos personas: quien pide y quien aprueba.
  if (p.requested_by === ctx.userId) {
    throw new ApiError('UNAUTHORIZED', 'No se puede aprobar la propia propuesta.', 403);
  }

  const minimo = p.risk === 'high' ? 'admin' : 'aprobador';
  if (!nivelAlcanza(ctx.level, minimo)) {
    throw new ApiError(
      'UNAUTHORIZED',
      `Aprobar esta acción requiere nivel '${minimo}' y este contacto es '${ctx.level}'.`,
      403
    );
  }

  const tool = getTool(p.tool_name);
  if (!tool) {
    throw new ApiError('NOT_FOUND', `La herramienta '${p.tool_name}' ya no existe.`, 404);
  }

  // Se marca aprobada ANTES de ejecutar: si la ejecución falla, queda constancia
  // de que se autorizó y de que el fallo fue posterior.
  await ctx.db
    .from('agent_action_approvals')
    .update({ status: 'aprobada', approved_by: ctx.userId, approved_at: new Date().toISOString() })
    .eq('id', p.id);

  // La accion se ejecuta con la identidad de QUIEN LA PIDIO, no de quien la
  // aprueba. Aprobar es autorizar, no firmar: si el handler guarda un autor,
  // debe quedar el del proponente. Los permisos ya se comprobaron arriba con
  // los del aprobador, que es donde tienen sentido.
  const ctxEjecucion: AgentContext = { ...ctx, userId: p.requested_by };

  try {
    const resultado = await tool.handler(p.input, ctxEjecucion);
    await ctx.db
      .from('agent_action_approvals')
      .update({
        status: 'ejecutada',
        result: resultado as Record<string, unknown>,
        executed_at: new Date().toISOString(),
      })
      .eq('id', p.id);
    return { ok: true, resultado };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Error desconocido';
    await ctx.db.from('agent_action_approvals').update({ error: message }).eq('id', p.id);
    return { ok: false, error: message };
  }
}

export async function rechazar(ctx: AgentContext, propuestaId: string): Promise<void> {
  const { error } = await ctx.db
    .from('agent_action_approvals')
    .update({ status: 'rechazada', approved_by: ctx.userId })
    .eq('id', propuestaId)
    .eq('status', 'pendiente');

  if (error) {
    throw new ApiError('DATABASE_ERROR', `No se pudo rechazar: ${error.message}`, 500);
  }
}
