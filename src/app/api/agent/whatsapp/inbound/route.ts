/**
 * Mensajes entrantes de WhatsApp.
 *
 * El gateway (proceso Baileys, fuera de Vercel) reenvía aquí lo que llega,
 * firmado con HMAC-SHA256. Esta ruta decide si el agente debe responder y, si
 * es así, encola el turno.
 *
 * Responde 200 en milisegundos y NO ejecuta el turno de forma síncrona: un
 * turno con varias herramientas supera de largo el tiempo máximo de una
 * función, y dejar al gateway esperando provocaría reintentos y respuestas
 * duplicadas.
 *
 * Orden de las comprobaciones, y por qué:
 *
 *   1. Firma — antes de mirar nada más.
 *   2. Deduplicación — Baileys reentrega mensajes al reconectar; sin esto el
 *      agente respondería dos veces al mismo mensaje.
 *   3. Canal — dice DÓNDE puede operar y con qué techo de permisos.
 *   4. Remitente — dice QUÉ puede pedir. La autorización es de la persona, no
 *      del grupo: si fuera del grupo, cualquiera que entrase heredaría sus
 *      permisos.
 *   5. Activación — en grupo hace falta prefijo o mención.
 *
 * A un remitente no reconocido se le responde con silencio: no se confirma que
 * hay un bot escuchando ni se dan pistas de lo que hace. El intento queda en el
 * registro de auditoría, que es lo que sirve para detectar a quién falta dar de
 * alta.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createAdminClient } from '@/utils/supabase/server';
import { logger } from '@/lib/error-handler';
import {
  resolverContacto,
  resolverCanal,
  registrarRemitenteVisto,
  evaluarActivacion,
  parsearComando,
} from '@/lib/agent/whatsapp/identidad';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Entrante = {
  messageId: string;
  chatId: string;
  participant: string;
  participantPn?: string;
  pushName?: string;
  texto: string;
  isGroup: boolean;
  mentions?: string[];
  timestamp?: number;
};

/** Comparación en tiempo constante: una comparación normal filtra la firma. */
function firmaValida(cuerpo: string, recibida: string | null, secreto: string): boolean {
  if (!recibida) return false;
  const esperada = createHmac('sha256', secreto).update(cuerpo).digest('hex');
  const a = Buffer.from(esperada, 'utf8');
  const b = Buffer.from(recibida, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 200 siempre que la firma sea válida: el gateway no debe reintentar. */
function ok(estado: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: true, estado, ...extra });
}

