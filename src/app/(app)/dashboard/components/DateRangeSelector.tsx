'use client'

import React, { useState } from 'react'
import { useRouter, useSearchParams, useParams } from 'next/navigation'
import {
    format, subDays, subYears, parseISO,
    startOfWeek, endOfWeek, subWeeks,
    startOfMonth, endOfMonth, subMonths,
} from 'date-fns'
import { es } from 'date-fns/locale'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Loader2, RefreshCcw, CheckCircle2, AlertCircle, ChevronDown, CalendarDays, Clock } from 'lucide-react'
import { triggerWorkerSync } from '../_actions'

const fmt = (d: Date) => format(d, 'yyyy-MM-dd')
const fmtDisplay = (d: Date) => format(d, 'd MMM yyyy', { locale: es })

/**
 * "Hoy" en hora Colombia, no en la del navegador.
 *
 * Los presets usaban `new Date()` del cliente: un usuario en España veía "Hoy"
 * apuntando a una fecha que en Colombia todavía no existe, el worker no la había
 * sincronizado (nunca sincroniza el futuro) y el dashboard salía vacío. La
 * operación entera —crons, cortes de día, `is_partial`— trabaja en UTC-5, así
 * que los presets deben hacer lo mismo.
 */
const COLOMBIA_OFFSET_MS = 5 * 60 * 60 * 1000
const hoyColombia = () => new Date(Date.now() - COLOMBIA_OFFSET_MS)

type Preset = { id: string; label: string; getRange: () => { from: string; to: string } }

const PRESETS: Preset[] = [
    { id: 'today', label: 'Hoy', getRange: () => { const t = hoyColombia(); return { from: fmt(t), to: fmt(t) } } },
    { id: 'yesterday', label: 'Ayer', getRange: () => { const y = subDays(hoyColombia(), 1); return { from: fmt(y), to: fmt(y) } } },
    { id: 'today_yesterday', label: 'Hoy y ayer', getRange: () => ({ from: fmt(subDays(hoyColombia(), 1)), to: fmt(hoyColombia()) }) },
    { id: 'last7', label: 'Últimos 7 días', getRange: () => ({ from: fmt(subDays(hoyColombia(), 6)), to: fmt(hoyColombia()) }) },
    { id: 'last14', label: 'Últimos 14 días', getRange: () => ({ from: fmt(subDays(hoyColombia(), 13)), to: fmt(hoyColombia()) }) },
    { id: 'last28', label: 'Últimos 28 días', getRange: () => ({ from: fmt(subDays(hoyColombia(), 27)), to: fmt(hoyColombia()) }) },
    { id: 'last30', label: 'Últimos 30 días', getRange: () => ({ from: fmt(subDays(hoyColombia(), 29)), to: fmt(hoyColombia()) }) },
    { id: 'this_week', label: 'Esta semana', getRange: () => ({ from: fmt(startOfWeek(hoyColombia(), { weekStartsOn: 1 })), to: fmt(hoyColombia()) }) },
    {
        id: 'last_week', label: 'La semana pasada', getRange: () => {
            const ref = subWeeks(hoyColombia(), 1)
            return { from: fmt(startOfWeek(ref, { weekStartsOn: 1 })), to: fmt(endOfWeek(ref, { weekStartsOn: 1 })) }
        }
    },
    { id: 'this_month', label: 'Este mes', getRange: () => ({ from: fmt(startOfMonth(hoyColombia())), to: fmt(hoyColombia()) }) },
    {
        id: 'last_month', label: 'El mes pasado', getRange: () => {
            const ref = subMonths(hoyColombia(), 1)
            return { from: fmt(startOfMonth(ref)), to: fmt(endOfMonth(ref)) }
        }
    },
    { id: 'all', label: 'Máximo', getRange: () => ({ from: 'all', to: fmt(hoyColombia()) }) },
]

function getActivePreset(from: string, to: string): string {
    for (const preset of PRESETS) {
        const range = preset.getRange()
        if (range.from === from && range.to === to) return preset.id
    }
    return 'personalizado'
}

