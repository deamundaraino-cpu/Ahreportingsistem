'use client'

import React, { useState, useRef, useEffect } from 'react'
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
import { triggerWorkerSync, triggerSheetsSync, getSyncProgress } from '../_actions'
import { SyncFreshnessBadge } from './SyncFreshnessBadge'

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
 *
 * Se devuelve la medianoche LOCAL del día colombiano, no el instante desplazado:
 * `format()` de date-fns lee la hora local, así que devolver `now - 5h` a un
 * navegador ya en UTC-5 restaba el desfase dos veces y "Hoy" era ayer hasta las
 * 10:00 de la mañana.
 */
const COLOMBIA_OFFSET_MS = 5 * 60 * 60 * 1000
const hoyColombia = () => parseISO(new Date(Date.now() - COLOMBIA_OFFSET_MS).toISOString().slice(0, 10))

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

    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'syncing_sheets' | 'success' | 'error' | 'queued' | 'stale'>('idle')
    /**
     * Detalle del último sync. NO se pinta en el dashboard: el botón solo dice en
     * qué fase está. Los avisos por plataforma, los de los Sheets y los errores de
     * la cola llenaban la cabecera de texto técnico que no es accionable ahí — su
     * sitio es /admin/sync. Aquí queda como `title` del botón, para poder
     * consultarlo pasando el ratón sin que ocupe la pantalla.
     */
    const [syncMessage, setSyncMessage] = useState<string | null>(null)
    // Se incrementa tras cada sync completado para forzar el refresco del semáforo.
    const [freshKey, setFreshKey] = useState(0)
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

    /**
     * Aplica el rango personalizado recortando el futuro.
     *
     * Ningún día posterior a hoy existe en Meta/TikTok/Hotmart/GA4: elegirlo solo
     * pintaba huecos en las gráficas y encolaba un job de sync condenado a fallar.
     * Todos los presets terminan en "hoy"; el rango manual sigue la misma regla.
     */
    const handleCustomApply = () => {
        setOpen(false)
        const hoy = fmt(hoyColombia())
        const desde = customFrom && customFrom > hoy ? hoy : customFrom
        const hasta = customTo && customTo > hoy ? hoy : customTo
        setCustomFrom(desde)
        setCustomTo(hasta)
        navigate(desde, hasta)
    }

    const stopPolling = () => {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    // Limpia el intervalo si el componente se desmonta a mitad de un sync en cola.
    useEffect(() => () => stopPolling(), [])

    /**
     * Cierra el sync: refresca los datos y deja el botón en "¡Actualizado!".
     *
     * `router.refresh()` vuelve a ejecutar la página de servidor con la URL
     * vigente —que ya lleva `from`/`to`—, así que lo que se repinta es el rango
     * que el usuario tiene puesto, sin recargar ni perder la pestaña activa.
     * `freshKey` fuerza además el refresco del semáforo de frescura.
     */
    const finishSuccess = (detalle?: string | null) => {
        stopPolling()
        setSyncStatus('success')
        setSyncMessage(detalle ?? null)
        setFreshKey(k => k + 1)
        router.refresh()
        setTimeout(() => { setSyncStatus('idle') }, 5000)
    }

    /**
     * Sondea el estado real de la cola tras encolar. Sin esto el botón fingía
     * "En cola…" 12 s y volvía a idle, ocultando si el sync fallaba o si nadie
     * llegaba a procesar los jobs.
     */
    const startPolling = (from: string, to: string) => {
        if (!clientId) return
        stopPolling()
        const deadline = Date.now() + 3 * 60 * 1000
        pollRef.current = setInterval(async () => {
            if (Date.now() > deadline) {
                stopPolling()
                setSyncStatus('stale')
                setSyncMessage('El sync sigue en cola. Si tarda, revísalo en el panel de sincronización (/admin/sync).')
                return
            }
            try {
                const prog = await getSyncProgress(clientId, from, to)
                if (!prog.ok || prog.estado === 'working') return
                if (prog.estado === 'error') {
                    stopPolling()
                    setSyncStatus('error')
                    setSyncMessage(prog.error || 'Un job de sincronización falló.')
                    return
                }
                // 'done' | 'empty' → ya no queda nada en cola para este rango.
                finishSuccess()
            } catch {
                // Error transitorio de red: reintenta en el próximo tick.
            }
        }, 4000)
    }

    /**
     * Sincroniza los Google Sheets del cliente después de las métricas.
     *
     * Un fallo aquí NO es un error del sync: las métricas ya entraron. Se avisa
     * y se sigue, porque marcarlo en rojo haría pensar que no se actualizó nada.
     * Devuelve el aviso a mostrar, si lo hay.
     */
    const sincronizarSheets = async (): Promise<string | null> => {
        setSyncStatus('syncing_sheets')
        const res = await triggerSheetsSync(clientId!)
        if (!res.configured) return null      // el cliente no tiene Sheets
        if (!res.ok) return `Métricas actualizadas. El Sheet falló: ${res.error}`
        return res.warnings?.[0] ?? null
    }

    const handleSync = async () => {
        if (!clientId || isPublic) return
        stopPolling()
        setSyncStatus('syncing')
        setSyncMessage(null)
        try {
            const syncFrom = fromParam === 'all' ? fmt(subDays(hoyColombia(), 365)) : fromParam
            const result = await triggerWorkerSync(clientId, syncFrom, toParam)
            if (!result.ok) throw new Error(result.error || 'Failed to sync')

            // El Sheet se sincroniza en las dos ramas: su job es independiente
            // del de métricas, así que no depende de si el rango se encoló.
            const avisoSheets = await sincronizarSheets()

            if (result.queued) {
                // Rango largo: quedó en cola. Sondeamos hasta que termine de verdad
                // y solo entonces se refrescan los datos.
                setSyncStatus('queued')
                setSyncMessage(avisoSheets ?? result.message ?? 'Sincronizando en segundo plano…')
                const r = result.range ?? { from: syncFrom, to: toParam }
                startPolling(r.from, r.to)
                return
            }

            // Rango corto (directo): ya terminó. Un aviso ("sin datos", un Sheet
            // que falló) no cambia lo que hay que hacer —refrescar con el rango
            // puesto—, solo queda en el tooltip.
            finishSuccess(avisoSheets ?? result.warning ?? result.message ?? null)
        } catch (err) {
            console.error('Error sincronizando', err)
            stopPolling()
            setSyncStatus('error')
            // El error persiste hasta reintentar: nada de auto-borrado a los 5 s.
            setSyncMessage(err instanceof Error ? err.message : 'Error al sincronizar')
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
                                    max={fmt(hoyColombia())}
                                    value={customFrom === 'all' ? '' : customFrom}
                                    onChange={e => setCustomFrom(e.target.value)}
                                    className="bg-muted text-foreground border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-ring cursor-pointer w-full"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground/70 ml-1">Hasta</span>
                                <input
                                    type="date"
                                    max={fmt(hoyColombia())}
                                    value={customTo}
                                    onChange={e => setCustomTo(e.target.value)}
                                    className="bg-muted text-foreground border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-ring cursor-pointer w-full"
                                />
                                <span className="text-[10px] text-muted-foreground/60 ml-1">
                                    Máximo hoy: aún no hay datos de días futuros.
                                </span>
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

            <div className={`flex flex-col items-end gap-1 ${isPublic ? 'hidden' : ''}`}>
                <Button
                    onClick={handleSync}
                    variant="outline"
                    size="sm"
                    // El detalle del sync vive aquí y solo aquí: visible al pasar el
                    // ratón, invisible el resto del tiempo.
                    title={syncMessage ?? undefined}
                    disabled={syncStatus === 'syncing' || syncStatus === 'syncing_sheets' || syncStatus === 'queued' || !clientId}
                    className={`mt-4 sm:mt-0 h-8 gap-2 border-border bg-background text-foreground/90 transition-colors
                        ${syncStatus === 'success' ? 'text-green-400 border-green-500/50 hover:bg-green-500/10 hover:text-green-300' : ''}
                        ${syncStatus === 'error' ? 'text-red-600 dark:text-red-400 border-red-500/50 hover:bg-red-500/10 hover:text-red-300' : ''}
                        ${(syncStatus === 'queued' || syncStatus === 'stale') ? 'text-amber-600 dark:text-amber-400 border-amber-500/50 hover:bg-amber-500/10' : ''}
                        ${syncStatus === 'idle' || syncStatus === 'syncing' || syncStatus === 'syncing_sheets' ? 'hover:bg-accent' : ''}
                    `}
                >
                    {(syncStatus === 'syncing' || syncStatus === 'syncing_sheets') && <Loader2 className="h-4 w-4 animate-spin text-blue-600 dark:text-blue-400" />}
                    {syncStatus === 'queued' && <Loader2 className="h-4 w-4 animate-spin text-amber-500" />}
                    {syncStatus === 'stale' && <Clock className="h-4 w-4 text-amber-500" />}
                    {syncStatus === 'success' && <CheckCircle2 className="h-4 w-4" />}
                    {syncStatus === 'error' && <AlertCircle className="h-4 w-4" />}
                    {syncStatus === 'idle' && <RefreshCcw className="h-4 w-4 text-blue-600 dark:text-blue-400" />}
                    {syncStatus === 'syncing' ? 'Sincronizando...' :
                        syncStatus === 'syncing_sheets' ? 'Sincronizando Sheets…' :
                        syncStatus === 'queued' ? 'En cola...' :
                            syncStatus === 'stale' ? 'Sigue en cola' :
                                syncStatus === 'success' ? '¡Actualizado!' :
                                    syncStatus === 'error' ? 'Error. Reintentar' : 'Sincronizar Datos'}
                </Button>

                {/* Sin detalles del sync: el estado del botón es toda la información
                    que el dashboard necesita dar. Los avisos por plataforma, los de
                    los Sheets y el error concreto de la cola quedan en el `title` del
                    botón y, completos, en /admin/sync. */}

                {clientId && !isPublic && <SyncFreshnessBadge clienteId={clientId} refreshKey={freshKey} />}
            </div>
        </div>
    )
}
