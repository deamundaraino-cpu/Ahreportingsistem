import { notFound } from 'next/navigation'
import { createAdminClient } from '@/utils/supabase/server'
import { format, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'

interface Props {
    params: Promise<{ slug: string }>
}

async function getPublicReport(slug: string) {
    const supabase = await createAdminClient()
    const { data, error } = await supabase
        .from('monthly_reports')
        .select('*, cliente:clientes(id, nombre), template:report_templates(*)')
        .eq('public_slug', slug)
        .eq('estado', 'publicado')
        .maybeSingle()
    if (error || !data) return null
    return data
}

export default async function PublicMonthlyReportPage({ params }: Props) {
    const { slug } = await params
    const report = await getPublicReport(slug)

    if (!report) notFound()

    const campaigns: any[] = report.campaigns_included || []
    const totalSpend = campaigns.reduce((s: number, c: any) => s + (parseFloat(c.spend || '0') || 0), 0)
    const totalLeads = campaigns.reduce((s: number, c: any) => s + (parseInt(c.leads || '0') || 0), 0)
    const totalImpressions = campaigns.reduce((s: number, c: any) => s + (parseInt(c.impressions || '0') || 0), 0)
    const cpl = totalLeads > 0 ? totalSpend / totalLeads : null

    const periodoLabel = (() => {
        try {
            return format(parseISO(`${report.periodo}-01`), 'MMMM yyyy', { locale: es })
        } catch {
            return report.periodo
        }
    })()

    return (
        <div className="max-w-4xl mx-auto px-4 py-10 space-y-8">
            {/* Header */}
            <div className="border-b border-zinc-800 pb-6">
                <p className="text-zinc-500 text-sm mb-1">Reporte de Rendimiento Publicitario</p>
                <h1 className="text-3xl font-bold text-white">{report.cliente?.nombre}</h1>
                <p className="text-zinc-400 mt-1 capitalize">{periodoLabel}</p>
                {report.template && (
                    <span className="inline-block mt-2 text-xs text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">
                        {report.template.nombre}
                    </span>
                )}
            </div>

            {/* KPI Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                    <p className="text-zinc-400 text-xs mb-1">Gasto Total</p>
                    <p className="text-2xl font-bold text-white font-mono">${totalSpend.toFixed(2)}</p>
                </div>
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                    <p className="text-zinc-400 text-xs mb-1">Leads</p>
                    <p className="text-2xl font-bold text-emerald-400 font-mono">{totalLeads.toLocaleString()}</p>
                </div>
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                    <p className="text-zinc-400 text-xs mb-1">CPL</p>
                    <p className="text-2xl font-bold text-amber-400 font-mono">
                        {cpl !== null ? `$${cpl.toFixed(2)}` : '—'}
                    </p>
                </div>
                <div className="bg-zinc-900 rounded-xl p-4 border border-zinc-800">
                    <p className="text-zinc-400 text-xs mb-1">Impresiones</p>
                    <p className="text-2xl font-bold text-blue-400 font-mono">{totalImpressions.toLocaleString()}</p>
                </div>
            </div>

            {/* Campaign Breakdown */}
            {campaigns.length > 0 && (
                <div>
                    <h2 className="text-white font-semibold text-lg mb-4">Desglose por Campaña</h2>
                    <div className="rounded-xl overflow-hidden border border-zinc-800">
                        <table className="w-full text-sm">
                            <thead className="bg-zinc-900 border-b border-zinc-800">
                                <tr>
                                    <th className="text-left text-zinc-400 font-medium px-4 py-3">Campaña</th>
                                    <th className="text-right text-zinc-400 font-medium px-4 py-3">Gasto</th>
                                    <th className="text-right text-zinc-400 font-medium px-4 py-3">Leads</th>
                                    <th className="text-right text-zinc-400 font-medium px-4 py-3">CPL</th>
                                    <th className="text-right text-zinc-400 font-medium px-4 py-3">Impresiones</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-800/60">
                                {campaigns.map((c: any) => {
                                    const spend = parseFloat(c.spend || '0') || 0
                                    const leads = parseInt(c.leads || '0') || 0
                                    const impressions = parseInt(c.impressions || '0') || 0
                                    const campaignCpl = leads > 0 ? spend / leads : null

                                    return (
                                        <tr key={c.campaign_id || c.name} className="bg-zinc-950 hover:bg-zinc-900/50 transition">
                                            <td className="px-4 py-3 text-zinc-200 max-w-xs truncate">{c.name}</td>
                                            <td className="px-4 py-3 text-right text-zinc-300 font-mono">${spend.toFixed(2)}</td>
                                            <td className="px-4 py-3 text-right text-emerald-400 font-mono">{leads}</td>
                                            <td className="px-4 py-3 text-right text-amber-400 font-mono">
                                                {campaignCpl !== null ? `$${campaignCpl.toFixed(2)}` : '—'}
                                            </td>
                                            <td className="px-4 py-3 text-right text-zinc-500 font-mono">{impressions.toLocaleString()}</td>
                                        </tr>
                                    )
                                })}
                            </tbody>
                            <tfoot className="bg-zinc-900 border-t-2 border-zinc-700">
                                <tr>
                                    <td className="px-4 py-3 text-zinc-300 font-semibold">Total</td>
                                    <td className="px-4 py-3 text-right text-white font-mono font-semibold">${totalSpend.toFixed(2)}</td>
                                    <td className="px-4 py-3 text-right text-emerald-300 font-mono font-semibold">{totalLeads}</td>
                                    <td className="px-4 py-3 text-right text-amber-300 font-mono font-semibold">
                                        {cpl !== null ? `$${cpl.toFixed(2)}` : '—'}
                                    </td>
                                    <td className="px-4 py-3 text-right text-zinc-400 font-mono">{totalImpressions.toLocaleString()}</td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            )}

            {/* Footer */}
            <div className="border-t border-zinc-800 pt-6 text-center">
                <p className="text-zinc-600 text-xs">
                    Generado por AdsHouse · {periodoLabel}
                </p>
            </div>
        </div>
    )
}
