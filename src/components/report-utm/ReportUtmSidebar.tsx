'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
    LayoutDashboard,
    Users,
    Link2,
    ShoppingBag,
    BarChart2,
    Settings,
    LogOut,
    Menu,
    X,
    ArrowLeftRight,
    Activity,
    UserCheck,
} from 'lucide-react'
import { ThemeToggle } from '@/components/theme/ThemeToggle'

const NAV_PRIMARY = [
    { name: 'Overview', href: '/report-utm', icon: LayoutDashboard, exact: true },
    { name: 'Clientes', href: '/report-utm/clientes', icon: Users },
]

const NAV_TRACKING = [
    { name: 'Ventas', href: '/report-utm/ventas', icon: ShoppingBag },
    { name: 'Leads', href: '/report-utm/leads', icon: UserCheck },
    { name: 'Atribución UTM', href: '/report-utm/atribucion', icon: BarChart2 },
    { name: 'Tracking Links', href: '/report-utm/links', icon: Link2 },
    { name: 'Pixel & Eventos', href: '/report-utm/pixel', icon: Activity },
]

const NAV_CONFIG = [
    { name: 'Integraciones', href: '/report-utm/integraciones', icon: Settings },
]

export function ReportUtmSidebar({ role }: { role: string }) {
    const pathname = usePathname()
    const [isOpen, setIsOpen] = useState(false)

    const isActive = (href: string, exact = false) => {
        if (!pathname) return false
        return exact ? pathname === href : pathname.startsWith(href)
    }

    const Section = ({
        title,
        items,
    }: {
        title: string
        items: { name: string; href: string; icon: typeof LayoutDashboard; exact?: boolean }[]
    }) => (
        <div>
            <p className="px-3 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-2">
                {title}
            </p>
            <div className="space-y-0.5">
                {items.map((item) => {
                    const active = isActive(item.href, item.exact)
                    return (
                        <Link
                            key={item.name}
                            href={item.href}
                            onClick={() => setIsOpen(false)}
                            className={`
                                group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg
                                transition-all duration-200 cursor-pointer
                                ${active
                                    ? 'text-white nav-active-emerald'
                                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                                }
                            `}
                        >
                            <item.icon
                                className={`
                                    mr-3 flex-shrink-0 h-4.5 w-4.5 transition-transform duration-200
                                    group-hover:scale-110
                                    ${active ? 'text-white' : 'text-muted-foreground/80 group-hover:text-foreground'}
                                `}
                            />
                            <span className="flex-1">{item.name}</span>
                            {active && (
                                <div className="w-1.5 h-1.5 rounded-full bg-white/70 animate-pulse" />
                            )}
                        </Link>
                    )
                })}
            </div>
        </div>
    )

    return (
        <>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-md
                           bg-card
                           border border-border
                           text-muted-foreground
                           hover:text-foreground
                           shadow-sm transition-colors"
            >
                {isOpen ? <X size={20} /> : <Menu size={20} />}
            </button>

            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/40 z-40 lg:hidden backdrop-blur-sm"
                    onClick={() => setIsOpen(false)}
                />
            )}

            <aside className={`
                fixed top-0 left-0 z-40 h-screen w-64
                bg-sidebar
                border-r border-sidebar-border
                shadow-lg dark:shadow-none
                flex flex-col
                transition-transform duration-300 ease-in-out
                ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
            `}>
                {/* Logo + Workspace label */}
                <div className="flex h-[68px] items-center px-5 border-b border-sidebar-border">
                    <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg shadow-md brand-gradient-utm">
                            <BarChart2 className="h-4.5 w-4.5 text-white" />
                        </div>
                        <div className="flex flex-col leading-tight">
                            <span className="text-base font-bold tracking-tight text-foreground">
                                Report-UTM
                            </span>
                            <span className="text-[10px] font-medium text-emerald-500 dark:text-emerald-400 tracking-wide uppercase">
                                Tracking & Atribución
                            </span>
                        </div>
                    </div>
                </div>

                {/* Workspace switcher */}
                <Link
                    href="/dashboard"
                    className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg
                               text-muted-foreground
                               border border-dashed border-border
                               hover:bg-accent
                               hover:text-foreground
                               transition-colors"
                >
                    <ArrowLeftRight className="h-3.5 w-3.5" />
                    Cambiar a Reporting
                </Link>

                <nav className="flex-1 space-y-6 px-3 py-6 overflow-y-auto custom-scrollbar">
                    <Section title="Panel" items={NAV_PRIMARY} />
                    <Section title="Tracking" items={NAV_TRACKING} />
                    <Section title="Configuración" items={NAV_CONFIG} />
                </nav>

                <div className="p-3 border-t border-sidebar-border space-y-2">
                    <div className="flex items-center justify-between px-3">
                        <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
                            Tema
                        </span>
                        <ThemeToggle />
                    </div>
                    <div className="px-3 py-2 rounded-lg bg-muted/60 flex items-center gap-2">
                        <span className="text-[10px] font-semibold text-emerald-500 dark:text-emerald-400 uppercase tracking-wider">
                            Local · {role}
                        </span>
                    </div>
                    <form action="/auth/signout" method="post" className="w-full">
                        <button className="
                            flex w-full items-center px-3 py-2.5 text-sm font-medium rounded-lg
                            text-muted-foreground
                            hover:bg-red-500/10
                            hover:text-red-600 dark:hover:text-red-400
                            transition-all duration-200 group cursor-pointer
                        ">
                            <LogOut className="mr-3 h-4.5 w-4.5 text-muted-foreground/80 group-hover:text-red-500 dark:group-hover:text-red-400 transition-colors" />
                            Cerrar Sesión
                        </button>
                    </form>
                </div>
            </aside>
        </>
    )
}
