'use client'

/**
 * Bloque de desglose de leads por RESPUESTA de formulario.
 *
 * Todo el cálculo vive en `lib/dashboard/lead-answer-aggregation.ts` (puro y
 * verificable); aquí solo se pinta y se exporta.
 *
 * ── Por qué una sola tonalidad y no una por respuesta ────────────────────────
 * El trabajo de este bloque es COMPARAR MAGNITUDES entre categorías, no
 * distinguir series. En un gráfico de barras la identidad la lleva la etiqueta
 * de la fila, así que colorear cada barra de un color distinto sería una
 * codificación redundante — y hacerlo por posición en el ranking es peor: el
 * color de una respuesta cambiaría al cambiar el rango de fechas, que es
 * exactamente lo que un lector interpreta como "algo pasó". Una tonalidad para
 * los datos y gris de de-énfasis para la cola agrupada.
 */

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ListChecks, Download, AlertTriangle, Info } from 'lucide-react'
import { agregarRespuestas, serieDiaria } from '@/lib/dashboard/lead-answer-aggregation'
import type { LeadAnswerDatasetLite } from '@/lib/dashboard/lead-answer-aggregation'
import type { AnyCampaignFilter } from '@/lib/campaign-filter'
import type { LeadAnswerBlockDef } from '@/lib/layout-types'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Props {
    def: LeadAnswerBlockDef
    dataset?: LeadAnswerDatasetLite | null
    prevDataset?: LeadAnswerDatasetLite | null
    /** Filtro de campañas de la pestaña activa. */
    effectiveKeyword: AnyCampaignFilter
    campaignGroups?: any[]
    /** Recorte de fechas de la pestaña, en yyyy-MM-dd. */
    fechaInicio?: string | null
    fechaFin?: string | null
    clienteNombre?: string
    pestanaNombre?: string
    rangoLabel?: string
    filtroLabel?: string
}

const nf = new Intl.NumberFormat('es-CO')

