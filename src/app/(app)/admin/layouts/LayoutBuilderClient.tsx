'use client'

import { useState } from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createLayout, updateLayout, deleteLayout } from '../settings/_actions'
import { Plus, Trash2, Save, ChevronDown, ChevronUp, GripVertical, LayoutDashboard, Loader2, PenSquare, X } from 'lucide-react'

// ─── Available metric fields ─────────────────────────────────────────────────
const AVAILABLE_METRICS = [
    { id: 'meta_spend', label: 'Gasto Meta (meta_spend)' },
    { id: 'meta_impressions', label: 'Impresiones (meta_impressions)' },
    { id: 'meta_clicks', label: 'Clics (meta_clicks)' },
    { id: 'ga_sessions', label: 'Sesiones GA4 (ga_sessions)' },
    { id: 'hotmart_pagos_iniciados', label: 'Checkouts Hotmart (hotmart_pagos_iniciados)' },
    { id: 'ventas_principal', label: 'Ventas Principal (ventas_principal)' },
    { id: 'ventas_bump', label: 'Ventas Bump (ventas_bump)' },
    { id: 'ventas_upsell', label: 'Ventas Upsell (ventas_upsell)' },
]

// ─── Quick formula templates ──────────────────────────────────────────────────
const FORMULA_PRESETS = [
    { label: 'CPC', formula: 'meta_spend / meta_clicks', prefix: '$', suffix: '' },
    { label: 'CTR %', formula: '(meta_clicks / meta_impressions) * 100', prefix: '', suffix: '%' },
    { label: 'ROAS', formula: '(ventas_principal + ventas_bump + ventas_upsell) / meta_spend', prefix: '', suffix: 'x' },
    { label: 'ROI %', formula: '((ventas_principal + ventas_bump + ventas_upsell - meta_spend) / meta_spend) * 100', prefix: '', suffix: '%' },
    { label: 'CPA', formula: 'meta_spend / (ventas_principal + ventas_bump + ventas_upsell)', prefix: '$', suffix: '' },
    { label: 'Total Ventas', formula: 'ventas_principal + ventas_bump + ventas_upsell', prefix: '$', suffix: '' },
]

// ─── Empty defaults ───────────────────────────────────────────────────────────
const emptyColumn = () => ({ id: crypto.randomUUID(), label: '', formula: '', prefix: '', suffix: '', decimals: 2, align: 'right', highlight: false })
const emptyTarjeta = () => ({ id: crypto.randomUUID(), label: '', formula: '', prefix: '', suffix: '', decimals: 2, color: 'default' })
const emptyLayout = () => ({ nombre: '', descripcion: '', columnas: [{ ...emptyColumn(), formula: 'fecha', label: 'Fecha', align: 'left', decimals: 0 }], tarjetas: [] })

