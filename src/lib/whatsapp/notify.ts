// Lógica central de envío de notificaciones a grupos de WhatsApp.
//
// Reutilizable por los tres disparadores: envío manual (UI), cron/eventos
// y webhooks de ventas (report-utm). Resuelve los grupos destino según el
// ruteo (cliente-específico → fallback global por tipo), llama al gateway
// por cada grupo y registra cada envío en whatsapp_messages.
//
// Estilo análogo a emitOutboundForSale en
// src/lib/report-utm/outbound-emitter.ts.

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendToGroup } from './gateway';
import type { NotificationType } from './types';

type Db = SupabaseClient;

export type SendNotificationArgs = {
  db: Db; // admin client (service_role) — escribe en whatsapp_messages
  clienteId: string | null; // null = solo aplican rutas globales por tipo
  notificationType: NotificationType;
  message: string;
  // Solo para alertas: además de las rutas del cliente, envía SIEMPRE al
  // grupo general fijo del equipo (system_settings 'whatsapp_alert_team_group').
  // El resultado es la unión deduplicada de ambos destinos.
  includeTeamAlertGroup?: boolean;
};

// Key en system_settings que guarda el grupo general fijo del equipo para alertas.
const ALERT_TEAM_GROUP_KEY = 'whatsapp_alert_team_group';

/**
 * Lee el grupo general fijo del equipo para alertas desde system_settings.
 * Devuelve el group_id si está configurado y habilitado, si no null.
 */
async function getAlertTeamGroupId(db: Db): Promise<string | null> {
  const { data } = await db
    .from('system_settings')
    .select('value')
    .eq('key', ALERT_TEAM_GROUP_KEY)
    .maybeSingle();

  const value = (data?.value ?? null) as { group_id?: string | null; enabled?: boolean } | null;
  if (!value || value.enabled === false) return null;
  const groupId = value.group_id?.trim();
  return groupId ? groupId : null;
}

export type SendNotificationResult = {
  sent: number;
  failed: number;
  skipped: boolean; // true si no había ninguna ruta destino
};

type RouteRow = { group_id: string };

/**
 * Resuelve los grupos destino para (clienteId, type):
 *   1) rutas del cliente: cliente_id = clienteId AND notification_type = type
 *   2) si no hay ninguna, cae a rutas globales: cliente_id IS NULL AND type
 * Devuelve la lista de group_id únicos y habilitados.
 */
async function resolveTargetGroups(
  db: Db,
  clienteId: string | null,
  notificationType: NotificationType,
  includeTeamAlertGroup = false
): Promise<string[]> {
  // Modo aditivo (alertas): rutas del cliente UNIÓN grupo general del equipo.
  // No se usa el fallback global por tipo; el grupo del equipo es el destino
  // garantizado, y el grupo del cliente se suma si existe.
  if (includeTeamAlertGroup) {
    const groupIds = new Set<string>();

    const teamGroupId = await getAlertTeamGroupId(db);
    if (teamGroupId) groupIds.add(teamGroupId);

    if (clienteId) {
      const { data: clientRoutes } = await db
        .from('whatsapp_routes')
        .select('group_id')
        .eq('enabled', true)
        .eq('notification_type', notificationType)
        .eq('cliente_id', clienteId);

      for (const r of (clientRoutes ?? []) as RouteRow[]) groupIds.add(r.group_id);
    }

    return [...groupIds];
  }

  if (clienteId) {
    const { data: clientRoutes } = await db
      .from('whatsapp_routes')
      .select('group_id')
      .eq('enabled', true)
      .eq('notification_type', notificationType)
      .eq('cliente_id', clienteId);

    const rows = (clientRoutes ?? []) as RouteRow[];
    if (rows.length > 0) {
      return [...new Set(rows.map((r) => r.group_id))];
    }
  }

  // Fallback: rutas globales por tipo (cliente_id IS NULL)
  const { data: globalRoutes } = await db
    .from('whatsapp_routes')
    .select('group_id')
    .eq('enabled', true)
    .eq('notification_type', notificationType)
    .is('cliente_id', null);

  const rows = (globalRoutes ?? []) as RouteRow[];
  return [...new Set(rows.map((r) => r.group_id))];
}

export async function sendWhatsAppNotification(
  args: SendNotificationArgs
): Promise<SendNotificationResult> {
  const { db, clienteId, notificationType, message, includeTeamAlertGroup } = args;

  const groups = await resolveTargetGroups(db, clienteId, notificationType, includeTeamAlertGroup);
  if (groups.length === 0) {
    return { sent: 0, failed: 0, skipped: true };
  }

  const results = await Promise.all(
    groups.map((groupId) => deliverOne(db, clienteId, notificationType, groupId, message))
  );

  const sent = results.filter(Boolean).length;
  return { sent, failed: results.length - sent, skipped: false };
}

async function deliverOne(
  db: Db,
  clienteId: string | null,
  notificationType: NotificationType,
  groupId: string,
  message: string
): Promise<boolean> {
  let gatewayMessageId: string | null = null;
  let errorMsg: string | null = null;

  try {
    const res = await sendToGroup(groupId, message);
    gatewayMessageId = res.messageId;
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
  }

  const ok = errorMsg === null;
  await db.from('whatsapp_messages').insert({
    cliente_id: clienteId,
    notification_type: notificationType,
    group_id: groupId,
    message,
    status: ok ? 'sent' : 'error',
    gateway_message_id: gatewayMessageId,
    error: errorMsg,
    sent_at: ok ? new Date().toISOString() : null,
  });

  return ok;
}
