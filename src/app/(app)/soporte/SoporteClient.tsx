'use client'

import React, { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Plus, Search, AlertCircle, Clock, CheckCircle2, MessageSquare, Edit2, User, Calendar } from 'lucide-react'
import { createSoporteTicket, updateSoporteTicket } from '../dashboard/_actions'
import { useRouter } from 'next/navigation'
import { format, isValid } from 'date-fns'
import { es } from 'date-fns/locale'

function safeDate(v: string | null | undefined, fmt: string) {
    if (!v) return '—'
    const d = new Date(v)
    return isValid(d) ? format(d, fmt, { locale: es }) : '—'
}

function elapsed(fecha: string) {
    const ms = Date.now() - new Date(fecha).getTime()
    const d = Math.floor(ms / 86400000)
    const h = Math.floor((ms % 86400000) / 3600000)
    return d > 0 ? `${d}d ${h}h` : `${h}h`
}

function daysLeft(fechaEntrega: string | null) {
    if (!fechaEntrega) return null
    return Math.ceil((new Date(fechaEntrega).getTime() - Date.now()) / 86400000)
}

const STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
    abierto:     { label: 'Abierto',     color: 'bg-blue-500/10 text-blue-400 border-blue-500/20',     icon: AlertCircle },
    en_progreso: { label: 'En Progreso', color: 'bg-amber-500/10 text-amber-400 border-amber-500/20',   icon: Clock },
    completado:  { label: 'Completado',  color: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', icon: CheckCircle2 },
    cancelado:   { label: 'Cancelado',   color: 'bg-zinc-700/30 text-zinc-500 border-zinc-700/30',      icon: MessageSquare },
}

