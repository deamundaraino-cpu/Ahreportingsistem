import { getDashboardData, getLeadsDiarios } from "../_actions"
import { DateRangeSelector } from "../components/DateRangeSelector"
import { DashboardClient } from "../components/DashboardClient"
import { GoogleSheetsLeadsCard } from "../components/GoogleSheetsLeadsCard"
import { CopyLinkButton } from "../components/CopyLinkButton"
import { PublicLinkButton } from "../components/PublicLinkButton"
import { format, subDays } from "date-fns"
import { createClient, createAdminClient } from "@/utils/supabase/server"
import { redirect } from "next/navigation"

export default async function DashboardPage(props: {
    params: Promise<{ clientId: string }>
    searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
    const params = await props.params;
    const clientId = params.clientId;

    // Guard: traffickers can only access assigned clients
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) {
        const { data: profile } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('id', user.id)
            .single()

        if (profile?.role === 'trafficker') {
            const adminSupabase = await createAdminClient()
            const { data: assignment } = await adminSupabase
                .from('user_client_assignments')
                .select('id')
                .eq('user_id', user.id)
                .eq('client_id', clientId)
                .maybeSingle()

            if (!assignment) redirect('/dashboard')
        }
    }
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
                        <PublicLinkButton
                            clienteId={clientId}
                            tabs={dashboardData?.tabs || []}
                            initialTabIds={dashboardData?.layoutPublico?.type === 'tab_mirror' ? (dashboardData.layoutPublico.tab_ids ?? []) : []}
                        />
                    </div>
                    <p className="text-zinc-400">Datos consolidados de Meta, Hotmart y Google Analytics 4.</p>
                </div>
                <DateRangeSelector />
            </div>

            <div className="pt-4">
                <DashboardClient data={dashboardData || { cliente: null, metrics: [], weeks: [] }} />
            </div>

            {/* Google Sheets Leads Section — only show if enabled */}
            {dashboardData?.cliente?.config_api?.google_sheets?.enabled && (
                <div className="pt-6 border-t border-zinc-800">
                    <h3 className="text-lg font-semibold text-white mb-4">📊 Leads desde Google Sheets</h3>
                    <GoogleSheetsLeadsCard dailyData={leadsResult.data || []} error={leadsResult.error} />
                </div>
            )}
        </div>
    )
}
