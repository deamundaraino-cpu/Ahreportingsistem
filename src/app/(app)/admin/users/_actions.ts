'use server'

import { createClient, createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

type Role = 'superadmin' | 'admin' | 'trafficker' | 'viewer'

const ROLE_HIERARCHY: Record<Role, number> = {
    superadmin: 4,
    admin: 3,
    trafficker: 2,
    viewer: 1,
}

async function getCurrentUserRole(): Promise<{ userId: string; role: Role } | null> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null

    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

    return { userId: user.id, role: (profile?.role ?? 'viewer') as Role }
}

export async function getUsers() {
    const current = await getCurrentUserRole()
    if (!current || !['superadmin', 'admin'].includes(current.role)) return []

    const adminSupabase = await createAdminClient()
    const { data: profiles, error: profileError } = await adminSupabase
        .from('user_profiles')
        .select('*')
        .order('updated_at', { ascending: false })

    if (profileError) return []

    const { data: { users: authUsers }, error: authError } = await adminSupabase.auth.admin.listUsers()
    if (authError) return profiles

    const mergedUsers = profiles.map(p => {
        const authUser = authUsers.find(u => u.id === p.id)
        return { ...p, email: authUser?.email || 'No email' }
    })

    return mergedUsers
}

export async function updateUserRole(targetUserId: string, newRole: string) {
    const current = await getCurrentUserRole()
    if (!current) return { error: 'No autorizado' }

    const validRoles: Role[] = ['superadmin', 'admin', 'trafficker', 'viewer']
    if (!validRoles.includes(newRole as Role)) return { error: 'Rol inválido' }

    const newRoleLevel = ROLE_HIERARCHY[newRole as Role]
    const currentLevel = ROLE_HIERARCHY[current.role]

    // Only superadmin can assign superadmin role
    if (newRole === 'superadmin' && current.role !== 'superadmin') {
        return { error: 'Solo el superadmin puede asignar el rol de superadmin' }
    }

    // Cannot elevate someone to your own level unless you're superadmin
    if (newRoleLevel >= currentLevel && current.role !== 'superadmin') {
        return { error: 'No puedes asignar un rol igual o superior al tuyo' }
    }

    // Get target user's current role
    const adminSupabase = await createAdminClient()
    const { data: targetProfile } = await adminSupabase
        .from('user_profiles')
        .select('role')
        .eq('id', targetUserId)
        .single()

    const targetCurrentRole = (targetProfile?.role ?? 'viewer') as Role
    const targetCurrentLevel = ROLE_HIERARCHY[targetCurrentRole]

    // Admin cannot modify superadmin or other admins
    if (current.role === 'admin' && targetCurrentLevel >= ROLE_HIERARCHY['admin']) {
        return { error: 'No puedes modificar a un admin o superadmin' }
    }

    // Prevent self-demotion
    if (targetUserId === current.userId && newRoleLevel < currentLevel) {
        return { error: 'No puedes reducir tu propio rol' }
    }

    const { error } = await adminSupabase
        .from('user_profiles')
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq('id', targetUserId)

    if (error) return { error: error.message }

    revalidatePath('/admin/users')
    return { success: true }
}

export async function deleteUser(userId: string) {
    const current = await getCurrentUserRole()
    if (!current) return { error: 'No autorizado' }
    if (!['superadmin', 'admin'].includes(current.role)) return { error: 'Sin permisos para eliminar usuarios' }
    if (current.userId === userId) return { error: 'No puedes eliminarte a ti mismo' }

    const adminSupabase = await createAdminClient()

    // Admins cannot delete other admins or superadmins
    const { data: targetProfile } = await adminSupabase
        .from('user_profiles')
        .select('role')
        .eq('id', userId)
        .single()

    const targetRole = (targetProfile?.role ?? 'viewer') as Role
    if (current.role === 'admin' && ROLE_HIERARCHY[targetRole] >= ROLE_HIERARCHY['admin']) {
        return { error: 'No puedes eliminar a un admin o superadmin' }
    }

    const { error: profileError } = await adminSupabase
        .from('user_profiles')
        .delete()
        .eq('id', userId)

    if (profileError) return { error: profileError.message }

    await adminSupabase.auth.admin.deleteUser(userId)

    revalidatePath('/admin/users')
    return { success: true }
}

export async function getClientAssignments(targetUserId: string) {
    const current = await getCurrentUserRole()
    if (!current || !['superadmin', 'admin'].includes(current.role)) return []

    const adminSupabase = await createAdminClient()
    const { data, error } = await adminSupabase
        .from('user_client_assignments')
        .select('client_id')
        .eq('user_id', targetUserId)

    if (error) return []
    return data.map(r => r.client_id)
}

export async function setClientAssignments(targetUserId: string, clientIds: string[]) {
    const current = await getCurrentUserRole()
    if (!current || !['superadmin', 'admin'].includes(current.role)) {
        return { error: 'Sin permisos para asignar clientes' }
    }

    const adminSupabase = await createAdminClient()

    // Delete all current assignments for this user
    await adminSupabase
        .from('user_client_assignments')
        .delete()
        .eq('user_id', targetUserId)

    if (clientIds.length === 0) {
        revalidatePath('/admin/users')
        return { success: true }
    }

    const rows = clientIds.map(client_id => ({
        user_id: targetUserId,
        client_id,
        assigned_by: current.userId,
    }))

    const { error } = await adminSupabase
        .from('user_client_assignments')
        .insert(rows)

    if (error) return { error: error.message }

    revalidatePath('/admin/users')
    return { success: true }
}

export async function getAllClients() {
    const current = await getCurrentUserRole()
    if (!current || !['superadmin', 'admin'].includes(current.role)) return []

    const adminSupabase = await createAdminClient()
    const { data, error } = await adminSupabase
        .from('clientes')
        .select('id, nombre')
        .order('nombre', { ascending: true })

    if (error) return []
    return data
}

export async function createUser(input: {
    email: string
    password: string
    fullName: string
    role: Role
    clientIds: string[]
}) {
    const current = await getCurrentUserRole()
    if (!current || !['superadmin', 'admin'].includes(current.role)) {
        return { error: 'Sin permisos para crear usuarios' }
    }

    // Admin cannot create admins or superadmins
    if (current.role === 'admin' && ['superadmin', 'admin'].includes(input.role)) {
        return { error: 'Solo el superadmin puede crear admins' }
    }

    const adminSupabase = await createAdminClient()

    // 1. Create auth user
    const { data: authData, error: authError } = await adminSupabase.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: true,
        user_metadata: { full_name: input.fullName },
    })

    if (authError) return { error: authError.message }
    const newUserId = authData.user.id

    // 2. Create profile (trigger may do this, but upsert to be safe)
    const { error: profileError } = await adminSupabase
        .from('user_profiles')
        .upsert({
            id: newUserId,
            role: input.role,
            full_name: input.fullName,
            updated_at: new Date().toISOString(),
        })

    if (profileError) {
        // Rollback auth user
        await adminSupabase.auth.admin.deleteUser(newUserId)
        return { error: profileError.message }
    }

    // 3. Assign clients if any
    if (input.clientIds.length > 0) {
        const rows = input.clientIds.map(client_id => ({
            user_id: newUserId,
            client_id,
            assigned_by: current.userId,
        }))
        await adminSupabase.from('user_client_assignments').insert(rows)
    }

    revalidatePath('/admin/users')
    return {
        success: true,
        user: {
            id: newUserId,
            email: input.email,
            role: input.role,
            full_name: input.fullName,
            updated_at: new Date().toISOString(),
        },
    }
}
