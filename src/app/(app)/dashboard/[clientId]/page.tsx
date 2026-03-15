import { getDashboardData } from "../_actions"
import { DateRangeSelector } from "../components/DateRangeSelector"
import { DashboardClient } from "../components/DashboardClient"
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

    const dashboardData = await getDashboardData(clientId, fromStr, toStr)

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight text-white">Embudo de Ventas V2</h2>
                    <p className="text-zinc-400">Datos consolidados de Meta, GA4 y Hotmart.</p>
                </div>
                <DateRangeSelector />
            </div>

            <div className="pt-4">
                <DashboardClient data={dashboardData || { cliente: null, metrics: [], weeks: [] }} />
            </div>
        </div>
    )
}
