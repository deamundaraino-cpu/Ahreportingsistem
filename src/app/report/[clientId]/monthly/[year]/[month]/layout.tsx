import type { Metadata } from 'next'
import { ThemeToggle } from '@/components/theme/ThemeToggle'

export const metadata: Metadata = {
    title: 'Reporte Mensual | AdsHouse',
    description: 'Reporte de rendimiento publicitario mensual generado por AdsHouse.',
}

export default function Layout({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-background text-foreground">
            <ThemeToggle className="fixed top-4 right-4 z-50" />
            {children}
        </div>
    )
}
