'use client'

// Lectura del diagnóstico que acompaña a una respuesta del BI, y su presentación.
//
// El invariante: un 0 en un informe significa «medimos y salió cero». Si no se
// pudo medir, se pinta «—» y se dice por qué. Es la misma regla que ya sigue
// `lib/fx.ts` con las tasas de cambio («nunca sumarlo como cero»), aplicada a
// todo el módulo.
//
// Antes cada widget hacía `Number(row[metric] ?? 0)`, así que un hueco y un cero
// real eran indistinguibles en pantalla — y de ahí venían los siete banners
// escritos a mano para explicar un cero a posteriori.

import { AlertCircle } from 'lucide-react'
import type { QueryDiagnostics } from '@/lib/report-utm/bi/diagnostics'
import { explainSkipReason } from '@/lib/report-utm/bi/diagnostics'

export interface WidgetUnavailable {
    /** Texto en español, listo para mostrar. */
    text: string
    /** Motivo en crudo, por si el widget quiere decidir el color. */
    kind: string
}

/**
 * ¿Este campo se pudo medir? Devuelve el motivo si no.
 *
 * `metricKeys` acepta varias porque una tabla pide varias columnas a la vez: se
 * devuelve el primer motivo encontrado, que es el que hay que explicar.
 */
export function readUnavailable(
    meta: QueryDiagnostics | undefined,
    metricKeys: string | string[]
): WidgetUnavailable | null {
    if (!meta) return null
    const claves = Array.isArray(metricKeys) ? metricKeys : [metricKeys]
    for (const k of claves) {
        const reason = meta.unavailable?.[k]
        if (!reason) continue
        // La etiqueta de la fuente da un mensaje mucho más útil («Anuncios
        // (Meta / TikTok)» en vez de «esta fuente»).
        const fuente = meta.skipped?.find(s =>
            Object.keys(meta.unavailable).length > 0 && s.reason.kind === reason.kind)
        return { text: explainSkipReason(reason, fuente?.sourceLabel), kind: reason.kind }
    }
    return null
}

/** Nota al pie de un widget explicando el hueco. Discreta pero legible. */
export function UnavailableNote({ info }: { info: WidgetUnavailable | null }) {
    if (!info) return null
    return (
        <p className="flex items-start gap-1 text-[10px] leading-snug text-amber-600 dark:text-amber-500">
            <AlertCircle className="h-3 w-3 shrink-0 mt-[1px]" />
            <span>{info.text}</span>
        </p>
    )
}

/**
 * Convierte el valor crudo de una fila en `number | null` sin colapsar a cero lo
 * que el motor marcó como desconocido.
 *
 * Sustituye al `Number(row[metric] ?? 0)` que estaba repartido por los widgets.
 * Ese `?? 0` tenía un efecto que pasaba desapercibido: el motor SÍ devuelve
 * `null` en un ratio que no se puede calcular (un CPL con 0 leads, un ROAS con 0
 * de gasto), y el `?? 0` lo convertía en un 0. Como el render solo pinta «—»
 * cuando el valor es `null`, esa rama era inalcanzable y el informe mostraba
 * «CPL 0», que se lee como «los leads salieron gratis».
 *
 * Se distinguen tres casos a propósito:
 *
 *  - `null` explícito del motor → `null`. No se pudo calcular. **Cambio visible
 *    y buscado**: algunos scorecards que mostraban 0 ahora muestran «—».
 *  - clave ausente o sin fila → `0`. Compatibilidad: el motor omite claves que
 *    no pidió, y ahí un 0 no engaña a nadie. Cambiarlo movería informes sin
 *    ninguna razón que dar.
 *  - hay un motivo en el diagnóstico → `null`, y el widget además lo explica.
 */
export function readValue(
    row: Record<string, unknown> | undefined,
    key: string,
    unavailable?: WidgetUnavailable | null
): number | null {
    if (unavailable) return null
    if (!row) return 0
    if (!(key in row)) return 0
    const v = row[key]
    if (v === null) return null
    if (v === undefined || v === '') return 0
    const n = Number(v)
    return Number.isFinite(n) ? n : null
}
