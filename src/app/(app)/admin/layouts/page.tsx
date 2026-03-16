import { getLayouts } from '../settings/_actions'
import { LayoutBuilderClient } from './LayoutBuilderClient'
import { createClient } from '@/utils/supabase/server'

export default async function LayoutsPage() {
    const layouts = await getLayouts()
    
    // Fetch user and role
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user?.id).single()
    const isAdmin = profile?.role === 'admin'

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
