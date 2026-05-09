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
} from 'lucide-react'

const NAV_PRIMARY = [
    { name: 'Overview', href: '/report-utm', icon: LayoutDashboard, exact: true },
    { name: 'Clientes', href: '/report-utm/clientes', icon: Users },
]

const NAV_TRACKING = [
    { name: 'Ventas', href: '/report-utm/ventas', icon: ShoppingBag },
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
            <p className="px-3 text-[10px] font-semibold text-zinc-400 dark:text-zinc-600 uppercase tracking-widest mb-2">
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
                                    ? 'text-white dark:text-white'
                                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-white/[0.06]'
                                }
                            `}
                            style={active ? {
                                background: 'linear-gradient(135deg, #10B981 0%, #059669 100%)',
                                boxShadow: '0 2px 8px rgba(16, 185, 129, 0.35)'
                            } : undefined}
                        >
                            <item.icon
                                className={`
                                    mr-3 flex-shrink-0 h-4.5 w-4.5 transition-transform duration-200
                                    group-hover:scale-110
                                    ${active ? 'text-white' : 'text-zinc-400 dark:text-zinc-500 group-hover:text-zinc-600 dark:group-hover:text-zinc-300'}
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
                           bg-white dark:bg-zinc-900
                           border border-zinc-200 dark:border-zinc-800
                           text-zinc-500 dark:text-zinc-400
                           hover:text-zinc-900 dark:hover:text-white
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
                bg-white dark:bg-[#0E0E0E]
                border-r border-zinc-200 dark:border-white/[0.06]
                shadow-lg dark:shadow-none
                flex flex-col
                transition-transform duration-300 ease-in-out
                ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
            `}>
                {/* Logo + Workspace label */}
                <div className="flex h-[68px] items-center px-5 border-b border-zinc-200 dark:border-white/[0.06]">
                    <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg shadow-md"
                             style={{ background: 'linear-gradient(135deg, #10B981 0%, #8B5CF6 100%)' }}>
                            <BarChart2 className="h-4.5 w-4.5 text-white" />
                        </div>
                        <div className="flex flex-col leading-tight">
                            <span className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
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
                               text-zinc-500 dark:text-zinc-400
                               border border-dashed border-zinc-200 dark:border-white/[0.06]
                               hover:bg-zinc-50 dark:hover:bg-white/[0.04]
                               hover:text-zinc-900 dark:hover:text-zinc-100
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

                <div className="p-3 border-t border-zinc-200 dark:border-white/[0.06] space-y-2">
                    <div className="px-3 py-2 rounded-lg bg-zinc-50 dark:bg-white/[0.04] flex items-center gap-2">
                        <span className="text-[10px] font-semibold text-emerald-500 dark:text-emerald-400 uppercase tracking-wider">
                            Local · {role}
                        </span>
                    </div>
                    <form action="/auth/signout" method="post" className="w-full">
                        <button className="
                            flex w-full items-center px-3 py-2.5 text-sm font-medium rounded-lg
                            text-zinc-500 dark:text-zinc-400
                            hover:bg-red-50 dark:hover:bg-red-500/10
                            hover:text-red-600 dark:hover:text-red-400
                            transition-all duration-200 group cursor-pointer
                        ">
                            <LogOut className="mr-3 h-4.5 w-4.5 text-zinc-400 group-hover:text-red-500 dark:group-hover:text-red-400 transition-colors" />
                            Cerrar Sesión
                        </button>
                    </form>
                </div>
            </aside>
        </>
    )
}
