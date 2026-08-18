'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Plus, Trash2, Loader2, Layers, ArrowUpNarrowWide } from 'lucide-react'
import { bucketsAcumulados } from '@/lib/report-utm/lead-campos'
import type { LeadCampoDef, LeadSegmentoDef } from '@/lib/report-utm/lead-campos'

/**
 * Segmentos de un campo de lead: «Desde 2M» = contar los leads cuya respuesta
 * caiga en estos buckets.
 *
 * Es lo que convierte un campo —que solo era una dimensión— en un número que se
 * puede poner en una tarjeta, en una columna, en un embudo y dentro de una
 * fórmula. Dividir el gasto por un segmento da el costo por lead de ese tipo,
 * que es la razón por la que existe.
 *
 * Hermano de `VistasEditor` de los campos de Sheet, sin sus selects de
 * agregación y formato: un segmento siempre CUENTA contactos, porque
 * `lead_events` no tiene ninguna columna numérica que sumar por bucket.
 */
export function LeadSegmentosEditor({
    campo, buckets, segmentos, guardando, onGuardar, onBorrar,
}: {
    campo: LeadCampoDef
    /** Buckets que produce el campo, en el orden configurado. */
    buckets: string[]
    segmentos: LeadSegmentoDef[]
    guardando: boolean
    onGuardar: (seg: Partial<LeadSegmentoDef>) => void
    onBorrar: (segId: string) => void
}) {
    const [nuevo, setNuevo] = useState<Partial<LeadSegmentoDef> | null>(null)

    const propios = segmentos.filter(s => s.campo_id === campo.id)
    const yaDefinido = (valores: string[]) =>
        propios.some(s => s.operador === 'in' &&
            s.valores.length === valores.length &&
            valores.every(v => s.valores.includes(v)))

    /** Un segmento por respuesta: el equivalente de `lf__<campo>__<respuesta>`. */
    function crearUnoPorRespuesta() {
        for (const b of buckets) {
            if (yaDefinido([b])) continue
            onGuardar({ campo_id: campo.id, nombre: b, operador: 'in', valores: [b] })
        }
    }

    /**
     * Acumulado desde un bucket: ese y todos los que van detrás en
     * `valores_orden`. Sin orden configurado no hay «hacia arriba» posible, así
     * que el atajo no se ofrece en vez de inventarse uno alfabético.
     */
    const hayOrden = (campo.valores_orden ?? []).length > 0
    function crearAcumulado(desde: string) {
        const valores = bucketsAcumulados(campo, desde)
        if (valores.length === 0) return
        onGuardar({ campo_id: campo.id, nombre: `Desde ${desde}`, operador: 'in', valores })
    }

    return (
        <div className="space-y-2">
            {propios.map(s => (
                <div key={s.id} className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1">
                        <span className="block text-xs text-foreground truncate">{s.nombre}</span>
                        <span className="block text-[10px] text-muted-foreground/60 truncate">
                            {s.operador === 'not_in' ? 'excepto' : 'donde'} {s.valores.join(', ')}
                            {' · '}
                            <span className="font-mono">lseg__{s.clave}</span>
                        </span>
                    </span>
                    <Button
                        type="button" variant="ghost" size="sm"
                        onClick={() => onBorrar(s.id)}
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500 shrink-0"
                        title="Borrar segmento"
                    >
                        <Trash2 className="w-3 h-3" />
                    </Button>
                </div>
            ))}

            {nuevo ? (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 space-y-2">
                    <div className="grid grid-cols-[1fr_110px] gap-2">
                        <Input
                            value={nuevo.nombre ?? ''}
                            onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })}
                            placeholder="Nombre visible (ej. Desde 2M)"
                            className="h-7 text-xs bg-background border-input"
                        />
                        <select
                            value={nuevo.operador ?? 'in'}
                            onChange={(e) => setNuevo({ ...nuevo, operador: e.target.value as 'in' | 'not_in' })}
                            className="h-7 text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        >
                            <option value="in">Donde sea</option>
                            <option value="not_in">Excepto</option>
                        </select>
                    </div>

                    <div className="rounded-md border border-input bg-background max-h-32 overflow-y-auto p-1.5 space-y-0.5">
                        {buckets.length === 0 && (
                            <p className="text-xs text-muted-foreground/60 px-1 py-0.5">
                                Agrupa primero las respuestas del campo para ver sus valores.
                            </p>
                        )}
                        {buckets.map(b => (
                            <label key={b} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted/60 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={(nuevo.valores ?? []).includes(b)}
                                    onChange={(e) => setNuevo({
                                        ...nuevo,
                                        valores: e.target.checked
                                            ? [...(nuevo.valores ?? []), b]
                                            : (nuevo.valores ?? []).filter(x => x !== b),
                                    })}
                                    className="rounded border-input bg-background text-emerald-500 focus:ring-emerald-500"
                                />
                                <span className="text-xs text-foreground truncate">{b}</span>
                            </label>
                        ))}
                    </div>

                    <div className="flex items-center justify-end gap-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => setNuevo(null)} className="h-7 text-xs">
                            Cancelar
                        </Button>
                        <Button
                            type="button" size="sm"
                            disabled={guardando || !nuevo.nombre?.trim() ||
                                (nuevo.operador !== 'not_in' && (nuevo.valores ?? []).length === 0)}
                            onClick={() => { onGuardar({ ...nuevo, campo_id: campo.id }); setNuevo(null) }}
                            className="h-7 text-xs gap-1"
                        >
                            {guardando && <Loader2 className="w-3 h-3 animate-spin" />}
                            Crear segmento
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    <Button
                        type="button" variant="outline" size="sm"
                        onClick={() => setNuevo({ operador: 'in', valores: [] })}
                        className="h-7 text-xs gap-1"
                    >
                        <Plus className="w-3 h-3" /> Añadir segmento
                    </Button>
                    <Button
                        type="button" variant="ghost" size="sm"
                        disabled={guardando || buckets.length === 0}
                        onClick={crearUnoPorRespuesta}
                        className="h-7 text-xs gap-1"
                        title="Crea un segmento por cada respuesta del campo, para poder medirlas por separado"
                    >
                        <Layers className="w-3 h-3" /> Una métrica por respuesta
                    </Button>
                    {hayOrden && (
                        <select
                            value=""
                            disabled={guardando}
                            onChange={(e) => { if (e.target.value) crearAcumulado(e.target.value) }}
                            className="h-7 text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500"
                            title="Crea «Desde X» con ese bucket y todos los posteriores del orden configurado"
                        >
                            <option value="">Acumulado desde…</option>
                            {(campo.valores_orden ?? []).map(b => (
                                <option key={b} value={b}>{b}</option>
                            ))}
                        </select>
                    )}
                    {!hayOrden && buckets.length > 1 && (
                        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70">
                            <ArrowUpNarrowWide className="w-3 h-3" />
                            Ordena los valores del campo para poder crear acumulados «desde X».
                        </span>
                    )}
                </div>
            )}
        </div>
    )
}
