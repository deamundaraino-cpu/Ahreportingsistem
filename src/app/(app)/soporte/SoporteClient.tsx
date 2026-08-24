'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Plus,
  Search,
  AlertCircle,
  Clock,
  CheckCircle2,
  MessageSquare,
  Edit2,
  User,
  Calendar,
  Bug,
  Sparkles,
  Wrench,
  ListTodo,
} from 'lucide-react';
import { createSoporteTicket, updateSoporteTicket } from '../dashboard/_actions';
import { useRouter } from 'next/navigation';
import { format, isValid } from 'date-fns';
import { es } from 'date-fns/locale';

function safeDate(v: string | null | undefined, fmt: string) {
  if (!v) return '—';
  const d = new Date(v);
  return isValid(d) ? format(d, fmt, { locale: es }) : '—';
}

function elapsed(fecha: string) {
  const ms = Date.now() - new Date(fecha).getTime();
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

function daysLeft(fechaEntrega: string | null) {
  if (!fechaEntrega) return null;
  return Math.ceil((new Date(fechaEntrega).getTime() - Date.now()) / 86400000);
}

const STATUS_MAP: Record<string, { label: string; color: string; icon: any }> = {
  abierto: {
    label: 'Planeado',
    color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20',
    icon: AlertCircle,
  },
  en_progreso: {
    label: 'En desarrollo',
    color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20',
    icon: Clock,
  },
  completado: {
    label: 'Lanzado',
    color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20',
    icon: CheckCircle2,
  },
  cancelado: {
    label: 'Descartado',
    color: 'bg-muted/50 text-muted-foreground border-border',
    icon: MessageSquare,
  },
};

const PRIORITY_MAP: Record<number, { label: string; color: string; bg: string }> = {
  1: {
    label: 'Alta',
    color: 'text-red-600 dark:text-red-400',
    bg: 'bg-red-500/10 border-red-500/30',
  },
  2: {
    label: 'Media',
    color: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/30',
  },
  3: {
    label: 'Baja',
    color: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/30',
  },
};

const TYPE_MAP: Record<string, { label: string; color: string; icon: any }> = {
  bug: {
    label: 'Bug',
    color: 'bg-red-600 text-white border-red-400 shadow-sm shadow-red-900/40',
    icon: Bug,
  },
  feature: {
    label: 'Feature',
    color: 'bg-violet-600 text-white border-violet-400 shadow-sm shadow-violet-900/40',
    icon: Sparkles,
  },
  mejora: {
    label: 'Mejora',
    color: 'bg-sky-600 text-white border-sky-400 shadow-sm shadow-sky-900/40',
    icon: Wrench,
  },
  tarea: {
    label: 'Tarea',
    color: 'bg-secondary text-secondary-foreground border-border shadow-sm',
    icon: ListTodo,
  },
};

interface Cliente {
  id: string;
  nombre: string;
}
interface Ticket {
  id: string;
  id_ticket_display: string;
  cliente_id: string | null;
  nombre_solicitante: string;
  fecha_solicitud: string;
  requerimiento: string;
  observaciones: string;
  responsable: string;
  fecha_entrega: string | null;
  prioridad: number;
  estado: string;
  tipo: string;
  cliente?: { nombre: string } | null;
}

const EMPTY_FORM = {
  cliente_id: '',
  tipo: 'tarea',
  nombre_solicitante: '',
  requerimiento: '',
  observaciones: '',
  prioridad: 2,
  fecha_entrega: '',
};

export function SoporteClient({
  tickets: initial,
  clientes,
  userRole,
}: {
  tickets: Ticket[];
  clientes: Cliente[];
  userRole: string;
}) {
  const router = useRouter();
  const isTeam = ['superadmin', 'admin', 'trafficker'].includes(userRole);

  const tickets = initial;
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('activos');
  const [tipoFilter, setTipoFilter] = useState<string>('todos');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const [editingTicket, setEditingTicket] = useState<Ticket | null>(null);
  const [editForm, setEditForm] = useState({
    nombre_solicitante: '',
    requerimiento: '',
    observaciones: '',
    prioridad: 2,
    tipo: 'tarea',
  });
  const [editSaving, setEditSaving] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState<string | null>(null);

  const refresh = () => router.refresh();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    const res = await createSoporteTicket({
      cliente_id: form.cliente_id || undefined,
      tipo: form.tipo as 'bug' | 'feature' | 'mejora' | 'tarea',
      nombre_solicitante: form.nombre_solicitante,
      requerimiento: form.requerimiento,
      observaciones: form.observaciones,
      prioridad: form.prioridad,
      fecha_entrega: form.fecha_entrega || undefined,
    });
    setSubmitting(false);
    if (res.error) {
      alert('Error: ' + res.error);
      return;
    }
    setShowForm(false);
    setForm(EMPTY_FORM);
    refresh();
  }

  async function handleStatusChange(ticketId: string, clienteId: string | null, estado: string) {
    setStatusUpdating(ticketId);
    await updateSoporteTicket(ticketId, clienteId, { estado });
    setStatusUpdating(null);
    refresh();
  }

  async function handleEditSave() {
    if (!editingTicket) return;
    setEditSaving(true);
    const res = await updateSoporteTicket(
      editingTicket.id,
      editingTicket.cliente_id,
      editForm as any
    );
    setEditSaving(false);
    if (res.error) {
      alert('Error: ' + res.error);
      return;
    }
    setEditingTicket(null);
    refresh();
  }

  const filtered = tickets.filter((t) => {
    const matchesSearch =
      t.id_ticket_display.toLowerCase().includes(search.toLowerCase()) ||
      t.requerimiento.toLowerCase().includes(search.toLowerCase()) ||
      t.nombre_solicitante.toLowerCase().includes(search.toLowerCase()) ||
      (t.cliente?.nombre ?? '').toLowerCase().includes(search.toLowerCase());
    const matchesStatus =
      statusFilter === 'todos'
        ? true
        : statusFilter === 'activos'
          ? t.estado === 'abierto' || t.estado === 'en_progreso'
          : t.estado === statusFilter;
    const matchesTipo = tipoFilter === 'todos' || t.tipo === tipoFilter;
    return matchesSearch && matchesStatus && matchesTipo;
  });

  const activeCount = tickets.filter(
    (t) => t.estado === 'abierto' || t.estado === 'en_progreso'
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">🗺️ Roadmap</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {activeCount} pendiente{activeCount !== 1 ? 's' : ''} · {tickets.length} total
          </p>
        </div>
        <Button
          onClick={() => setShowForm((v) => !v)}
          className="bg-indigo-600 hover:bg-indigo-700 text-white gap-2 shadow-lg shadow-indigo-500/20"
        >
          <Plus className="w-4 h-4" />
          Nuevo ítem
        </Button>
      </div>

      {/* Create form */}
      {showForm && (
        <div className="rounded-xl border border-indigo-500/30 border-t-4 border-t-indigo-500 bg-card p-6 animate-in slide-in-from-top-3 duration-300">
          <h2 className="text-base font-semibold text-foreground mb-4">
            Registrar Nuevo Ítem del Roadmap
          </h2>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Tipo */}
            <div className="space-y-1.5 md:col-span-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Tipo
              </label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(TYPE_MAP).map(([k, tp]) => {
                  const Icon = tp.icon;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setForm({ ...form, tipo: k })}
                      className={`flex items-center gap-1.5 py-2 px-3 rounded-lg border text-xs font-medium transition ${form.tipo === k ? tp.color : 'bg-background border-border text-muted-foreground/70 hover:border-ring'}`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {tp.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Cliente (opcional) */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Cliente{' '}
                <span className="text-muted-foreground/70 normal-case font-normal">(opcional)</span>
              </label>
              <select
                value={form.cliente_id}
                onChange={(e) => setForm({ ...form, cliente_id: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-background border border-input text-foreground text-sm focus:outline-none focus:border-indigo-500 transition"
              >
                <option value="">Interno (sin cliente)</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nombre}
                  </option>
                ))}
              </select>
            </div>

            {/* Solicitante */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Nombre del Solicitante *
              </label>
              <Input
                required
                value={form.nombre_solicitante}
                onChange={(e) => setForm({ ...form, nombre_solicitante: e.target.value })}
                className="bg-background border-input text-foreground focus:border-indigo-500"
                placeholder="Ej. Juan Pérez"
              />
            </div>

            {/* Fecha entrega */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Fecha de Entrega (Deadline)
              </label>
              <input
                type="date"
                value={form.fecha_entrega}
                onChange={(e) => setForm({ ...form, fecha_entrega: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-background border border-input text-foreground text-sm focus:outline-none focus:border-indigo-500 transition"
              />
            </div>

            {/* Prioridad */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Prioridad
              </label>
              <div className="flex gap-2">
                {[1, 2, 3].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setForm({ ...form, prioridad: p })}
                    className={`flex-1 py-2 px-2 rounded-lg border text-xs font-medium transition ${form.prioridad === p ? PRIORITY_MAP[p].bg + ' ' + PRIORITY_MAP[p].color : 'bg-background border-border text-muted-foreground/70 hover:border-ring'}`}
                  >
                    {PRIORITY_MAP[p].label}
                  </button>
                ))}
              </div>
            </div>

            {/* Requerimiento */}
            <div className="space-y-1.5 md:col-span-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Requerimiento *
              </label>
              <textarea
                required
                rows={2}
                value={form.requerimiento}
                onChange={(e) => setForm({ ...form, requerimiento: e.target.value })}
                className="w-full bg-background border border-input rounded-md p-3 text-sm text-foreground focus:border-indigo-500 outline-none transition"
                placeholder="Describe el requerimiento..."
              />
            </div>

            {/* Observaciones */}
            <div className="space-y-1.5 md:col-span-2">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Observaciones
              </label>
              <textarea
                rows={2}
                value={form.observaciones}
                onChange={(e) => setForm({ ...form, observaciones: e.target.value })}
                className="w-full bg-background border border-input rounded-md p-3 text-sm text-foreground focus:border-indigo-500 outline-none transition"
                placeholder="Detalles adicionales..."
              />
            </div>

            <div className="md:col-span-2 flex justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowForm(false)}
                className="text-muted-foreground hover:text-foreground"
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
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/70" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-card border-input text-foreground text-sm h-9"
            placeholder="Buscar por cliente, ID, nombre o requerimiento..."
          />
        </div>
        <Select value={tipoFilter} onValueChange={setTipoFilter}>
          <SelectTrigger className="w-full sm:w-40 h-9 text-sm bg-card border-input text-foreground/90">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="todos" className="text-sm">
              Todos los tipos
            </SelectItem>
            {Object.entries(TYPE_MAP).map(([k, tp]) => (
              <SelectItem key={k} value={k} className="text-sm">
                {tp.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-44 h-9 text-sm bg-card border-input text-foreground/90">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="activos" className="text-sm">
              Solo activos
            </SelectItem>
            <SelectItem value="todos" className="text-sm">
              Todos
            </SelectItem>
            <SelectItem value="abierto" className="text-sm">
              Planeados
            </SelectItem>
            <SelectItem value="en_progreso" className="text-sm">
              En desarrollo
            </SelectItem>
            <SelectItem value="completado" className="text-sm">
              Lanzados
            </SelectItem>
            <SelectItem value="cancelado" className="text-sm">
              Descartados
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Ticket list */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground/70">
            <span className="text-3xl mb-3">🗺️</span>
            <p className="font-medium text-muted-foreground">Sin ítems que mostrar</p>
            <p className="text-sm mt-1">Prueba cambiando el filtro o el término de búsqueda.</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((t) => {
              const isActive = t.estado === 'abierto' || t.estado === 'en_progreso';
              const dl = daysLeft(t.fecha_entrega);
              const StatusIcon = STATUS_MAP[t.estado]?.icon ?? AlertCircle;
              return (
                <div
                  key={t.id}
                  className="grid grid-cols-1 gap-3 px-4 py-3.5 hover:bg-accent/50 transition-colors sm:grid-cols-[1fr_2fr_1fr] sm:items-start"
                >
                  {/* Left: IDs */}
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-sm font-bold text-indigo-600 dark:text-indigo-400">
                      {t.id_ticket_display}
                    </span>
                    <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">
                      {t.cliente?.nombre ? `🏢 ${t.cliente.nombre}` : '🌐 Interno'}
                    </span>
                    <span className="text-xs text-muted-foreground/70 flex items-center gap-1 mt-0.5">
                      <User className="w-3 h-3 shrink-0" />
                      {t.nombre_solicitante}
                    </span>
                    <span className="text-xs text-muted-foreground/70 flex items-center gap-1">
                      <Calendar className="w-3 h-3 shrink-0" />
                      {safeDate(t.fecha_solicitud, 'dd MMM yyyy')}
                    </span>
                  </div>

                  {/* Center: content */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground leading-snug">
                      {t.requerimiento}
                    </p>
                    {t.observaciones && (
                      <p className="mt-1.5 text-xs text-muted-foreground/70 flex items-start gap-1">
                        <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        {t.observaciones}
                      </p>
                    )}
                    {t.responsable && (
                      <p className="mt-1 text-xs text-muted-foreground/70 flex items-center gap-1">
                        <User className="w-3.5 h-3.5 shrink-0" /> Responsable: {t.responsable}
                      </p>
                    )}
                    {t.fecha_entrega && (
                      <p className="mt-1 text-xs text-emerald-500/80 flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5 shrink-0" /> Deadline:{' '}
                        {safeDate(t.fecha_entrega, 'dd MMM yyyy')}
                      </p>
                    )}
                  </div>

                  {/* Right: meta + actions */}
                  <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end sm:gap-1.5 sm:justify-self-end sm:w-full">
                    {/* Tipo */}
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-bold uppercase px-2 py-0.5 rounded border ${TYPE_MAP[t.tipo]?.color ?? TYPE_MAP.tarea.color}`}
                    >
                      {React.createElement((TYPE_MAP[t.tipo] ?? TYPE_MAP.tarea).icon, {
                        className: 'w-3 h-3',
                      })}
                      {(TYPE_MAP[t.tipo] ?? TYPE_MAP.tarea).label}
                    </span>

                    {/* Priority */}
                    <span
                      className={`text-xs font-bold uppercase px-2 py-0.5 rounded border ${PRIORITY_MAP[t.prioridad]?.bg} ${PRIORITY_MAP[t.prioridad]?.color}`}
                    >
                      {PRIORITY_MAP[t.prioridad]?.label}
                    </span>

                    {/* Status */}
                    {isTeam ? (
                      <Select
                        value={t.estado}
                        onValueChange={(v) => handleStatusChange(t.id, t.cliente_id, v)}
                        disabled={statusUpdating === t.id}
                      >
                        <SelectTrigger className="h-7 w-full text-xs bg-secondary border-input">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-popover border-border">
                          {Object.entries(STATUS_MAP).map(([k, s]) => (
                            <SelectItem key={k} value={k} className="text-xs">
                              <span className={s.color.split(' ')[1]}>{s.label}</span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-bold ${STATUS_MAP[t.estado]?.color}`}
                      >
                        <StatusIcon className="w-3 h-3" />
                        {STATUS_MAP[t.estado]?.label}
                      </span>
                    )}

                    {/* Time badges */}
                    {isActive && (
                      <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                        ⏱ {elapsed(t.fecha_solicitud)} abierto
                      </span>
                    )}
                    {isActive && dl !== null && dl <= 2 && (
                      <span className="inline-flex items-center gap-1 rounded bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 text-xs font-semibold text-red-600 dark:text-red-400">
                        ⚠️ Vence {dl <= 0 ? 'hoy' : `en ${dl}d`}
                      </span>
                    )}

                    {/* Edit */}
                    {isTeam && (
                      <button
                        onClick={() => {
                          setEditForm({
                            nombre_solicitante: t.nombre_solicitante,
                            requerimiento: t.requerimiento,
                            observaciones: t.observaciones || '',
                            prioridad: t.prioridad,
                            tipo: t.tipo || 'tarea',
                          });
                          setEditingTicket(t);
                        }}
                        className="text-muted-foreground/70 hover:text-indigo-600 dark:hover:text-indigo-400 transition mt-0.5"
                        title="Editar"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit dialog */}
      <Dialog
        open={!!editingTicket}
        onOpenChange={(open) => {
          if (!open) setEditingTicket(null);
        }}
      >
        <DialogContent className="bg-background border-border text-foreground max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar Requerimiento</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Solicitante
              </label>
              <Input
                value={editForm.nombre_solicitante}
                onChange={(e) => setEditForm({ ...editForm, nombre_solicitante: e.target.value })}
                className="bg-card border-input text-foreground"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Requerimiento
              </label>
              <textarea
                rows={3}
                value={editForm.requerimiento}
                onChange={(e) => setEditForm({ ...editForm, requerimiento: e.target.value })}
                className="w-full bg-card border border-input rounded-md p-3 text-sm text-foreground outline-none focus:border-indigo-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Observaciones
              </label>
              <textarea
                rows={2}
                value={editForm.observaciones}
                onChange={(e) => setEditForm({ ...editForm, observaciones: e.target.value })}
                className="w-full bg-card border border-input rounded-md p-3 text-sm text-foreground outline-none focus:border-indigo-500"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Tipo
              </label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(TYPE_MAP).map(([k, tp]) => {
                  const Icon = tp.icon;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setEditForm({ ...editForm, tipo: k })}
                      className={`flex items-center gap-1.5 py-2 px-3 rounded-lg border text-xs font-medium transition ${editForm.tipo === k ? tp.color : 'bg-background border-border text-muted-foreground/70 hover:border-ring'}`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      {tp.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Prioridad
              </label>
              <div className="flex gap-2">
                {[1, 2, 3].map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setEditForm({ ...editForm, prioridad: p })}
                    className={`flex-1 py-2 px-2 rounded-lg border text-xs font-medium transition ${editForm.prioridad === p ? PRIORITY_MAP[p].bg + ' ' + PRIORITY_MAP[p].color : 'bg-background border-border text-muted-foreground/70 hover:border-ring'}`}
                  >
                    {PRIORITY_MAP[p].label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setEditingTicket(null)}
              className="text-muted-foreground hover:text-foreground"
            >
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
  );
}
