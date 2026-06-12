import { AppSidebar } from '@/components/layout/AppSidebar'
import { NotificationBell } from '@/components/notifications/NotificationBell'
import { ReactNode } from 'react'
import { createClient } from '@/utils/supabase/server'
import { Toaster } from 'sonner'

export default async function AppLayout({ children }: { children: ReactNode }) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    let role = 'viewer'
    let userId = ''
    if (user) {
        userId = user.id
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
        <div className="flex min-h-screen bg-background text-foreground font-sans selection:bg-brand-blue/20">
            {/* Ambient background glows — brand colors, very subtle */}
            <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] ambient-glow-red" />
                <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] ambient-glow-blue" />
            </div>

            <AppSidebar initialRole={role} userId={userId} />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col relative w-full transition-all duration-300 ease-in-out lg:ml-64">
                {/* Desktop topbar */}
                <header className="hidden lg:flex h-14 border-b border-border items-center justify-end px-6 bg-background/80 backdrop-blur-md sticky top-0 z-30">
                    {userId && <NotificationBell userId={userId} />}
                </header>

                {/* Mobile header */}
                <header className="lg:hidden h-14 border-b border-border flex items-center justify-between px-4 bg-background/80 backdrop-blur-md sticky top-0 z-30">
                    <span className="w-9" aria-hidden />
                    <span className="text-base font-bold tracking-tight text-foreground">
                        AdsHouse
                    </span>
                    {userId ? <NotificationBell userId={userId} /> : <span className="w-9" aria-hidden />}
                </header>

                {/* Dynamic Page Content Wrapper */}
                <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 pt-6 pb-24 lg:pb-8 animate-in fade-in duration-300">
                    {children}
                </main>
            </div>

            <Toaster richColors position="top-right" />
        </div>
    )
}
