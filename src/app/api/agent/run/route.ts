/**
 * Procesa turnos encolados del agente.
 *
 * La llama el worker del VPS (el mismo proceso que ya tiene el gateway de
 * WhatsApp) con el secreto de cron. Reclama un turno, lo ejecuta y manda la
 * respuesta por su canal.
 *
 * El reparto usa `claim_agent_turn`, calcada de `claim_sync_job`: `FOR UPDATE
 * SKIP LOCKED` para que varios trabajadores no se pisen, y recuperación por
 * lease vencido para que un turno de un proceso que murió a media ejecución
 * vuelva a la cola solo, sin necesidad de un barrido aparte.
 *
 * Se procesa de uno en uno y se devuelve `pendientes` para que quien llama
 * sepa si merece la pena volver enseguida.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { createAdminClient } from '@/utils/supabase/server';
import { logger } from '@/lib/error-handler';
import { contextoDesdeSesion } from '@/lib/agent/context';
import { ejecutarTurno } from '@/lib/agent/runner';
import { aprobarYEjecutar, rechazar } from '@/lib/agent/approvals';
import { nivelEfectivo } from '@/lib/agent/types';
import { resolverCanal } from '@/lib/agent/whatsapp/identidad';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Turno = {
  id: string;
  conversation_id: string;
  entrada: string;
  intentos: number;
  max_intentos: number;
};

type Conversacion = {
  id: string;
  channel: string;
  external_id: string | null;
  user_id: string | null;
  contact_id: string | null;
};

/** Manda la respuesta por donde llegó la pregunta. */
async function responder(conv: Conversacion, texto: string): Promise<void> {
  if (conv.channel !== 'whatsapp' || !conv.external_id) return;
  const { sendToGroup } = await import('@/lib/whatsapp/gateway');
  // El gateway acepta tanto jids de grupo como de contacto.
  await sendToGroup(conv.external_id, texto);
}

/**
 * Comandos `APROBAR` / `RECHAZAR`, que la ruta de entrada encola con un prefijo
 * reservado en vez de resolverlos allí mismo: ejecutar una acción aprobada
 * necesita el contexto completo del contacto, y eso se arma aquí.
 */
async function procesarComando(
  entrada: string,
  conv: Conversacion,
  db: Awaited<ReturnType<typeof createAdminClient>>
): Promise<string> {
  const [, tipo, id] = entrada.split(':');
  if (!conv.user_id) return 'No se ha podido identificar quién aprueba.';

  // El techo del canal cuenta: un admin escribiendo en un grupo de solo lectura
  // no aprueba desde ahí.
  let techoCanal: 'consulta' | 'operador' | 'aprobador' | 'admin' | undefined;
  let nivelContacto: typeof techoCanal;

  if (conv.external_id) {
    const canal = await resolverCanal(db, conv.external_id);
    techoCanal = canal?.maxLevel;
  }
  if (conv.contact_id) {
    const { data } = await db
      .from('agent_contacts')
      .select('level')
      .eq('id', conv.contact_id)
      .maybeSingle();
    nivelContacto = (data as { level?: typeof techoCanal } | null)?.level;
  }

  const ctx = await contextoDesdeSesion(conv.user_id, {
    origin: 'whatsapp',
    conversationId: conv.id,
    contactLevel: nivelContacto,
    channelLevel: techoCanal,
  });
  ctx.level = nivelEfectivo(ctx.level, nivelContacto, techoCanal);

  // La propuesta se busca por prefijo: por WhatsApp nadie va a teclear un UUID
  // completo.
  const { data: candidatas } = await db
    .from('agent_action_approvals')
    .select('id, summary')
    .eq('status', 'pendiente')
    .order('created_at', { ascending: false })
    .limit(50);

  const encontrada = (candidatas ?? []).find((p) =>
    (p as { id: string }).id.startsWith(id.toLowerCase())
  ) as { id: string; summary: string } | undefined;

  if (!encontrada) return `No encuentro ninguna propuesta pendiente que empiece por "${id}".`;

  try {
    if (tipo === 'rechazar') {
      await rechazar(ctx, encontrada.id);
      return `Rechazada: ${encontrada.summary}`;
    }
    const res = await aprobarYEjecutar(ctx, encontrada.id);
    return res.ok
      ? `Hecho: ${encontrada.summary}`
      : `No se pudo ejecutar: ${res.error ?? 'error desconocido'}`;
  } catch (e) {
    return e instanceof Error ? e.message : 'No se pudo procesar la aprobación.';
  }
}

