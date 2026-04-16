import { ReactNode } from 'react'
import { Metadata } from 'next'

export const metadata: Metadata = {
    title: 'Reporte de Resultados',
}

export default function ReportLayout({ children }: { children: ReactNode }) {
    return (
        <div className="min-h-screen bg-[#050505] text-zinc-50 font-sans selection:bg-indigo-500/30">
            {/* Dynamic Background Effects */}
            <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-900/10 blur-[120px]" />
                <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-purple-900/10 blur-[120px]" />
            </div>

            {/* Main Content Area */}
            <main className="relative flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 animate-in fade-in zoom-in-95 duration-500">
                {children}
            </main>
        </div>
    )
}
