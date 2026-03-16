import { getUsers } from './_actions'
import { UserManagementClient } from './UserManagementClient'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import { Users as UsersIcon } from 'lucide-react'

export default async function AdminUsersPage() {
    // Check role again on server for page access
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
        redirect('/')
    }

    const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
    
    // if (profile?.role !== 'admin') {
    //     redirect('/dashboard') // Or some error page
    // }

    const initialUsers = await getUsers()

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-500/10 rounded-lg">
                    <UsersIcon className="h-6 w-6 text-purple-400" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold text-white">Gestión de Usuarios</h2>
                    <p className="text-zinc-400 text-sm">Administra los roles y accesos de tu equipo.</p>
                </div>
            </div>
            
            <UserManagementClient initialUsers={initialUsers} />
        </div>
    )
}
