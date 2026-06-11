import { getMirrorDashboardData } from "@/app/(app)/dashboard/_actions"
import { DashboardClient } from "@/app/(app)/dashboard/components/DashboardClient"
import { DateRangeSelector } from "@/app/(app)/dashboard/components/DateRangeSelector"
import { notFound } from "next/navigation"
import { Search, X } from "lucide-react"
import { ThemeToggle } from "@/components/theme/ThemeToggle"

export const dynamic = 'force-dynamic'

export default async function PublicMirrorPage({ params, searchParams }: any) {
    const { token } = await params
    const { from, to, search } = await searchParams

    const { data, error } = await getMirrorDashboardData(token, from, to)

    if (error || !data) {
        return notFound()
    }

    const keyword = typeof search === 'string' ? search : ''

    return (
        <div className="min-h-screen bg-background text-foreground font-sans">
             {/* Public Mirror View - No sidebar, just the dashboard */}
            <header className="border-b border-border bg-background/50 backdrop-blur-md sticky top-0 z-50">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div className="flex items-center gap-6">
                        <div>
                            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                                AdsHouse <span className="text-muted-foreground/70 font-normal">|</span> <span className="text-blue-600 dark:text-blue-400">Mirror</span>
                            </h1>
                            <p className="text-xs text-muted-foreground mt-0.5">Reporte de: {data.cliente.nombre}</p>
                        </div>
                    </div>

                    <div className="flex flex-1 items-center justify-end gap-4">
                        <DateRangeSelector basePath="/p" isPublic={true} />
                        <ThemeToggle />
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
                <DashboardClient 
                    data={data}
                    isPublic={true}
                    initialTabId={data.activeTabId}
                    initialKeyword={keyword}
                />
            </main>
        </div>
    )
}
