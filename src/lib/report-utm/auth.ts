import { createClient } from '@/utils/supabase/server'

// ============================================================
// Autorización compartida del módulo report-utm.
// Roles con permiso de escritura (S2S, mapeos de campaña, etc.):
// los mismos que pueden operar el módulo. El detalle por cliente lo
// refuerza RLS; aquí solo se valida el rol.
// ============================================================

export const REPORT_UTM_WRITE_ROLES = new Set(['superadmin', 'admin', 'trafficker'])

/** Rol del usuario autenticado (o null si no hay sesión / perfil). */
export async function getUserRole(): Promise<string | null> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null
    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle()
    return profile?.role ?? null
}

/**
 * Verifica que el usuario tenga un rol con permiso de escritura en report-utm.
 * Devuelve `{ ok: true, role }` o `{ ok: false, role }` para que el llamador
 * decida el código de respuesta (403 en API, mensaje en server action).
 */
export async function checkWriteRole(): Promise<{ ok: boolean; role: string | null }> {
    const role = await getUserRole()
    return { ok: !!role && REPORT_UTM_WRITE_ROLES.has(role), role }
}
