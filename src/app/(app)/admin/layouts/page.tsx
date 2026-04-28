import { getLayouts } from '../settings/_actions'
import { LayoutBuilderClient } from './LayoutBuilderClient'
import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'

export default async function LayoutsPage() {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) redirect('/login')

    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

    const role = profile?.role ?? 'viewer'
    const isAdmin = ['superadmin', 'admin'].includes(role)

    const layouts = await getLayouts()

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-bold tracking-tight text-white">Constructor de Layouts</h2>
                <p className="text-zinc-400">Crea y edita plantillas de métricas para asignarlas a tus clientes.</p>
            </div>
            <LayoutBuilderClient layouts={layouts} isAdmin={isAdmin} />
        </div>
    )
}
