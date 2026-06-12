// Proveedor: Evolution API v2 (https://doc.evolution-api.com/v2).
//
// Evolution es un servicio self-hosted (Docker + Postgres + Redis) que ya
// envuelve Baileys: gestiona instancias, QR y persistencia de sesión por su
// cuenta. Aquí solo lo consumimos por REST. NO requiere el microservicio
// whatsapp-gateway/ ni la tabla whatsapp_session.
//
// Endpoints usados (header de auth: `apikey: <key>`):
//   GET  /instance/connectionState/{instance}   -> { instance: { state } }
//   GET  /instance/connect/{instance}           -> { base64, code, pairingCode } (QR)
//   GET  /group/fetchAllGroups/{instance}?getParticipants=false -> [{ id, subject }]
//   POST /message/sendText/{instance}           -> body { number: "<jid>@g.us", text }

import type { GatewayStatus, WhatsAppGroup, WhatsAppProvider } from '../types';

const TIMEOUT_MS = 15_000;

function evolutionConfig(): { url: string; key: string; instance: string } {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!url || !key || !instance) {
    throw new Error('EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE no configurados');
  }
  return { url: url.replace(/\/$/, ''), key, instance };
}

async function evolutionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, key } = evolutionConfig();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        apikey: key,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Evolution ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timeout);
  }
}

type ConnState = { instance?: { state?: string; profileName?: string; owner?: string } };

export async function getStatus(): Promise<GatewayStatus> {
  const { instance } = evolutionConfig();
  const data = await evolutionFetch<ConnState>(`/instance/connectionState/${instance}`);
  const state = data.instance?.state ?? 'close';
  const connected = state === 'open';
  return {
    connected,
    me: data.instance?.owner ? { id: data.instance.owner, name: data.instance.profileName } : null,
    lastSeen: null,
  };
}

type ConnectResp = {
  base64?: string;
  code?: string;
  pairingCode?: string;
  instance?: { state?: string };
};

export async function getQr(): Promise<{ qr: string | null; connected: boolean }> {
  const { instance } = evolutionConfig();
  const data = await evolutionFetch<ConnectResp>(`/instance/connect/${instance}`);
  // Evolution devuelve `base64` con el QR como dataURL mientras no esté conectado.
  // Si ya está conectado, no hay base64 (responde el estado de la instancia).
  const qr = data.base64 ?? null;
  return { qr, connected: !qr };
}

type EvoGroup = { id: string; subject?: string };

export async function listGroups(): Promise<WhatsAppGroup[]> {
  const { instance } = evolutionConfig();
  const data = await evolutionFetch<EvoGroup[] | { groups?: EvoGroup[] }>(
    `/group/fetchAllGroups/${instance}?getParticipants=false`
  );
  const arr = Array.isArray(data) ? data : (data.groups ?? []);
  return arr
    .filter((g) => g.id?.endsWith('@g.us'))
    .map((g) => ({ id: g.id, name: g.subject ?? g.id }));
}

type SendResp = { key?: { id?: string } };

export async function sendToGroup(
  groupId: string,
  message: string
): Promise<{ messageId: string }> {
  const { instance } = evolutionConfig();
  // En Evolution v2 el campo `number` acepta el JID del grupo ("...@g.us").
  const data = await evolutionFetch<SendResp>(`/message/sendText/${instance}`, {
    method: 'POST',
    body: JSON.stringify({ number: groupId, text: message }),
  });
  return { messageId: data.key?.id ?? '' };
}

export const evolutionProvider: WhatsAppProvider = {
  getStatus,
  getQr,
  listGroups,
  sendToGroup,
};