function pctTexto(p: number): string {
    return `${p.toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function celda(v: string | number): string {
    const s = String(v ?? '')
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Descarga el desglose visible.
 *
 * Se genera en el navegador y no en una ruta de API a propósito: los datos ya
 * están agregados aquí, y una ruta tendría que reejecutar la consulta, recargar
 * el resolver de campañas y REIMPLEMENTAR el filtro de la pestaña — con la
 * garantía de que las dos copias divergirían. Es el mismo argumento por el que
 * la cascada UTM→campaña no baja a SQL. Además el espejo público no tiene sesión.
 */
function descargarCsv(
    nombreCampo: string,
    filas: { label: string; leads: number; pct: number; leadsPrevio: number | null; delta: number | null }[],
    meta: { cliente: string; pestana: string; rango: string; filtro: string; total: number; sinCruce: number },
) {
    const lineas: string[] = [
        // Cabecera de contexto: sin esto, un CSV abierto suelto dentro de tres
        // semanas no dice de qué cliente es ni qué filtro tenía aplicado.
        `# cliente,${celda(meta.cliente)}`,
        `# pestana,${celda(meta.pestana)}`,
        `# rango,${celda(meta.rango)}`,
        `# filtro_campana,${celda(meta.filtro || '(sin filtro)')}`,
        `# total_leads,${meta.total}`,
        `# leads_sin_campana_excluidos,${meta.sinCruce}`,
        'pregunta,respuesta,leads,pct_del_total,leads_periodo_anterior,variacion_pct',
    ]
    for (const f of filas) {
        lineas.push([
            celda(nombreCampo), celda(f.label), f.leads,
            f.pct.toFixed(2),
            f.leadsPrevio ?? '',
            f.delta === null ? '' : f.delta.toFixed(2),
        ].join(','))
    }

    // BOM: sin él, Excel en español abre el CSV en la codificación del sistema y
    // "Rango de ingresos" pierde los acentos.
    const blob = new Blob(['﻿' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    try {
        const a = document.createElement('a')
        a.href = url
        a.download = `respuestas-${nombreCampo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.csv`
        a.click()
    } finally {
        URL.revokeObjectURL(url)
    }
}

// ─── Estados vacíos ───────────────────────────────────────────────────────────

function Vacio({ titulo, texto, detalle }: { titulo: string; texto: string; detalle?: string }) {
    return (
        <Card className="bg-card/60 border-border">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-foreground text-base">
                    <ListChecks className="w-4 h-4 text-muted-foreground" />
                    {titulo}
                </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center py-8 gap-1.5 text-center">
                <p className="text-sm text-muted-foreground">{texto}</p>
                {detalle && <p className="text-xs text-muted-foreground/70 max-w-md">{detalle}</p>}
            </CardContent>
        </Card>
    )
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function LeadAnswerBlock({
    def, dataset, prevDataset, effectiveKeyword, campaignGroups,
    fechaInicio, fechaFin,
    clienteNombre = '', pestanaNombre = 'Vista general', rangoLabel = '', filtroLabel = '',
}: Props) {
    const [hover, setHover] = useState<number | null>(null)

    const res = useMemo(
        () => agregarRespuestas(dataset, def, effectiveKeyword, campaignGroups, {
            fechaInicio, fechaFin, prev: prevDataset,
        }),
        [dataset, def, effectiveKeyword, campaignGroups, fechaInicio, fechaFin, prevDataset],
    )

    const esDiario = def.display === 'daily'
    const serie = useMemo(
        () => esDiario
            ? serieDiaria(dataset, def, effectiveKeyword, campaignGroups, { fechaInicio, fechaFin })
            : { dias: [], buckets: [] },
        [esDiario, dataset, def, effectiveKeyword, campaignGroups, fechaInicio, fechaFin],
    )

    const sinPregunta = def.origen === 'catalogo' ? !def.clave : (def.clavesOrigen ?? []).length === 0
    if (sinPregunta) {
        return (
            <Vacio
                titulo={def.title || 'Respuestas de formulario'}
                texto="Elige una pregunta"
                detalle="Abre la configuración del bloque y selecciona qué pregunta del formulario quieres desglosar."
            />
        )
    }

    if (!dataset || dataset.campos.length === 0) {
        return (
            <Vacio
                titulo={def.title || 'Respuestas de formulario'}
                texto="No hay respuestas de formulario para este cliente"
                detalle="O el cliente no está enlazado al módulo de informes, o sus formularios no hacen preguntas (solo piden nombre y correo). Los leads siguen contándose en el resto del dashboard."
            />
        )
    }

    if (res.campoAusente) {
        return (
            <Vacio
                titulo={def.title || 'Respuestas de formulario'}
                texto="La pregunta configurada ya no está disponible"
                detalle="Puede que se haya borrado del catálogo de campos de lead, o que ningún lead del período la haya respondido. Vuelve a elegirla en la configuración del bloque."
            />
        )
    }

    const maxLeads = res.buckets.reduce((m, b) => Math.max(m, b.leads), 0)

    return (
        <Card className="bg-card/60 border-border">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-foreground text-base flex-wrap">
                    <ListChecks className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                    {def.title || res.nombreCampo}
                    <span className="ml-auto flex items-center gap-2">
                        <span className="text-xs font-normal text-muted-foreground/70">
                            {nf.format(res.total)} leads · {res.buckets.length} respuestas
                        </span>
                        {def.showCsv !== false && res.buckets.length > 0 && (
                            <button
                                type="button"
                                onClick={() => descargarCsv(res.nombreCampo, res.buckets, {
                                    cliente: clienteNombre, pestana: pestanaNombre,
                                    rango: rangoLabel, filtro: filtroLabel,
                                    total: res.total, sinCruce: res.sinCruce,
                                })}
                                className="p-1.5 text-muted-foreground/70 hover:text-foreground border border-border hover:border-muted-foreground/40 rounded transition"
                                title="Descargar CSV"
                            >
                                <Download className="w-3.5 h-3.5" />
                            </button>
                        )}
                    </span>
                </CardTitle>
                {/* Aviso permanente. No es decorativo: es lo que evita que dentro de
                    unos meses alguien pida "y el CPL por respuesta" dando por hecho
                    que solo falta añadir una columna. */}
                <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                    <Info className="w-3 h-3 shrink-0" />
                    Solo leads. Este bloque no reparte inversión por respuesta: el gasto se
                    mide por campaña y no sabe qué contestó cada lead.
                </p>
            </CardHeader>

            <CardContent className="space-y-1 pt-0">
                {esDiario ? (
                    /* Tabla diaria: el total del día y de qué está hecho.
                       Cada fila cierra — total = respuestas + (sin respuesta)—,
                       que es lo que permite leerla sin preguntarse dónde está el
                       resto. */
                    serie.dias.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            No hay contactos en este período con los filtros de esta pestaña.
                        </p>
                    ) : (
                        <div className="overflow-x-auto -mx-2">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="border-b border-border text-muted-foreground">
                                        <th className="text-left font-medium px-2 py-2">Día</th>
                                        <th className="text-right font-semibold px-2 py-2">Total</th>
                                        {serie.buckets.map(b => (
                                            <th key={b} className="text-right font-medium px-2 py-2 max-w-[9rem] truncate" title={b}>{b}</th>
                                        ))}
                                        <th className="text-right font-medium px-2 py-2 text-muted-foreground/70">Sin responder</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {serie.dias.map(d => (
                                        <tr key={d.fecha} className="border-b border-border/50 hover:bg-accent/40">
                                            <td className="px-2 py-1.5 text-foreground whitespace-nowrap">{d.fecha}</td>
                                            <td className="px-2 py-1.5 text-right font-semibold text-foreground tabular-nums">
                                                {nf.format(d.total)}
                                            </td>
                                            {d.porBucket.map((n, i) => (
                                                <td key={i} className="px-2 py-1.5 text-right text-foreground tabular-nums">
                                                    {n > 0 ? nf.format(n) : <span className="text-muted-foreground/40">·</span>}
                                                </td>
                                            ))}
                                            <td className="px-2 py-1.5 text-right text-muted-foreground tabular-nums">
                                                {d.sinRespuesta > 0 ? nf.format(d.sinRespuesta) : <span className="text-muted-foreground/40">·</span>}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr className="border-t-2 border-border font-semibold text-foreground">
                                        <td className="px-2 py-2">Total</td>
                                        <td className="px-2 py-2 text-right tabular-nums">
                                            {nf.format(serie.dias.reduce((s, d) => s + d.total, 0))}
                                        </td>
                                        {serie.buckets.map((_, i) => (
                                            <td key={i} className="px-2 py-2 text-right tabular-nums">
                                                {nf.format(serie.dias.reduce((s, d) => s + (d.porBucket[i] ?? 0), 0))}
                                            </td>
                                        ))}
                                        <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">
                                            {nf.format(serie.dias.reduce((s, d) => s + d.sinRespuesta, 0))}
                                        </td>
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                    )
                ) : res.buckets.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        Ningún lead respondió esta pregunta con los filtros de esta pestaña.
                    </p>
                ) : res.buckets.map((b, i) => {
                    // Ancho relativo al bucket mayor, no al total: con una respuesta
                    // dominante el resto se volvería invisible.
                    const ancho = maxLeads > 0 ? Math.max(2, (b.leads / maxLeads) * 100) : 0
                    return (
                        <div
                            key={b.label}
                            className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-accent/60 transition"
                            onMouseEnter={() => setHover(i)}
                            onMouseLeave={() => setHover(null)}
                            title={`${b.label}: ${nf.format(b.leads)} leads (${pctTexto(b.pct)})${
                                b.leadsPrevio !== null ? ` · período anterior: ${nf.format(b.leadsPrevio)}` : ''}`}
                        >
                            <span
                                className="text-sm text-foreground w-48 shrink-0 truncate"
                                title={b.label}
                            >
                                {b.label}
                            </span>

                            {/* Barra fina, extremo redondeado y anclada a la línea base. */}
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden min-w-0">
                                <div
                                    className={`h-full rounded-full transition-all ${
                                        b.esResto
                                            ? 'bg-muted-foreground/40'
                                            : hover === i
                                                ? 'bg-sky-600 dark:bg-sky-300'
                                                : 'bg-sky-500 dark:bg-sky-400'
                                    }`}
                                    style={{ width: `${ancho}%` }}
                                />
                            </div>

                            {/* El texto lleva tokens de texto, nunca el color de la serie. */}
                            <span className="text-xs text-muted-foreground w-12 text-right shrink-0 tabular-nums">
                                {pctTexto(b.pct)}
                            </span>
                            <span className="text-sm font-semibold text-foreground w-16 text-right shrink-0 tabular-nums">
                                {nf.format(b.leads)}
                            </span>

                            {def.showDelta !== false && (
                                <span className="w-16 text-right shrink-0 text-xs tabular-nums">
                                    {b.delta === null ? (
                                        // Un guion es "no se puede calcular", no "cero".
                                        // Misma regla que CPL/CPA/ROAS en el BI.
                                        <span className="text-muted-foreground/50">—</span>
                                    ) : (
                                        <span className={b.delta >= 0
                                            ? 'text-emerald-600 dark:text-emerald-400'
                                            : 'text-rose-600 dark:text-rose-400'}>
                                            {b.delta >= 0 ? '+' : ''}{b.delta.toFixed(0)}%
                                        </span>
                                    )}
                                </span>
                            )}
                        </div>
                    )
                })}

                {/* Pies informativos: cada uno explica un número que si no cuadraría mal. */}
                <div className="pt-2 space-y-1">
                    {res.sinCruce > 0 && (
                        <p className="text-[11px] text-muted-foreground/70">
                            {nf.format(res.sinCruce)} leads respondieron pero no se pudo identificar su
                            campaña, así que quedan fuera de este filtro.
                        </p>
                    )}
                    {res.omitidos > 0 && (
                        <p className="text-[11px] text-muted-foreground/70">
                            {nf.format(res.omitidos)} leads en respuestas fuera del Top {def.topN ?? 12}.
                        </p>
                    )}
                    {dataset.incompleto && (
                        <p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            Datos parciales: el período supera el tope de la consulta. Prueba con un
                            rango más corto.
                        </p>
                    )}
                </div>
            </CardContent>
        </Card>
    )
}
