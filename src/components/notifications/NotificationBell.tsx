'use client'

// Campanita de notificaciones: contador de no leídas en vivo (Supabase
// Realtime sobre public.notifications) + popover con las últimas 10.
// Se monta tanto en la topbar desktop como en el header mobile del
// layout autenticado.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { toast } from 'sonner'
import { AlertTriangle, Bell, CheckCheck, CheckCircle2, Info, XCircle } from 'lucide-react'
import { createClient } from '@/utils/supabase/client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
    getNotifications,
    getUnreadCount,
    markAllAsRead,
    markAsRead,
} from '@/app/(app)/notificaciones/_actions'
import type { InAppNotification, NotificationSeverity } from '@/lib/notifications/types'

const SEVERITY_ICON: Record<NotificationSeverity, React.ReactNode> = {
    info: <Info className="h-4 w-4 text-indigo-500 shrink-0" />,
    success: <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />,
    warning: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
    error: <XCircle className="h-4 w-4 text-rose-500 shrink-0" />,
}

export function NotificationBell({ userId }: { userId: string }) {
    const router = useRouter()
    const [items, setItems] = useState<InAppNotification[]>([])
    const [unread, setUnread] = useState(0)
    const [open, setOpen] = useState(false)
    // Evita duplicar toasts cuando el componente está montado dos veces
    // (header mobile + topbar desktop): solo la primera instancia los emite.
    const toastOwner = useRef(false)

    const refresh = useCallback(async () => {
        const [{ items: latest }, count] = await Promise.all([
            getNotifications({ limit: 10 }),
            getUnreadCount(),
        ])
        setItems(latest)
        setUnread(count)
    }, [])

    useEffect(() => {
        refresh()

        if (!(window as any).__notifToastOwner) {
            ;(window as any).__notifToastOwner = true
            toastOwner.current = true
        }

        const supabase = createClient()
        const channel = supabase
            .channel(`notif:${userId}:${Math.random().toString(36).slice(2)}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'notifications',
                    filter: `user_id=eq.${userId}`,
                },
                (payload) => {
                    const notif = payload.new as InAppNotification
                    setItems((prev) => [notif, ...prev].slice(0, 10))
                    setUnread((n) => n + 1)
                    if (toastOwner.current) {
                        const show =
                            notif.severity === 'error' ? toast.error
                            : notif.severity === 'warning' ? toast.warning
                            : notif.severity === 'success' ? toast.success
                            : toast.info
                        show(notif.title, {
                            description: notif.message ?? undefined,
                            action: notif.link
                                ? { label: 'Ver', onClick: () => router.push(notif.link!) }
                                : undefined,
                        })
                    }
                }
            )
            .subscribe()

        return () => {
            supabase.removeChannel(channel)
            if (toastOwner.current) {
                ;(window as any).__notifToastOwner = false
                toastOwner.current = false
            }
        }
    }, [userId, refresh, router])

    const handleClick = async (notif: InAppNotification) => {
        setOpen(false)
        if (!notif.read_at) {
            setItems((prev) =>
                prev.map((n) => (n.id === notif.id ? { ...n, read_at: new Date().toISOString() } : n))
            )
            setUnread((n) => Math.max(0, n - 1))
            markAsRead(notif.id)
        }
        if (notif.link) router.push(notif.link)
    }

    const handleMarkAll = async () => {
        setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })))
        setUnread(0)
        await markAllAsRead()
    }

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="relative" aria-label="Notificaciones">
                    <Bell className="h-5 w-5" />
                    {unread > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-[#E53529] text-white text-[10px] font-bold flex items-center justify-center">
                            {unread > 99 ? '99+' : unread}
                        </span>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 sm:w-96 p-0">
                <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-white/[0.06]">
                    <span className="text-sm font-semibold">Notificaciones</span>
                    {unread > 0 && (
                        <button
                            onClick={handleMarkAll}
                            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 flex items-center gap-1"
                        >
                            <CheckCheck className="h-3.5 w-3.5" />
                            Marcar todas
                        </button>
                    )}
                </div>

                <div className="max-h-[360px] overflow-y-auto">
                    {items.length === 0 ? (
                        <div className="px-4 py-8 text-center text-sm text-zinc-500">
                            No tienes notificaciones
                        </div>
                    ) : (
                        items.map((notif) => (
                            <button
                                key={notif.id}
                                onClick={() => handleClick(notif)}
                                className={`w-full text-left px-4 py-3 flex gap-3 border-b border-zinc-100 dark:border-white/[0.04] last:border-0 hover:bg-zinc-50 dark:hover:bg-white/[0.03] transition-colors ${
                                    !notif.read_at ? 'bg-indigo-50/50 dark:bg-indigo-500/[0.06]' : ''
                                }`}
                            >
                                <span className="mt-0.5">{SEVERITY_ICON[notif.severity] ?? SEVERITY_ICON.info}</span>
                                <span className="flex-1 min-w-0">
                                    <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                                        {notif.title}
                                    </span>
                                    {notif.message && (
                                        <span className="block text-xs text-zinc-500 line-clamp-2">{notif.message}</span>
                                    )}
                                    <span className="block text-[11px] text-zinc-400 mt-0.5">
                                        {formatDistanceToNow(new Date(notif.created_at), { addSuffix: true, locale: es })}
                                    </span>
                                </span>
                                {!notif.read_at && (
                                    <span className="mt-1.5 h-2 w-2 rounded-full bg-[#1E6AB5] shrink-0" />
                                )}
                            </button>
                        ))
                    )}
                </div>

                <div className="px-4 py-2.5 border-t border-zinc-200 dark:border-white/[0.06]">
                    <button
                        onClick={() => {
                            setOpen(false)
                            router.push('/notificaciones')
                        }}
                        className="text-xs font-medium text-[#1E6AB5] hover:underline"
                    >
                        Ver todas las notificaciones
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    )
}
