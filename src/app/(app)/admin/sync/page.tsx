import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'
import { getSyncPanelData } from './_actions'
import { SyncPanelClient } from './SyncPanelClient'

export const dynamic = 'force-dynamic'

/**
 * Panel de estado de la sincronización.
 *
 * Hasta ahora los logs del worker solo viajaban en la respuesta HTTP del cron,
 * que nadie leía: un cliente con Hotmart caído tres días seguidos era
 * indistinguible de un cliente sin ventas. Aquí se ve la cola, el historial de
 * ejecuciones y los períodos congelados.
 */
export default async function SyncAdminPage() {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) redirect('/login')

    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

    const role = profile?.role ?? 'viewer'
    if (!['superadmin', 'admin', 'trafficker'].includes(role)) redirect('/dashboard')
    const isAdmin = ['superadmin', 'admin'].includes(role)

    const data = await getSyncPanelData()

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl font-bold tracking-tight text-foreground">Sincronización</h2>
                <p className="text-muted-foreground">
                    Estado de la cola, historial de ejecuciones y períodos congelados.
                </p>
            </div>
            <SyncPanelClient data={data} isAdmin={isAdmin} />
        </div>
    )
}
