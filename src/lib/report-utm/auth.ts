import { NextResponse } from 'next/server'
import { getSesionActual } from '@/lib/auth-session'

// ============================================================
// Autorización compartida del módulo report-utm.
// Roles con permiso de escritura (S2S, mapeos de campaña, etc.):
// los mismos que pueden operar el módulo. El detalle por cliente lo
// refuerza RLS; aquí solo se valida el rol.
// ============================================================

export const REPORT_UTM_WRITE_ROLES = new Set(['superadmin', 'admin', 'trafficker'])

/**
 * Rol del usuario autenticado (o null si no hay sesión / perfil).
 * Se apoya en `getSesionActual()`, memoizado por petición, para que varias
 * comprobaciones dentro del mismo render no repitan las dos consultas.
 */
export async function getUserRole(): Promise<string | null> {
    const { userId, role } = await getSesionActual()
    return userId ? role : null
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

/** Roles que pueden operar los endpoints internos de administración. */
export const ADMIN_ROLES = new Set(['superadmin', 'admin'])

/**
 * Guard para los handlers de `/api/admin/*`. El proxy ya exige sesión en esas
 * rutas, pero la comprobación de rol vive aquí para que la ruta no dependa de
 * una sola barrera: si alguien reordena la allowlist del proxy, el handler
 * sigue negando a quien no es admin.
 *
 * Devuelve `null` si el usuario puede pasar, o la `NextResponse` de error que
 * el handler debe devolver tal cual.
 */
export async function requireAdminRole(): Promise<NextResponse | null> {
    const role = await getUserRole()
    if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!ADMIN_ROLES.has(role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    return null
}
