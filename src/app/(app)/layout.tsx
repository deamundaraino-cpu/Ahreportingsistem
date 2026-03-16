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
        <div className="flex min-h-screen bg-[#050505] text-zinc-50 font-sans selection:bg-indigo-500/30">
            {/* Dynamic Background Effects */}
            <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-900/10 blur-[120px]" />
                <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-purple-900/10 blur-[120px]" />
            </div>

            {/* Elegant Sidebar */}
            <AppSidebar initialRole={role} />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col relative w-full transition-all duration-300 ease-in-out lg:ml-64">
                {/* Top Navigation Wrapper for Mobile Header */}
                <header className="lg:hidden h-16 border-b border-zinc-800/50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-xl sticky top-0 z-30">
                    <span className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-400">
                        AdsHouse
                    </span>
                </header>

                {/* Dynamic Page Content Wrapper */}
                <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 pt-6 pb-24 lg:pb-8 animate-in fade-in zoom-in-95 duration-500">
                    {children}
                </main>
            </div>
        </div>
    )
}
