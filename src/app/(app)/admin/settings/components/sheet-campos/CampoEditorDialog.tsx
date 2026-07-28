'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, AlertCircle, Save } from 'lucide-react'
import { slugCampo } from '@/lib/sheets/campos'
import type {
    SheetCampoDef, SheetCampoVistaDef, CampoValorCrudo,
    CampoRol, CampoFormato, CampoAgg, CampoSinMapear,
} from '@/lib/sheets/campos'
import { OrigenesEditor, type Fuente } from './OrigenesEditor'
import { ValoresAgrupador } from './ValoresAgrupador'
import { VistasEditor } from './VistasEditor'

/**
 * Editor de un campo de Sheet, en tres pasos que siguen el orden natural:
 * de dónde sale el dato → cómo se agrupan sus valores → qué vistas se guardan.
 *
 * El agrupador y las vistas solo tienen sentido con el campo ya calculado (hay
 * que saber qué valores existen), así que hasta el primer guardado se muestran
 * en modo explicativo en vez de vacíos y sin contexto.
 */
export function CampoEditorDialog({
    open, campo, vistas, fuentes, valores, totalDistintos,
    guardando, error, onClose, onGuardar, onGuardarVista, onBorrarVista,
}: {
    open: boolean
    campo: Partial<SheetCampoDef> | null
    vistas: SheetCampoVistaDef[]
    fuentes: Fuente[]
    valores: CampoValorCrudo[]
    totalDistintos: number
    guardando: boolean
    error?: string
    onClose: () => void
    onGuardar: (campo: Partial<SheetCampoDef>) => void
    onGuardarVista: (vista: Partial<SheetCampoVistaDef>) => void
    onBorrarVista: (vistaId: string) => void
}) {
    // El borrador arranca del campo recibido y a partir de ahí es local: mientras
    // el diálogo está abierto manda lo que escribe el analista. Para volver a
    // sembrarlo (otro campo, o el mismo ya calculado tras guardar) el padre monta
    // el diálogo con una `key` distinta en vez de sincronizarlo con un efecto.
    const [borrador, setBorrador] = useState<Partial<SheetCampoDef>>(campo ?? {})

    if (!open) return null

    const esNuevo = !borrador.id
    const set = (patch: Partial<SheetCampoDef>) => setBorrador(prev => ({ ...prev, ...patch }))
    const clavePrevia = borrador.clave || slugCampo(borrador.nombre || '') || 'campo'

    const puedeGuardar =
        !!borrador.nombre?.trim() &&
        (borrador.origenes ?? []).some(o => o.columnas.length > 0)

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
            {/* Ancho generoso a propósito: el mapeo de columnas y el agrupador de
                valores son dos listas lado a lado con nombres largos, y en un
                diálogo estrecho todo sale truncado. */}
            <DialogContent className="max-w-5xl w-[min(96vw,72rem)] max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{esNuevo ? 'Nuevo campo de Sheet' : `Editar “${campo?.nombre}”`}</DialogTitle>
                </DialogHeader>

                <div className="space-y-5">
                    {/* ── 1. Identidad ──────────────────────────────────────── */}
                    <div className="space-y-2">
                        <div className="grid grid-cols-[1fr_130px_130px] gap-2">
                            <div className="space-y-1">
                                <Label className="text-xs text-foreground/90">Nombre del campo</Label>
                                <Input
                                    value={borrador.nombre ?? ''}
                                    onChange={(e) => set({ nombre: e.target.value })}
                                    placeholder="Rango de ingresos"
                                    className="h-8 text-sm bg-background border-input"
                                />
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-foreground/90">Se usa como</Label>
                                <select
                                    value={borrador.rol ?? 'dimension'}
                                    onChange={(e) => set({ rol: e.target.value as CampoRol })}
                                    className="h-8 w-full text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                >
                                    <option value="dimension">Categoría</option>
                                    <option value="metrica">Número</option>
                                    <option value="ambos">Las dos</option>
                                </select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-foreground/90">Se mide</Label>
                                <select
                                    value={borrador.agregacion ?? 'count'}
                                    onChange={(e) => set({ agregacion: e.target.value as CampoAgg })}
                                    className="h-8 w-full text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                >
                                    <option value="count">Contando filas</option>
                                    <option value="sum">Sumando</option>
                                    <option value="avg">Promediando</option>
                                    <option value="min">Con el mínimo</option>
                                    <option value="max">Con el máximo</option>
                                </select>
                            </div>
                        </div>

                        <p className="text-xs text-muted-foreground/60">
                            Este nombre es el que verás en los informes, en el constructor de dashboards
                            y en las tablas. En fórmulas se llama{' '}
                            <span className="font-mono text-indigo-400">sf_{clavePrevia}</span>.
                            {!esNuevo && ' Renombrarlo no rompe nada de lo ya construido.'}
                        </p>
                    </div>

                    {/* ── 2. Orígenes ───────────────────────────────────────── */}
                    <div className="space-y-2">
                        <div>
                            <Label className="text-sm text-foreground">¿Dónde está este dato?</Label>
                            <p className="text-xs text-muted-foreground/70">
                                Marca la columna que contiene el dato en cada pestaña. Si en un formulario
                                se llama distinto que en otro, da igual: aquí se unifican.
                            </p>
                        </div>
                        <OrigenesEditor
                            origenes={borrador.origenes ?? []}
                            fuentes={fuentes}
                            onChange={(origenes) => set({ origenes })}
                        />
                    </div>

                    {/* ── 3. Valores ────────────────────────────────────────── */}
                    <div className="space-y-2">
                        <div className="flex items-end justify-between gap-2">
                            <div>
                                <Label className="text-sm text-foreground">Valores</Label>
                                <p className="text-xs text-muted-foreground/70">
                                    Junta las formas distintas de escribir lo mismo bajo un solo nombre.
                                </p>
                            </div>
                            <select
                                value={borrador.sin_mapear ?? 'crudo'}
                                onChange={(e) => set({ sin_mapear: e.target.value as CampoSinMapear })}
                                className="h-7 text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500 shrink-0"
                                title="Qué hacer con los valores que no agrupes"
                            >
                                <option value="crudo">Los no agrupados van tal cual</option>
                                <option value="otros">Los no agrupados van a (otros)</option>
                                <option value="ignorar">Los no agrupados se ignoran</option>
                            </select>
                        </div>

                        {esNuevo ? (
                            <div className="rounded-lg border border-dashed border-border p-4 text-center">
                                <p className="text-xs text-muted-foreground">
                                    Guarda el campo para ver aquí sus valores reales y agruparlos.
                                </p>
                            </div>
                        ) : (
                            <ValoresAgrupador
                                campo={borrador as SheetCampoDef}
                                valores={valores}
                                totalDistintos={totalDistintos}
                                onChange={(valores_map) => set({ valores_map })}
                            />
                        )}
                    </div>

                    {/* ── 4. Vistas ─────────────────────────────────────────── */}
                    {!esNuevo && (
                        <div className="space-y-2">
                            <div>
                                <Label className="text-sm text-foreground">Vistas guardadas</Label>
                                <p className="text-xs text-muted-foreground/70">
                                    Un recorte con nombre propio que se comporta como una métrica más.
                                    Por ejemplo “Leads 20-100”: contar solo las filas de ese rango.
                                </p>
                            </div>
                            <VistasEditor
                                campo={borrador as SheetCampoDef}
                                vistas={vistas}
                                valores={valores}
                                guardando={guardando}
                                onGuardar={onGuardarVista}
                                onBorrar={onBorrarVista}
                            />
                        </div>
                    )}

                    {/* ── Avanzado ──────────────────────────────────────────── */}
                    <details className="rounded-md border border-border">
                        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground select-none">
                            Opciones avanzadas
                        </summary>
                        <div className="grid grid-cols-2 gap-3 px-3 pb-3">
                            <div className="space-y-1">
                                <Label className="text-xs text-foreground/90">Formato</Label>
                                <select
                                    value={borrador.formato ?? 'number'}
                                    onChange={(e) => set({ formato: e.target.value as CampoFormato })}
                                    className="h-8 w-full text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                >
                                    <option value="number">Número</option>
                                    <option value="currency">Moneda</option>
                                    <option value="percent">Porcentaje</option>
                                    <option value="text">Texto</option>
                                </select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs text-foreground/90">Máximo de valores distintos</Label>
                                <Input
                                    type="number" min={1}
                                    value={borrador.max_valores ?? 200}
                                    onChange={(e) => set({ max_valores: Number(e.target.value) || 200 })}
                                    className="h-8 text-xs bg-background border-input"
                                />
                                <p className="text-[10px] text-muted-foreground/60">
                                    Al superarlo, el excedente se agrupa en (otros) y el campo deja de
                                    ofrecerse como categoría.
                                </p>
                            </div>
                        </div>
                    </details>

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
                        title={puedeGuardar ? undefined : 'Ponle un nombre y marca al menos una columna'}
                    >
                        {guardando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        {esNuevo ? 'Crear y calcular' : 'Guardar y recalcular'}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    )
}
