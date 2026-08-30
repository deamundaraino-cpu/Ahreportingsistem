import 'server-only';

/**
 * Bucle de uso de herramientas.
 *
 * OpenRouter habla el dialecto de OpenAI, que no trae un ejecutor de
 * herramientas, así que el bucle se escribe aquí: mientras el modelo pida
 * herramientas, se ejecutan todas las de esa tanda, se devuelven juntas y se
 * vuelve a preguntar.
 *
 * Dos decisiones que se notan en el resultado:
 *
 *   · Un error de validación se devuelve al modelo COMO RESULTADO de la
 *     herramienta, no como excepción. Así se corrige solo en el turno siguiente
 *     en lugar de romper la conversación.
 *
 *   · El contexto del cliente se carga en código antes del primer mensaje. Si
 *     dependiera de que el modelo se acuerde de pedirlo, algún día no lo haría,
 *     y ese día volvería el análisis que reporta como problema que un cliente
 *     no tenga Google Analytics.
 */

import { z } from 'zod';
import { logger } from '@/lib/error-handler';
import { ejecutarTool } from './execute';
import { toolsFor } from './registry';
import {
  llamarLlm,
  leerPolitica,
  type DefinicionTool,
  type MensajeLlm,
  type Tier,
} from './llm/client';
import type { AgentContext, AnyAgentTool, DominioTool } from './types';

/** Tope de vueltas del bucle. Sin él, un modelo confundido puede no parar. */
export const MAX_ITERACIONES = 8;

export type ResultadoTurno = {
  respuesta: string;
  iteraciones: number;
  herramientas: { nombre: string; ok: boolean; ms: number }[];
  costeUsd: number;
  modelos: string[];
  mensajes: MensajeLlm[];
  /** True si se agotaron las iteraciones sin que el modelo cerrara. */
  truncado: boolean;
};

/** Convierte una herramienta del registro al formato de OpenRouter. */
export function aFormatoOpenRouter(tool: AnyAgentTool): DefinicionTool {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  delete schema.$schema;
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: schema },
  };
}

export type OpcionesTurno = {
  ctx: AgentContext;
  /** Lo que ha escrito la persona. */
  entrada: string;
  /** Historial previo, sin el mensaje de sistema. */
  historial?: MensajeLlm[];
  tier?: Tier;
  dominios?: DominioTool[];
  /** Instrucciones adicionales, por ejemplo el contexto de un cliente. */
  contextoExtra?: string;
  maxIteraciones?: number;
};

/**
 * Prompt del sistema.
 *
 * Lo estable va primero (y es lo que se cachea); lo variable, después.
 */
export function construirSystem(ctx: AgentContext, contextoExtra?: string): string {
  const base = [
    'Eres el asistente de una agencia de publicidad digital. Ayudas al equipo a entender cómo van',
    'sus clientes y a operar la plataforma de reporting.',
    '',
    'Cómo trabajas:',
    '',
    '· Antes de opinar sobre el rendimiento de un cliente, usa `analyze_performance`. Trae el',
    '  contexto de ese cliente y sin él las cifras se malinterpretan.',
    '· Respeta siempre el campo `no_aplican` y la lista `fuentes_ausentes`. Lo que aparezca ahí NO',
    '  es un dato que falte: es un dato que no tiene sentido para ese cliente. No lo menciones',
    '  como una carencia ni sugieras conectarlo salvo que te lo pregunten.',
    '· Para acotar a una estrategia usa el `tab_id` que te da `get_tabs`. Nunca intentes',
    '  reconstruir el filtro de campañas a partir de su texto.',
    '· Si no hay metas configuradas, describe las cifras pero no las califiques de buenas o malas.',
    '· Si una herramienta devuelve `warnings`, tenlos en cuenta y menciónalos cuando afecten a la',
    '  fiabilidad de lo que estás contando.',
    '· Si un dato no lo tienes, dilo. No lo estimes ni lo rellenes.',
    '',
    'Cuando pidas una acción de escritura, recuerda que NO se ejecuta al momento: queda como',
    'propuesta y una persona autorizada tiene que aprobarla. Dilo con claridad en tu respuesta,',
    'sin dar por hecho que ya está hecha.',
    '',
    'Sobre las campañas: puedes leerlas y recomendar cambios, pero no puedes pausarlas ni tocar',
    'presupuestos. Eso lo hace el equipo en Meta.',
    '',
    'Escribe en español, en el tono de un compañero de trabajo: directo, sin florituras y sin',
    'repetir la pregunta. Da las cifras con su unidad y redondeadas con sensatez.',
  ].join('\n');

  return contextoExtra ? `${base}\n\n── Contexto de esta conversación ──\n${contextoExtra}` : base;
}

