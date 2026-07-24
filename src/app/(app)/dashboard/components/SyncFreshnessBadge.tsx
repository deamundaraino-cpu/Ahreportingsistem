'use client'

import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { es } from 'date-fns/locale'
import { getDataFreshness } from '../_actions'

type Display = {
    color: 'verde' | 'ambar' | 'rojo'
    etiqueta: string
    relativo: string
    errorMsg: string | null
}

/**
 * Semáforo de "última sincronización" del cliente.
 *
 * Existe porque, hasta ahora, un pipeline caído no dejaba ninguna señal en el
 * dashboard: los datos simplemente se quedaban viejos sin que nadie lo notara.
 * El color se decide por la antigüedad de `metricas_diarias.synced_at` y se pone
 * rojo si la última ejecución registrada en `sync_runs` terminó en error.
 *
 * - Verde  : sincronizado hace < 6 h.
 * - Ámbar  : entre 6 y 24 h (o datos parciales del día en curso).
 * - Rojo   : > 24 h sin sincronizar, o última ejecución en error.
 *
 * El bucketing se calcula dentro del efecto (no en render) para no llamar a
 * `Date.now()` durante el renderizado.
 */
export function SyncFreshnessBadge({ clienteId, refreshKey = 0 }: { clienteId: string; refreshKey?: number }) {
    const [display, setDisplay] = useState<Display | null>(null)

    useEffect(() => {
        if (!clienteId) return
        let activo = true
        getDataFreshness(clienteId)
            .then((res) => {
                if (!activo) return
                const syncedAt = res.data?.synced_at ? new Date(res.data.synced_at) : null
                const horas = syncedAt ? (Date.now() - syncedAt.getTime()) / 3_600_000 : Infinity
                const ultimoRunError = res.lastRun?.estado === 'error'

                let color: Display['color']
                let etiqueta: string
                if (ultimoRunError || horas > 24) {
                    color = 'rojo'
                    etiqueta = ultimoRunError ? 'Último sync con error' : 'Datos desactualizados'
                } else if (horas > 6 || res.data?.is_partial) {
                    color = 'ambar'
                    etiqueta = res.data?.is_partial ? 'Datos parciales del día' : 'Sincronización antigua'
                } else {
                    color = 'verde'
                    etiqueta = 'Datos al día'
                }

                setDisplay({
                    color,
                    etiqueta,
                    relativo: syncedAt ? formatDistanceToNow(syncedAt, { addSuffix: true, locale: es }) : 'sin registro',
                    errorMsg: res.lastRun?.error ?? null,
                })
            })
            .catch(() => { /* observabilidad, no debe romper el dashboard */ })
        return () => { activo = false }
    }, [clienteId, refreshKey])

    if (!display) return null
    const { color, etiqueta, relativo, errorMsg } = display

    const dot = { verde: 'bg-green-500', ambar: 'bg-amber-500', rojo: 'bg-red-500' }[color]
    const texto = {
        verde: 'text-green-600 dark:text-green-400',
        ambar: 'text-amber-600 dark:text-amber-400',
        rojo: 'text-red-600 dark:text-red-400',
    }[color]

    return (
        <div
            className="flex items-center gap-1.5 text-[11px]"
            title={`${etiqueta}. Última verificación: ${relativo}${errorMsg ? `\nÚltimo error: ${errorMsg}` : ''}`}
        >
            <span className={`h-2 w-2 rounded-full ${dot} ${color === 'rojo' ? 'animate-pulse' : ''}`} />
            <span className={texto}>{etiqueta} · {relativo}</span>
        </div>
    )
}
