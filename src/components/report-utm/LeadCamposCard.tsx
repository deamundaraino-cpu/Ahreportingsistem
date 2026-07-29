'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ListFilter, Plus, Pencil, Trash2, Loader2, AlertCircle, RefreshCw } from 'lucide-react'
import { LeadCampoEditorDialog } from './LeadCampoEditorDialog'
import { bucketDeValor, ordenarBuckets } from '@/lib/report-utm/lead-campos'
import type { LeadCampoDef, ClaveDetectada } from '@/lib/report-utm/lead-campos'

/**
 * Campos de lead del cliente: las preguntas de sus formularios convertidas en
 * algo cruzable en los informes.
 *
 * El dato ya está guardado en cada lead (`raw_fields`); lo que falta para poder
 * usarlo es decidir qué claves son la misma pregunta y qué respuestas son el
 * mismo valor. Eso es lo que se define aquí, y el BI lo ofrece de inmediato como
 * dimensión y como filtro — sin recálculo, porque se aplica al consultar.
 */
export function LeadCamposCard({ clienteId }: { clienteId: string }) {
    const [campos, setCampos] = useState<LeadCampoDef[]>([])
    const [detectadas, setDetectadas] = useState<ClaveDetectada[]>([])
    const [leadsEscaneados, setLeadsEscaneados] = useState(0)
    const [cargando, setCargando] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const [editando, setEditando] = useState<Partial<LeadCampoDef> | null>(null)
    const [guardando, setGuardando] = useState(false)
    const [errorDialogo, setErrorDialogo] = useState<string | undefined>()

    const cargar = useCallback(async (opts?: { redetectar?: boolean }) => {
        setCargando(true)
        setError(null)
        try {
            const [resCampos, resDet] = await Promise.all([
                fetch(`/api/report-utm/lead-campos?cliente_id=${clienteId}`),
                // La detección escanea leads: solo se rehace a petición o en la
                // primera carga, no en cada guardado.
                opts?.redetectar || detectadas.length === 0
                    ? fetch(`/api/report-utm/lead-campos/detectar?cliente_id=${clienteId}`)
                    : null,
            ])
            const jsonCampos = await resCampos.json()
            if (!resCampos.ok) throw new Error(jsonCampos?.error ?? 'No se pudo leer el catálogo.')
            setCampos(jsonCampos.data ?? [])

            if (resDet) {
                const jsonDet = await resDet.json()
                if (resDet.ok) {
                    setDetectadas(jsonDet.data ?? [])
                    setLeadsEscaneados(jsonDet.leads ?? 0)
                }
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Error inesperado.')
        } finally {
            setCargando(false)
        }
    }, [clienteId, detectadas.length])

    useEffect(() => { void cargar() }, [clienteId])   // eslint-disable-line react-hooks/exhaustive-deps

    async function guardar(borrador: Partial<LeadCampoDef>) {
        setGuardando(true)
        setErrorDialogo(undefined)
        try {
            const res = await fetch('/api/report-utm/lead-campos', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...borrador, cliente_id: clienteId }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) { setErrorDialogo(json?.error ?? 'No se pudo guardar.'); return }
            setEditando(null)
            await cargar()
        } finally {
            setGuardando(false)
        }
    }

    async function borrar(campo: LeadCampoDef) {
        if (!confirm(`¿Borrar el campo “${campo.nombre}”? Los widgets que lo usen dejarán de tener datos.`)) return
        const res = await fetch(`/api/report-utm/lead-campos?id=${campo.id}`, { method: 'DELETE' })
        if (res.ok) await cargar()
        else setError('No se pudo borrar el campo.')
    }

    /** Valores que produce un campo, para el resumen de la lista. */
    function resumenValores(campo: LeadCampoDef): string[] {
        const set = new Set<string>()
        for (const clave of campo.claves_origen) {
            const det = detectadas.find(d => d.clave_norm === clave)
            for (const v of det?.valores ?? []) {
                const b = bucketDeValor(campo, v.valor_crudo)
                if (b) set.add(b)
            }
        }
        return ordenarBuckets(campo, Array.from(set))
    }

    return (
        <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-start justify-between gap-4 mb-1">
                <div className="flex items-center gap-2">
                    <ListFilter className="h-4 w-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold text-foreground">Campos de lead</h3>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost" size="sm"
                        onClick={() => void cargar({ redetectar: true })}
                        disabled={cargando}
                        className="h-7 text-xs gap-1"
                        title="Volver a escanear los leads en busca de preguntas nuevas"
                    >
                        {cargando ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                        Redetectar
                    </Button>
                    <Button
                        size="sm"
                        onClick={() => { setErrorDialogo(undefined); setEditando({ sin_mapear: 'crudo' }) }}
                        className="h-7 text-xs gap-1"
                    >
                        <Plus className="w-3 h-3" /> Nuevo campo
                    </Button>
                </div>
            </div>

            <p className="text-xs text-muted-foreground mb-4">
                Convierte las respuestas de los formularios (rango de ingresos, plazo de compra…) en
                dimensiones de los informes: agrupar por ellas, filtrar por una respuesta concreta y
                cruzarlas con el resto de métricas.
                {detectadas.length > 0 && (
                    <> Se detectaron <strong>{detectadas.length}</strong> preguntas en {leadsEscaneados} leads del último año.</>
                )}
            </p>

            {error && (
                <p className="text-xs text-red-500 flex items-center gap-1 mb-3">
                    <AlertCircle className="w-3 h-3" /> {error}
                </p>
            )}

            {campos.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                    <p className="text-xs text-muted-foreground">
                        Todavía no hay campos definidos para este cliente.
                    </p>
                    <p className="text-xs text-muted-foreground/70 mt-1">
                        {detectadas.length > 0
                            ? `Empieza por «${detectadas[0].clave}» — la respondieron ${detectadas[0].leads} leads.`
                            : 'Cuando lleguen leads con respuestas de formulario aparecerán aquí para configurarlas.'}
                    </p>
                </div>
            ) : (
                <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
                    {campos.map(campo => {
                        const valores = resumenValores(campo)
                        return (
                            <div key={campo.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-accent/40">
                                <div className="min-w-0 flex-1">
                                    <p className="text-xs font-medium text-foreground">
                                        {campo.nombre}
                                        {!campo.activo && (
                                            <span className="ml-2 text-[10px] uppercase tracking-wider text-muted-foreground">inactivo</span>
                                        )}
                                    </p>
                                    <p className="text-[10px] text-muted-foreground/70 break-words mt-0.5">
                                        {campo.claves_origen.length} pregunta{campo.claves_origen.length === 1 ? '' : 's'}
                                        {valores.length > 0 && ` · ${valores.length} valores: ${valores.slice(0, 4).join(' · ')}`}
                                        {valores.length > 4 && ` …`}
                                    </p>
                                    <p className="text-[10px] font-mono text-muted-foreground/50 mt-0.5">
                                        leadfield:{campo.clave}
                                    </p>
                                </div>
                                <Button
                                    variant="ghost" size="sm"
                                    onClick={() => { setErrorDialogo(undefined); setEditando(campo) }}
                                    className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                    title="Editar"
                                >
                                    <Pencil className="w-3 h-3" />
                                </Button>
                                <Button
                                    variant="ghost" size="sm"
                                    onClick={() => void borrar(campo)}
                                    className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500 shrink-0"
                                    title="Borrar"
                                >
                                    <Trash2 className="w-3 h-3" />
                                </Button>
                            </div>
                        )
                    })}
                </div>
            )}

            {editando && (
                // `key` distinta por campo: el diálogo siembra su borrador en el
                // primer render, así que remontarlo es lo que hace que abrir otro
                // campo no arrastre el anterior.
                <LeadCampoEditorDialog
                    key={editando.id ?? 'nuevo'}
                    open
                    campo={editando}
                    detectadas={detectadas}
                    guardando={guardando}
                    error={errorDialogo}
                    onClose={() => setEditando(null)}
                    onGuardar={(c) => void guardar(c)}
                />
            )}
        </div>
    )
}