export async function POST(request: NextRequest) {
  const secreto = process.env.AGENT_INBOUND_SECRET;
  if (!secreto) {
    logger.error('AGENT_INBOUND_SECRET no está configurado', new Error('sin secreto'));
    return NextResponse.json({ error: 'No configurado' }, { status: 503 });
  }

  const cuerpo = await request.text();
  if (!firmaValida(cuerpo, request.headers.get('x-agent-signature'), secreto)) {
    return NextResponse.json({ error: 'Firma inválida' }, { status: 401 });
  }

  let msg: Entrante;
  try {
    msg = JSON.parse(cuerpo) as Entrante;
  } catch {
    return NextResponse.json({ error: 'Cuerpo no válido' }, { status: 400 });
  }

  if (!msg.messageId || !msg.chatId || !msg.participant || !msg.texto) {
    return NextResponse.json({ error: 'Faltan campos' }, { status: 400 });
  }

  const db = await createAdminClient();

  // 2 · Deduplicación. La clave primaria hace el trabajo: si ya estaba, el
  // insert falla con 23505 y sabemos que es repetido.
  const { error: errDedup } = await db.from('whatsapp_inbound_messages').insert({
    message_id: msg.messageId,
    chat_id: msg.chatId,
    participant: msg.participant,
  });
  if (errDedup) {
    if (errDedup.code === '23505') return ok('duplicado');
    logger.warn('No se pudo deduplicar el mensaje entrante', { code: errDedup.code });
  }

  // 3 · Canal.
  const canal = await resolverCanal(db, msg.chatId);

  if (!canal) {
    // Un chat desconocido se registra para que aparezca en el panel, pero
    // deshabilitado: que alguien añada el bot a un grupo no basta para que
    // empiece a responder ahí.
    await db
      .from('agent_channels')
      .upsert(
        {
          channel: 'whatsapp',
          external_id: msg.chatId,
          kind: msg.isGroup ? 'group' : 'dm',
          is_active: false,
        },
        { onConflict: 'channel,external_id' }
      )
      .select('id');
    return ok('canal_desconocido');
  }

  if (!canal.isActive) {
    if (canal.learningMode) {
      await registrarRemitenteVisto(db, canal.id, {
        lid: msg.participant,
        participantPn: msg.participantPn,
        pushName: msg.pushName,
      });
      return ok('aprendizaje');
    }
    return ok('canal_inactivo');
  }

  // 4 · Remitente. Se prueban todas sus identidades posibles.
  const contacto = await resolverContacto(db, [msg.participant, msg.participantPn]);

  if (!contacto) {
    if (canal.learningMode) {
      await registrarRemitenteVisto(db, canal.id, {
        lid: msg.participant,
        participantPn: msg.participantPn,
        pushName: msg.pushName,
      });
    }
    // Silencio, pero con rastro.
    await db.from('agent_audit_log').insert({
      tool_name: '(mensaje entrante)',
      input: { chatId: msg.chatId, participant: msg.participant, pushName: msg.pushName },
      ok: false,
      error: 'Remitente no autorizado',
      origin: 'whatsapp',
    });
    return ok('remitente_no_autorizado');
  }

  // 5 · Activación.
  const activacion = evaluarActivacion({
    esGrupo: msg.isGroup,
    texto: msg.texto,
    requiereMencion: canal.requireMention,
    mentions: msg.mentions ?? [],
    jidBot: await jidDelBot(db),
  });

  if (!activacion.activado) return ok('sin_activacion');

  // Los comandos de aprobación se atienden aquí, sin pasar por el modelo: son
  // una decisión, no una pregunta.
  const comando = parsearComando(activacion.texto);
  if (comando) {
    return ok('comando', {
      comando: comando.tipo,
      // La ejecución la hace el worker, con el contexto completo del contacto.
      encolado: await encolarComando(db, canal.id, contacto.id, msg, comando),
    });
  }

  // Turno normal: se encola y el worker lo procesa.
  const conversationId = await conversacionDe(db, msg.chatId, canal.id, contacto);

  const { error } = await db.from('agent_turns').insert({
    conversation_id: conversationId,
    entrada: activacion.texto,
    estado: 'pending',
    prioridad: 5,
  });

  if (error) {
    // El índice único deja un solo turno vivo por conversación: si ya hay uno,
    // este mensaje llega mientras el agente todavía está pensando.
    if (error.code === '23505') return ok('turno_en_curso');
    logger.error('No se pudo encolar el turno', new Error(error.message));
    return ok('error_al_encolar');
  }

  return ok('encolado', { conversation_id: conversationId });
}

/** Jid del propio bot, para reconocer las menciones. */
async function jidDelBot(
  db: Awaited<ReturnType<typeof createAdminClient>>
): Promise<string | null> {
  const { data } = await db.from('whatsapp_session').select('me').eq('id', 'agency').maybeSingle();
  const me = (data as { me?: { id?: string } } | null)?.me;
  return me?.id ?? null;
}

/** Conversación del chat, creándola la primera vez. */
async function conversacionDe(
  db: Awaited<ReturnType<typeof createAdminClient>>,
  chatId: string,
  canalId: string,
  contacto: { id: string; userId: string }
): Promise<string> {
  const { data } = await db
    .from('agent_conversations')
    .select('id')
    .eq('channel', 'whatsapp')
    .eq('external_id', chatId)
    .maybeSingle();

  if (data) return (data as { id: string }).id;

  const { data: nueva, error } = await db
    .from('agent_conversations')
    .insert({
      channel: 'whatsapp',
      external_id: chatId,
      contact_id: contacto.id,
      user_id: contacto.userId,
      titulo: `WhatsApp ${chatId}`,
    })
    .select('id')
    .single();

  if (error) throw new Error(`No se pudo abrir la conversación: ${error.message}`);
  void canalId;
  return (nueva as { id: string }).id;
}

/** Encola un comando de aprobación como un turno especial. */
async function encolarComando(
  db: Awaited<ReturnType<typeof createAdminClient>>,
  canalId: string,
  contactoId: string,
  msg: Entrante,
  comando: { tipo: string; numero: string }
): Promise<boolean> {
  const conversationId = await conversacionDe(db, msg.chatId, canalId, {
    id: contactoId,
    userId: '',
  }).catch(() => null);
  if (!conversationId) return false;

  const { error } = await db.from('agent_turns').insert({
    conversation_id: conversationId,
    entrada: `__comando:${comando.tipo}:${comando.numero}`,
    estado: 'pending',
    // Por delante de las consultas: quien aprueba está esperando.
    prioridad: 1,
  });

  return !error;
}
