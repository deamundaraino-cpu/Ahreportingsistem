// Lógica central de creación de notificaciones in-app.
//
// Reutilizable por todos los disparadores del server: webhooks de ventas
// (report-utm), acciones de soporte, asignación de clientes y crons.
// Resuelve los destinatarios según rol/asignación de cliente, respeta las
// preferencias opt-out del usuario y hace el insert batch en
// public.notifications. Estilo análogo a sendWhatsAppNotification en
// src/lib/whatsapp/notify.ts: nunca lanza, devuelve conteo.
//
// Las alertas de umbral de presupuesto NO pasan por aquí: las inserta el
// trigger trg_notify_budget_alert (migración 022) porque el writer de
// cliente_tabs.alert_sent_at_* es un worker externo.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { InAppNotificationType, NotificationSeverity } from './types';

type Db = SupabaseClient;

export type NotifyAudience =
  | 'admins' // admins + superadmins
  | 'client_team' // admins + traffickers asignados al cliente (requiere clienteId)
  | { userIds: string[] }; // destinatarios explícitos

export type NotifyUsersArgs = {
  db: Db; // admin client (service_role) — INSERT en notifications bypassa RLS
  type: InAppNotificationType;
  title: string;
  message?: string;
  link?: string;
  severity?: NotificationSeverity;
  clienteId?: string | null;
  audience?: NotifyAudience; // default: 'client_team' si hay clienteId, si no 'admins'
  metadata?: Record<string, unknown>;
};

export type NotifyUsersResult = {
  inserted: number;
};

async function resolveRecipients(
  db: Db,
  audience: NotifyAudience,
  clienteId: string | null
): Promise<string[]> {
  if (typeof audience === 'object') {
    return [...new Set(audience.userIds)];
  }

  const { data: admins } = await db
    .from('user_profiles')
    .select('id')
    .in('role', ['admin', 'superadmin']);

  const ids = new Set<string>((admins ?? []).map((r: { id: string }) => r.id));

  if (audience === 'client_team' && clienteId) {
    const { data: assignments } = await db
      .from('user_client_assignments')
      .select('user_id')
      .eq('client_id', clienteId);
    for (const row of (assignments ?? []) as { user_id: string }[]) {
      ids.add(row.user_id);
    }
  }

  return [...ids];
}

// Filtra los usuarios que desactivaron este tipo (opt-out: sin fila = habilitado).
async function applyPreferences(db: Db, userIds: string[], type: InAppNotificationType): Promise<string[]> {
  if (userIds.length === 0) return [];

  const { data: optedOut } = await db
    .from('notification_preferences')
    .select('user_id')
    .eq('type', type)
    .eq('enabled', false)
    .in('user_id', userIds);

  const excluded = new Set((optedOut ?? []).map((r: { user_id: string }) => r.user_id));
  return userIds.filter((id) => !excluded.has(id));
}

export async function notifyUsers(args: NotifyUsersArgs): Promise<NotifyUsersResult> {
  try {
    const clienteId = args.clienteId ?? null;
    const audience: NotifyAudience = args.audience ?? (clienteId ? 'client_team' : 'admins');

    const candidates = await resolveRecipients(args.db, audience, clienteId);
    const recipients = await applyPreferences(args.db, candidates, args.type);
    if (recipients.length === 0) return { inserted: 0 };

    const rows = recipients.map((userId) => ({
      user_id: userId,
      type: args.type,
      severity: args.severity ?? 'info',
      title: args.title,
      message: args.message ?? null,
      link: args.link ?? null,
      cliente_id: clienteId,
      metadata: args.metadata ?? {},
    }));

    const { error } = await args.db.from('notifications').insert(rows);
    if (error) {
      console.error('[notifications] insert failed:', error.message);
      return { inserted: 0 };
    }
    return { inserted: rows.length };
  } catch (e) {
    console.error('[notifications] notifyUsers error:', e);
    return { inserted: 0 };
  }
}