// ─── Column/Tarjeta row editor ────────────────────────────────────────────────
function FieldRow({ item, onChange, onRemove, type }: { item: any; onChange: (v: any) => void; onRemove: () => void; type: 'column' | 'card' }) {
    return (
        <div className="grid grid-cols-12 gap-2 items-start bg-zinc-950/60 border border-zinc-800 rounded-lg p-3">
            <div className="col-span-1 flex justify-center pt-2.5 text-zinc-600">
                <GripVertical className="w-4 h-4" />
            </div>
            <div className="col-span-3">
                <Input placeholder="Etiqueta" value={item.label} onChange={e => onChange({ ...item, label: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-4">
                <Input placeholder="Fórmula (ej: meta_spend / meta_clicks)" value={item.formula} onChange={e => onChange({ ...item, formula: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs font-mono" />
                <div className="flex flex-wrap gap-1 mt-1">
                    {FORMULA_PRESETS.map(p => (
                        <button key={p.label} onClick={() => onChange({ ...item, label: item.label || p.label, formula: p.formula, prefix: p.prefix, suffix: p.suffix })} className="text-[10px] bg-zinc-800 hover:bg-indigo-500/20 hover:text-indigo-300 text-zinc-400 px-1.5 py-0.5 rounded transition">
                            {p.label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="col-span-1">
                <Input placeholder="$" value={item.prefix || ''} onChange={e => onChange({ ...item, prefix: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-1">
                <Input placeholder="%" value={item.suffix || ''} onChange={e => onChange({ ...item, suffix: e.target.value })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-1">
                <Input placeholder="2" type="number" min={0} max={6} value={item.decimals ?? 2} onChange={e => onChange({ ...item, decimals: parseInt(e.target.value) || 0 })} className="bg-zinc-900 border-zinc-700 text-zinc-100 h-8 text-xs" />
            </div>
            <div className="col-span-1 flex justify-end">
                <button onClick={onRemove} className="p-1.5 text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition">
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}

// ─── Layout Editor ────────────────────────────────────────────────────────────
function LayoutEditor({ initial, onSave, onCancel }: { initial: any; onSave: (l: any) => Promise<void>; onCancel: () => void }) {
    const [layout, setLayout] = useState(initial)
    const [saving, setSaving] = useState(false)

    const updateCol = (idx: number, val: any) => {
        const cols = [...layout.columnas]
        cols[idx] = val
        setLayout({ ...layout, columnas: cols })
    }
    const removeCol = (idx: number) => setLayout({ ...layout, columnas: layout.columnas.filter((_: any, i: number) => i !== idx) })
    const addCol = () => setLayout({ ...layout, columnas: [...layout.columnas, emptyColumn()] })

    const updateCard = (idx: number, val: any) => {
        const cards = [...layout.tarjetas]
        cards[idx] = val
        setLayout({ ...layout, tarjetas: cards })
    }
    const removeCard = (idx: number) => setLayout({ ...layout, tarjetas: layout.tarjetas.filter((_: any, i: number) => i !== idx) })
    const addCard = () => setLayout({ ...layout, tarjetas: [...layout.tarjetas, emptyTarjeta()] })

    return (
        <div className="space-y-6">
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <CardTitle className="text-white text-base">Información de la Plantilla</CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <Label className="text-zinc-300">Nombre de la Plantilla</Label>
                        <Input value={layout.nombre} onChange={e => setLayout({ ...layout, nombre: e.target.value })} placeholder="ej: Plantilla Camaradictos" className="bg-zinc-950 border-zinc-700 text-zinc-100" />
                    </div>
                    <div className="space-y-2">
                        <Label className="text-zinc-300">Descripción (opcional)</Label>
                        <Input value={layout.descripcion || ''} onChange={e => setLayout({ ...layout, descripcion: e.target.value })} placeholder="Para qué tipo de cliente..." className="bg-zinc-950 border-zinc-700 text-zinc-100" />
                    </div>
                </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-white text-base">Columnas de la Tabla</CardTitle>
                            <CardDescription className="text-zinc-400">Define cada columna que aparecerá en la tabla diaria.</CardDescription>
                        </div>
                        <Button size="sm" variant="outline" onClick={addCol} className="gap-1 border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                            <Plus className="w-3.5 h-3.5" /> Añadir columna
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="grid grid-cols-12 gap-2 text-[10px] text-zinc-500 font-medium px-1 mb-1">
                        <div className="col-span-1"></div>
                        <div className="col-span-3">Etiqueta</div>
                        <div className="col-span-4">Fórmula</div>
                        <div className="col-span-1">Prefijo</div>
                        <div className="col-span-1">Sufijo</div>
                        <div className="col-span-1">Dec.</div>
                        <div className="col-span-1"></div>
                    </div>
                    {layout.columnas.map((col: any, i: number) => (
                        <FieldRow key={col.id} item={col} onChange={v => updateCol(i, v)} onRemove={() => removeCol(i)} type="column" />
                    ))}
                    {layout.columnas.length === 0 && (
                        <p className="text-xs text-zinc-500 text-center py-4">Sin columnas. Añade al menos la columna "fecha".</p>
                    )}
                </CardContent>
            </Card>

            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex items-center justify-between">
                        <div>
                            <CardTitle className="text-white text-base">Tarjetas de Resumen</CardTitle>
                            <CardDescription className="text-zinc-400">Métricas que aparecerán como tarjetas grandes en la parte superior.</CardDescription>
                        </div>
                        <Button size="sm" variant="outline" onClick={addCard} className="gap-1 border-zinc-700 text-zinc-300 hover:bg-zinc-800">
                            <Plus className="w-3.5 h-3.5" /> Añadir tarjeta
                        </Button>
                    </div>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="grid grid-cols-12 gap-2 text-[10px] text-zinc-500 font-medium px-1 mb-1">
                        <div className="col-span-1"></div>
                        <div className="col-span-3">Etiqueta</div>
                        <div className="col-span-4">Fórmula</div>
                        <div className="col-span-1">Prefijo</div>
                        <div className="col-span-1">Sufijo</div>
                        <div className="col-span-1">Dec.</div>
                        <div className="col-span-1"></div>
                    </div>
                    {layout.tarjetas.map((card: any, i: number) => (
                        <FieldRow key={card.id} item={card} onChange={v => updateCard(i, v)} onRemove={() => removeCard(i)} type="card" />
                    ))}
                    {layout.tarjetas.length === 0 && (
                        <p className="text-xs text-zinc-500 text-center py-4">Sin tarjetas de resumen todavía.</p>
                    )}
                </CardContent>
                <CardFooter className="border-t border-zinc-800 flex justify-between pt-4">
                    <Button variant="outline" onClick={onCancel} className="border-zinc-700 text-zinc-400">Cancelar</Button>
                    <Button disabled={saving || !layout.nombre} onClick={async () => { setSaving(true); await onSave(layout); setSaving(false) }} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Guardar Plantilla
                    </Button>
                </CardFooter>
            </Card>
        </div>
    )
}

// ─── Main Builder Client ──────────────────────────────────────────────────────
export function LayoutBuilderClient({ layouts: initial }: { layouts: any[] }) {
    const [layouts, setLayouts] = useState(initial)
    const [editing, setEditing] = useState<any | null>(null)
    const [isNew, setIsNew] = useState(false)

    async function handleSave(layout: any) {
        if (isNew) {
            const res = await createLayout({ nombre: layout.nombre, descripcion: layout.descripcion, columnas: layout.columnas, tarjetas: layout.tarjetas })
            if (res.success) {
                setLayouts(prev => [...prev, res.data])
                setEditing(null)
                setIsNew(false)
            }
        } else {
            await updateLayout(layout.id, { nombre: layout.nombre, descripcion: layout.descripcion, columnas: layout.columnas, tarjetas: layout.tarjetas })
            setLayouts(prev => prev.map(l => l.id === layout.id ? layout : l))
            setEditing(null)
        }
    }

    async function handleDelete(id: string) {
        if (!confirm('¿Eliminar esta plantilla? Los clientes que la usen volverán a la vista clásica.')) return
        await deleteLayout(id)
        setLayouts(prev => prev.filter(l => l.id !== id))
    }

    if (editing) {
        return <LayoutEditor initial={editing} onSave={handleSave} onCancel={() => { setEditing(null); setIsNew(false) }} />
    }

    return (
        <div className="space-y-4">
            <div className="flex justify-end">
                <Button onClick={() => { setEditing(emptyLayout()); setIsNew(true) }} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
                    <Plus className="w-4 h-4" /> Nueva Plantilla
                </Button>
            </div>

            {layouts.length === 0 && (
                <Card className="bg-zinc-900 border-zinc-800 text-center p-12">
                    <LayoutDashboard className="w-10 h-10 text-zinc-600 mx-auto mb-3" />
                    <p className="text-zinc-400">No hay plantillas. Crea la primera usando el botón de arriba.</p>
                </Card>
            )}

            <div className="grid gap-4">
                {layouts.map(layout => (
                    <Card key={layout.id} className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                        <CardHeader>
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-indigo-500/10 rounded-lg">
                                        <LayoutDashboard className="w-5 h-5 text-indigo-400" />
                                    </div>
                                    <div>
                                        <CardTitle className="text-white">{layout.nombre}</CardTitle>
                                        {layout.descripcion && <CardDescription className="text-zinc-400 mt-0.5">{layout.descripcion}</CardDescription>}
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <Button size="sm" variant="outline" onClick={() => setEditing(layout)} className="gap-1.5 border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800">
                                        <PenSquare className="w-3.5 h-3.5" /> Editar
                                    </Button>
                                    <Button size="sm" variant="outline" onClick={() => handleDelete(layout.id)} className="border-zinc-700 text-zinc-500 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/5">
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </Button>
                                </div>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                <div>
                                    <p className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">Columnas ({(layout.columnas || []).length})</p>
                                    <div className="flex flex-wrap gap-1.5">
                                        {(layout.columnas || []).map((c: any) => (
                                            <span key={c.id} className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded border border-zinc-700 font-mono">{c.label}</span>
                                        ))}
                                    </div>
                                </div>
                                {(layout.tarjetas || []).length > 0 && (
                                    <div>
                                        <p className="text-xs text-zinc-500 mb-1.5 font-medium uppercase tracking-wider">Tarjetas ({layout.tarjetas.length})</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {layout.tarjetas.map((t: any) => (
                                                <span key={t.id} className="text-xs bg-indigo-500/10 text-indigo-300 px-2 py-1 rounded border border-indigo-500/20">{t.label}</span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </div>
        </div>
    )
}
