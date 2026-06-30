'use server';

import { createClient, createAdminClient } from '@/utils/supabase/server';
import { revalidatePath } from 'next/cache';
import * as gateway from '@/lib/whatsapp/gateway';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import { NOTIFICATION_TYPES, type NotificationType } from '@/lib/whatsapp/types';

type Role = 'superadmin' | 'admin' | 'trafficker' | 'viewer';

async function requireAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'No autorizado' };

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = (profile?.role ?? 'viewer') as Role;
  if (!['superadmin', 'admin'].includes(role)) {
    return { ok: false, error: 'Sin permisos para gestionar WhatsApp' };
  }
  return { ok: true };
}

// ── Estado de conexión / QR ──────────────────────────────────────
export async function getWhatsAppStatus() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };
  try {
    const status = await gateway.getStatus();
    return { status };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Gateway inaccesible' };
  }
}

export async function getWhatsAppQr() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };
  try {
    return await gateway.getQr();
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Gateway inaccesible' };
  }
}

// ── Grupos ───────────────────────────────────────────────────────
export async function syncGroups() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  let groups;
  try {
    groups = await gateway.listGroups();
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Gateway inaccesible' };
  }

  const admin = await createAdminClient();
  const rows = groups.map((g) => ({
    group_id: g.id,
    group_name: g.name,
    synced_at: new Date().toISOString(),
  }));
  if (rows.length > 0) {
    const { error } = await admin.from('whatsapp_groups').upsert(rows, { onConflict: 'group_id' });
    if (error) return { error: error.message };
  }

  revalidatePath('/admin/whatsapp');
  return { success: true, count: rows.length };
}

export async function getGroups() {
  const admin = await createAdminClient();
  const { data } = await admin
    .from('whatsapp_groups')
    .select('id, group_id, group_name, enabled')
    .order('group_name');
  return data ?? [];
}

// ── Clientes (lista mínima para el selector de rutas) ────────────
export async function getClientesMin() {
  const admin = await createAdminClient();
  const { data } = await admin.from('clientes').select('id, nombre').order('nombre');
  return data ?? [];
}

// ── Rutas ────────────────────────────────────────────────────────
export async function getRoutes() {
  const admin = await createAdminClient();
  const { data } = await admin
    .from('whatsapp_routes')
    .select(
      'id, cliente_id, notification_type, group_id, enabled, cliente:clientes(nombre), grupo:whatsapp_groups(group_name)'
    )
    .order('created_at', { ascending: false });
  return data ?? [];
}

export async function upsertRoute(input: {
  clienteId: string | null;
  notificationType: string;
  groupId: string;
}) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!NOTIFICATION_TYPES.includes(input.notificationType as NotificationType)) {
    return { error: 'Tipo de notificación inválido' };
  }
  if (!input.groupId) return { error: 'Grupo requerido' };

  const admin = await createAdminClient();
  const { error } = await admin.from('whatsapp_routes').insert({
    cliente_id: input.clienteId,
    notification_type: input.notificationType,
    group_id: input.groupId,
    enabled: true,
  });
  if (error) {
    // 23505 = unique_violation (ruta ya existe)
    if (error.code === '23505') return { error: 'Esa ruta ya existe' };
    return { error: error.message };
  }

  revalidatePath('/admin/whatsapp');
  return { success: true };
}

export async function setRouteEnabled(routeId: string, enabled: boolean) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const admin = await createAdminClient();
  const { error } = await admin.from('whatsapp_routes').update({ enabled }).eq('id', routeId);
  if (error) return { error: error.message };

  revalidatePath('/admin/whatsapp');
  return { success: true };
}

export async function deleteRoute(routeId: string) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const admin = await createAdminClient();
  const { error } = await admin.from('whatsapp_routes').delete().eq('id', routeId);
  if (error) return { error: error.message };

  revalidatePath('/admin/whatsapp');
  return { success: true };
}

// ── Envío manual ─────────────────────────────────────────────────
export async function sendManualWhatsApp(input: { clienteId: string | null; message: string }) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  if (!input.message.trim()) return { error: 'El mensaje no puede estar vacío' };

  const admin = await createAdminClient();
  const result = await sendWhatsAppNotification({
    db: admin,
    clienteId: input.clienteId,
    notificationType: 'manual',
    message: input.message.trim(),
  });

  revalidatePath('/admin/whatsapp');
  if (result.skipped) {
    return { error: 'No hay ningún grupo ruteado para "Envío manual" (ni del cliente ni global)' };
  }
  return { success: true, sent: result.sent, failed: result.failed };
}

// ── Grupo general fijo del equipo (alertas) ──────────────────────
const ALERT_TEAM_GROUP_KEY = 'whatsapp_alert_team_group';

export async function getAlertTeamGroup(): Promise<{
  group_id: string | null;
  enabled: boolean;
}> {
  const admin = await createAdminClient();
  const { data } = await admin
    .from('system_settings')
    .select('value')
    .eq('key', ALERT_TEAM_GROUP_KEY)
    .maybeSingle();

  const value = (data?.value ?? null) as { group_id?: string | null; enabled?: boolean } | null;
  return {
    group_id: value?.group_id ?? null,
    enabled: value?.enabled ?? false,
  };
}

export async function setAlertTeamGroup(input: {
  groupId: string | null;
  enabled: boolean;
}) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const admin = await createAdminClient();
  const { error } = await admin.from('system_settings').upsert({
    key: ALERT_TEAM_GROUP_KEY,
    value: { group_id: input.groupId, enabled: input.enabled },
    updated_at: new Date().toISOString(),
  });
  if (error) return { error: error.message };

  revalidatePath('/admin/whatsapp');
  return { success: true };
}

// ── Log reciente ─────────────────────────────────────────────────
export async function getRecentMessages() {
  const admin = await createAdminClient();
  const { data } = await admin
    .from('whatsapp_messages')
    .select(
      'id, cliente_id, notification_type, group_id, message, status, error, created_at, cliente:clientes(nombre)'
    )
    .order('created_at', { ascending: false })
    .limit(20);
  return data ?? [];
}
