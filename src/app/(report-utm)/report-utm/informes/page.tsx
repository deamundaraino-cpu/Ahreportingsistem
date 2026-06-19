import Link from 'next/link'
import { createAdminClient } from '@/utils/supabase/server'
import { reportUtmAdminClient } from '@/lib/report-utm/client'
import { BarChart2, PlusCircle, LayoutTemplate, Clock, ArrowRight, Lock } from 'lucide-react'
import { formatDate } from '@/lib/report-utm/formatters'
import { HelpTip } from '@/components/report-utm/bi/HelpTip'

export const dynamic = 'force-dynamic'

export default async function InformesPage() {
    const db = await createAdminClient()
    const rtm = await reportUtmAdminClient()

    const [{ data: reports }, { data: clientes }] = await Promise.all([
        db.from('bi_reports')
            .select('id,nombre,descripcion,filters,created_at,updated_at,cliente_id')
            .order('updated_at', { ascending: false })
            .limit(100),
        rtm.from('clientes').select('id,nombre'),
    ])

    const clienteMap = new Map((clientes ?? []).map((c: { id: string; nombre: string }) => [c.id, c.nombre]))

    const templates = (reports ?? []).filter((r) => !r.cliente_id)
    const custom    = (reports ?? []).filter((r) => !!r.cliente_id)

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

            {/* Templates */}
            <section>
                <div className="flex items-center gap-2 mb-4">
                    <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">Plantillas del sistema</h2>
                    <HelpTip text="Informes prearmados listos para usar (Rendimiento por Fuente, Tendencia de Leads, ROAS por Campaña, Funnel). Ábrelos para verlos o duplica sus widgets en tus propios informes." />
                    <span className="px-1.5 py-0.5 rounded-md bg-muted text-[10px] font-mono text-muted-foreground">
                        {templates.length}
                    </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                    {templates.map((r) => (
                        <ReportCard key={r.id} report={r} isTemplate />
                    ))}
                </div>
            </section>

            {/* Custom reports */}
            <section>
                <div className="flex items-center gap-2 mb-4">
                    <BarChart2 className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-foreground">Mis informes</h2>
                    <HelpTip text="Tus informes personalizados. Crea uno con 'Nuevo Informe', agrega widgets en modo edición y compártelos con un link público cuando estén listos." />
                    <span className="px-1.5 py-0.5 rounded-md bg-muted text-[10px] font-mono text-muted-foreground">
                        {custom.length}
                    </span>
                </div>
                {custom.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                        {custom.map((r) => (
                            <ReportCard key={r.id} report={r} clienteName={r.cliente_id ? clienteMap.get(r.cliente_id) : undefined} />
                        ))}
                    </div>
                ) : (
                    <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-12 text-center">
                        <BarChart2 className="h-8 w-8 text-muted-foreground/50 mx-auto mb-3" />
                        <p className="text-sm font-medium text-foreground mb-1">Sin informes personalizados</p>
                        <p className="text-xs text-muted-foreground mb-4">
                            Crea tu primer informe o usa una plantilla del sistema.
                        </p>
                        <Link
                            href="/report-utm/informes/nuevo"
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald"
                        >
                            <PlusCircle className="h-3.5 w-3.5" />
                            Crear informe
                        </Link>
                    </div>
                )}
            </section>
        </div>
    )
}

type Report = {
    id: string
    nombre: string
    descripcion?: string | null
    updated_at: string
    cliente_id?: string | null
}

function ReportCard({ report, isTemplate, clienteName }: { report: Report; isTemplate?: boolean; clienteName?: string }) {
    return (
        <Link
            href={`/report-utm/informes/${report.id}`}
            className="group rounded-2xl border border-border bg-card p-5 hover:border-emerald-500/40 hover:shadow-sm transition-all duration-200 flex flex-col gap-3"
        >
            <div className="flex items-start justify-between gap-2">
                <div className="h-9 w-9 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10 flex-shrink-0">
                    <BarChart2 className="h-4.5 w-4.5 text-emerald-600 dark:text-emerald-400" />
                </div>
                {isTemplate ? (
                    <span className="px-1.5 py-0.5 rounded-md bg-muted text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        plantilla
                    </span>
                ) : clienteName ? (
                    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-500/10 text-[9px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                        <Lock className="h-2.5 w-2.5" />
                        {clienteName}
                    </span>
                ) : null}
            </div>

            <div className="flex-1">
                <p className="text-sm font-semibold text-foreground group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors line-clamp-1">
                    {report.nombre}
                </p>
                {report.descripcion && (
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {report.descripcion}
                    </p>
                )}
            </div>

            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {formatDate(report.updated_at)}
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-emerald-500 transition-colors" />
            </div>
        </Link>
    )
}
