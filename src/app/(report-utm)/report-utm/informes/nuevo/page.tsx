'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Plus, Loader2 } from 'lucide-react'
import Link from 'next/link'

interface Cliente { id: string; nombre: string }

export default function NuevoInformePage() {
    const router = useRouter()
    const [nombre, setNombre]   = useState('')
    const [desc, setDesc]       = useState('')
    const [clienteId, setClienteId] = useState('')
    const [clientes, setClientes]   = useState<Cliente[]>([])
    const [saving, setSaving]   = useState(false)
    const [error, setError]     = useState<string | null>(null)

    useEffect(() => {
        fetch('/api/report-utm/clientes')
            .then(r => r.json())
            .then(j => setClientes(j.data ?? []))
            .catch(() => {})
    }, [])

    async function handleCreate() {
        if (!nombre.trim()) return
        setSaving(true)
        setError(null)
        try {
            const res = await fetch('/api/report-utm/bi/reports', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nombre: nombre.trim(), descripcion: desc.trim() || null, cliente_id: clienteId || null }),
            })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error ?? 'Error al crear')
            router.push(`/report-utm/informes/${json.data.id}`)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Error desconocido')
            setSaving(false)
        }
    }

    return (
        <div className="max-w-lg mx-auto space-y-6">
            <div className="flex items-center gap-3">
                <Link
                    href="/report-utm/informes"
                    className="p-2 rounded-xl hover:bg-accent text-muted-foreground transition-colors"
                >
                    <ArrowLeft className="h-4 w-4" />
                </Link>
                <div>
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                        BI Builder
                    </p>
                    <h1 className="text-2xl font-bold tracking-tight text-foreground">Nuevo informe</h1>
                </div>
            </div>

            <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
                <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Nombre del informe <span className="text-red-500">*</span>
                    </label>
                    <input
                        type="text"
                        value={nombre}
                        onChange={e => setNombre(e.target.value)}
                        placeholder="ej. Performance Q2 2025"
                        autoFocus
                        className="w-full px-3 py-2.5 text-sm rounded-xl bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        onKeyDown={e => e.key === 'Enter' && handleCreate()}
                    />
                </div>
                <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Cliente <span className="text-muted-foreground/50">(opcional)</span>
                    </label>
                    <select
                        value={clienteId}
                        onChange={e => setClienteId(e.target.value)}
                        className="w-full px-3 py-2.5 text-sm rounded-xl bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                    >
                        <option value="">Sin cliente fijo (todos)</option>
                        {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                    </select>
                    <p className="text-[10px] text-muted-foreground mt-1">
                        Si eliges un cliente, el informe quedará fijo a ese cliente (no se podrá cambiar al verlo).
                    </p>
                </div>
                <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                        Descripción <span className="text-muted-foreground/50">(opcional)</span>
                    </label>
                    <textarea
                        value={desc}
                        onChange={e => setDesc(e.target.value)}
                        placeholder="Qué analiza este informe…"
                        rows={3}
                        className="w-full px-3 py-2.5 text-sm rounded-xl bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 resize-none"
                    />
                </div>

                {error && (
                    <p className="text-xs text-red-500">{error}</p>
                )}

                <button
                    onClick={handleCreate}
                    disabled={saving || !nombre.trim()}
                    className="flex items-center gap-2 w-full justify-center px-4 py-2.5 rounded-xl text-sm font-medium text-white nav-active-emerald disabled:opacity-50"
                >
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {saving ? 'Creando…' : 'Crear informe'}
                </button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
                Podrás agregar widgets y configurar los datos después de crear el informe.
            </p>
        </div>
    )
}
