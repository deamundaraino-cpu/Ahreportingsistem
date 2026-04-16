'use client'

import React, { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Plus, Search, AlertCircle, Clock, CheckCircle2, User, Calendar, MessageSquare, History } from 'lucide-react'
import { createSoporteTicket, getSoporteTickets } from '../_actions'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

interface Ticket {
    id: string
    id_ticket_display: string
    nombre_solicitante: string
    fecha_solicitud: string
    requerimiento: string
    observaciones: string
    responsable: string
    fecha_entrega: string
    prioridad: number
    estado: string
}

export function SupportModule({ clientId }: { clientId: string }) {
    const [tickets, setTickets] = useState<Ticket[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showForm, setShowForm] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [search, setSearch] = useState('')

    // Form state
    const [formData, setFormData] = useState({
        nombre_solicitante: '',
        requerimiento: '',
        observaciones: '',
        prioridad: 2
    })

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
            ...formData
        })
        if (res.success) {
            setShowForm(false)
            setFormData({ nombre_solicitante: '', requerimiento: '', observaciones: '', prioridad: 2 })
            fetchTickets()
        } else {
            alert("Error al crear el ticket: " + res.error)
        }
        setSubmitting(false)
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
        'abierto': { label: 'Abierto', icon: AlertCircle, color: 'text-blue-400' },
        'en_progreso': { label: 'En Progreso', icon: Clock, color: 'text-amber-400' },
        'completado': { label: 'Completado', icon: CheckCircle2, color: 'text-emerald-400' },
        'cancelado': { label: 'Cancelado', icon: MessageSquare, color: 'text-zinc-500' },
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-bold text-white flex items-center gap-2">
                        <History className="w-6 h-6 text-indigo-400" />
                        Soporte Ads House
                    </h2>
                    <p className="text-zinc-400 text-sm">Gestiona y haz seguimiento a tus requerimientos técnicos.</p>
                </div>
                {!showForm && (
                    <Button 
                        onClick={() => setShowForm(true)}
                        className="bg-indigo-600 hover:bg-indigo-700 text-white gap-2 shadow-lg shadow-indigo-500/20"
                    >
                        <Plus className="w-4 h-4" />
                        Nuevo Requerimiento
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
                                        className="w-full bg-zinc-950 border-zinc-800 rounded-md p-3 text-sm text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
                                        placeholder="Describe brevemente lo que necesitas..."
                                    />
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Observaciones Adicionales</label>
                                    <textarea 
                                        rows={2}
                                        value={formData.observaciones}
                                        onChange={e => setFormData({...formData, observaciones: e.target.value})}
                                        className="w-full bg-zinc-950 border-zinc-800 rounded-md p-3 text-sm text-white focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 outline-none transition"
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
                                    <TableHead className="text-zinc-400 font-bold w-[100px]">ID Ticket</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Solicitante / Fecha</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Requerimiento</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Prioridad</TableHead>
                                    <TableHead className="text-zinc-400 font-bold">Responsable / Entrega</TableHead>
                                    <TableHead className="text-zinc-400 font-bold text-center">Estado</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {loading ? (
                                    <TableRow>
                                        <TableCell colSpan={6} className="text-center py-10 text-zinc-500">Cargando tickets...</TableCell>
                                    </TableRow>
                                ) : filteredTickets.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={6} className="text-center py-10 text-zinc-500">No se encontraron requerimientos registrados.</TableCell>
                                    </TableRow>
                                ) : (
                                    filteredTickets.map(ticket => {
                                        const StatusIcon = statusMap[ticket.estado]?.icon || AlertCircle
                                        return (
                                            <TableRow key={ticket.id} className="border-zinc-800 hover:bg-zinc-800/30 transition-colors group">
                                                <TableCell className="font-mono font-bold text-indigo-400">{ticket.id_ticket_display}</TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className="text-zinc-200 font-medium">{ticket.nombre_solicitante}</span>
                                                        <span className="text-zinc-500 text-[10px] flex items-center gap-1">
                                                            <Calendar className="w-3 h-3" />
                                                            {format(new Date(ticket.fecha_solicitud), 'dd MMM yyyy', { locale: es })}
                                                        </span>
                                                    </div>
                                                </TableCell>
                                                <TableCell className="max-w-md">
                                                    <div className="flex flex-col">
                                                        <span className="text-zinc-300 text-sm line-clamp-1 group-hover:line-clamp-none transition-all">{ticket.requerimiento}</span>
                                                        {ticket.observaciones && (
                                                            <span className="text-zinc-500 text-[11px] mt-1 flex items-start gap-1">
                                                                <MessageSquare className="w-3 h-3 mt-0.5 shrink-0" />
                                                                {ticket.observaciones}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge className={`${priorityMap[ticket.prioridad]?.bg} ${priorityMap[ticket.prioridad]?.color} border-transparent text-[10px] font-bold uppercase`}>
                                                        {priorityMap[ticket.prioridad]?.label.split('(')[1].replace(')', '')}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className="text-zinc-300 text-sm flex items-center gap-1.5">
                                                            <User className="w-3.5 h-3.5 text-zinc-600" />
                                                            {ticket.responsable || <span className="text-zinc-600 italic">Por asignar</span>}
                                                        </span>
                                                        {ticket.fecha_entrega && (
                                                            <span className="text-emerald-500/80 text-[10px] mt-1 font-semibold flex items-center gap-1">
                                                                <Clock className="w-3 h-3" />
                                                                Est: {format(new Date(ticket.fecha_entrega), 'dd MMM yyyy', { locale: es })}
                                                            </span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col items-center justify-center">
                                                        <div className={`flex items-center gap-1.5 ${statusMap[ticket.estado]?.color} font-bold text-[11px] uppercase tracking-wider`}>
                                                            <StatusIcon className="w-3.5 h-3.5" />
                                                            {statusMap[ticket.estado]?.label}
                                                        </div>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })
                                )}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
