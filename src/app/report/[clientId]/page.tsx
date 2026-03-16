import { getDashboardData } from "@/app/(app)/dashboard/_actions"
import { DateRangeSelector } from "@/app/(app)/dashboard/components/DateRangeSelector"
import { DashboardClient } from "@/app/(app)/dashboard/components/DashboardClient"
import { format, subDays } from "date-fns"

export default async function PublicReportPage(props: {
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

    if (!dashboardData?.cliente) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center space-y-4">
                <div className="w-16 h-16 bg-zinc-900 rounded-full flex items-center justify-center border border-zinc-800">
                    <span className="text-2xl">🔍</span>
                </div>
                <h1 className="text-2xl font-bold text-white">Reporte no encontrado</h1>
                <p className="text-zinc-400">El cliente solicitado no existe o no tiene datos disponibles.</p>
            </div>
        )
    }

    return (
        <div className="space-y-6 pt-4">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mb-1">
                        Reporte de Resultados
                    </h2>
                    <p className="text-zinc-400 text-sm sm:text-base">
                        Visualización de datos para <strong className="text-zinc-200">{dashboardData.cliente.nombre}</strong>
                    </p>
                </div>
                <DateRangeSelector basePath="/report" />
            </div>

            <div className="pt-2">
                <DashboardClient data={dashboardData} isPublic={true} />
            </div>
        </div>
    )
}
