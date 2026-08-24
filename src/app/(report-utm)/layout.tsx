import { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/utils/supabase/server'
import { ReportUtmSidebar } from '@/components/report-utm/ReportUtmSidebar'
import { getBranding } from '@/lib/branding'

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

    // Una sola lectura cacheada en vez de repetir la consulta al service role
    // en cada layout (`lib/branding.ts`).
    const branding = await getBranding()

    const utmName = branding?.utm_name || 'Report-UTM'
    const utmTag = branding?.utm_tag || 'Tracking & Atribución'

    return (
        <div className="flex min-h-screen bg-background text-foreground font-sans selection:bg-emerald-500/20">
            {/* Ambient glow distinto al reporting para diferenciar visualmente */}
            <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-20%] right-[-10%] w-[50%] h-[50%] ambient-glow-emerald" />
                <div className="absolute bottom-[-20%] left-[-10%] w-[50%] h-[50%] ambient-glow-violet" />
            </div>

            <ReportUtmSidebar role={role} utmName={utmName} utmTag={utmTag} />

            <div className="flex-1 flex flex-col relative w-full transition-all duration-300 ease-in-out lg:ml-64">
                <header className="lg:hidden h-14 border-b border-border flex items-center justify-between px-4 bg-background/90 backdrop-blur-xl sticky top-0 z-30">
                    <span className="w-9" aria-hidden />
                    <span className="text-base font-bold tracking-tight text-foreground default-logo-element">
                        {utmName}
                    </span>
                    {/* Custom logo container */}
                    <div 
                        className="custom-logo-container hidden h-8 w-32" 
                        style={{ 
                            backgroundImage: 'var(--brand-logo-url)', 
                            backgroundSize: 'contain', 
                            backgroundRepeat: 'no-repeat', 
                            backgroundPosition: 'center' 
                        }} 
                    />
                    <span className="w-9" aria-hidden />
                </header>

                <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 pt-6 pb-24 lg:pb-8 animate-in fade-in duration-300">
                    {children}
                </main>
            </div>
        </div>
    )
}
