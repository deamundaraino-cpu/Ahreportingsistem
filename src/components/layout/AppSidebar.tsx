'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'
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
    Key
} from 'lucide-react'

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
    ]

    const settingsNavigation = [
        { name: 'Ajustes de Sistema', href: '/admin/settings', icon: Settings, show: true },
        { name: 'Constructor de Layouts', href: '/admin/layouts', icon: Users, show: true },
        { name: 'Reportes Mensuales', href: '/admin/reports', icon: FileText, show: hasAdminAccess },
        { name: 'Gestión de Usuarios', href: '/admin/users', icon: Shield, show: hasAdminAccess },
        { name: 'API & Integraciones', href: '/admin/api-tokens', icon: Key, show: hasAdminAccess },
    ].filter(item => item.show)

    const isActive = (path: string) => pathname?.startsWith(path)

    if (loading) return null

    return (
        <>
            {/* Mobile Menu Button */}
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
                bg-white dark:bg-[#0E0E0E]
                border-r border-zinc-200 dark:border-white/[0.06]
                shadow-lg dark:shadow-none
                flex flex-col
                transition-transform duration-300 ease-in-out
                ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
            `}>

                {/* Logo area */}
                <div className="flex h-[68px] items-center px-5 border-b border-zinc-200 dark:border-white/[0.06]">
                    <div className="flex items-center gap-3">
                        {/* Brand icon: red-to-blue gradient matching logo */}
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg shadow-md"
                             style={{ background: 'linear-gradient(135deg, #E53529 0%, #1E6AB5 100%)' }}>
                            <BarChart3 className="h-4.5 w-4.5 text-white" />
                        </div>
                        <div className="flex flex-col leading-tight">
                            <span className="text-base font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
                                AdsHouse
                            </span>
                            <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500 tracking-wide uppercase">
                                Reporting
                            </span>
                        </div>
                    </div>
                </div>

                {/* Navigation */}
                <nav className="flex-1 space-y-6 px-3 py-6 overflow-y-auto custom-scrollbar">

                    {/* Dashboard section */}
                    <div>
                        <p className="px-3 text-[10px] font-semibold text-zinc-400 dark:text-zinc-600 uppercase tracking-widest mb-2">
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
                                                ? 'text-white dark:text-white'
                                                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-white/[0.06]'
                                            }
                                        `}
                                        style={active ? {
                                            background: 'linear-gradient(135deg, #E53529 0%, #c42d22 100%)',
                                            boxShadow: '0 2px 8px rgba(229, 53, 41, 0.35)'
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

                    {/* Settings section */}
                    <div>
                        <p className="px-3 text-[10px] font-semibold text-zinc-400 dark:text-zinc-600 uppercase tracking-widest mb-2">
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
                                                ? 'text-white dark:text-white'
                                                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-white/[0.06]'
                                            }
                                        `}
                                        style={active ? {
                                            background: 'linear-gradient(135deg, #1E6AB5 0%, #155a9a 100%)',
                                            boxShadow: '0 2px 8px rgba(30, 106, 181, 0.35)'
                                        } : undefined}
                                    >
                                        <item.icon
                                            className={`
                                                mr-3 flex-shrink-0 h-4.5 w-4.5 transition-transform duration-200
                                                group-hover:rotate-6
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
                </nav>

                {/* Role badge + Logout */}
                <div className="p-3 border-t border-zinc-200 dark:border-white/[0.06] space-y-2">
                    {role && (
                        <div className="px-3 py-2 rounded-lg bg-zinc-50 dark:bg-white/[0.04] flex items-center gap-2">
                            <Shield className="h-3.5 w-3.5 flex-shrink-0 text-zinc-400 dark:text-zinc-500" />
                            <span className={`text-xs font-semibold capitalize ${
                                role === 'superadmin' ? 'text-amber-500 dark:text-amber-400' :
                                role === 'admin'      ? 'text-purple-500 dark:text-purple-400' :
                                role === 'trafficker' ? 'text-blue-500 dark:text-blue-400' :
                                'text-zinc-400 dark:text-zinc-500'
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
