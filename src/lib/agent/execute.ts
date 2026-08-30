import 'server-only';

/**
 * Ejecución de una herramienta: autorizar, validar, ejecutar y auditar.
 *
 * Es el único camino de entrada. Que el control de permisos viva aquí y no en
 * cada handler es la diferencia entre "todos los handlers lo comprueban" y
 * "alguno se olvidó".
 */

import { ApiError, logger } from '@/lib/error-handler';
import { autorizar, getTool } from './registry';
import type { AgentContext } from './types';

export type ResultadoEjecucion = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  /** Milisegundos que tardó, para poder ver qué herramientas son caras. */
  duracionMs: number;
  /** Propuesta pendiente de aprobación, si la herramienta era de escritura. */
  aprobacionId?: string;
};

/**
 * Registro de auditoría.
 *
 * Tolera que la tabla no exista todavía: la migración puede no estar aplicada y
 * eso no debe impedir que las herramientas funcionen. Nunca lanza — un fallo al
 * registrar no puede tumbar la operación que se estaba auditando.
 */
async function auditar(
  ctx: AgentContext,
  entrada: {
    tool: string;
    input: unknown;
    ok: boolean;
    error?: string;
    duracionMs: number;
  }
): Promise<void> {
  try {
    const { error } = await ctx.db.from('agent_audit_log').insert({
      tool_name: entrada.tool,
      input: entrada.input as Record<string, unknown>,
      ok: entrada.ok,
      error: entrada.error ?? null,
      duration_ms: entrada.duracionMs,
      origin: ctx.origin,
      user_id: ctx.userId,
      token_id: ctx.tokenId,
      conversation_id: ctx.conversationId,
    });
    if (error) {
      // La tabla puede no existir aun (migracion sin aplicar): PGRST205 es como
      // lo reporta PostgREST y 42P01 como lo reporta Postgres directamente.
      // Cualquier otro error si merece verse.
      const TABLA_AUSENTE = ['PGRST205', '42P01'];
      if (!TABLA_AUSENTE.includes(error.code)) {
        logger.warn('No se pudo escribir el registro de auditoría', { code: error.code });
      }
    }
  } catch {
    // Auditar es best-effort por definición.
  }
}

/**
 * Ejecuta una herramienta del registro.
 *
 * Las herramientas marcadas como mutación NO se ejecutan aquí: se registran
 * como propuesta y esperan aprobación humana. Interceptarlo en el ejecutor, y
 * no confiarlo al prompt, es lo que hace que la regla se cumpla siempre.
 */
export async function ejecutarTool(
  nombre: string,
  input: unknown,
  ctx: AgentContext
): Promise<ResultadoEjecucion> {
  const t0 = Date.now();

  const tool = getTool(nombre);
  if (!tool) {
    return {
      ok: false,
      error: { code: 'NOT_FOUND', message: `No existe la herramienta '${nombre}'.` },
      duracionMs: Date.now() - t0,
    };
  }

  try {
    const validado = autorizar(tool, input, ctx);

    if (tool.mutation) {
      const { crearPropuesta } = await import('./approvals');
      const id = await crearPropuesta(ctx, tool, validado);
      const duracionMs = Date.now() - t0;
      await auditar(ctx, { tool: nombre, input: validado, ok: true, duracionMs });
      return {
        ok: true,
        aprobacionId: id,
        data: {
          estado: 'pendiente_de_aprobacion',
          propuesta_id: id,
          resumen: tool.mutation.summarize(validado),
          // El modelo tiene que saber que NO se ha hecho, para no dar por
          // cerrada una acción que sigue esperando a una persona.
          nota: 'La acción no se ha ejecutado. Requiere que una persona autorizada la apruebe.',
        },
        duracionMs,
      };
    }

    const data = await tool.handler(validado, ctx);
    const duracionMs = Date.now() - t0;
    await auditar(ctx, { tool: nombre, input: validado, ok: true, duracionMs });
    return { ok: true, data, duracionMs };
  } catch (e) {
    const duracionMs = Date.now() - t0;
    const esApi = e instanceof ApiError;
    const code = esApi ? e.code : 'INTERNAL_ERROR';
    const message = e instanceof Error ? e.message : 'Error desconocido';

    await auditar(ctx, { tool: nombre, input, ok: false, error: message, duracionMs });

    if (!esApi) {
      logger.error('Fallo inesperado ejecutando una herramienta', e as Error, { tool: nombre });
    }

    // El error se devuelve como dato, no se lanza: el modelo lo lee y puede
    // corregirse en el turno siguiente en vez de romper la conversación.
    return { ok: false, error: { code, message }, duracionMs };
  }
}
