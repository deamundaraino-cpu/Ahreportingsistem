import { getCliente, getLayouts } from '../_actions'
import { ClientConfigForm } from '../components/ClientConfigForm'
import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'

export default async function ClientDetailPage(props: { params: Promise<{ id: string }> }) {
    const params = await props.params;
    
    // Fetch user and role
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user?.id).single()
    const isAdmin = true // profile?.role === 'admin'

    const [cliente, layouts] = await Promise.all([
        getCliente(params.id),
        getLayouts(),
    ])

    if (!cliente) {
        redirect('/admin/clientes')
    }

    return (
        <div className="max-w-3xl mx-auto py-6">
            <ClientConfigForm cliente={cliente} layouts={layouts} isAdmin={isAdmin} />
        </div>
    )
}
