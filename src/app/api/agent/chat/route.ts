/**
 * Conversación con el agente desde la consola de administración.
 *
 * Autenticación por cookie de sesión: es una pantalla interna. El canal de
 * WhatsApp entra por otra ruta, con su propia verificación de firma.
 *
 * Guarda la conversación y cada mensaje con el coste y el modelo que
 * respondió de verdad, que con una cadena de reserva puede no ser el primario.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';
import { contextoDesdeSesion } from '@/lib/agent/context';
import { ejecutarTurno } from '@/lib/agent/runner';
import { construirContextoCliente } from '@/lib/agent/tools/analisis';
import type { MensajeLlm } from '@/lib/agent/llm/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const cuerpoSchema = z.object({
  mensaje: z.string().min(1).max(4000),
  conversation_id: z.string().uuid().optional(),
  /** Fija la conversación a un cliente y precarga su contexto. */
  client_id: z.string().uuid().optional(),
  tab_id: z.string().uuid().optional(),
});

/** Mensajes previos, en el formato que espera el modelo. */
async function cargarHistorial(
  db: Awaited<ReturnType<typeof createAdminClient>>,
  conversationId: string,
  limite = 20
): Promise<MensajeLlm[]> {
  const { data } = await db
    .from('agent_messages')
    .select('role, content, tool_calls, tool_call_id')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limite);

  const filas = (data ?? []).reverse() as {
    role: string;
    content: unknown;
    tool_calls: unknown;
    tool_call_id: string | null;
  }[];

  // Solo se reponen los turnos de conversación. Los resultados de herramientas
  // se quedan fuera: son voluminosos, envejecen enseguida y el modelo puede
  // volver a pedirlos si los necesita.
  return filas
    .filter((f) => f.role === 'user' || f.role === 'assistant')
    .map((f) =>
      f.role === 'user'
        ? { role: 'user' as const, content: String(f.content ?? '') }
        : { role: 'assistant' as const, content: String(f.content ?? '') }
    )
    .filter((m) => m.content.length > 0);
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('UNAUTHORIZED', 'Hay que iniciar sesión.', 401);
    }

    const parsed = cuerpoSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', z.prettifyError(parsed.error), 400);
    }
    const { mensaje, client_id, tab_id } = parsed.data;

    const db = await createAdminClient();

    let conversationId = parsed.data.conversation_id;
    if (!conversationId) {
      const { data, error } = await db
        .from('agent_conversations')
        .insert({
          channel: 'web',
          user_id: user.id,
          titulo: mensaje.slice(0, 80),
        })
        .select('id')
        .single();
      if (error) {
        throw new ApiError(
          'DATABASE_ERROR',
          `No se pudo abrir la conversación: ${error.message}`,
          500
        );
      }
      conversationId = (data as { id: string }).id;
    }

    const ctx = await contextoDesdeSesion(user.id, { origin: 'web', conversationId });

    // El contexto del cliente se carga aquí, en código, y se inyecta en el
    // prompt. Dejarlo a criterio del modelo es lo que produce análisis que
    // reportan como problema el diseño de la cuenta.
    let contextoExtra: string | undefined;
    if (client_id) {
      const c = await construirContextoCliente(ctx, client_id, tab_id);
      contextoExtra = [
        `Cliente: ${c.cliente.nombre} (id ${c.cliente.id})`,
        c.perfil.descripcion ? `Qué hace: ${c.perfil.descripcion}` : null,
        c.perfil.alcance_medicion ? `Alcance de la medición: ${c.perfil.alcance_medicion}` : null,
        c.perfil.fuentes_ausentes.length
          ? `Fuentes que NO tiene (no las reportes como carencia): ${c.perfil.fuentes_ausentes.join(', ')}`
          : null,
        c.estrategia
          ? `Estrategia de la pestaña: ${c.estrategia.nombre} · mide ${c.estrategia.alcance}` +
            (c.estrategia.metricas_na.length
              ? ` · no aplican: ${c.estrategia.metricas_na.join(', ')}`
              : '')
          : null,
        c.perfil.instrucciones ? `Indicaciones del equipo: ${c.perfil.instrucciones}` : null,
        c.feedback.length ? `Correcciones anteriores:\n- ${c.feedback.join('\n- ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    }

    const historial = await cargarHistorial(db, conversationId);

    await db.from('agent_messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: mensaje,
    });

    const turno = await ejecutarTurno({ ctx, entrada: mensaje, historial, contextoExtra });

    await db.from('agent_messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: turno.respuesta,
      model_used: turno.modelos[turno.modelos.length - 1] ?? null,
      tier: 'power',
      cost_usd: turno.costeUsd,
    });

    await db
      .from('agent_conversations')
      .update({ last_activity_at: new Date().toISOString() })
      .eq('id', conversationId);

    return NextResponse.json({
      conversation_id: conversationId,
      respuesta: turno.respuesta,
      // Se devuelve para que la consola muestre qué hizo y cuánto costó: sin
      // esto, un fallback silencioso a un modelo peor es indetectable.
      meta: {
        iteraciones: turno.iteraciones,
        herramientas: turno.herramientas,
        modelos: turno.modelos,
        coste_usd: turno.costeUsd,
        truncado: turno.truncado,
      },
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'POST /api/agent/chat');
  }
}
