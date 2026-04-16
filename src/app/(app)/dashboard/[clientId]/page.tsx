import { getDashboardData, getLeadsDiarios } from "../_actions"
import { DateRangeSelector } from "../components/DateRangeSelector"
import { DashboardClient } from "../components/DashboardClient"
import { GoogleSheetsLeadsCard } from "../components/GoogleSheetsLeadsCard"
import { CopyLinkButton } from "../components/CopyLinkButton"
import { PublicLayoutButton } from "../components/PublicLayoutButton"
import { format, subDays } from "date-fns"

export default async function DashboardPage(props: {
    params: Promise<{ clientId: string }>
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    const params = await props.params;
    const clientId = params.clientId;
    const searchParams = await props.searchParams;
    const now = new Date()
    const fallbackFrom = format(subDays(now, 30), 'yyyy-MM-dd')
    const fallbackTo = format(now, 'yyyy-MM-dd')

    const fromStr = typeof searchParams.from === 'string' ? searchParams.from : fallbackFrom
    const toStr = typeof searchParams.to === 'string' ? searchParams.to : fallbackTo

    const [dashboardData, leadsResult] = await Promise.all([
        getDashboardData(clientId, fromStr, toStr),
        getLeadsDiarios(clientId),
    ])

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <h2 className="text-2xl font-bold tracking-tight text-white">Embudo de Ventas V2</h2>
                        <CopyLinkButton clientId={clientId} />
                        <PublicLayoutButton
                            clienteId={clientId}
                            initialLayout={dashboardData?.layoutPublico || null}
                            conversionesCatalogo={dashboardData?.conversionesCatalogo || []}
                        />
                    </div>
                    <p className="text-zinc-400">Datos consolidados de Meta, Hotmart y Google Analytics 4.</p>
                </div>
                <DateRangeSelector />
            </div>

            <div className="pt-4">
                <DashboardClient data={dashboardData || { cliente: null, metrics: [], weeks: [] }} />
            </div>

            {/* Google Sheets Leads Section */}
            <div className="pt-6 border-t border-zinc-800">
                <h3 className="text-lg font-semibold text-white mb-4">📊 Leads desde Google Sheets</h3>
                <GoogleSheetsLeadsCard dailyData={leadsResult.data || []} error={leadsResult.error} />
            </div>
        </div>
    )
}
