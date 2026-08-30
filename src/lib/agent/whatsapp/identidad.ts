import 'server-only';

/**
 * Quién escribe y desde dónde.
 *
 * Dos reglas gobiernan esto:
 *
 *   1. **La autorización es por remitente, nunca por canal.** Que un grupo esté
 *      habilitado significa que el agente OPERA ahí, no que todos sus
 *      participantes puedan usarlo. Si se autorizara por grupo, cualquiera que
 *      entrase heredaría los permisos del canal.
 *
 *   2. **Un contacto tiene varias identidades.** WhatsApp usa el número
 *      (`@s.whatsapp.net`) en privado y un LID opaco (`@lid`) dentro de los
 *      grupos, y traducir un LID a su número no está garantizado. Dar de alta
 *      solo el número produce un síntoma desconcertante: la persona funciona en
 *      privado y el bot la ignora en el grupo. Por eso se buscan todas sus
 *      identidades y el modo aprendizaje permite vincular las que falten.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NivelAgente } from '../types';

export type ContactoResuelto = {
  id: string;
  userId: string;
  level: NivelAgente;
  clientScope: string[] | null;
  displayName: string | null;
};

export type CanalResuelto = {
  id: string;
  maxLevel: NivelAgente;
  clienteId: string | null;
  requireMention: boolean;
  learningMode: boolean;
  isActive: boolean;
  kind: 'group' | 'dm';
};

/**
 * Busca el contacto por cualquiera de sus identidades.
 *
 * Se prueban ambos identificadores porque en un grupo llega el LID y en privado
 * el número, y la misma persona puede tener registrados uno, otro o los dos.
 */
export async function resolverContacto(
  db: SupabaseClient,
  identificadores: (string | undefined | null)[]
): Promise<ContactoResuelto | null> {
  const ids = identificadores.filter((x): x is string => Boolean(x));
  if (ids.length === 0) return null;

  const { data: identidad } = await db
    .from('agent_contact_identities')
    .select('contact_id')
    .in('external_id', ids)
    .limit(1)
    .maybeSingle();

  if (!identidad) return null;

  const { data: contacto } = await db
    .from('agent_contacts')
    .select('id, user_id, level, client_scope, display_name, is_active')
    .eq('id', (identidad as { contact_id: string }).contact_id)
    .maybeSingle();

  if (!contacto) return null;
  const c = contacto as {
    id: string;
    user_id: string;
    level: NivelAgente;
    client_scope: string[] | null;
    display_name: string | null;
    is_active: boolean;
  };

  // Un contacto desactivado es como uno que no existe.
  if (!c.is_active) return null;

  return {
    id: c.id,
    userId: c.user_id,
    level: c.level,
    clientScope: c.client_scope,
    displayName: c.display_name,
  };
}

/** Busca el canal. Un canal que no está dado de alta no existe para el agente. */
export async function resolverCanal(
  db: SupabaseClient,
  externalId: string
): Promise<CanalResuelto | null> {
  const { data } = await db
    .from('agent_channels')
    .select('id, max_level, cliente_id, require_mention, learning_mode, is_active, kind')
    .eq('channel', 'whatsapp')
    .eq('external_id', externalId)
    .maybeSingle();

  if (!data) return null;
  const c = data as {
    id: string;
    max_level: NivelAgente;
    cliente_id: string | null;
    require_mention: boolean;
    learning_mode: boolean;
    is_active: boolean;
    kind: 'group' | 'dm';
  };

  return {
    id: c.id,
    maxLevel: c.max_level,
    clienteId: c.cliente_id,
    requireMention: c.require_mention,
    learningMode: c.learning_mode,
    isActive: c.is_active,
    kind: c.kind,
  };
}

/**
 * Registra a quien escribe en un canal en modo aprendizaje.
 *
 * Es lo que permite dar de alta a alguien por su LID sin tener que adivinarlo:
 * escribe una vez en el grupo, aparece en el panel y se vincula con un clic.
 */
export async function registrarRemitenteVisto(
  db: SupabaseClient,
  canalId: string,
  datos: { lid: string; participantPn?: string; pushName?: string }
): Promise<void> {
  await db.from('whatsapp_seen_senders').upsert(
    {
      channel_id: canalId,
      lid: datos.lid,
      participant_pn: datos.participantPn ?? null,
      push_name: datos.pushName ?? null,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: 'channel_id,lid' }
  );
}

/** Prefijos que despiertan al agente en un grupo. */
export const PREFIJOS = ['/ah', '@ah', '/agente'];

export type Activacion = {
  activado: boolean;
  /** El texto sin el prefijo, listo para el modelo. */
  texto: string;
  motivo: string;
};

/**
 * ¿Hay que invocar al modelo con este mensaje?
 *
 * En privado, siempre: toda la conversación es con el agente. En grupo, solo si
 * lo llaman — de lo contrario leería y pagaría por cada mensaje del grupo, y
 * multiplicaría el tráfico de un cliente de WhatsApp no oficial.
 */
export function evaluarActivacion(opts: {
  esGrupo: boolean;
  texto: string;
  requiereMencion: boolean;
  mentions: string[];
  jidBot?: string | null;
}): Activacion {
  if (!opts.esGrupo) {
    return { activado: true, texto: opts.texto, motivo: 'chat privado' };
  }

  const limpio = opts.texto.trim();
  const enMinusculas = limpio.toLowerCase();

  for (const p of PREFIJOS) {
    if (enMinusculas.startsWith(p)) {
      return { activado: true, texto: limpio.slice(p.length).trim(), motivo: `prefijo ${p}` };
    }
  }

  // La mención se compara por el número del bot: el jid completo trae sufijos
  // de dispositivo que no siempre coinciden.
  if (opts.jidBot) {
    const numeroBot = opts.jidBot.split('@')[0].split(':')[0];
    if (opts.mentions.some((m) => m.split('@')[0].split(':')[0] === numeroBot)) {
      return { activado: true, texto: limpio, motivo: 'mención al bot' };
    }
  }

  if (!opts.requiereMencion) {
    return { activado: true, texto: limpio, motivo: 'canal sin mención obligatoria' };
  }

  return { activado: false, texto: limpio, motivo: 'sin prefijo ni mención' };
}

/** Comandos de aprobación, que se atienden antes de invocar al modelo. */
export type Comando =
  { tipo: 'aprobar'; numero: string } | { tipo: 'rechazar'; numero: string } | null;

/**
 * Reconoce `APROBAR <id>` y `RECHAZAR <id>`.
 *
 * Se tratan como comandos y no como conversación porque son una decisión, no
 * una pregunta: no tiene sentido gastar una llamada al modelo para
 * interpretarlos, ni arriesgarse a que los interprete mal.
 */
export function parsearComando(texto: string): Comando {
  const m = texto.trim().match(/^(aprobar|rechazar)\s+#?([0-9a-f-]{4,})$/i);
  if (!m) return null;
  return {
    tipo: m[1].toLowerCase() === 'aprobar' ? 'aprobar' : 'rechazar',
    numero: m[2],
  };
}
