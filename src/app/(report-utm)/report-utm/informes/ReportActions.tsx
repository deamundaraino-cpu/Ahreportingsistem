'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Trash2, X, Loader2, Check } from 'lucide-react'

interface Cliente { id: string; nombre: string }

interface Props {
    report: { id: string; nombre: string; descripcion?: string | null; cliente_id?: string | null }
    className?: string
}

export function ReportActions({ report, className }: Props) {
    const router = useRouter()
    const [editing, setEditing] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [deleting, setDeleting] = useState(false)

    async function handleDelete(e: React.MouseEvent) {
        e.preventDefault(); e.stopPropagation()
        setDeleting(true)
        try {
            const res = await fetch(`/api/report-utm/bi/reports/${report.id}`, { method: 'DELETE' })
            if (res.ok) router.refresh()
            else {
                const j = await res.json().catch(() => ({}))
                alert(j.error ?? 'No se pudo eliminar')
                setDeleting(false); setConfirming(false)
            }
        } catch {
            setDeleting(false); setConfirming(false)
        }
    }

    return (
        <div className={className}>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditing(true) }}
                    title="Editar"
                    className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shadow-sm"
                >
                    <Pencil className="h-3.5 w-3.5" />
                </button>
                {confirming ? (
                    <button
                        onClick={handleDelete}
                        disabled={deleting}
                        className="px-2 py-1 rounded-lg bg-red-500 text-white text-[10px] font-medium shadow-sm flex items-center gap-1"
                    >
                        {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        Confirmar
                    </button>
                ) : (
                    <button
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirming(true) }}
                        title="Eliminar"
                        className="p-1.5 rounded-lg bg-card border border-border text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors shadow-sm"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                )}
            </div>

            {editing && (
                <EditModal report={report} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); router.refresh() }} />
            )}
        </div>
    )
}

function EditModal({ report, onClose, onSaved }: { report: Props['report']; onClose: () => void; onSaved: () => void }) {
    const [nombre, setNombre] = useState(report.nombre)
    const [desc, setDesc] = useState(report.descripcion ?? '')
    const [clienteId, setClienteId] = useState(report.cliente_id ?? '')
    const [clientes, setClientes] = useState<Cliente[]>([])
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        fetch('/api/report-utm/clientes').then(r => r.json()).then(j => setClientes(j.data ?? [])).catch(() => {})
    }, [])

    async function save() {
        if (!nombre.trim()) return
        setSaving(true)
        try {
            await fetch(`/api/report-utm/bi/reports/${report.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre: nombre.trim(), descripcion: desc.trim() || null, cliente_id: clienteId || null }),
            })
            onSaved()
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <p className="text-sm font-semibold text-foreground">Editar informe</p>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="p-5 space-y-4">
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Nombre <span className="text-red-500">*</span></label>
                        <input
                            type="text" value={nombre} onChange={e => setNombre(e.target.value)} autoFocus
                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Descripción</label>
                        <textarea
                            value={desc} onChange={e => setDesc(e.target.value)} rows={2}
                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-none"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-muted-foreground mb-1">Cliente fijo</label>
                        <select
                            value={clienteId} onChange={e => setClienteId(e.target.value)}
                            className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        >
                            <option value="">Sin cliente fijo (todos)</option>
                            {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                        </select>
                    </div>
                </div>
                <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors">Cancelar</button>
                    <button
                        onClick={save} disabled={saving || !nombre.trim()}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-50"
                    >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Guardar
                    </button>
                </div>
            </div>
        </div>
    )
}
