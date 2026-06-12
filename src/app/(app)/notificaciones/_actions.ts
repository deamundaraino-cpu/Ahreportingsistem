'use server'

// Server actions del módulo de notificaciones in-app.
// Todas operan con el cliente autenticado: el RLS de public.notifications /
// notification_preferences (migración 022) limita cada query al usuario actual.

import { createClient, createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { notifyUsers } from '@/lib/notifications/notify'
import type { InAppNotification, InAppNotificationType } from '@/lib/notifications/types'

const PAGE_SIZE = 50

export async function getNotifications(opts?: {
    page?: number
    limit?: number
    type?: InAppNotificationType
    unreadOnly?: boolean
}): Promise<{ items: InAppNotification[]; total: number }> {
    const supabase = await createClient()
    const page = opts?.page ?? 0
    const limit = opts?.limit ?? PAGE_SIZE

    let query = supabase
        .from('notifications')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(page * limit, page * limit + limit - 1)

    if (opts?.type) query = query.eq('type', opts.type)
    if (opts?.unreadOnly) query = query.is('read_at', null)

    const { data, count, error } = await query
    if (error) return { items: [], total: 0 }
    return { items: (data ?? []) as InAppNotification[], total: count ?? 0 }
}

export async function getUnreadCount(): Promise<number> {
    const supabase = await createClient()
    const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .is('read_at', null)
    return count ?? 0
}

export async function markAsRead(id: string): Promise<{ ok: boolean }> {
    const supabase = await createClient()
    const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', id)
        .is('read_at', null)
    return { ok: !error }
}

export async function markAllAsRead(): Promise<{ ok: boolean }> {
    const supabase = await createClient()
    const { error } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .is('read_at', null)
    revalidatePath('/notificaciones')
    return { ok: !error }
}

export async function getPreferences(): Promise<Record<string, boolean>> {
    const supabase = await createClient()
    const { data } = await supabase
        .from('notification_preferences')
        .select('type, enabled')
    const prefs: Record<string, boolean> = {}
    for (const row of (data ?? []) as { type: string; enabled: boolean }[]) {
        prefs[row.type] = row.enabled
    }
    return prefs
}

export async function updatePreference(
    type: InAppNotificationType,
    enabled: boolean
): Promise<{ ok: boolean }> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { ok: false }

    const { error } = await supabase
        .from('notification_preferences')
        .upsert({ user_id: user.id, type, enabled, updated_at: new Date().toISOString() })
    return { ok: !error }
}

// Solo para verificar el flujo end-to-end (realtime + toast). Admin-only.
export async function sendTestNotification(): Promise<{ ok: boolean; inserted: number }> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { ok: false, inserted: 0 }

    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()
    if (!profile || !['admin', 'superadmin'].includes(profile.role)) {
        return { ok: false, inserted: 0 }
    }

    const adminSupabase = await createAdminClient()
    const result = await notifyUsers({
        db: adminSupabase,
        type: 'system',
        severity: 'info',
        title: 'Notificación de prueba',
        message: 'Si ves esto, el sistema de notificaciones funciona correctamente.',
        audience: { userIds: [user.id] },
    })
    return { ok: result.inserted > 0, inserted: result.inserted }
}
