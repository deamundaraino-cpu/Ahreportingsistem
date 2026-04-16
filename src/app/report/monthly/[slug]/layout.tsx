import type { Metadata } from 'next'

export const metadata: Metadata = {
    title: 'Reporte Mensual | AdsHouse',
    description: 'Reporte de rendimiento publicitario generado por AdsHouse.',
}

export default function MonthlyReportLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-zinc-950 text-white">
            {children}
        </div>
    )
}