export async function POST(request: NextRequest) {
  const auth = requireCronAuth(request);
  if (auth) return auth;

  const db = await createAdminClient();
  const worker = request.nextUrl.searchParams.get('worker') ?? 'agent-runner';

  const { data: reclamados, error } = await db.rpc('claim_agent_turn', {
    p_worker: worker,
    p_lease_seconds: 180,
  });

  if (error) {
    logger.error('No se pudo reclamar un turno', new Error(error.message));
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const turno = (reclamados as Turno[] | null)?.[0];
  if (!turno) {
    return NextResponse.json({ procesados: 0, pendientes: 0 });
  }

  const { data: convData } = await db
    .from('agent_conversations')
    .select('id, channel, external_id, user_id, contact_id')
    .eq('id', turno.conversation_id)
    .maybeSingle();

  const conv = convData as Conversacion | null;

  try {
    if (!conv) throw new Error('La conversación del turno ya no existe.');

    let respuesta: string;

    if (turno.entrada.startsWith('__comando:')) {
      respuesta = await procesarComando(turno.entrada, conv, db);
    } else {
      if (!conv.user_id) throw new Error('La conversación no tiene usuario asociado.');

      let nivelContacto: 'consulta' | 'operador' | 'aprobador' | 'admin' | undefined;
      let techoCanal: typeof nivelContacto;
      let clientScope: string[] | null = null;

      if (conv.contact_id) {
        const { data } = await db
          .from('agent_contacts')
          .select('level, client_scope')
          .eq('id', conv.contact_id)
          .maybeSingle();
        const c = data as { level?: typeof nivelContacto; client_scope?: string[] } | null;
        nivelContacto = c?.level;
        clientScope = c?.client_scope ?? null;
      }
      if (conv.external_id) {
        const canal = await resolverCanal(db, conv.external_id);
        techoCanal = canal?.maxLevel;
        // Un canal fijado a un cliente acota el alcance por debajo de lo que
        // tenga el contacto.
        if (canal?.clienteId) clientScope = [canal.clienteId];
      }

      const ctx = await contextoDesdeSesion(conv.user_id, {
        origin: 'whatsapp',
        conversationId: conv.id,
        contactLevel: nivelContacto,
        channelLevel: techoCanal,
        clientScope,
      });

      const { data: previos } = await db
        .from('agent_messages')
        .select('role, content')
        .eq('conversation_id', conv.id)
        .in('role', ['user', 'assistant'])
        .order('created_at', { ascending: false })
        .limit(10);

      const historial = ((previos ?? []).reverse() as { role: string; content: unknown }[])
        .map((m) =>
          m.role === 'user'
            ? ({ role: 'user', content: String(m.content ?? '') } as const)
            : ({ role: 'assistant', content: String(m.content ?? '') } as const)
        )
        .filter((m) => m.content.length > 0);

      await db.from('agent_messages').insert({
        conversation_id: conv.id,
        role: 'user',
        content: turno.entrada,
      });

      const resultado = await ejecutarTurno({ ctx, entrada: turno.entrada, historial });
      respuesta = resultado.respuesta;

      await db.from('agent_messages').insert({
        conversation_id: conv.id,
        role: 'assistant',
        content: respuesta,
        model_used: resultado.modelos[resultado.modelos.length - 1] ?? null,
        cost_usd: resultado.costeUsd,
      });
    }

    await responder(conv, respuesta);

    await db
      .from('agent_turns')
      .update({ estado: 'done', respuesta, updated_at: new Date().toISOString() })
      .eq('id', turno.id);
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : 'Error desconocido';
    const agotado = turno.intentos >= turno.max_intentos;

    await db
      .from('agent_turns')
      .update({
        // Mientras queden intentos vuelve a la cola; el lease vencido bastaría,
        // pero marcarlo explícitamente lo hace inmediato.
        estado: agotado ? 'error' : 'pending',
        last_error: mensaje.slice(0, 2000),
        locked_at: null,
        locked_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', turno.id);

    logger.error('Falló un turno del agente', e as Error, { turno: turno.id, agotado });

    // Al agotar los intentos se avisa a quien preguntó: quedarse callado deja a
    // una persona esperando una respuesta que no va a llegar.
    if (agotado && conv) {
      await responder(
        conv,
        'No he podido completar tu consulta. El equipo técnico tiene el detalle del error.'
      ).catch(() => {});
    }

    return NextResponse.json({ procesados: 1, ok: false, error: mensaje });
  }

  const { count } = await db
    .from('agent_turns')
    .select('id', { count: 'exact', head: true })
    .eq('estado', 'pending');

  return NextResponse.json({ procesados: 1, ok: true, pendientes: count ?? 0 });
}
