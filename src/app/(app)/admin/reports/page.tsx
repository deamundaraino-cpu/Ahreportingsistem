import { getMonthlyReports, getReportTemplates } from './_actions'
import { ReportsClient } from './ReportsClient'
import { createAdminClient } from '@/utils/supabase/server'
import { FileText } from 'lucide-react'

export default async function AdminReportsPage() {
    const supabase = await createAdminClient()

    const [reports, templates, clientesRes] = await Promise.all([
        getMonthlyReports(),
        getReportTemplates(),
        supabase.from('clientes').select('id, nombre').order('nombre'),
    ])

    const clientes = clientesRes.data || []

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-3">
                <div className="p-2 bg-indigo-500/10 rounded-lg">
                    <FileText className="h-6 w-6 text-indigo-400" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold text-white">Reportes Mensuales</h2>
                    <p className="text-zinc-400 text-sm">Genera y publica reportes de rendimiento para tus clientes.</p>
                </div>
            </div>

            <ReportsClient
                initialReports={reports}
                templates={templates}
                clientes={clientes}
            />
        </div>
    )
}
