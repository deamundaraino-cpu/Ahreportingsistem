import { getLayouts } from '../settings/_actions'
import { LayoutBuilderClient } from './LayoutBuilderClient'
import { TabTemplatesManager } from './TabTemplatesManager'
import { listTabTemplates } from '../../dashboard/_actions'
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

    const [layouts, tabTemplatesRes] = await Promise.all([getLayouts(), listTabTemplates()])

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-bold tracking-tight text-foreground">Constructor de Layouts</h2>
                <p className="text-muted-foreground">Crea y edita plantillas de métricas para asignarlas a tus clientes.</p>
            </div>
            <LayoutBuilderClient layouts={layouts} isAdmin={isAdmin} />
            <TabTemplatesManager templates={tabTemplatesRes.data || []} isAdmin={isAdmin} />
        </div>
    )
}
