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
    Shield
} from 'lucide-react'

export function AppSidebar({ initialRole = 'viewer' }: { initialRole?: string }) {
    const pathname = usePathname()
    const [isOpen, setIsOpen] = useState(false)
    const [role, setRole] = useState<string | null>(initialRole)
    const [loading, setLoading] = useState(false) // No longer need initial loading since we pass initialRole

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
                // Check once just in case
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

    const navigation = [
        { name: 'General Overview', href: '/dashboard', icon: LayoutDashboard },
    ]

    // Acceso global — todos los usuarios ven todo el menú
    const settingsNavigation = [
        { name: 'Ajustes de Sistema', href: '/admin/settings', icon: Settings },
        { name: 'Constructor de Layouts', href: '/admin/layouts', icon: Users },
        { name: 'Gestión de Usuarios', href: '/admin/users', icon: Shield },
    ]

    // Only Admin can see the User Management link if we add one in the future
    // For now, both see settings, but we might want to hide specific items for traffickers later
    
    const isActive = (path: string) => {
        return pathname?.startsWith(path)
    }

    if (loading) return null // Or a skeleton

    return (
        <>
            {/* Mobile Menu Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-md bg-zinc-900 border border-zinc-800 text-zinc-400 hover:text-white"
            >
                {isOpen ? <X size={20} /> : <Menu size={20} />}
            </button>

            {/* Backdrop for mobile */}
            {isOpen && (
                <div
                    className="fixed inset-0 bg-black/50 z-40 lg:hidden backdrop-blur-sm"
                    onClick={() => setIsOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside className={`
        fixed top-0 left-0 z-40 h-screen w-64 
        border-r border-zinc-800/50 bg-[#0A0A0A]/95 backdrop-blur-xl
        transition-transform duration-300 ease-in-out
        flex flex-col shadow-2xl
        ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
                <div className="flex h-20 items-center px-6 border-b border-zinc-800/50 bg-gradient-to-b from-black/20 to-transparent">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/20">
                            <BarChart3 className="h-5 w-5 text-white" />
                        </div>
                        <span className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white via-zinc-200 to-zinc-400">
                            AdsHouse
                        </span>
                    </div>
                </div>

                <nav className="flex-1 space-y-8 px-4 py-8 overflow-y-auto custom-scrollbar">
                    <div>
                        <p className="px-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                            Dashboard
                        </p>
                        <div className="space-y-1">
                            {navigation.map((item) => {
                                const active = isActive(item.href)
                                return (
                                    <Link
                                        key={item.name}
                                        href={item.href}
                                        onClick={() => setIsOpen(false)}
                                        className={`
                      group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-all duration-200
                      ${active
                                                ? 'bg-indigo-500/10 text-indigo-400 shadow-inner'
                                                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                                            }
                    `}
                                    >
                                        <item.icon
                                            className={`
                        mr-3 flex-shrink-0 h-5 w-5 transition-transform duration-200 group-hover:scale-110
                        ${active ? 'text-indigo-400' : 'text-zinc-500 group-hover:text-zinc-300'}
                      `}
                                        />
                                        {item.name}
                                        {active && (
                                            <div className="ml-auto w-1.5 h-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.8)] animate-pulse" />
                                        )}
                                    </Link>
                                )
                            })}
                        </div>
                    </div>

                    <div>
                        <p className="px-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4">
                            Configuración & APIs
                        </p>
                        <div className="space-y-1">
                            {settingsNavigation.map((item) => {
                                const active = isActive(item.href)
                                return (
                                    <Link
                                        key={item.name}
                                        href={item.href}
                                        onClick={() => setIsOpen(false)}
                                        className={`
                      group flex items-center px-3 py-2.5 text-sm font-medium rounded-lg transition-all duration-200
                      ${active
                                                ? 'bg-purple-500/10 text-purple-400 shadow-inner'
                                                : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
                                            }
                    `}
                                    >
                                        <item.icon
                                            className={`
                        mr-3 flex-shrink-0 h-5 w-5 transition-transform duration-200 group-hover:rotate-12
                        ${active ? 'text-purple-400' : 'text-zinc-500 group-hover:text-zinc-300'}
                      `}
                                        />
                                        {item.name}
                                        {active && (
                                            <div className="ml-auto w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.8)] animate-pulse" />
                                        )}
                                    </Link>
                                )
                            })}
                        </div>
                    </div>
            </nav>

                <div className="p-4 border-t border-zinc-800/50">
                    <form action="/auth/signout" method="post" className="w-full">
                        <button className="flex w-full items-center px-3 py-2.5 text-sm font-medium text-zinc-400 transition-colors rounded-lg hover:bg-red-500/10 hover:text-red-400 group">
                            <LogOut className="mr-3 h-5 w-5 text-zinc-500 group-hover:text-red-400 transition-colors" />
                            Cerrar Sesión
                        </button>
                    </form>
                </div>
            </aside>
        </>
    )
}
