'use client'

import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, AlertCircle, Save, ChevronUp, ChevronDown, ArrowDownAZ } from 'lucide-react'
import { ValoresAgrupador } from '@/components/campos/ValoresAgrupador'
import {
    slugCampo, bucketDeValor, sugerirAgrupacionLead, ordenarBuckets,
    normalizarValorCrudo, esValorPlaceholder,
} from '@/lib/report-utm/lead-campos'
import type { LeadCampoDef, ClaveDetectada, CampoValorCrudo, CampoSinMapear } from '@/lib/report-utm/lead-campos'

/**
 * Editor de un campo de lead, en el orden en que se piensa el problema:
 * qué pregunta es → qué respuestas la componen → en qué orden se muestran.
 *
 * A diferencia del editor de campos de Sheet, el agrupador está disponible desde
 * el primer momento: las respuestas ya están en los leads, así que no hay que
 * guardar y recalcular para ver con qué se está trabajando.
 */
export function LeadCampoEditorDialog({
    open, campo, detectadas, guardando, error, onClose, onGuardar,
}: {
    open: boolean
    campo: Partial<LeadCampoDef> | null
    detectadas: ClaveDetectada[]
    guardando: boolean
    error?: string
    onClose: () => void
    onGuardar: (campo: Partial<LeadCampoDef>) => void
}) {
    const [borrador, setBorrador] = useState<Partial<LeadCampoDef>>(campo ?? { sin_mapear: 'crudo' })

    const set = (patch: Partial<LeadCampoDef>) => setBorrador(prev => ({ ...prev, ...patch }))
    // Referencia estable: si se recreara en cada render, los useMemo que dependen
    // de ella (respuestas y buckets) recalcularían siempre.
    const claves = useMemo(() => borrador.claves_origen ?? [], [borrador.claves_origen])
    const esNuevo = !borrador.id

    const campoParaBucket = useMemo(() => ({
        claves_origen: claves,
        valores_map: borrador.valores_map ?? {},
        valores_orden: borrador.valores_orden ?? [],
        sin_mapear: (borrador.sin_mapear ?? 'crudo') as CampoSinMapear,
        max_valores: borrador.max_valores ?? 200,
    }), [claves, borrador.valores_map, borrador.valores_orden, borrador.sin_mapear, borrador.max_valores])

    // Respuestas de TODAS las preguntas marcadas, fundidas por valor: es lo que
    // hace que unir dos claves equivalentes muestre una sola lista y que "más de
    // $4.000.000" sume los leads de los dos formularios.
    const valores: CampoValorCrudo[] = useMemo(() => {
        const acc = new Map<string, CampoValorCrudo>()
        for (const clave of claves) {
            const det = detectadas.find(d => d.clave_norm === clave)
            for (const v of det?.valores ?? []) {
                const prev = acc.get(v.valor_crudo)
                if (prev) {
                    prev.filas += v.filas
                    if (det && !prev.origenes.includes(det.clave)) prev.origenes.push(det.clave)
                } else {
                    acc.set(v.valor_crudo, { ...v, origenes: det ? [det.clave] : [] })
                }
            }
        }
        return Array.from(acc.values()).sort((a, b) => b.filas - a.filas)
    }, [claves, detectadas])

    // Buckets actuales, calculados con la misma función que el motor.
    const buckets = useMemo(() => {
        const acc = new Map<string, number>()
        for (const v of valores) {
            const b = bucketDeValor(campoParaBucket, v.valor_crudo)
            if (b) acc.set(b, (acc.get(b) ?? 0) + v.filas)
        }
        const orden = ordenarBuckets(campoParaBucket, Array.from(acc.keys()))
        return orden.map(b => ({ bucket: b, filas: acc.get(b) ?? 0 }))
    }, [valores, campoParaBucket])

    if (!open) return null

    const clavePrevia = borrador.clave || slugCampo(borrador.nombre || '') || 'campo'
    const puedeGuardar = !!borrador.nombre?.trim() && claves.length > 0

    const toggleClave = (claveNorm: string) => {
        const next = claves.includes(claveNorm)
            ? claves.filter(c => c !== claveNorm)
            : [...claves, claveNorm]
        set({ claves_origen: next })
    }

    /** Mueve un bucket dentro del orden guardado. */
    const mover = (bucket: string, delta: number) => {
        const actual = buckets.map(b => b.bucket)
        const i = actual.indexOf(bucket)
        const j = i + delta
        if (i < 0 || j < 0 || j >= actual.length) return
        const next = [...actual]
        ;[next[i], next[j]] = [next[j], next[i]]
        set({ valores_orden: next })
    }

    /** Ignora de golpe los rellenos de desplegable ("Seleccione una opción."). */
    const ignorarPlaceholders = () => {
        const next = { ...(borrador.valores_map ?? {}) }
        let tocado = false
        for (const v of valores) {
            if (esValorPlaceholder(v.valor_crudo)) {
                next[normalizarValorCrudo(v.valor_crudo)] = '(sin respuesta)'
                tocado = true
            }
        }
        if (tocado) set({ valores_map: next })
    }

    const hayPlaceholders = valores.some(v => esValorPlaceholder(v.valor_crudo))

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
            {/* Ancho generoso: el agrupador son dos listas lado a lado con valores
                largos ("entre_$1.300.000_a_$1.600.000") que no se pueden truncar. */}
            <DialogContent className="max-w-5xl w-[min(96vw,72rem)] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{esNuevo ? 'Nuevo campo de lead' : `Editar “${campo?.nombre}”`}</DialogTitle>
                </DialogHeader>

                <div className="space-y-5">
                    {/* ── 1. Identidad ──────────────────────────────────────── */}
                    <div className="space-y-1">
                        <Label className="text-xs text-foreground/90">Nombre del campo</Label>
                        <Input
                            value={borrador.nombre ?? ''}
                            onChange={(e) => set({ nombre: e.target.value })}
                            placeholder="Rango de ingresos"
                            className="h-8 text-sm bg-background border-input"
                        />
                        <p className="text-xs text-muted-foreground/60">
                            Es el nombre que verás en los informes al agrupar y al filtrar. En los widgets
                            se guarda como <span className="font-mono text-emerald-500">leadfield:{clavePrevia}</span>.
                            {!esNuevo && ' Renombrarlo no rompe los informes ya creados.'}
                        </p>
                    </div>

                    {/* ── 2. Preguntas de origen ────────────────────────────── */}
                    <div className="space-y-2">
                        <div>
                            <Label className="text-sm text-foreground">¿Qué preguntas son este campo?</Label>
                            <p className="text-xs text-muted-foreground/70">
                                Marca todas las que sean la misma pregunta. Si el formulario web y el de Meta
                                la escriben distinto, aquí se unifican y los leads se suman.
                            </p>
                        </div>
                        <div className="rounded-md border border-input bg-background max-h-64 overflow-y-auto p-1.5 space-y-0.5">
                            {detectadas.length === 0 && (
                                <p className="text-xs text-muted-foreground px-2 py-3 text-center">
                                    No se detectaron preguntas en los leads de este cliente.
                                </p>
                            )}
                            {detectadas.map(d => (
                                <label
                                    key={d.clave_norm}
                                    className="flex items-start gap-2 px-1 py-1 rounded hover:bg-muted/60 cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={claves.includes(d.clave_norm)}
                                        onChange={() => toggleClave(d.clave_norm)}
                                        className="mt-0.5 rounded border-input bg-background text-emerald-500 focus:ring-emerald-500"
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-start gap-1.5">
                                            <span className="text-xs text-foreground break-words leading-snug">{d.clave}</span>
                                            {d.es_opcion && (
                                                <span className="text-[9px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 shrink-0">
                                                    opción
                                                </span>
                                            )}
                                            <span className="text-[10px] text-muted-foreground/60 shrink-0 ml-auto">
                                                {d.leads} leads
                                            </span>
                                        </span>
                                        <span className="block text-[10px] text-muted-foreground/60 break-words">
                                            {d.distintos} respuestas distintas
                                            {d.formularios.length > 0 && ` · ${d.formularios.join(', ')}`}
                                        </span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </div>

                    {/* ── 3. Valores ────────────────────────────────────────── */}
                    <div className="space-y-2">
                        <div className="flex items-end justify-between gap-2">
                            <div>
                                <Label className="text-sm text-foreground">Respuestas</Label>
                                <p className="text-xs text-muted-foreground/70">
                                    Junta las formas distintas de escribir lo mismo bajo un solo nombre.
                                </p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {hayPlaceholders && (
                                    <Button
                                        type="button" variant="outline" size="sm"
                                        onClick={ignorarPlaceholders}
                                        className="h-7 text-xs"
                                        title="Manda a «(sin respuesta)» los rellenos del desplegable y los leads de prueba"
                                    >
                                        Apartar «Seleccione una opción»
                                    </Button>
                                )}
                                <select
                                    value={borrador.sin_mapear ?? 'crudo'}
                                    onChange={(e) => set({ sin_mapear: e.target.value as CampoSinMapear })}
                                    className="h-7 text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500"
                                    title="Qué hacer con las respuestas que no agrupes"
                                >
                                    <option value="crudo">Las no agrupadas van tal cual</option>
                                    <option value="otros">Las no agrupadas van a (otros)</option>
                                    <option value="ignorar">Las no agrupadas se ignoran</option>
                                </select>
                            </div>
                        </div>

                        {claves.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border p-4 text-center">
                                <p className="text-xs text-muted-foreground">
                                    Marca arriba al menos una pregunta para ver sus respuestas.
                                </p>
                            </div>
                        ) : (
                            <ValoresAgrupador
                                campo={campoParaBucket}
                                valores={valores}
                                totalDistintos={valores.length}
                                origenLabel="Respuestas de los leads"
                                sugerir={sugerirAgrupacionLead}
                                onChange={(valores_map) => set({ valores_map })}
                            />
                        )}
                    </div>

                    {/* ── 4. Orden ──────────────────────────────────────────── */}
                    {buckets.length > 1 && (
                        <div className="space-y-2">
                            <div className="flex items-end justify-between gap-2">
                                <div>
                                    <Label className="text-sm text-foreground">Orden en los informes</Label>
                                    <p className="text-xs text-muted-foreground/70">
                                        Un rango se lee de menor a mayor. Sin este orden, la tabla los pone
                                        alfabéticamente y «Menos de $2M» acaba entre medio de los demás.
                                    </p>
                                </div>
                                <Button
                                    type="button" variant="ghost" size="sm"
                                    onClick={() => set({ valores_orden: [] })}
                                    className="h-7 text-xs gap-1 shrink-0"
                                    title="Volver al orden alfabético"
                                >
                                    <ArrowDownAZ className="w-3 h-3" /> Alfabético
                                </Button>
                            </div>
                            <div className="rounded-md border border-input bg-background max-h-56 overflow-y-auto p-1.5 space-y-0.5">
                                {buckets.map((b, i) => (
                                    <div key={b.bucket} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-muted/40">
                                        <span className="text-[10px] text-muted-foreground/50 w-5 shrink-0 text-right">{i + 1}</span>
                                        <span className="text-xs text-foreground break-words leading-snug min-w-0 flex-1">{b.bucket}</span>
                                        <span className="text-[10px] text-muted-foreground/60 shrink-0">{b.filas}</span>
                                        <Button
                                            type="button" variant="ghost" size="sm"
                                            onClick={() => mover(b.bucket, -1)}
                                            disabled={i === 0}
                                            className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                        >
                                            <ChevronUp className="w-3 h-3" />
                                        </Button>
                                        <Button
                                            type="button" variant="ghost" size="sm"
                                            onClick={() => mover(b.bucket, 1)}
                                            disabled={i === buckets.length - 1}
                                            className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground shrink-0"
                                        >
                                            <ChevronDown className="w-3 h-3" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {error && (
                        <p className="text-xs text-red-500 flex items-center gap-1">
                            <AlertCircle className="w-3 h-3" /> {error}
                        </p>
                    )}
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
                    <Button variant="ghost" onClick={onClose} disabled={guardando}>Cancelar</Button>
                    <Button
                        onClick={() => onGuardar(borrador)}
                        disabled={guardando || !puedeGuardar}
                        className="gap-2"
                        title={puedeGuardar ? undefined : 'Ponle un nombre y marca al menos una pregunta'}
                    >
                        {guardando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        {esNuevo ? 'Crear campo' : 'Guardar'}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
