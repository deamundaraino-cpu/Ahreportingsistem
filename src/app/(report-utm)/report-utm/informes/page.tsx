import Link from 'next/link'
import { createAdminClient } from '@/utils/supabase/server'
import { reportUtmAdminClient } from '@/lib/report-utm/client'
import { PlusCircle } from 'lucide-react'
import { InformesBrowser, type Report } from './InformesBrowser'

export const dynamic = 'force-dynamic'

export default async function InformesPage(props: {
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    const searchParams = await props.searchParams
    // ?cliente=<report_utm.clientes.id> — deep link desde el dashboard del cliente.
    const initialClienteId = typeof searchParams.cliente === 'string' ? searchParams.cliente : ''

    const db = await createAdminClient()
    const rtm = await reportUtmAdminClient()

    const [{ data: reports }, { data: clientes }] = await Promise.all([
        db.from('bi_reports')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(100),
        rtm.from('clientes').select('id,nombre'),
    ])

    // is_template explícito (migración 035); fallback al heurístico anterior si no existe
    const isTpl = (r: { is_template?: boolean; cliente_id?: string | null }) => r.is_template ?? !r.cliente_id
    const templates: Report[] = (reports ?? []).filter(isTpl)
    const custom: Report[] = (reports ?? []).filter((r) => !isTpl(r))
    // Las plantillas sin autor son las del sistema: no se pueden eliminar.
    const editableTemplateIds = templates
        .filter((r) => (r as { created_by?: string | null }).created_by)
        .map((r) => r.id)

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex items-end justify-between gap-4 flex-wrap">
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                        Report-UTM · BI Builder
                    </p>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">
                        Informes
                    </h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Crea reportes personalizados combinando leads, ventas y gasto publicitario.
                    </p>
                </div>
                <Link
                    href="/report-utm/informes/nuevo"
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white nav-active-emerald shadow-sm"
                >
                    <PlusCircle className="h-4 w-4" />
                    Nuevo Informe
                </Link>
            </div>

            <InformesBrowser
                custom={custom}
                templates={templates}
                editableTemplateIds={editableTemplateIds}
                clientes={(clientes ?? []) as { id: string; nombre: string }[]}
                initialClienteId={initialClienteId}
            />
        </div>
    )
}
