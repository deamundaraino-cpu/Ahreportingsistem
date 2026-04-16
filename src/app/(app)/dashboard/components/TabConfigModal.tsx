'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Plus, Settings, Trash2 } from 'lucide-react'
import { saveClienteTab, deleteClienteTab } from '../_actions'

export function TabConfigModal({
    isOpen,
    onClose,
    clienteId,
    allLayouts,
    tabToEdit = null
}: {
    isOpen: boolean
    onClose: () => void
    clienteId: string
    allLayouts: any[]
    tabToEdit?: any | null
}) {
    const [nombre, setNombre] = useState(tabToEdit?.nombre || '')
    const [keyword, setKeyword] = useState(tabToEdit?.keyword_meta || '')
    const [layoutId, setLayoutId] = useState(tabToEdit?.plantilla_id || 'none')
    const [fechaInicio, setFechaInicio] = useState(tabToEdit?.fecha_inicio || '')
    const [fechaFinalizacion, setFechaFinalizacion] = useState(tabToEdit?.fecha_finalizacion || '')
    const [presupuestoObjetivo, setPresupuestoObjetivo] = useState(tabToEdit?.presupuesto_objetivo?.toString() || '')
    const [saving, setSaving] = useState(false)

    const handleSave = async () => {
        if (!nombre || !keyword) return
        setSaving(true)
        await saveClienteTab(clienteId, {
            id: tabToEdit?.id,
            nombre,
            keyword_meta: keyword,
            plantilla_id: layoutId === 'none' ? undefined : layoutId,
            fecha_inicio: fechaInicio || undefined,
            fecha_finalizacion: fechaFinalizacion || undefined,
            presupuesto_objetivo: presupuestoObjetivo ? parseFloat(presupuestoObjetivo) : undefined
        })
        setSaving(false)
        onClose()
    }

    const handleDelete = async () => {
        if (!tabToEdit?.id) return
        if (!confirm('¿Seguro que deseas eliminar esta pestaña?')) return
        setSaving(true)
        await deleteClienteTab(clienteId, tabToEdit.id)
        setSaving(false)
        onClose()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle>{tabToEdit ? 'Editar Pestaña' : 'Nueva Pestaña'}</DialogTitle>
                    <DialogDescription className="text-zinc-500">
                        Configura un nombre, la palabra clave para filtrar campañas de Meta, y la plantilla de métricas a mostrar.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-zinc-400">Nombre de la Pestaña</label>
                        <Input
                            placeholder="Ej. Diplomado TCC"
                            value={nombre}
                            onChange={e => setNombre(e.target.value)}
                            className="bg-zinc-900 border-zinc-800"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-zinc-400">Palabra Clave (Filtro Meta)</label>
                        <Input
                            placeholder="Ej. EDU-TCC"
                            value={keyword}
                            onChange={e => setKeyword(e.target.value)}
                            className="bg-zinc-900 border-zinc-800"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-zinc-400">Plantilla de Layout Asociada</label>
                        <Select value={layoutId} onValueChange={setLayoutId}>
                            <SelectTrigger className="w-full bg-zinc-900 border-zinc-800">
                                <SelectValue placeholder="Seleccionar plantilla..." />
                            </SelectTrigger>
                            <SelectContent className="bg-zinc-900 border-zinc-800 text-white z-[120]">
                                <SelectItem value="none">Por Defecto (Del cliente)</SelectItem>
                                {allLayouts.map(l => (
                                    <SelectItem key={l.id} value={l.id}>{l.nombre}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400">Fecha de Inicio (Opcional)</label>
                            <Input
                                type="date"
                                value={fechaInicio}
                                onChange={e => setFechaInicio(e.target.value)}
                                className="bg-zinc-900 border-zinc-800"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400">Fecha de Cierre (Opcional)</label>
                            <Input
                                type="date"
                                value={fechaFinalizacion}
                                onChange={e => setFechaFinalizacion(e.target.value)}
                                className="bg-zinc-900 border-zinc-800"
                            />
                        </div>

                        <div className="space-y-2 col-span-2">
                            <label className="text-xs font-semibold text-zinc-400">Presupuesto ($) (Opcional)</label>
                            <Input
                                type="number"
                                placeholder="Ej. 4000000"
                                value={presupuestoObjetivo}
                                onChange={e => setPresupuestoObjetivo(e.target.value)}
                                className="bg-zinc-900 border-zinc-800"
                            />
                        </div>
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:gap-0">
                    {tabToEdit && (
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={saving}
                            className="mr-auto text-xs h-9 bg-red-900/30 text-red-400 hover:bg-red-900/50 hover:text-red-300"
                        >
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                            Eliminar
                        </Button>
                    )}
                    <Button variant="outline" onClick={onClose} disabled={saving} className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800">
                        Cancelar
                    </Button>
                    <Button onClick={handleSave} disabled={saving || !nombre || !keyword} className="bg-blue-600 hover:bg-blue-700 text-white">
                        {saving ? 'Guardando...' : 'Guardar Pestaña'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
