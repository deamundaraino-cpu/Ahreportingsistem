'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { APP_VERSION } from '@/lib/version'
import {
    Users,
    BarChart3,
    LogOut,
    Settings,
    LayoutDashboard,
    Menu,
    X,
    Shield,
    FileText,
    Key,
    Sliders,
    ArrowLeftRight,
    MessageCircle,
    Bell,
    Map
} from 'lucide-react'

const REPORT_UTM_ENABLED = process.env.NEXT_PUBLIC_REPORT_UTM_ENABLED === 'true'

export function AppSidebar({ initialRole = 'viewer', userId = '' }: { initialRole?: string; userId?: string }) {
    const pathname = usePathname()
    const [isOpen, setIsOpen] = useState(false)
    const [role, setRole] = useState<string | null>(initialRole)
    const [loading, setLoading] = useState(false)
    const supabase = createClient()

    useEffect(() => {
        let mounted = true

        async function getProfile(userId: string) {
            try {
                const { data, error } = await supabase
                    .from('user_profiles')
                    .select('role')
                    .eq('id', userId)
                    .single()

                if (error) throw error
                if (mounted) setRole(data?.role || 'viewer')
            } catch (err) {
                console.error('Error fetching role:', err)
                if (mounted) setRole('viewer')
            } finally {
                if (mounted) setLoading(false)
            }
        }

        const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
            if (session?.user) {
                await getProfile(session.user.id)
            } else if (event === 'SIGNED_OUT') {
                if (mounted) {
                    setRole(null)
                    setLoading(false)
                }
            } else {
                const { data: { user } } = await supabase.auth.getUser()
                if (user) {
                    await getProfile(user.id)
                } else {
                    if (mounted) setLoading(false)
                }
            }
        })

        return () => {
            mounted = false
            subscription.unsubscribe()
        }
    }, [supabase])

    const isSuperAdmin = role === 'superadmin'
    const isAdmin = role === 'admin'
    const isTrafficker = role === 'trafficker'
    const hasAdminAccess = isSuperAdmin || isAdmin

    const navigation = [
        { name: 'General Overview', href: '/dashboard', icon: LayoutDashboard },
        { name: 'Notificaciones', href: '/notificaciones', icon: Bell },
    ]

    const settingsNavigation = [
        { name: 'Ajustes de Sistema', href: '/admin/settings', icon: Settings, show: true },
        { name: 'Constructor de Layouts', href: '/admin/layouts', icon: Users, show: true },
        { name: 'Reportes Mensuales', href: '/admin/reports', icon: FileText, show: hasAdminAccess },
        { name: 'Configuración y Alertas', href: '/admin/configuracion', icon: Sliders, show: hasAdminAccess },
    ].filter(item => item.show)

    const isActive = (path: string) => pathname?.startsWith(path)

    if (loading) return null

    return (
        <>
            {/* Mobile Menu Button */}
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

            {/* Mobile backdrop */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/40 z-40 lg:hidden backdrop-blur-sm"
                    onClick={() => setIsOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside className={`
                fixed top-0 left-0 z-40 h-screen w-64
                bg-sidebar
                border-r border-sidebar-border
                shadow-lg dark:shadow-none
                flex flex-col
                transition-transform duration-300 ease-in-out
                ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
            `}>

                {/* Logo area */}
                <div className="flex h-[68px] items-center px-5 border-b border-sidebar-border">
                    <div className="flex items-center gap-3">
                        {/* Brand icon: red-to-blue gradient matching logo */}
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg shadow-md brand-gradient-reporting">
                            <BarChart3 className="h-4.5 w-4.5 text-white" />
                        </div>
                        <div className="flex flex-col leading-tight">
                            <span className="text-base font-bold tracking-tight text-foreground">
                                AdsHouse
                            </span>
                            <span className="text-[10px] font-medium text-muted-foreground tracking-wide uppercase">
                                Reporting
                            </span>
                        </div>
                    </div>
                </div>

                {/* Workspace switcher (todos los roles + flag local) */}
                {REPORT_UTM_ENABLED && (
                    <Link
                        href="/report-utm"
                        className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg
                                   text-emerald-600 dark:text-emerald-400
                                   border border-dashed border-emerald-300 dark:border-emerald-500/30
                                   hover:bg-emerald-50 dark:hover:bg-emerald-500/10
                                   transition-colors"
                    >
                        <ArrowLeftRight className="h-3.5 w-3.5" />
                        Ir a Report-UTM
                    </Link>
                )}

                {/* Navigation */}
                <nav className="flex-1 space-y-6 px-3 py-6 overflow-y-auto custom-scrollbar">

                    {/* Dashboard section */}
                    <div>
                        <p className="px-3 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-2">
                            Dashboard
                        </p>
                        <div className="space-y-0.5">
                            {navigation.map((item) => {
                                const active = isActive(item.href)
                                return (
                                    <Link
                                        key={item.name}
                                        href={item.href}
                                        onClick={() => setIsOpen(false)}
                                        className={`
                                            group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg
                                            transition-all duration-200 cursor-pointer
                                            ${active
                                                ? 'text-white nav-active-red'
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

                    {/* Settings section */}
                    <div>
                        <p className="px-3 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest mb-2">
                            Configuración
                        </p>
                        <div className="space-y-0.5">
                            {settingsNavigation.map((item) => {
                                const active = isActive(item.href)
                                return (
                                    <Link
                                        key={item.name}
                                        href={item.href}
                                        onClick={() => setIsOpen(false)}
                                        className={`
                                            group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg
                                            transition-all duration-200 cursor-pointer
                                            ${active
                                                ? 'text-white nav-active-blue'
                                                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                                            }
                                        `}
                                    >
                                        <item.icon
                                            className={`
                                                mr-3 flex-shrink-0 h-4.5 w-4.5 transition-transform duration-200
                                                group-hover:rotate-6
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
                </nav>

                {/* Roadmap — fixed button */}
                <div className="px-3 pb-2">
                    <Link
                        href="/soporte"
                        onClick={() => setIsOpen(false)}
                        className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-semibold transition-all duration-200
                            ${isActive('/soporte')
                                ? 'border-transparent nav-active-blue text-white'
                                : 'border-brand-blue/30 bg-brand-blue/10 text-brand-blue dark:text-brand-blue-light hover:bg-brand-blue/15 hover:border-brand-blue/40'
                            }`}
                    >
                        <Map className="h-4 w-4 flex-shrink-0" />
                        <span className="flex-1 leading-tight">Roadmap</span>
                    </Link>
                </div>

                {/* Role badge + Logout */}
                <div className="p-3 border-t border-sidebar-border space-y-2">
                    <div className="flex items-center justify-between px-3">
                        <span className="text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
                            Tema
                        </span>
                        <ThemeToggle />
                    </div>
                    {role && (
                        <div className="px-3 py-2 rounded-lg bg-muted/60 flex items-center gap-2">
                            <Shield className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" />
                            <span className={`text-xs font-semibold capitalize ${
                                role === 'superadmin' ? 'text-amber-500 dark:text-amber-400' :
                                role === 'admin'      ? 'text-purple-500 dark:text-purple-400' :
                                role === 'trafficker' ? 'text-blue-500 dark:text-blue-400' :
                                'text-muted-foreground'
                            }`}>
                                {role === 'superadmin' ? 'Super Admin' :
                                 role === 'admin'      ? 'Admin' :
                                 role === 'trafficker' ? 'Trafficker' : 'Viewer'}
                            </span>
                        </div>
                    )}
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
                    <p className="px-3 pt-1 text-center text-[10px] font-medium text-muted-foreground/50 tracking-wide">
                        Ad House Reporting · v{APP_VERSION}
                    </p>
                </div>
            </aside>
        </>
    )
}