export function DateRangeSelector({ basePath = '/dashboard', isPublic = false }: { basePath?: string; isPublic?: boolean }) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const params = useParams()
    const clientId = params.clientId as string | undefined
    const token = params.token as string | undefined

    const fromParam = searchParams.get('from') || fmt(subDays(hoyColombia(), 29))
    const toParam = searchParams.get('to') || fmt(hoyColombia())

    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error' | 'queued'>('idle')
    const [syncLogs, setSyncLogs] = useState<{ meta?: string; hotmart?: string; ga4?: string }>({})
    const [syncMessage, setSyncMessage] = useState<string | null>(null)

    const [open, setOpen] = useState(false)
    const [showCustom, setShowCustom] = useState(false)
    const [customFrom, setCustomFrom] = useState(fromParam)
    const [customTo, setCustomTo] = useState(toParam)

    const activePresetId = getActivePreset(fromParam, toParam)
    const activeLabel = PRESETS.find(p => p.id === activePresetId)?.label ?? 'Personalizado'
    const buttonLabel = activePresetId === 'all'
        ? `Máximo: ${fmtDisplay(subYears(hoyColombia(), 3))} – ${fmtDisplay(hoyColombia())}`
        : `${activeLabel}: ${fmtDisplay(parseISO(fromParam))} – ${fmtDisplay(parseISO(toParam))}`

    const navigate = (from: string, to: string) => {
        const id = isPublic ? token : clientId
        router.push(`${basePath}/${id}?from=${from}&to=${to}`)
    }

    const handleOpenChange = (v: boolean) => {
        setOpen(v)
        if (v) {
            setShowCustom(activePresetId === 'personalizado')
            setCustomFrom(fromParam)
            setCustomTo(toParam)
        }
    }

    const handlePresetSelect = (presetId: string) => {
        if (presetId === 'personalizado') {
            setShowCustom(true)
            return
        }
        const preset = PRESETS.find(p => p.id === presetId)
        if (!preset) return
        const range = preset.getRange()
        setOpen(false)
        navigate(range.from, range.to)
    }

    const handleCustomApply = () => {
        setOpen(false)
        navigate(customFrom, customTo)
    }

    const handleSync = async () => {
        if (!clientId || isPublic) return
        setSyncStatus('syncing')
        setSyncLogs({})
        setSyncMessage(null)
        try {
            const syncFrom = fromParam === 'all' ? fmt(subDays(hoyColombia(), 365)) : fromParam
            const result = await triggerWorkerSync(clientId, syncFrom, toParam)
            if (!result.ok) throw new Error(result.error || 'Failed to sync')
            setSyncMessage(result.message ?? null)
            if (result.queued) {
                // Rango largo: quedó en cola. El aviso dura más porque el trabajo
                // sigue en segundo plano y el usuario debe saber que no terminó aún.
                setSyncStatus('queued')
                setTimeout(() => { setSyncStatus('idle'); setSyncMessage(null) }, 12000)
                return
            }
            setSyncLogs(result.platform_status ?? { meta: 'Sincronizado', hotmart: 'Sincronizado', ga4: 'Sincronizado' })
            setSyncStatus('success')
            router.refresh()
            setTimeout(() => { setSyncStatus('idle'); setSyncMessage(null) }, 5000)
        } catch (err) {
            console.error('Error sincronizando', err)
            setSyncStatus('error')
            setTimeout(() => { setSyncStatus('idle'); setSyncMessage(null) }, 5000)
        }
    }

    const isCustomSelected = activePresetId === 'personalizado' || showCustom

    return (
        <div className="flex flex-col sm:flex-row items-center gap-3 bg-card border border-border p-2 rounded-lg mt-4 sm:mt-0">
            <Popover open={open} onOpenChange={handleOpenChange}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-2 border-border bg-muted text-foreground hover:bg-accent hover:text-foreground"
                    >
                        <CalendarDays className="h-4 w-4 text-muted-foreground" />
                        {buttonLabel}
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    className="w-52 p-2 bg-card border-border shadow-xl"
                    align="start"
                    sideOffset={6}
                >
                    <div className="max-h-72 overflow-y-auto space-y-0.5">
                        {PRESETS.map(preset => {
                            const isActive = activePresetId === preset.id && !showCustom
                            return (
                                <button
                                    key={preset.id}
                                    onClick={() => handlePresetSelect(preset.id)}
                                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm rounded-md text-left transition-colors
                                        ${isActive ? 'bg-secondary text-secondary-foreground' : 'text-foreground/90 hover:bg-accent hover:text-foreground'}`}
                                >
                                    <span className={`h-3.5 w-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center
                                        ${isActive ? 'border-blue-500' : 'border-muted-foreground/40'}`}>
                                        {isActive && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
                                    </span>
                                    {preset.label}
                                </button>
                            )
                        })}
                        <button
                            onClick={() => handlePresetSelect('personalizado')}
                            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm rounded-md text-left transition-colors
                                ${isCustomSelected ? 'bg-secondary text-secondary-foreground' : 'text-foreground/90 hover:bg-accent hover:text-foreground'}`}
                        >
                            <span className={`h-3.5 w-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center
                                ${isCustomSelected ? 'border-blue-500' : 'border-muted-foreground/40'}`}>
                                {isCustomSelected && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
                            </span>
                            Personalizado
                        </button>
                    </div>

                    {isCustomSelected && (
                        <div className="mt-2 pt-2 border-t border-border space-y-2">
                            <div className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground/70 ml-1">Desde</span>
                                <input
                                    type="date"
                                    value={customFrom === 'all' ? '' : customFrom}
                                    onChange={e => setCustomFrom(e.target.value)}
                                    className="bg-muted text-foreground border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-ring cursor-pointer w-full"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground/70 ml-1">Hasta</span>
                                <input
                                    type="date"
                                    value={customTo}
                                    onChange={e => setCustomTo(e.target.value)}
                                    className="bg-muted text-foreground border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-ring cursor-pointer w-full"
                                />
                            </div>
                            <Button
                                onClick={handleCustomApply}
                                size="sm"
                                className="w-full h-8 bg-muted-foreground/30 hover:bg-accent text-foreground"
                            >
                                Aplicar
                            </Button>
                        </div>
                    )}
                </PopoverContent>
            </Popover>

            <div className="h-8 w-px bg-muted-foreground/30 hidden sm:block mx-1" />

            <div className={`flex flex-col items-end ${isPublic ? 'hidden' : ''}`}>
                <Button
                    onClick={handleSync}
                    variant="outline"
                    size="sm"
                    disabled={syncStatus === 'syncing' || !clientId}
                    className={`mt-4 sm:mt-0 h-8 gap-2 border-border bg-background text-foreground/90 transition-colors
                        ${syncStatus === 'success' ? 'text-green-400 border-green-500/50 hover:bg-green-500/10 hover:text-green-300' : ''}
                        ${syncStatus === 'error' ? 'text-red-600 dark:text-red-400 border-red-500/50 hover:bg-red-500/10 hover:text-red-300' : 'hover:bg-accent'}
                    `}
                >
                    {syncStatus === 'syncing' && <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />}
                    {syncStatus === 'queued' && <Clock className="h-4 w-4 text-amber-500" />}
                    {syncStatus === 'success' && <CheckCircle2 className="h-4 w-4" />}
                    {syncStatus === 'error' && <AlertCircle className="h-4 w-4" />}
                    {syncStatus === 'idle' && <RefreshCcw className="h-4 w-4 text-blue-600 dark:text-blue-400" />}
                    {syncStatus === 'syncing' ? 'Sincronizando...' :
                        syncStatus === 'queued' ? 'En cola...' :
                            syncStatus === 'success' ? '¡Actualizado!' :
                                syncStatus === 'error' ? 'Error. Reintentar' : 'Sincronizar Datos'}
                </Button>

                {syncStatus === 'queued' && syncMessage && (
                    <div className="mt-1 text-[10px] text-amber-600 dark:text-amber-400 text-right max-w-[240px]">
                        {syncMessage}
                    </div>
                )}

                {syncStatus === 'success' && syncLogs && (
                    <div className="flex gap-2 mt-1 text-[10px] font-mono justify-end w-full">
                        {syncLogs.meta && <span className={syncLogs.meta.includes('Saltado') ? 'text-muted-foreground/70' : 'text-green-500/80'}>M:{syncLogs.meta.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                        {syncLogs.hotmart && <span className={syncLogs.hotmart.includes('Saltado') ? 'text-muted-foreground/70' : 'text-green-500/80'}>H:{syncLogs.hotmart.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                        {syncLogs.ga4 && <span className={syncLogs.ga4.includes('Saltado') ? 'text-muted-foreground/70' : 'text-green-500/80'}>G:{syncLogs.ga4.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                    </div>
                )}
            </div>
        </div>
    )
}
