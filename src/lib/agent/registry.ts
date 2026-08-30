import 'server-only';

/**
 * Registro de herramientas — la fuente única.
 *
 * El servidor MCP, el motor conversacional y la consola de administración leen
 * de aquí. Añadir una herramienta es añadirla a un array; nadie tiene que
 * acordarse de actualizar un `switch` en otro archivo ni de escribir el JSON
 * Schema a mano.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import { nivelAlcanza, type AgentContext, type AnyAgentTool, type DominioTool } from './types';

import { toolsClientes } from './tools/clientes';
import { toolsContexto } from './tools/contexto';
import { toolsAnalisis } from './tools/analisis';
import { toolsMetricas } from './tools/metricas';
import { toolsCampanas } from './tools/campanas';
import { toolsInformes } from './tools/informes';
import { toolsOperaciones } from './tools/operaciones';
import { toolsAdministracion } from './tools/administracion';

/**
 * Todas las herramientas, en orden estable.
 *
 * El orden importa más de lo que parece: el catálogo se envía en cada petición
 * al modelo y encabeza el prefijo cacheado. Un orden que cambie entre llamadas
 * invalida la caché de prompt y multiplica el coste sin que se note.
 */
export const ALL_TOOLS: AnyAgentTool[] = [
  ...toolsClientes,
  ...toolsContexto,
  ...toolsAnalisis,
  ...toolsMetricas,
  ...toolsCampanas,
  ...toolsInformes,
  ...toolsOperaciones,
  ...toolsAdministracion,
].sort((a, b) => a.name.localeCompare(b.name));

const PORNOMBRE = new Map<string, AnyAgentTool>(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(nombre: string): AnyAgentTool | undefined {
  return PORNOMBRE.get(nombre);
}

/** ¿El contexto tiene todos los scopes que pide la herramienta? */
function tieneScopes(tool: AnyAgentTool, ctx: AgentContext): boolean {
  return tool.scopes.every((s) => ctx.permissions.includes(s));
}

/**
 * Herramientas que este contexto puede ver y usar.
 *
 * Filtrar el catálogo, y no solo rechazar al ejecutar, es deliberado: si al
 * modelo no se le ofrece una herramienta que no puede usar, no la intenta ni
 * promete al usuario algo que después será rechazado.
 */
export function toolsFor(ctx: AgentContext, dominios?: DominioTool[]): AnyAgentTool[] {
  return ALL_TOOLS.filter((t) => {
    if (dominios && !dominios.includes(t.domain)) return false;
    if (!tieneScopes(t, ctx)) return false;
    if (!nivelAlcanza(ctx.level, t.minLevel ?? 'consulta')) return false;
    // Una escritura de riesgo alto exige nivel `admin` aunque el scope esté.
    if (t.mutation?.risk === 'high' && !nivelAlcanza(ctx.level, 'admin')) return false;
    return true;
  });
}

/**
 * Comprueba permisos y valida la entrada. Lanza `ApiError` si algo falla.
 *
 * Está centralizado a propósito. Las server actions del proyecto delegan la
 * protección al proxy que cierra `/admin` — `createCliente`, por ejemplo, no
 * comprueba el rol por su cuenta. Eso vale mientras la única puerta sea la
 * interfaz, pero las herramientas no pasan por el proxy: si cada handler
 * tuviera que acordarse de comprobar, alguno no lo haría.
 */
export function autorizar<I>(tool: AnyAgentTool, input: unknown, ctx: AgentContext): I {
  if (!tieneScopes(tool, ctx)) {
    const faltan = tool.scopes.filter((s) => !ctx.permissions.includes(s));
    throw new ApiError(
      'UNAUTHORIZED',
      `La herramienta '${tool.name}' requiere: ${faltan.join(', ')}.`,
      403
    );
  }

  const minimo = tool.mutation?.risk === 'high' ? 'admin' : (tool.minLevel ?? 'consulta');
  if (!nivelAlcanza(ctx.level, minimo)) {
    throw new ApiError(
      'UNAUTHORIZED',
      `La herramienta '${tool.name}' requiere nivel '${minimo}' y este contacto es '${ctx.level}'.`,
      403
    );
  }

  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    // El detalle se devuelve al modelo para que se corrija solo en el siguiente
    // turno, en lugar de romper la conversación.
    throw new ApiError(
      'VALIDATION_ERROR',
      `Argumentos inválidos para '${tool.name}': ${z.prettifyError(parsed.error)}`,
      400
    );
  }
  return parsed.data as I;
}

/**
 * ¿Puede el contexto ver este cliente?
 *
 * Se comprueba en cada herramienta que reciba un `cliente_id`, y no una sola vez
 * al construir el contexto, porque el id llega como argumento del modelo y no
 * de una ruta ya autorizada.
 */
export function puedeVerCliente(ctx: AgentContext, clienteId: string): boolean {
  return ctx.allowedClientIds === 'all' || ctx.allowedClientIds.includes(clienteId);
}

export function exigirCliente(ctx: AgentContext, clienteId: string): void {
  if (!puedeVerCliente(ctx, clienteId)) {
    // Mismo mensaje que si no existiera: distinguirlos revelaría qué clientes
    // hay en la cuenta a quien no debería saberlo.
    throw new ApiError('NOT_FOUND', `No se encuentra el cliente ${clienteId}.`, 404);
  }
}

/** Filtro de clientes visibles, para las herramientas que listan. */
export function idsVisibles(ctx: AgentContext): string[] | null {
  return ctx.allowedClientIds === 'all' ? null : ctx.allowedClientIds;
}
