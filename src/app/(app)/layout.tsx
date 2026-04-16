import { AppSidebar } from '@/components/layout/AppSidebar'
import { ReactNode } from 'react'
import { createClient } from '@/utils/supabase/server'

export default async function AppLayout({ children }: { children: ReactNode }) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    let role = 'viewer'
    if (user) {
        const { data: profile } = await supabase
            .from('user_profiles')
            .select('role')
            .eq('id', user.id)
            .single()
        if (profile?.role) {
            role = profile.role
        }
    }

    return (
        <div className="flex min-h-screen bg-background text-foreground font-sans selection:bg-[#1E6AB5]/20">
            {/* Ambient background glows — brand colors, very subtle */}
            <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full opacity-[0.06] blur-[140px]"
                     style={{ background: '#E53529' }} />
                <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full opacity-[0.07] blur-[140px]"
                     style={{ background: '#1E6AB5' }} />
            </div>

            <AppSidebar initialRole={role} />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col relative w-full transition-all duration-300 ease-in-out lg:ml-64">
                {/* Mobile header */}
                <header className="lg:hidden h-14 border-b border-zinc-200 dark:border-white/[0.06] flex items-center justify-center bg-white/90 dark:bg-zinc-950/90 backdrop-blur-xl sticky top-0 z-30">
                    <span className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                        AdsHouse
                    </span>
                </header>

                {/* Dynamic Page Content Wrapper */}
                <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 pt-6 pb-24 lg:pb-8 animate-in fade-in duration-300">
                    {children}
                </main>
            </div>
        </div>
    )
}
