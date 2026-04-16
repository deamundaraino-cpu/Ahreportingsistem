import type { Metadata } from 'next'

export const metadata: Metadata = {
    title: 'Reporte Mensual | AdsHouse',
    description: 'Reporte de rendimiento publicitario mensual generado por AdsHouse.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-gray-50">
            {children}
        </div>
    )
}
