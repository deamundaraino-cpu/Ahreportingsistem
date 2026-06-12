// Dispatcher de proveedor de WhatsApp.
//
// Selecciona el proveedor según WHATSAPP_PROVIDER:
//   - 'baileys'   (default) → microservicio gateway propio (whatsapp-gateway/)
//   - 'evolution'           → Evolution API v2 self-hosted
//
// El resto de la app (notify.ts, _actions.ts) importa SOLO desde aquí, así
// cambiar de proveedor es una variable de entorno — sin tocar lógica de envío,
// ruteo, UI ni disparadores.

import type { GatewayStatus, WhatsAppGroup, WhatsAppProvider } from './types';
import { baileysProvider } from './providers/baileys';
import { evolutionProvider } from './providers/evolution';

function selectProvider(): WhatsAppProvider {
  return process.env.WHATSAPP_PROVIDER === 'evolution' ? evolutionProvider : baileysProvider;
}

export async function getStatus(): Promise<GatewayStatus> {
  return selectProvider().getStatus();
}

export async function getQr(): Promise<{ qr: string | null; connected: boolean }> {
  return selectProvider().getQr();
}

export async function listGroups(): Promise<WhatsAppGroup[]> {
  return selectProvider().listGroups();
}

export async function sendToGroup(
  groupId: string,
  message: string
): Promise<{ messageId: string }> {
  return selectProvider().sendToGroup(groupId, message);
}
