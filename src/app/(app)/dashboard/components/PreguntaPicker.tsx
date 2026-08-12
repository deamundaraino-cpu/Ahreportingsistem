'use client'

/**
 * Selector de la pregunta de formulario que desglosa un bloque de respuestas.
 *
 * Ofrece dos grupos, y el orden importa: primero los campos ya configurados en
 * `report_utm.lead_campos` —con sus respuestas agrupadas y ordenadas— y después
 * las preguntas detectadas en crudo. Un campo configurado es lo único que puede
 * unir la misma pregunta llegada por Meta y por la web bajo un solo desglose;
 * elegir las claves sueltas partiría ese desglose en dos sin avisar.
 *
 * Por eso las auto-detectadas permiten MULTI-SELECCIÓN y ofrecen "Guardar en el
 * catálogo": es el camino para que un cliente sin nada configurado acabe
 * teniéndolo, sin obligar a configurarlo antes de poder ver nada.
 */

import { useEffect, useState, useCallback } from 'react'
import { Loader2, Check, BookmarkPlus, AlertCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { promoverCampoLead } from '../_actions'
import type { LeadAnswerBlockDef } from '@/lib/layout-types'

interface Sugerida {
    origen: 'catalogo' | 'auto'
    clave: string
    nombre: string
    clavesOrigen: string[]
    leads: number
    distintos: number
    formularios: string[]
    valores: string[]
}

interface Props {
    clienteId: string
    def: LeadAnswerBlockDef
    onChange: (patch: Partial<LeadAnswerBlockDef>) => void
}

const nf = new Intl.NumberFormat('es-CO')

export function PreguntaPicker({ clienteId, def, onChange }: Props) {
    const [cargando, setCargando] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [enlazado, setEnlazado] = useState(true)
    const [leadsEscaneados, setLeadsEscaneados] = useState(0)
    const [sugeridas, setSugeridas] = useState<Sugerida[]>([])
    const [guardando, setGuardando] = useState(false)

    const cargar = useCallback(async () => {
        setCargando(true)
        setError(null)
        try {
            const r = await fetch(`/api/report-utm/lead-campos/sugeridas?public_cliente_id=${clienteId}`)
            const j = await r.json()
            if (!r.ok) throw new Error(j?.error ?? 'No se pudieron leer las preguntas.')
            setSugeridas(j.data ?? [])
            setLeadsEscaneados(j.leads ?? 0)
            setEnlazado(j.enlazado !== false)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'No se pudieron leer las preguntas.')
        } finally {
            setCargando(false)
        }
    }, [clienteId])

    useEffect(() => { void cargar() }, [cargar])

    const seleccionadasAuto = new Set(def.origen === 'auto' ? (def.clavesOrigen ?? []) : [])
    const seleccionadaCatalogo = def.origen === 'catalogo' ? def.clave : undefined

    function elegirCatalogo(s: Sugerida) {
        onChange({
            origen: 'catalogo', clave: s.clave, clavesOrigen: undefined,
            label: s.nombre,
            title: def.title === 'Respuestas de formulario' ? s.nombre : def.title,
        })
    }

    function alternarAuto(s: Sugerida) {
        const actual = def.origen === 'auto' ? new Set(def.clavesOrigen ?? []) : new Set<string>()
        if (actual.has(s.clave)) actual.delete(s.clave)
        else actual.add(s.clave)
        const claves = [...actual]
        onChange({
            origen: 'auto', clavesOrigen: claves, clave: undefined,
            label: claves.length === 1 ? s.nombre : def.label,
            title: def.title === 'Respuestas de formulario' && claves.length === 1 ? s.nombre : def.title,
        })
    }

    async function guardarEnCatalogo() {
        const claves = def.clavesOrigen ?? []
        if (claves.length === 0) return
        const nombre = (def.label || def.title || claves[0]).trim()
        setGuardando(true)
        const r = await promoverCampoLead(clienteId, { nombre, clavesOrigen: claves })
        setGuardando(false)
        if (r.error) { toast.error(r.error); return }
        toast.success(`"${nombre}" guardado en el catálogo. Ya puedes agrupar sus respuestas desde la ficha del cliente.`)
        onChange({ origen: 'catalogo', clave: r.clave, clavesOrigen: undefined, label: nombre })
        void cargar()
    }

    if (cargando) {
        return <div className="space-y-2"><Skeleton className="h-9 rounded" /><Skeleton className="h-9 rounded" /><Skeleton className="h-9 rounded" /></div>
    }

    if (error) {
        return (
            <div className="flex items-start gap-2 text-xs text-rose-600 dark:text-rose-400 p-3 border border-rose-500/30 rounded-lg">
                <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
                <div>
                    <p>{error}</p>
                    <button type="button" onClick={() => void cargar()} className="underline mt-1">Reintentar</button>
                </div>
            </div>
        )
    }

    if (!enlazado) {
        return (
            <p className="text-xs text-muted-foreground p-3 border border-border rounded-lg">
                Este cliente no está enlazado al módulo de informes, así que no hay leads que
                desglosar. Se enlaza desde <span className="text-foreground">Report-UTM → Clientes</span>.
            </p>
        )
    }

    const delCatalogo = sugeridas.filter(s => s.origen === 'catalogo')
    const detectadas = sugeridas.filter(s => s.origen === 'auto')

    if (sugeridas.length === 0) {
        return (
            <p className="text-xs text-muted-foreground p-3 border border-border rounded-lg">
                No se detectaron preguntas de opción en los últimos 365 días
                {leadsEscaneados > 0
                    // Distinguir los dos casos importa: con 0 leads el problema es la
                    // integración; con miles de leads y ninguna pregunta, el formulario
                    // simplemente no pregunta nada y no hay nada que arreglar.
                    ? ` (se revisaron ${nf.format(leadsEscaneados)} leads, y sus formularios solo piden datos de contacto).`
                    : ' porque este cliente no tiene leads en el período.'}
            </p>
        )
    }

    return (
        <div className="space-y-3">
            {delCatalogo.length > 0 && (
                <div className="space-y-1">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Del catálogo
                    </p>
                    {delCatalogo.map(s => (
                        <button
                            key={s.clave}
                            type="button"
                            onClick={() => elegirCatalogo(s)}
                            className={`w-full flex items-start gap-2 px-3 py-2 rounded-lg border text-left transition ${
                                seleccionadaCatalogo === s.clave
                                    ? 'border-emerald-500/50 bg-emerald-50 dark:bg-emerald-500/10'
                                    : 'border-border hover:bg-accent'
                            }`}
                        >
                            <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                                seleccionadaCatalogo === s.clave
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-transparent'}`} />
                            <span className="min-w-0 flex-1">
                                <span className="block text-xs text-foreground truncate">{s.nombre}</span>
                                <span className="block text-[11px] text-muted-foreground/70">
                                    {nf.format(s.leads)} leads
                                    {s.clavesOrigen.length > 1 && ` · une ${s.clavesOrigen.length} preguntas`}
                                </span>
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {detectadas.length > 0 && (
                <div className="space-y-1">
                    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                        Detectadas en los formularios
                    </p>
                    <p className="text-[11px] text-muted-foreground/70">
                        Marca varias si son la misma pregunta escrita de formas distintas.
                    </p>
                    {detectadas.map(s => (
                        <button
                            key={s.clave}
                            type="button"
                            onClick={() => alternarAuto(s)}
                            className={`w-full flex items-start gap-2 px-3 py-2 rounded-lg border text-left transition ${
                                seleccionadasAuto.has(s.clave)
                                    ? 'border-sky-500/50 bg-sky-50 dark:bg-sky-500/10'
                                    : 'border-border hover:bg-accent'
                            }`}
                        >
                            <Check className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                                seleccionadasAuto.has(s.clave)
                                    ? 'text-sky-600 dark:text-sky-400'
                                    : 'text-transparent'}`} />
                            <span className="min-w-0 flex-1">
                                <span className="block text-xs text-foreground truncate" title={s.nombre}>{s.nombre}</span>
                                <span className="block text-[11px] text-muted-foreground/70">
                                    {nf.format(s.leads)} leads · {s.distintos} respuestas
                                    {s.formularios.length > 0 && ` · ${s.formularios.slice(0, 2).join(', ')}`}
                                </span>
                                {s.valores.length > 0 && (
                                    <span className="block text-[11px] text-muted-foreground/50 truncate">
                                        {s.valores.slice(0, 4).join(' · ')}
                                    </span>
                                )}
                            </span>
                        </button>
                    ))}
                </div>
            )}

            {def.origen === 'auto' && (def.clavesOrigen ?? []).length > 0 && (
                <button
                    type="button"
                    onClick={() => void guardarEnCatalogo()}
                    disabled={guardando}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 text-xs rounded-lg border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 transition disabled:opacity-50"
                >
                    {guardando ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <BookmarkPlus className="w-3.5 h-3.5" />}
                    Guardar en el catálogo
                </button>
            )}
            {def.origen === 'auto' && (def.clavesOrigen ?? []).length > 0 && (
                <p className="text-[11px] text-muted-foreground/70">
                    Guardarla permite renombrarla, agrupar respuestas equivalentes y ordenarlas
                    de menor a mayor desde la ficha del cliente.
                </p>
            )}
        </div>
    )
}
