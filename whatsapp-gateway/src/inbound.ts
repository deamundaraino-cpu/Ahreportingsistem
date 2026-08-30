// Reenvío de mensajes entrantes de WhatsApp a la aplicación.
//
// El gateway era solo de salida: escuchaba `creds.update` y `connection.update`
// y nada más. Para conversar hace falta escuchar `messages.upsert` y mandar lo
// que llegue a la app, que es quien decide si responde.
//
// ── Sobre la identidad del remitente ────────────────────────────────────────
//
// WhatsApp identifica a la misma persona de dos maneras: el PN JID
// (`<número>@s.whatsapp.net`), que es lo que se ve en un chat privado, y el LID
// (`@lid`), un identificador opaco que asigna para no exponer números dentro de
// los grupos. En un grupo, `participant` llega a menudo como LID, y traducirlo
// de vuelta al número NO está garantizado: depende de que WhatsApp haya enviado
// el mapeo, que Baileys expone de forma irregular.
//
// Por eso se mandan AMBOS identificadores cuando existen (`participant` y
// `participantPn`) más el nombre visible: la app guarda varias identidades por
// contacto y así una persona dada de alta por su número también se reconoce
// dentro de un grupo.

import { createHmac } from 'node:crypto';
import type { WASocket } from '@whiskeysockets/baileys';

export type MensajeEntrante = {
  messageId: string;
  chatId: string;
  /** Quien escribe. En grupos puede ser un LID. */
  participant: string;
  /** El número, cuando WhatsApp lo manda. Puede faltar. */
  participantPn?: string;
  pushName?: string;
  texto: string;
  isGroup: boolean;
  /** Jids mencionados: sirve para saber si han llamado al bot. */
  mentions: string[];
  timestamp: number;
};

/** Extrae el texto de los formatos que nos interesan. Lo demás se ignora. */
function extraerTexto(mensaje: Record<string, unknown> | null | undefined): string | null {
  if (!mensaje) return null;
  const m = mensaje as {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
  };
  const texto =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    null;
  return texto && texto.trim().length > 0 ? texto.trim() : null;
}

function extraerMenciones(mensaje: Record<string, unknown> | null | undefined): string[] {
  const m = mensaje as { extendedTextMessage?: { contextInfo?: { mentionedJid?: string[] } } };
  return m?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
}

export type OpcionesInbound = {
  appUrl: string;
  secret: string;
  logger: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
};

/**
 * Envía un mensaje a la app firmado con HMAC-SHA256.
 *
 * La firma va sobre el cuerpo exacto que se transmite, no sobre el objeto: si
 * se serializara dos veces podrían no coincidir y la app rechazaría todo.
 */
async function reenviar(msg: MensajeEntrante, opts: OpcionesInbound): Promise<void> {
  const cuerpo = JSON.stringify(msg);
  const firma = createHmac('sha256', opts.secret).update(cuerpo).digest('hex');

  const res = await fetch(`${opts.appUrl}/api/agent/whatsapp/inbound`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Signature': firma,
    },
    body: cuerpo,
  });

  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    opts.logger.error(
      { status: res.status, body: texto.slice(0, 300) },
      'La app rechazó el mensaje entrante'
    );
  }
}

/**
 * Engancha la escucha de mensajes entrantes.
 *
 * Filtra aquí lo que nunca va a interesar —mensajes propios, sin texto, de
 * estados— para no pagar una petición HTTP por cada uno.
 */
export function registrarEntrantes(sock: WASocket, opts: OpcionesInbound): void {
  sock.ev.on('messages.upsert', (evento) => {
    // `append` son mensajes de historial que llegan al reconectar; solo
    // interesan los nuevos.
    if (evento.type !== 'notify') return;

    for (const m of evento.messages) {
      try {
        if (m.key.fromMe) continue;

        const chatId = m.key.remoteJid ?? '';
        // Los estados no son una conversación.
        if (!chatId || chatId === 'status@broadcast') continue;

        const texto = extraerTexto(m.message as Record<string, unknown>);
        if (!texto) continue;

        const isGroup = chatId.endsWith('@g.us');
        // En privado, quien escribe es el propio chat; en grupo, `participant`.
        const participant = (isGroup ? m.key.participant : chatId) ?? '';
        if (!participant) continue;

        const clave = m.key as { participantPn?: string; participantAlt?: string };

        const mensaje: MensajeEntrante = {
          messageId: m.key.id ?? '',
          chatId,
          participant,
          participantPn: clave.participantPn ?? clave.participantAlt ?? undefined,
          pushName: m.pushName ?? undefined,
          texto,
          isGroup,
          mentions: extraerMenciones(m.message as Record<string, unknown>),
          timestamp: Number(m.messageTimestamp ?? 0),
        };

        if (!mensaje.messageId) continue;

        void reenviar(mensaje, opts).catch((err) => {
          opts.logger.error({ err }, 'No se pudo reenviar el mensaje entrante');
        });
      } catch (err) {
        // Un mensaje raro no puede tumbar la escucha de todos los demás.
        opts.logger.error({ err }, 'Error procesando un mensaje entrante');
      }
    }
  });
}
