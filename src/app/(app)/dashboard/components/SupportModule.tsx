'use client'

import React, { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Plus, Search, AlertCircle, Clock, CheckCircle2, User, Calendar, MessageSquare, History, Edit2, Bug, Sparkles, Wrench, ListTodo } from 'lucide-react'
import { createSoporteTicket, getSoporteTickets, updateSoporteTicket } from '../_actions'
import { format, isValid } from 'date-fns'
import { es } from 'date-fns/locale'

function safeFormatDate(value: string | null | undefined, fmt: string): string {
    if (!value) return 'Sin fecha'
    const d = new Date(value)
    return isValid(d) ? format(d, fmt, { locale: es }) : 'Sin fecha'
}

function formatElapsed(fechaSolicitud: string): string {
    const opened = new Date(fechaSolicitud)
    const now = new Date()
    const diffMs = now.getTime() - opened.getTime()
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    if (days > 0) return `${days}d ${hours}h`
    return `${hours}h`
}

function daysUntilDeadline(fechaEntrega: string | null): number | null {
    if (!fechaEntrega) return null
    const deadline = new Date(fechaEntrega)
    const now = new Date()
    return Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

interface Ticket {
    id: string
    id_ticket_display: string
    nombre_solicitante: string
    fecha_solicitud: string
    requerimiento: string
    observaciones: string
    responsable: string
    fecha_entrega: string | null
    prioridad: number
    estado: string
    tipo: string
}

export function SupportModule({ clientId, userRole = 'viewer', clienteNombre = '' }: {
    clientId: string
    userRole?: string
    clienteNombre?: string
}) {
    const [tickets, setTickets] = useState<Ticket[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showForm, setShowForm] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [search, setSearch] = useState('')

    const [formData, setFormData] = useState({
        nombre_solicitante: '',
        requerimiento: '',
        observaciones: '',
        prioridad: 2,
        fecha_entrega: '',
        tipo: 'tarea',
    })

    const [editingTicket, setEditingTicket] = useState<Ticket | null>(null)
    const [editForm, setEditForm] = useState({
        nombre_solicitante: '',
        requerimiento: '',
        observaciones: '',
        prioridad: 2,
        tipo: 'tarea',
    })
    const [editSaving, setEditSaving] = useState(false)
    const [statusUpdating, setStatusUpdating] = useState<string | null>(null)

    const isTeam = ['superadmin', 'admin', 'trafficker'].includes(userRole)

    useEffect(() => {
        fetchTickets()
    }, [clientId])

    async function fetchTickets() {
        setLoading(true)
        setError(null)
        try {
            const res = await getSoporteTickets(clientId)
            if (res.error) {
                setError(res.error)
            } else if (res.data) {
                setTickets(res.data)
            }
        } catch (e: any) {
            setError(e.message || 'Error desconocido al cargar tickets')
        } finally {
            setLoading(false)
        }
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setSubmitting(true)
        const res = await createSoporteTicket({
            cliente_id: clientId,
            tipo: formData.tipo as 'bug' | 'feature' | 'mejora' | 'tarea',
            nombre_solicitante: formData.nombre_solicitante,
            requerimiento: formData.requerimiento,
            observaciones: formData.observaciones,
            prioridad: formData.prioridad,
            fecha_entrega: formData.fecha_entrega || undefined,
        })
        if (res.success) {
            setShowForm(false)
            setFormData({ nombre_solicitante: '', requerimiento: '', observaciones: '', prioridad: 2, fecha_entrega: '', tipo: 'tarea' })
            fetchTickets()
        } else {
            alert("Error al crear el ticket: " + res.error)
        }
        setSubmitting(false)
    }

    function handleEditOpen(ticket: Ticket) {
        setEditForm({
            nombre_solicitante: ticket.nombre_solicitante,
            requerimiento: ticket.requerimiento,
            observaciones: ticket.observaciones || '',
            prioridad: ticket.prioridad,
            tipo: ticket.tipo || 'tarea',
        })
        setEditingTicket(ticket)
    }

    async function handleEditSave() {
        if (!editingTicket) return
        setEditSaving(true)
        const res = await updateSoporteTicket(editingTicket.id, clientId, {
            nombre_solicitante: editForm.nombre_solicitante,
            requerimiento: editForm.requerimiento,
            observaciones: editForm.observaciones,
            prioridad: editForm.prioridad,
            tipo: editForm.tipo as 'bug' | 'feature' | 'mejora' | 'tarea',
        })
        setEditSaving(false)
        if (res.error) { alert('Error al guardar: ' + res.error); return }
        setEditingTicket(null)
        fetchTickets()
    }

    async function handleStatusChange(ticketId: string, newEstado: string) {
        setStatusUpdating(ticketId)
        await updateSoporteTicket(ticketId, clientId, { estado: newEstado })
        setStatusUpdating(null)
        fetchTickets()
    }

    const filteredTickets = tickets.filter(t =>
        t.id_ticket_display.toLowerCase().includes(search.toLowerCase()) ||
        t.requerimiento.toLowerCase().includes(search.toLowerCase()) ||
        t.nombre_solicitante.toLowerCase().includes(search.toLowerCase())
    )

    const priorityMap: Record<number, { label: string, color: string, bg: string }> = {
        1: { label: 'Nivel 1 (Alta)', color: 'text-red-400', bg: 'bg-red-500/10 border-red-500/30' },
        2: { label: 'Nivel 2 (Media)', color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/30' },
        3: { label: 'Nivel 3 (Baja)', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/30' },
    }

    const statusMap: Record<string, { label: string, icon: any, color: string }> = {
        'abierto': { label: 'Planeado', icon: AlertCircle, color: 'text-blue-400' },
        'en_progreso': { label: 'En desarrollo', icon: Clock, color: 'text-amber-400' },
        'completado': { label: 'Lanzado', icon: CheckCircle2, color: 'text-emerald-400' },
        'cancelado': { label: 'Descartado', icon: MessageSquare, color: 'text-zinc-500' },
    }

    const typeMap: Record<string, { label: string, icon: any, color: string }> = {
        'bug': { label: 'Bug', icon: Bug, color: 'bg-red-600 text-white border-red-400 shadow-sm shadow-red-900/40' },
        'feature': { label: 'Feature', icon: Sparkles, color: 'bg-violet-600 text-white border-violet-400 shadow-sm shadow-violet-900/40' },
        'mejora': { label: 'Mejora', icon: Wrench, color: 'bg-sky-600 text-white border-sky-400 shadow-sm shadow-sky-900/40' },
        'tarea': { label: 'Tarea', icon: ListTodo, color: 'bg-zinc-600 text-white border-zinc-400 shadow-sm shadow-zinc-900/40' },
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                        <History className="w-6 h-6 text-indigo-400" />
                        🗺️ Roadmap
                    </h2>
                    <p className="text-zinc-400 text-sm">Bugs, mejoras e implementaciones de este cliente.</p>
                </div>
                {!showForm && (
                    <Button
                        onClick={() => setShowForm(true)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white gap-2 shadow-lg shadow-indigo-500/20"
                    >
                        <Plus className="w-4 h-4" />
                        Nuevo ítem
                    </Button>
                )}
            </div>

            {showForm && (
                <Card className="bg-zinc-900 border-zinc-800 border-t-4 border-t-indigo-500 shadow-xl overflow-hidden animate-in slide-in-from-top-4 duration-300">
                    <CardHeader>
                        <CardTitle className="text-lg text-white">Registrar Nuevo Requerimiento</CardTitle>
                        <CardDescription>Completa los detalles de tu solicitud para que nuestro equipo pueda procesarla.</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-4">
                                {/* Tipo */}
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Tipo</label>
                                    <div className="flex flex-wrap gap-2">
                                        {Object.entries(typeMap).map(([k, tp]) => {
                                            const Icon = tp.icon
                                            return (
                                                <button key={k} type="button"
                                                    onClick={() => setFormData({ ...formData, tipo: k })}
                                                    className={`flex items-center gap-1.5 py-2 px-3 rounded-lg border text-xs font-medium transition ${formData.tipo === k ? tp.color : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                                                >
                                                    <Icon className="w-3.5 h-3.5" />{tp.label}
                                                </button>
                                            )
                                        })}
                                    </div>
                                </div>
                                {/* Cliente (auto) */}
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
                                        Cliente <span className="text-blue-400 normal-case font-normal">(automático)</span>
                                    </label>
                                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-950 border border-blue-500/20 text-blue-400 text-sm">
                                        🏢 {clienteNombre || 'Sin cliente'}
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Nombre del Solicitante</label>
                                    <Input
                                        required
                                        value={formData.nombre_solicitante}
                                        onChange={e => setFormData({...formData, nombre_solicitante: e.target.value})}
                                        className="bg-zinc-950 border-zinc-800 text-white focus:border-indigo-500"
                                        placeholder="Ej. Juan Pérez"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Fecha de Entrega (Deadline)</label>
                                    <input
                                        type="date"
                                        value={formData.fecha_entrega}
                                        onChange={e => setFormData({...formData, fecha_entrega: e.target.value})}
                                        className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-zinc-100 text-sm focus:outline-none focus:border-indigo-500 transition"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Prioridad del Requerimiento</label>
                                    <div className="flex gap-2">
                                        {[1, 2, 3].map(p => (
                                            <button
                                                key={p}
                                                type="button"
                                                onClick={() => setFormData({...formData, prioridad: p})}
                                                className={`flex-1 py-2 px-3 rounded-lg border text-xs font-medium transition ${formData.prioridad === p ? priorityMap[p].bg + ' ' + priorityMap[p].color + ' border-' + priorityMap[p].color.split('-')[1] + '-500/50' : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                                            >
                                                {priorityMap[p].label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div className="space-y-4">
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Definición del Pedido / Requerimiento</label>
                                    <textarea
                                        required
                                        rows={2}
                                        value={formData.requerimiento}
                                        onChange={e => setFormData({...formData, requerimiento: e.target.value})}
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-md p-3 text-sm text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                                        placeholder="Describe brevemente lo que necesitas..."
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Observaciones Adicionales</label>
                                    <textarea
                                        rows={2}
                                        value={formData.observaciones}
                                        onChange={e => setFormData({...formData, observaciones: e.target.value})}
                                        className="w-full bg-zinc-950 border border-zinc-800 rounded-md p-3 text-sm text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                                        placeholder="Cualquier detalle extra que debamos saber..."
                                    />
                                </div>
                            </div>
                            <div className="md:col-span-2 flex justify-end gap-3 pt-2">
                                <Button
                                    type="button"
                                    variant="ghost"
                                    onClick={() => setShowForm(false)}
                                    className="text-zinc-400 hover:text-white"
                                >
                                    Cancelar
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={submitting}
                                    className="bg-indigo-600 hover:bg-indigo-700 text-white min-w-[140px]"
                                >
                                    {submitting ? 'Guardando...' : 'Enviar Solicitud'}
                                </Button>
                            </div>
                        </form>
                    </CardContent>
                </Card>
            )}

            <Card className="bg-zinc-900 border-zinc-800 shadow-2xl overflow-hidden">
                <CardHeader className="border-b border-zinc-800 bg-zinc-950/30 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <CardTitle className="text-white text-lg">Historial de Requerimientos</CardTitle>
                        <CardDescription>Trazabilidad completa de tus solicitudes con Ads House.</CardDescription>
                    </div>
                    <div className="relative max-w-sm w-full">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                        <Input
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            className="pl-9 bg-zinc-950 border-zinc-800 text-white text-xs h-9"
                            placeholder="Buscar por ID, nombre o requerimiento..."
                        />
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {error && (
                        <div className="p-6 bg-red-500/10 border-b border-red-500/20 text-red-400 text-sm flex items-center gap-2">
                            <AlertCircle className="w-4 h-4" />
                            <span><strong>Error:</strong> {error}</span>
                            <Button variant="outline" size="xs" onClick={fetchTickets} className="ml-auto border-red-500/30 text-red-400 hover:bg-red-500/20">Reintentar</Button>
                        </div>
                    )}
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader className="bg-zinc-950/50">
                                <TableRow className="border-zinc-800">
                                    <TableHead className="text-zinc-400 font-bold w-[100px]">ID</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Cliente / Solicitante</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Tipo</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Requerimiento</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Prioridad</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Responsable / Tiempo</TableHead>
                                    <TableHead className="text-zinc-400 font-bold text-center">Estado</TableHead>
                                    {isTeam && <TableHead className="text-zinc-400 font-bold w-[60px]"></TableHead>}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {loading ? (
                                    <TableRow>
                                        <TableCell colSpan={isTeam ? 8 : 7} className="text-center py-10 text-zinc-500">Cargando tickets...</TableCell>
                                    </TableRow>
                                ) : filteredTickets.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={isTeam ? 8 : 7} className="text-center py-10 text-zinc-500">No se encontraron requerimientos registrados.</TableCell>
                                    </TableRow>
                                ) : (
                                    filteredTickets.map(t => {
                                        const StatusIcon = statusMap[t.estado]?.icon || AlertCircle
                                        const isActive = t.estado === 'abierto' || t.estado === 'en_progreso'
                                        const daysLeft = daysUntilDeadline(t.fecha_entrega)
                                        return (
                                            <TableRow key={t.id} className="border-zinc-800 hover:bg-zinc-800/30 transition-colors group">
                                                <TableCell className="font-mono font-bold text-indigo-400">{t.id_ticket_display}</TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col gap-0.5">
                                                        {clienteNombre && (
                                                            <span className="text-blue-400 text-xs font-semibold flex items-center gap-1">
                                                                🏢 {clienteNombre}
                                                            </span>
                                                        )}
                                                        <span className="text-zinc-200 font-medium">{t.nombre_solicitante}</span>
                                                        <span className="text-zinc-500 text-[10px] flex items-center gap-1">
                                                            <Calendar className="w-3 h-3" />
                                                            {safeFormatDate(t.fecha_solicitud, 'dd MMM yyyy')}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge className={`inline-flex items-center gap-1 ${(typeMap[t.tipo] ?? typeMap.tarea).color} text-[10px] font-bold uppercase`}>
                                                        {React.createElement((typeMap[t.tipo] ?? typeMap.tarea).icon, { className: 'w-3 h-3' })}
                                                        {(typeMap[t.tipo] ?? typeMap.tarea).label}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="max-w-md">
                                                    <div className="flex flex-col">
                                                        <span className="text-zinc-300 text-sm line-clamp-1 group-hover:line-clamp-none transition-all">{t.requerimiento}</span>
                                                        {t.observaciones && (
                                                            <span className="text-zinc-500 text-[11px] mt-1 flex items-start gap-1">
                                                                <MessageSquare className="w-3 h-3 mt-0.5 shrink-0" />
                                                                {t.observaciones}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge className={`${priorityMap[t.prioridad]?.bg} ${priorityMap[t.prioridad]?.color} border-transparent text-[10px] font-bold uppercase`}>
                                                        {priorityMap[t.prioridad]?.label.split('(')[1].replace(')', '')}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col gap-1">
                                                        <span className="text-zinc-300 text-sm flex items-center gap-1.5">
                                                            <User className="w-3.5 h-3.5 text-zinc-600" />
                                                            {t.responsable || <span className="text-zinc-600 italic">Por asignar</span>}
                                                        </span>
                                                        {t.fecha_entrega && (
                                                            <span className="text-emerald-500/80 text-[10px] font-semibold flex items-center gap-1">
                                                                <Clock className="w-3 h-3" />
                                                                Est: {safeFormatDate(t.fecha_entrega, 'dd MMM yyyy')}
                                                            </span>
                                                        )}
                                                        {isActive && (
                                                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 w-fit">
                                                                ⏱ {formatElapsed(t.fecha_solicitud)} abierto
                                                            </span>
                                                        )}
                                                        {isActive && daysLeft !== null && daysLeft <= 2 && (
                                                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 w-fit">
                                                                ⚠️ Vence en {daysLeft <= 0 ? 'hoy' : `${daysLeft}d`}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    {isTeam ? (
                                                        <Select
                                                            value={t.estado}
                                                            onValueChange={(val) => handleStatusChange(t.id, val)}
                                                            disabled={statusUpdating === t.id}
                                                        >
                                                            <SelectTrigger className="h-7 w-36 text-xs bg-zinc-900 border-zinc-700">
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent className="bg-zinc-900 border-zinc-700">
                                                                {Object.entries(statusMap).map(([key, s]) => (
                                                                    <SelectItem key={key} value={key} className="text-xs">
                                                                        <span className={s.color}>{s.label}</span>
                                                                    </SelectItem>
                                                                ))}
                                                            </SelectContent>
                                                        </Select>
                                                    ) : (
                                                        <div className="flex flex-col items-center justify-center">
                                                            <div className={`flex items-center gap-1.5 ${statusMap[t.estado]?.color} font-bold text-[11px] uppercase tracking-wider`}>
                                                                <StatusIcon className="w-3.5 h-3.5" />
                                                                {statusMap[t.estado]?.label}
                                                            </div>
                                                        </div>
                                                    )}
                                                </TableCell>
                                                {isTeam && (
                                                    <TableCell>
                                                        <button
                                                            onClick={() => handleEditOpen(t)}
                                                            className="text-zinc-500 hover:text-indigo-400 transition"
                                                            title="Editar ticket"
                                                        >
                                                            <Edit2 className="w-4 h-4" />
                                                        </button>
                                                    </TableCell>
                                                )}
                                            </TableRow>
                                        )
                                    })
                                )}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

            <Dialog open={!!editingTicket} onOpenChange={(open) => { if (!open) setEditingTicket(null) }}>
                <DialogContent className="bg-zinc-950 border-zinc-800 text-white max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="text-white">Editar Requerimiento</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Nombre del Solicitante</label>
                            <Input
                                value={editForm.nombre_solicitante}
                                onChange={e => setEditForm({ ...editForm, nombre_solicitante: e.target.value })}
                                className="bg-zinc-900 border-zinc-700 text-white"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Requerimiento</label>
                            <textarea
                                rows={3}
                                value={editForm.requerimiento}
                                onChange={e => setEditForm({ ...editForm, requerimiento: e.target.value })}
                                className="w-full bg-zinc-900 border border-zinc-700 rounded-md p-3 text-sm text-white outline-none focus:border-indigo-500"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Observaciones</label>
                            <textarea
                                rows={2}
                                value={editForm.observaciones}
                                onChange={e => setEditForm({ ...editForm, observaciones: e.target.value })}
                                className="w-full bg-zinc-900 border border-zinc-700 rounded-md p-3 text-sm text-white outline-none focus:border-indigo-500"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Tipo</label>
                            <div className="flex flex-wrap gap-2">
                                {Object.entries(typeMap).map(([k, tp]) => {
                                    const Icon = tp.icon
                                    return (
                                        <button key={k} type="button"
                                            onClick={() => setEditForm({ ...editForm, tipo: k })}
                                            className={`flex items-center gap-1.5 py-2 px-3 rounded-lg border text-xs font-medium transition ${editForm.tipo === k ? tp.color : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                                        >
                                            <Icon className="w-3.5 h-3.5" />{tp.label}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Prioridad</label>
                            <div className="flex gap-2">
                                {[1, 2, 3].map(p => (
                                    <button
                                        key={p}
                                        type="button"
                                        onClick={() => setEditForm({ ...editForm, prioridad: p })}
                                        className={`flex-1 py-2 px-3 rounded-lg border text-xs font-medium transition ${editForm.prioridad === p ? priorityMap[p].bg + ' ' + priorityMap[p].color : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                                    >
                                        {priorityMap[p].label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setEditingTicket(null)} className="text-zinc-400 hover:text-white">
                            Cancelar
                        </Button>
                        <Button
                            onClick={handleEditSave}
                            disabled={editSaving}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white"
                        >
                            {editSaving ? 'Guardando...' : 'Guardar Cambios'}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