/**
 * Ejecuta un turno completo: pregunta, herramientas y respuesta final.
 */
export async function ejecutarTurno(opts: OpcionesTurno): Promise<ResultadoTurno> {
  const { ctx, entrada } = opts;
  const tier: Tier = opts.tier ?? 'power';
  const maxIter = opts.maxIteraciones ?? MAX_ITERACIONES;

  const disponibles = toolsFor(ctx, opts.dominios);
  const tools = disponibles.map(aFormatoOpenRouter);
  const politica = await leerPolitica(
    ctx.db as unknown as Parameters<typeof leerPolitica>[0],
    tier
  );

  const mensajes: MensajeLlm[] = [
    { role: 'system', content: construirSystem(ctx, opts.contextoExtra) },
    ...(opts.historial ?? []),
    { role: 'user', content: entrada },
  ];

  const herramientas: ResultadoTurno['herramientas'] = [];
  const modelos: string[] = [];
  let costeUsd = 0;
  let iteraciones = 0;

  while (iteraciones < maxIter) {
    iteraciones++;

    const res = await llamarLlm({ tier, mensajes, tools, politica });
    modelos.push(res.modelo);
    costeUsd += res.uso.costUsd;

    if (res.toolCalls.length === 0) {
      mensajes.push({ role: 'assistant', content: res.contenido });
      return {
        respuesta: res.contenido ?? '',
        iteraciones,
        herramientas,
        costeUsd,
        modelos,
        mensajes,
        truncado: false,
      };
    }

    mensajes.push({
      role: 'assistant',
      content: res.contenido,
      tool_calls: res.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.nombre, arguments: tc.argumentos },
      })),
    });

    // Todas las herramientas de la tanda se ejecutan y sus resultados se
    // devuelven juntos: repartirlos en varios mensajes enseña al modelo a dejar
    // de pedirlas en paralelo.
    const resultados = await Promise.all(
      res.toolCalls.map(async (tc) => {
        let args: unknown = {};
        try {
          args = tc.argumentos ? JSON.parse(tc.argumentos) : {};
        } catch {
          return {
            id: tc.id,
            nombre: tc.nombre,
            ok: false,
            ms: 0,
            texto: JSON.stringify({
              error: 'Los argumentos no son JSON válido. Vuelve a llamarla con JSON correcto.',
            }),
          };
        }

        const r = await ejecutarTool(tc.nombre, args, ctx);
        return {
          id: tc.id,
          nombre: tc.nombre,
          ok: r.ok,
          ms: r.duracionMs,
          texto: JSON.stringify(r.ok ? r.data : { error: r.error }),
        };
      })
    );

    for (const r of resultados) {
      herramientas.push({ nombre: r.nombre, ok: r.ok, ms: r.ms });
      mensajes.push({ role: 'tool', tool_call_id: r.id, content: r.texto });
    }
  }

  // Se agotaron las vueltas. Se pide un cierre en texto, sin herramientas, para
  // no dejar a la persona sin respuesta.
  logger.warn('El turno agotó las iteraciones', { iteraciones, tools: herramientas.length });

  const cierre = await llamarLlm({
    tier,
    mensajes: [
      ...mensajes,
      {
        role: 'user',
        content:
          'Responde ya con lo que tengas, sin usar más herramientas. Di qué has podido averiguar y qué te ha faltado.',
      },
    ],
    politica,
  });

  costeUsd += cierre.uso.costUsd;
  modelos.push(cierre.modelo);

  return {
    respuesta: cierre.contenido ?? 'No he podido completar la consulta.',
    iteraciones,
    herramientas,
    costeUsd,
    modelos,
    mensajes,
    truncado: true,
  };
}
