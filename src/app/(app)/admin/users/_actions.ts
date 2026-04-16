'use server'

import { createClient, createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

export async function getUsers() {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) return []

    // TODO: Implement role-based access control
    // const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
    // if (profile?.role !== 'admin') return []

    // Get all profiles
    const adminSupabase = await createAdminClient()
    const { data: profiles, error: profileError } = await adminSupabase
        .from('user_profiles')
        .select('*')
        .order('updated_at', { ascending: false })

    if (profileError) {
        console.error('Error fetching profiles:', profileError)
        return []
    }

    // Get all users from auth to match emails
    const { data: { users: authUsers }, error: authError } = await adminSupabase.auth.admin.listUsers()
    
    if (authError) {
        console.error('Error fetching auth users:', authError)
        return profiles // Return profiles anyway, but without email
    }

    // Merge email into profiles
    const mergedUsers = profiles.map(p => {
        const authUser = authUsers.find(u => u.id === p.id)
        return {
            ...p,
            email: authUser?.email || 'No email'
        }
    })

    return mergedUsers
}

export async function updateUserRole(userId: string, newRole: string) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) return { error: 'No autorizado' }

    // Check if current user is admin
    const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') return { error: 'Solo los administradores pueden cambiar roles' }

    const adminSupabase = await createAdminClient()
    const { error } = await adminSupabase
        .from('user_profiles')
        .update({ role: newRole })
        .eq('id', userId)

    if (error) {
        return { error: error.message }
    }

    revalidatePath('/admin/users')
    return { success: true }
}

export async function deleteUser(userId: string) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) return { error: 'No autorizado' }

    // Check if current user is admin
    const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') return { error: 'Solo los administradores pueden eliminar usuarios' }

    // Prevent deleting self
    if (user.id === userId) return { error: 'No puedes eliminarte a ti mismo' }

    const adminSupabase = await createAdminClient()
    
    // Delete profile (RLS handles this but Admin Client is safer here)
    // Note: To delete from auth.users we'd need admin.auth.deleteUser
    const { error: profileError } = await adminSupabase
        .from('user_profiles')
        .delete()
        .eq('id', userId)

    if (profileError) return { error: profileError.message }

    // Optional: Delete from auth.users if needed
    await adminSupabase.auth.admin.deleteUser(userId)

    revalidatePath('/admin/users')
    return { success: true }
}
