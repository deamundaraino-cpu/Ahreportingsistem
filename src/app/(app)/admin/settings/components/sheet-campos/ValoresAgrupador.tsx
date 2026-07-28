'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Wand2, Undo2, AlertTriangle, Layers } from 'lucide-react'
import {
    normalizarValorCrudo, bucketDeValor, sugerirAgrupacion,
} from '@/lib/sheets/campos'
import type { SheetCampoDef, CampoValoresMap, CampoValorCrudo } from '@/lib/sheets/campos'

/**
 * Agrupador de valores: la parte que resuelve que una hoja diga "20 a 100" y
 * otra "20-100" para el mismo dato.
 *
 * A la izquierda, los valores tal como están en los Sheets, con cuántas filas
 * tiene cada uno y de qué pestaña salen. A la derecha, los buckets resultantes.
 * Se seleccionan varios valores y se agrupan bajo un nombre propio.
 *
 * El cálculo del bucket lo hace la MISMA función que usa el motor
 * (`bucketDeValor`), así que la vista previa no puede mentir.
 */
export function ValoresAgrupador({ campo, valores, totalDistintos, onChange }: {
    campo: SheetCampoDef
    valores: CampoValorCrudo[]
    totalDistintos: number
    onChange: (valoresMap: CampoValoresMap) => void
}) {
    const [seleccion, setSeleccion] = useState<Set<string>>(new Set())
    const [nombreGrupo, setNombreGrupo] = useState('')
    const [filtro, setFiltro] = useState('')

    const visibles = useMemo(() => {
        const f = filtro.trim().toLowerCase()
        return f ? valores.filter(v => v.valor_crudo.toLowerCase().includes(f)) : valores
    }, [valores, filtro])

    // Buckets tal como quedarían ahora mismo, calculados con el motor real.
    const buckets = useMemo(() => {
        const mapa = new Map<string, { filas: number; crudos: string[] }>()
        for (const v of valores) {
            const b = bucketDeValor(campo, v.valor_crudo)
            if (b === null) continue
            const e = mapa.get(b) ?? { filas: 0, crudos: [] }
            e.filas += v.filas
            e.crudos.push(v.valor_crudo)
            mapa.set(b, e)
        }
        return Array.from(mapa.entries())
            .map(([bucket, d]) => ({ bucket, ...d }))
            .sort((a, b) => b.filas - a.filas)
    }, [campo, valores])

    const toggle = (valorCrudo: string) => {
        setSeleccion(prev => {
            const next = new Set(prev)
            if (next.has(valorCrudo)) next.delete(valorCrudo)
            else next.add(valorCrudo)
            return next
        })
    }

    const agrupar = () => {
        const nombre = nombreGrupo.trim()
        if (!nombre || seleccion.size === 0) return
        const next = { ...campo.valores_map }
        for (const crudo of seleccion) next[normalizarValorCrudo(crudo)] = nombre
        onChange(next)
        setSeleccion(new Set())
        setNombreGrupo('')
    }

    const desagrupar = (bucket: string) => {
        const next = { ...campo.valores_map }
        for (const [k, v] of Object.entries(next)) if (v === bucket) delete next[k]
        onChange(next)
    }

    const autoAgrupar = () => {
        const sugerido = sugerirAgrupacion(valores)
        if (Object.keys(sugerido).length === 0) return
        // Lo ya decidido a mano manda sobre la sugerencia.
        onChange({ ...sugerido, ...campo.valores_map })
    }

    if (valores.length === 0) {
        return (
            <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <p className="text-xs text-muted-foreground">
                    Aún no hay valores detectados para este campo.
                </p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                    Guarda el campo con sus pestañas y columnas: al calcularlo aparecerán aquí los
                    valores reales para agruparlos.
                </p>
            </div>
        )
    }

    const excedeTope = totalDistintos > campo.max_valores

    return (
        <div className="space-y-3">
            {excedeTope && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                        Este campo tiene <strong>{totalDistintos}</strong> valores distintos (tope{' '}
                        {campo.max_valores}). Se conservarán los más frecuentes y el resto se agrupará
                        en <span className="font-mono">(otros)</span>. Deja de ofrecerse como dimensión:
                        si apunta a un correo o un identificador, mejor usa otra columna.
                    </p>
                </div>
            )}

            <div className="flex items-center gap-2">
                <Input
                    value={filtro}
                    onChange={(e) => setFiltro(e.target.value)}
                    placeholder="Buscar un valor..."
                    className="h-7 text-xs bg-background border-input"
                />
                <Button
                    type="button" variant="outline" size="sm"
                    onClick={autoAgrupar}
                    className="h-7 text-xs gap-1 shrink-0"
                    title='Junta las variantes evidentes: "20 a 100", "20-100" y "20A100" al mismo grupo'
                >
                    <Wand2 className="w-3 h-3" /> Auto-agrupar
                </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
                {/* ── Valores crudos ─────────────────────────────────────────── */}
                <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground/60 px-1">
                        Valores en los Sheets ({visibles.length})
                    </p>
                    <div className="rounded-md border border-input bg-background max-h-64 overflow-y-auto p-1.5 space-y-0.5">
                        {visibles.map(v => {
                            const bucket = bucketDeValor(campo, v.valor_crudo)
                            const agrupado = campo.valores_map[normalizarValorCrudo(v.valor_crudo)]
                            return (
                                <label
                                    key={v.valor_crudo}
                                    className="flex items-start gap-2 px-1 py-1 rounded hover:bg-muted/60 cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={seleccion.has(v.valor_crudo)}
                                        onChange={() => toggle(v.valor_crudo)}
                                        className="mt-0.5 rounded border-input bg-background text-indigo-500 focus:ring-indigo-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-1.5">
                                            <span className="text-xs text-foreground truncate">{v.valor_crudo}</span>
                                            <span className="text-[10px] text-muted-foreground/60 shrink-0">{v.filas}</span>
                                        </span>
                                        <span className="block text-[10px] text-muted-foreground/60 truncate">
                                            {v.origenes.join(', ')}
                                            {agrupado && <span className="text-indigo-400"> → {agrupado}</span>}
                                            {!agrupado && bucket === null && <span className="text-amber-500"> · se ignora</span>}
                                        </span>
                                    </span>
                                </label>
                            )
                        })}
                    </div>

                    <div className="flex items-center gap-2">
                        <Input
                            value={nombreGrupo}
                            onChange={(e) => setNombreGrupo(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); agrupar() } }}
                            placeholder={seleccion.size > 0 ? 'Nombre del grupo...' : 'Marca valores primero'}
                            disabled={seleccion.size === 0}
                            className="h-7 text-xs bg-background border-input"
                        />
                        <Button
                            type="button" size="sm"
                            onClick={agrupar}
                            disabled={seleccion.size === 0 || !nombreGrupo.trim()}
                            className="h-7 text-xs gap-1 shrink-0"
                        >
                            <Layers className="w-3 h-3" /> Agrupar {seleccion.size > 0 && `(${seleccion.size})`}
                        </Button>
                    </div>
                </div>

                {/* ── Buckets resultantes ────────────────────────────────────── */}
                <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground/60 px-1">
                        Así queda el campo ({buckets.length} valores)
                    </p>
                    <div className="rounded-md border border-input bg-background max-h-64 overflow-y-auto p-1.5 space-y-0.5">
                        {buckets.map(b => {
                            const esGrupo = b.crudos.length > 1
                            return (
                                <div key={b.bucket} className="flex items-start gap-2 px-1 py-1 rounded hover:bg-muted/40">
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-1.5">
                                            <span className="text-xs text-foreground truncate">{b.bucket}</span>
                                            <span className="text-[10px] text-muted-foreground/60 shrink-0">{b.filas}</span>
                                        </span>
                                        {esGrupo && (
                                            <span className="block text-[10px] text-muted-foreground/60 truncate">
                                                une: {b.crudos.join(' · ')}
                                            </span>
                                        )}
                                    </span>
                                    {esGrupo && (
                                        <Button
                                            type="button" variant="ghost" size="sm"
                                            onClick={() => desagrupar(b.bucket)}
                                            className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                            title="Deshacer esta agrupación"
                                        >
                                            <Undo2 className="w-3 h-3" />
                                        </Button>
                                    )}
                                </div>
                            )
                        })}
                    </div>
                    <p className="text-[10px] text-muted-foreground/60 px-1">
                        Estos son los valores por los que podrás filtrar y agrupar en el BI y en el dashboard.
                    </p>
                </div>
            </div>
        </div>
    )
}
