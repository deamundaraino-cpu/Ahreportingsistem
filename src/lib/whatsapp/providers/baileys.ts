// Proveedor: microservicio gateway Baileys propio (whatsapp-gateway/).
//
// Proceso Node persistente (fuera de Vercel) que mantiene la conexión
// WebSocket con WhatsApp. Aquí solo lo llamamos por REST con un Bearer
// compartido. Mismo patrón de fetch + AbortController/timeout que
// src/lib/report-utm/outbound-emitter.ts (deliverOne).

import type { GatewayStatus, WhatsAppGroup, WhatsAppProvider } from '../types';

const TIMEOUT_MS = 12_000;

function gatewayConfig(): { url: string; key: string } {
  const url = process.env.WHATSAPP_GATEWAY_URL;
  const key = process.env.WHATSAPP_GATEWAY_API_KEY;
  if (!url || !key) {
    throw new Error('WHATSAPP_GATEWAY_URL / WHATSAPP_GATEWAY_API_KEY no configurados');
  }
  return { url: url.replace(/\/$/, ''), key };
}

async function gatewayFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { url, key } = gatewayConfig();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Gateway ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getStatus(): Promise<GatewayStatus> {
  return gatewayFetch<GatewayStatus>('/status');
}

// Devuelve el QR vigente (dataURL) para emparejar el número de la agencia,
// o null si ya está conectado / no hay QR disponible.
export async function getQr(): Promise<{ qr: string | null; connected: boolean }> {
  return gatewayFetch<{ qr: string | null; connected: boolean }>('/qr');
}

export async function listGroups(): Promise<WhatsAppGroup[]> {
  const data = await gatewayFetch<{ groups: WhatsAppGroup[] }>('/groups');
  return data.groups ?? [];
}

// Envía un mensaje de texto a un grupo. Devuelve el id del mensaje del gateway.
export async function sendToGroup(
  groupId: string,
  message: string
): Promise<{ messageId: string }> {
  return gatewayFetch<{ messageId: string }>('/send', {
    method: 'POST',
    body: JSON.stringify({ groupId, message }),
  });
}

export const baileysProvider: WhatsAppProvider = {
  getStatus,
  getQr,
  listGroups,
  sendToGroup,
};
