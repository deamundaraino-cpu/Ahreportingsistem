'use client'

import React, { useState } from 'react'
import { useRouter, useSearchParams, useParams } from 'next/navigation'
import { format, parseISO, subDays } from 'date-fns'
import { es } from 'date-fns/locale'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, RefreshCcw, CheckCircle2, AlertCircle } from 'lucide-react'

export function DateRangeSelector({ basePath = '/dashboard' }: { basePath?: string }) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const params = useParams()
    const clientId = params.clientId as string | undefined

    const fromParam = searchParams.get('from') || format(subDays(new Date(), 30), 'yyyy-MM-dd')
    const toParam = searchParams.get('to') || format(new Date(), 'yyyy-MM-dd')

    const [from, setFrom] = useState(fromParam)
    const [to, setTo] = useState(toParam)

    // Status can be: 'idle' | 'syncing' | 'success' | 'error'
    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle')
    const [syncLogs, setSyncLogs] = useState<{ meta?: string, hotmart?: string, ga4?: string }>({})

    const handleApply = () => {
        router.push(`${basePath}/${clientId}?from=${from}&to=${to}`)
    }

    const handleSync = async () => {
        if (!clientId) return

        setSyncStatus('syncing')
        setSyncLogs({})

        try {
            const res = await fetch(`/api/worker?start=${from}&end=${to}&client_id=${clientId}`)
            const resData = await res.json()

            if (!res.ok) {
                throw new Error(resData.error || 'Failed to sync')
            }

            // The worker will return statuses for each platform it attempted to run
            if (resData.platform_status) {
                setSyncLogs(resData.platform_status)
            } else {
                setSyncLogs({ meta: 'Sincronizado', hotmart: 'Sincronizado', ga4: 'Sincronizado' })
            }

            setSyncStatus('success')
            router.refresh()

            setTimeout(() => setSyncStatus('idle'), 5000)
        } catch (err) {
            console.error("Error sincronizando", err)
            setSyncStatus('error')
            setTimeout(() => setSyncStatus('idle'), 5000)
        }
    }

    return (
        <div className="flex flex-col sm:flex-row items-center gap-3 bg-zinc-900 border border-zinc-800 p-2 rounded-lg mt-4 sm:mt-0">
            <div className="flex items-center gap-2">
                <div className="flex flex-col">
                    <span className="text-xs text-zinc-500 font-medium ml-1">Desde</span>
                    <input
                        type="date"
                        value={from}
                        onChange={(e) => setFrom(e.target.value)}
                        className="bg-zinc-800 text-zinc-100 border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-zinc-500 cursor-pointer"
                    />
                </div>
                <div className="flex flex-col">
                    <span className="text-xs text-zinc-500 font-medium ml-1">Hasta</span>
                    <input
                        type="date"
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                        className="bg-zinc-800 text-zinc-100 border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-zinc-500 cursor-pointer"
                    />
                </div>
                <Button onClick={handleApply} variant="secondary" size="sm" className="mt-4 h-8 bg-zinc-700 hover:bg-zinc-600 text-zinc-100">
                    Filtrar
                </Button>
            </div>

            <div className="h-8 w-px bg-zinc-700 hidden sm:block mx-1"></div>

            <div className="flex flex-col items-end">
                <Button
                    onClick={handleSync}
                    variant="outline"
                    size="sm"
                    disabled={syncStatus === 'syncing' || !clientId}
                    className={`mt-4 sm:mt-0 h-8 gap-2 border-zinc-700 bg-zinc-950 text-zinc-300 transition-colors
                        ${syncStatus === 'success' ? 'text-green-400 border-green-500/50 hover:bg-green-500/10 hover:text-green-300' : ''}
                        ${syncStatus === 'error' ? 'text-red-400 border-red-500/50 hover:bg-red-500/10 hover:text-red-300' : 'hover:bg-zinc-800'}
                    `}
                >
                    {syncStatus === 'syncing' && <Loader2 className="h-4 w-4 animate-spin text-blue-400" />}
                    {syncStatus === 'success' && <CheckCircle2 className="h-4 w-4" />}
                    {syncStatus === 'error' && <AlertCircle className="h-4 w-4" />}
                    {syncStatus === 'idle' && <RefreshCcw className="h-4 w-4 text-blue-400" />}

                    {syncStatus === 'syncing' ? 'Sincronizando...' :
                        syncStatus === 'success' ? '¡Actualizado!' :
                            syncStatus === 'error' ? 'Error. Reintentar' : 'Sincronizar Datos'}
                </Button>

                {/* Minimalist log indicators */}
                {syncStatus === 'success' && syncLogs && (
                    <div className="flex gap-2 mt-1 text-[10px] font-mono justify-end w-full">
                        {syncLogs.meta && <span className={syncLogs.meta.includes('Saltado') ? 'text-zinc-500' : 'text-green-500/80'}>M:{syncLogs.meta.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                        {syncLogs.hotmart && <span className={syncLogs.hotmart.includes('Saltado') ? 'text-zinc-500' : 'text-green-500/80'}>H:{syncLogs.hotmart.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                        {syncLogs.ga4 && <span className={syncLogs.ga4.includes('Saltado') ? 'text-zinc-500' : 'text-green-500/80'}>G:{syncLogs.ga4.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                    </div>
                )}
            </div>
        </div>
    )
}
