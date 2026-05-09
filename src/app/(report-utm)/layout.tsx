import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'
import { ReportUtmSidebar } from '@/components/report-utm/ReportUtmSidebar'

export default async function ReportUtmLayout({ children }: { children: ReactNode }) {
    // Gate por env flag — el módulo solo se monta si está habilitado.
    // Por ahora es local-only; en prod queda deshabilitado salvo que se setee.
    if (process.env.NEXT_PUBLIC_REPORT_UTM_ENABLED !== 'true') {
        redirect('/dashboard')
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) redirect('/login')

    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

    const role = profile?.role ?? 'viewer'

    // Solo admin / superadmin acceden al módulo (los clientes no).
    if (role !== 'admin' && role !== 'superadmin') {
        redirect('/dashboard')
    }

    return (
        <div className="flex min-h-screen bg-background text-foreground font-sans selection:bg-emerald-500/20">
            {/* Ambient glow distinto al reporting para diferenciar visualmente */}
            <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full opacity-[0.07] blur-[140px]"
                     style={{ background: '#10B981' }} />
                <div className="absolute bottom-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full opacity-[0.06] blur-[140px]"
                     style={{ background: '#8B5CF6' }} />
            </div>

            <ReportUtmSidebar role={role} />

            <div className="flex-1 flex flex-col relative w-full transition-all duration-300 ease-in-out lg:ml-64">
                <header className="lg:hidden h-14 border-b border-zinc-200 dark:border-white/[0.06] flex items-center justify-center bg-white/90 dark:bg-zinc-950/90 backdrop-blur-xl sticky top-0 z-30">
                    <span className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                        Report-UTM
                    </span>
                </header>

                <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 pt-6 pb-24 lg:pb-8 animate-in fade-in duration-300">
                    {children}
                </main>
            </div>
        </div>
    )
}