const PRIORITY_MAP: Record<number, { label: string; color: string; bg: string }> = {
    1: { label: 'Alta',  color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/30' },
    2: { label: 'Media', color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/30' },
    3: { label: 'Baja',  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' },
}

interface Cliente { id: string; nombre: string }
interface Ticket {
    id: string; id_ticket_display: string; cliente_id: string
    nombre_solicitante: string; fecha_solicitud: string; requerimiento: string
    observaciones: string; responsable: string; fecha_entrega: string | null
    prioridad: number; estado: string; cliente?: { nombre: string }
}

const EMPTY_FORM = { cliente_id: '', nombre_solicitante: '', requerimiento: '', observaciones: '', prioridad: 2, fecha_entrega: '' }

export function SoporteClient({ tickets: initial, clientes, userRole }: {
    tickets: Ticket[]
    clientes: Cliente[]
    userRole: string
}) {
    const router = useRouter()
    const isTeam = ['superadmin', 'admin', 'trafficker'].includes(userRole)

    const tickets = initial
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState<string>('activos')
    const [showForm, setShowForm] = useState(false)
    const [form, setForm] = useState(EMPTY_FORM)
    const [submitting, setSubmitting] = useState(false)

    const [editingTicket, setEditingTicket] = useState<Ticket | null>(null)
    const [editForm, setEditForm] = useState({ nombre_solicitante: '', requerimiento: '', observaciones: '', prioridad: 2 })
    const [editSaving, setEditSaving] = useState(false)
    const [statusUpdating, setStatusUpdating] = useState<string | null>(null)

    const refresh = () => router.refresh()

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault()
        if (!form.cliente_id) { alert('Selecciona un cliente'); return }
        setSubmitting(true)
        const res = await createSoporteTicket({
            cliente_id: form.cliente_id,
            nombre_solicitante: form.nombre_solicitante,
            requerimiento: form.requerimiento,
            observaciones: form.observaciones,
            prioridad: form.prioridad,
            fecha_entrega: form.fecha_entrega || undefined,
        })
        setSubmitting(false)
        if (res.error) { alert('Error: ' + res.error); return }
        setShowForm(false)
        setForm(EMPTY_FORM)
        refresh()
    }

    async function handleStatusChange(ticketId: string, clienteId: string, estado: string) {
        setStatusUpdating(ticketId)
        await updateSoporteTicket(ticketId, clienteId, { estado })
        setStatusUpdating(null)
        refresh()
    }

    async function handleEditSave() {
        if (!editingTicket) return
        setEditSaving(true)
        const res = await updateSoporteTicket(editingTicket.id, editingTicket.cliente_id, editForm)
        setEditSaving(false)
        if (res.error) { alert('Error: ' + res.error); return }
        setEditingTicket(null)
        refresh()
    }

    const filtered = tickets.filter(t => {
        const matchesSearch =
            t.id_ticket_display.toLowerCase().includes(search.toLowerCase()) ||
            t.requerimiento.toLowerCase().includes(search.toLowerCase()) ||
            t.nombre_solicitante.toLowerCase().includes(search.toLowerCase()) ||
            (t.cliente?.nombre ?? '').toLowerCase().includes(search.toLowerCase())
        const matchesStatus =
            statusFilter === 'todos' ? true :
            statusFilter === 'activos' ? (t.estado === 'abierto' || t.estado === 'en_progreso') :
            t.estado === statusFilter
        return matchesSearch && matchesStatus
    })

    const activeCount = tickets.filter(t => t.estado === 'abierto' || t.estado === 'en_progreso').length

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                        🎧 Soporte Ads House
                    </h1>
                    <p className="text-zinc-400 text-sm mt-0.5">
                        {activeCount} ticket{activeCount !== 1 ? 's' : ''} activo{activeCount !== 1 ? 's' : ''} · {tickets.length} total
                    </p>
                </div>
                <Button
                    onClick={() => setShowForm(v => !v)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white gap-2 shadow-lg shadow-indigo-500/20"
                >
                    <Plus className="w-4 h-4" />
                    Nuevo Requerimiento
                </Button>
            </div>

            {/* Create form */}
            {showForm && (
                <div className="rounded-xl border border-indigo-500/30 border-t-4 border-t-indigo-500 bg-zinc-900 p-6 animate-in slide-in-from-top-3 duration-300">
                    <h2 className="text-base font-semibold text-white mb-4">Registrar Nuevo Requerimiento</h2>
                    <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Cliente */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Cliente *</label>
                            <select
                                required
                                value={form.cliente_id}
                                onChange={e => setForm({ ...form, cliente_id: e.target.value })}
                                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 text-sm focus:outline-none focus:border-indigo-500 transition"
                            >
                                <option value="">Seleccionar cliente...</option>
                                {clientes.map(c => (
                                    <option key={c.id} value={c.id}>{c.nombre}</option>
                                ))}
                            </select>
                        </div>

                        {/* Solicitante */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Nombre del Solicitante *</label>
                            <Input
                                required
                                value={form.nombre_solicitante}
                                onChange={e => setForm({ ...form, nombre_solicitante: e.target.value })}
                                className="bg-zinc-950 border-zinc-800 text-white focus:border-indigo-500"
                                placeholder="Ej. Juan Pérez"
                            />
                        </div>

                        {/* Fecha entrega */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Fecha de Entrega (Deadline)</label>
                            <input
                                type="date"
                                value={form.fecha_entrega}
                                onChange={e => setForm({ ...form, fecha_entrega: e.target.value })}
                                className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 text-sm focus:outline-none focus:border-indigo-500 transition"
                            />
                        </div>

                        {/* Prioridad */}
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Prioridad</label>
                            <div className="flex gap-2">
                                {[1, 2, 3].map(p => (
                                    <button key={p} type="button"
                                        onClick={() => setForm({ ...form, prioridad: p })}
                                        className={`flex-1 py-2 px-2 rounded-lg border text-xs font-medium transition ${form.prioridad === p ? PRIORITY_MAP[p].bg + ' ' + PRIORITY_MAP[p].color : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                                    >
                                        {PRIORITY_MAP[p].label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Requerimiento */}
                        <div className="space-y-1.5 md:col-span-2">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Requerimiento *</label>
                            <textarea required rows={2} value={form.requerimiento}
                                onChange={e => setForm({ ...form, requerimiento: e.target.value })}
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-md p-3 text-sm text-white focus:border-indigo-500 outline-none transition"
                                placeholder="Describe el requerimiento..."
                            />
                        </div>

                        {/* Observaciones */}
                        <div className="space-y-1.5 md:col-span-2">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Observaciones</label>
                            <textarea rows={2} value={form.observaciones}
                                onChange={e => setForm({ ...form, observaciones: e.target.value })}
                                className="w-full bg-zinc-950 border border-zinc-800 rounded-md p-3 text-sm text-white focus:border-indigo-500 outline-none transition"
                                placeholder="Detalles adicionales..."
                            />
                        </div>

                        <div className="md:col-span-2 flex justify-end gap-3 pt-2">
                            <Button type="button" variant="ghost" onClick={() => setShowForm(false)} className="text-zinc-400 hover:text-white">Cancelar</Button>
                            <Button type="submit" disabled={submitting} className="bg-indigo-600 hover:bg-indigo-700 text-white min-w-[140px]">
                                {submitting ? 'Guardando...' : 'Enviar Solicitud'}
                            </Button>
                        </div>
                    </form>
                </div>
            )}

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                    <Input value={search} onChange={e => setSearch(e.target.value)}
                        className="pl-9 bg-zinc-900 border-zinc-800 text-white text-sm h-9"
                        placeholder="Buscar por cliente, ID, nombre o requerimiento..." />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-full sm:w-44 h-9 text-sm bg-zinc-900 border-zinc-800 text-zinc-300">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-zinc-900 border-zinc-700">
                        <SelectItem value="activos" className="text-sm">Solo activos</SelectItem>
                        <SelectItem value="todos" className="text-sm">Todos</SelectItem>
                        <SelectItem value="abierto" className="text-sm">Abiertos</SelectItem>
                        <SelectItem value="en_progreso" className="text-sm">En progreso</SelectItem>
                        <SelectItem value="completado" className="text-sm">Completados</SelectItem>
                        <SelectItem value="cancelado" className="text-sm">Cancelados</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {/* Ticket list */}
            <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-zinc-900">
                {filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                        <span className="text-3xl mb-3">🎧</span>
                        <p className="font-medium text-zinc-400">Sin tickets que mostrar</p>
                        <p className="text-sm mt-1">Prueba cambiando el filtro o el término de búsqueda.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-white/[0.04]">
                        {filtered.map(t => {
                            const isActive = t.estado === 'abierto' || t.estado === 'en_progreso'
                            const dl = daysLeft(t.fecha_entrega)
                            const StatusIcon = STATUS_MAP[t.estado]?.icon ?? AlertCircle
                            return (
                                <div key={t.id} className="grid grid-cols-1 gap-3 px-4 py-3.5 hover:bg-zinc-800/30 transition-colors sm:grid-cols-[1fr_2fr_1fr] sm:items-start">
                                    {/* Left: IDs */}
                                    <div className="flex flex-col gap-0.5">
                                        <span className="font-mono text-sm font-bold text-indigo-400">{t.id_ticket_display}</span>
                                        <span className="text-sm font-semibold text-blue-400">🏢 {t.cliente?.nombre ?? '—'}</span>
                                        <span className="text-xs text-zinc-500 flex items-center gap-1 mt-0.5">
                                            <User className="w-3 h-3 shrink-0" />{t.nombre_solicitante}
                                        </span>
                                        <span className="text-xs text-zinc-600 flex items-center gap-1">
                                            <Calendar className="w-3 h-3 shrink-0" />{safeDate(t.fecha_solicitud, 'dd MMM yyyy')}
                                        </span>
                                    </div>

                                    {/* Center: content */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-zinc-100 leading-snug">{t.requerimiento}</p>
                                        {t.observaciones && (
                                            <p className="mt-1.5 text-xs text-zinc-500 flex items-start gap-1">
                                                <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0" />{t.observaciones}
                                            </p>
                                        )}
                                        {t.responsable && (
                                            <p className="mt-1 text-xs text-zinc-500 flex items-center gap-1">
                                                <User className="w-3.5 h-3.5 shrink-0" /> Responsable: {t.responsable}
                                            </p>
                                        )}
                                        {t.fecha_entrega && (
                                            <p className="mt-1 text-xs text-emerald-500/80 flex items-center gap-1">
                                                <Clock className="w-3.5 h-3.5 shrink-0" /> Deadline: {safeDate(t.fecha_entrega, 'dd MMM yyyy')}
                                            </p>
                                        )}
                                    </div>

                                    {/* Right: meta + actions */}
                                    <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5 sm:justify-self-end sm:w-full">
                                        {/* Priority */}
                                        <span className={`text-xs font-bold uppercase px-2 py-0.5 rounded border ${PRIORITY_MAP[t.prioridad]?.bg} ${PRIORITY_MAP[t.prioridad]?.color}`}>
                                            {PRIORITY_MAP[t.prioridad]?.label}
                                        </span>

                                        {/* Status */}
                                        {isTeam ? (
                                            <Select value={t.estado} onValueChange={v => handleStatusChange(t.id, t.cliente_id, v)} disabled={statusUpdating === t.id}>
                                                <SelectTrigger className="h-7 w-full text-xs bg-zinc-800 border-zinc-700">
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent className="bg-zinc-900 border-zinc-700">
                                                    {Object.entries(STATUS_MAP).map(([k, s]) => (
                                                        <SelectItem key={k} value={k} className="text-xs"><span className={s.color.split(' ')[1]}>{s.label}</span></SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        ) : (
                                            <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-bold ${STATUS_MAP[t.estado]?.color}`}>
                                                <StatusIcon className="w-3 h-3" />{STATUS_MAP[t.estado]?.label}
                                            </span>
                                        )}

                                        {/* Time badges */}
                                        {isActive && (
                                            <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-xs font-semibold text-amber-400">
                                                ⏱ {elapsed(t.fecha_solicitud)} abierto
                                            </span>
                                        )}
                                        {isActive && dl !== null && dl <= 2 && (
                                            <span className="inline-flex items-center gap-1 rounded bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 text-xs font-semibold text-red-400">
                                                ⚠️ Vence {dl <= 0 ? 'hoy' : `en ${dl}d`}
                                            </span>
                                        )}

                                        {/* Edit */}
                                        {isTeam && (
                                            <button onClick={() => { setEditForm({ nombre_solicitante: t.nombre_solicitante, requerimiento: t.requerimiento, observaciones: t.observaciones || '', prioridad: t.prioridad }); setEditingTicket(t) }}
                                                className="text-zinc-500 hover:text-indigo-400 transition mt-0.5" title="Editar">
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )}
            </div>

            {/* Edit dialog */}
            <Dialog open={!!editingTicket} onOpenChange={open => { if (!open) setEditingTicket(null) }}>
                <DialogContent className="bg-zinc-950 border-zinc-800 text-white max-w-lg">
                    <DialogHeader><DialogTitle>Editar Requerimiento</DialogTitle></DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Solicitante</label>
                            <Input value={editForm.nombre_solicitante} onChange={e => setEditForm({ ...editForm, nombre_solicitante: e.target.value })} className="bg-zinc-900 border-zinc-700 text-white" />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Requerimiento</label>
                            <textarea rows={3} value={editForm.requerimiento} onChange={e => setEditForm({ ...editForm, requerimiento: e.target.value })} className="w-full bg-zinc-900 border border-zinc-700 rounded-md p-3 text-sm text-white outline-none focus:border-indigo-500" />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Observaciones</label>
                            <textarea rows={2} value={editForm.observaciones} onChange={e => setEditForm({ ...editForm, observaciones: e.target.value })} className="w-full bg-zinc-900 border border-zinc-700 rounded-md p-3 text-sm text-white outline-none focus:border-indigo-500" />
                        </div>
                        <div className="space-y-1.5">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Prioridad</label>
                            <div className="flex gap-2">
                                {[1, 2, 3].map(p => (
                                    <button key={p} type="button" onClick={() => setEditForm({ ...editForm, prioridad: p })}
                                        className={`flex-1 py-2 px-2 rounded-lg border text-xs font-medium transition ${editForm.prioridad === p ? PRIORITY_MAP[p].bg + ' ' + PRIORITY_MAP[p].color : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}>
                                        {PRIORITY_MAP[p].label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setEditingTicket(null)} className="text-zinc-400 hover:text-white">Cancelar</Button>
                        <Button onClick={handleEditSave} disabled={editSaving} className="bg-indigo-600 hover:bg-indigo-700 text-white">
                            {editSaving ? 'Guardando...' : 'Guardar Cambios'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
