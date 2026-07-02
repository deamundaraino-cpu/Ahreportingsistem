import { getDashboardData } from "../_actions"
import { DateRangeSelector } from "../components/DateRangeSelector"
import { DashboardClient } from "../components/DashboardClient"
import { GoogleSheetsLeadsCard } from "../components/GoogleSheetsLeadsCard"
import { ConversionesOfflineCard } from "../components/ConversionesOfflineCard"
import { PublicLinkButton } from "../components/PublicLinkButton"
import { BitacorasSidebar } from "../components/BitacorasSidebar"
import { getBitacoras } from "../../admin/settings/[id]/_actions"
import { format, subDays } from "date-fns"
import { createClient, createAdminClient } from "@/utils/supabase/server"
import { redirect } from "next/navigation"

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

    const supabase = await createClient()
    const adminSupabase = await createAdminClient()

    // Auth check and data fetch run in parallel to cut latency
    const authCheck = async (): Promise<{ userRole: string; allowed: boolean; userId: string | null }> => {
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return { userRole: 'viewer', allowed: false, userId: null }

        const { data: profile } = await adminSupabase
            .from('user_profiles').select('role').eq('id', user.id).single()
        const role = profile?.role ?? 'viewer'

        // Admins/superadmins can access any client
        if (['superadmin', 'admin'].includes(role)) return { userRole: role, allowed: true, userId: user.id }

        // All other roles (trafficker, viewer, …) must have an explicit assignment
        const { data: assignment } = await adminSupabase
            .from('user_client_assignments').select('id')
            .eq('user_id', user.id).eq('client_id', clientId).maybeSingle()
        return { userRole: role, allowed: !!assignment, userId: user.id }
    }

    const [{ userRole, allowed, userId }, dashboardData, initialBitacoras] = await Promise.all([
        authCheck(),
        getDashboardData(clientId, fromStr, toStr),
        getBitacoras(clientId),
    ])

    if (!allowed) redirect('/dashboard')

    return (
        <div className="space-y-6">
            <BitacorasSidebar key={clientId} clientId={clientId} userRole={userRole} userId={userId} initialEntries={initialBitacoras} />
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <h2 className="text-2xl font-bold tracking-tight text-foreground">{dashboardData?.cliente?.nombre ?? 'Dashboard'}</h2>
                        <PublicLinkButton
                            clienteId={clientId}
                            tabs={dashboardData?.tabs || []}
                            initialTabIds={dashboardData?.layoutPublico?.type === 'tab_mirror' ? (dashboardData.layoutPublico.tab_ids ?? []) : []}
                        />
                    </div>
                    <p className="text-sm text-muted-foreground font-medium">Embudo de Ventas V2</p>
                    <p className="text-muted-foreground text-sm">Datos consolidados de Meta, Hotmart y Google Analytics 4.</p>
                </div>
                <DateRangeSelector />
            </div>

            <div className="pt-4">
                <DashboardClient
                    data={dashboardData || { cliente: null, metrics: [], weeks: [] }}
                    userRole={userRole}
                    initialTabId={typeof searchParams.tab === 'string' ? searchParams.tab : 'general'}
                />
            </div>

            {/* Google Sheets Leads Section — only show if enabled */}
            {dashboardData?.cliente?.config_api?.google_sheets?.enabled && (
                <div className="pt-6 border-t border-border">
                    <h3 className="text-lg font-semibold text-foreground mb-4">Leads desde Google Sheets</h3>
                    <GoogleSheetsLeadsCard dailyData={dashboardData.leadsRaw || []} error={null} />
                </div>
            )}

            {/* Conversiones Offline Section — show if at least one sheet is enabled */}
            {(() => {
                const raw = dashboardData?.cliente?.config_api?.google_sheets_conversiones
                const hasEnabled = Array.isArray(raw)
                    ? raw.some((s: any) => s.enabled)
                    : raw?.enabled === true
                return hasEnabled ? (
                    <div className="pt-6 border-t border-border">
                        <h3 className="text-lg font-semibold text-foreground mb-4">Conversiones Offline</h3>
                        <ConversionesOfflineCard
                            dailyData={dashboardData?.conversionesOfflineRaw || []}
                            error={null}
                            clientId={clientId}
                            canSync={userRole === 'admin' || userRole === 'trafficker'}
                        />
                    </div>
                ) : null
            })()}
        </div>
    )
}
