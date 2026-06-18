import { notFound } from 'next/navigation'
import { createAdminClient } from '@/utils/supabase/server'
import { BiReportCanvas } from '@/components/report-utm/bi/BiReportCanvas'
import type { BiReport } from '@/components/report-utm/bi/BiTypes'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

export default async function PublicBiReportPage({ params }: Params) {
    const { token } = await params
    const db = await createAdminClient()

    const { data, error } = await db
        .from('bi_reports')
        .select('*')
        .eq('public_token', token)
        .maybeSingle()

    if (error || !data) notFound()

    const report: BiReport = {
        id:          data.id,
        nombre:      data.nombre,
        descripcion: data.descripcion,
        layout:      Array.isArray(data.layout) ? data.layout : [],
        filters:     typeof data.filters === 'object' && data.filters ? data.filters : {},
        calculated_fields: Array.isArray(data.calculated_fields) ? data.calculated_fields : [],
        cliente_id:  data.cliente_id,
    }

    return (
        <div className="min-h-screen bg-background">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
                <div className="mb-2 flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                        Report-UTM · Informe compartido
                    </span>
                </div>
                <BiReportCanvas report={report} readonly />
                <p className="mt-8 text-center text-[10px] text-muted-foreground">
                    Vista de solo lectura · Ad House Reporting
                </p>
            </div>
        </div>
    )
}
