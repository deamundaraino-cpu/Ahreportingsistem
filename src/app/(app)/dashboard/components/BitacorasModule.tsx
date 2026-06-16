'use client'

import { useState, useEffect, useTransition } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Pencil, Trash2, Loader2, Lock, Users, Globe, BookOpen } from 'lucide-react'
import { createClient } from '@/utils/supabase/client'
import { getBitacoras, createBitacora, updateBitacora, deleteBitacora } from '../../admin/settings/[id]/_actions'
import type { Bitacora, BitacoraVisibilidad } from '../../admin/settings/[id]/_actions'

const VISIBILITY_CONFIG = {
    privado: {
        label: 'Solo agencia',
        icon: Lock,
        className: 'bg-muted text-muted-foreground',
    },
    trafficker: {
        label: 'Equipo',
        icon: Users,
        className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    },
    publico: {
        label: 'Público',
        icon: Globe,
        className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    },
} as const

function VisibilidadBadge({ v }: { v: BitacoraVisibilidad }) {
    const cfg = VISIBILITY_CONFIG[v]
    const Icon = cfg.icon
    return (
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${cfg.className}`}>
            <Icon className="w-3 h-3" />
            {cfg.label}
        </span>
    )
}

function BitacoraDialog({
    clientId,
    userRole,
    entry,
    open,
    onOpenChange,
    onDone,
}: {
    clientId: string
    userRole: string
    entry?: Bitacora
    open: boolean
    onOpenChange: (v: boolean) => void
    onDone: () => void
}) {
    const [titulo, setTitulo] = useState(entry?.titulo ?? '')
    const [contenido, setContenido] = useState(entry?.contenido ?? '')
    const [visibilidad, setVisibilidad] = useState<BitacoraVisibilidad>(entry?.visibilidad ?? 'trafficker')
    const [error, setError] = useState<string | null>(null)
    const [isPending, startTransition] = useTransition()

    const canSelectPrivado = userRole === 'admin' || userRole === 'superadmin'

    const handleSubmit = () => {
        if (!titulo.trim() || !contenido.trim()) {
            setError('El título y el contenido son obligatorios')
            return
        }
        setError(null)
        startTransition(async () => {
            const res = entry
                ? await updateBitacora(entry.id, clientId, titulo.trim(), contenido.trim(), visibilidad)
                : await createBitacora(clientId, titulo.trim(), contenido.trim(), visibilidad)
            if (res.error) {
                setError(res.error)
            } else {
                onOpenChange(false)
                onDone()
            }
        })
    }

    const handleOpenChange = (v: boolean) => {
        if (!v) setError(null)
        onOpenChange(v)
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{entry ? 'Editar entrada' : 'Nueva entrada de bitácora'}</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 pt-2">
                    <div className="space-y-1.5">
                        <Label>Título</Label>
                        <Input
                            placeholder="Ej: Cambio de presupuesto Meta"
                            value={titulo}
                            onChange={(e) => setTitulo(e.target.value)}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Contenido</Label>
                        <textarea
                            placeholder="Describe el cambio, prueba o idea implementada..."
                            value={contenido}
                            onChange={(e) => setContenido(e.target.value)}
                            rows={4}
                            className="w-full rounded-md bg-background border border-input px-3 py-2 text-sm text-foreground resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label>Visibilidad</Label>
                        <Select value={visibilidad} onValueChange={(v) => setVisibilidad(v as BitacoraVisibilidad)}>
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {canSelectPrivado && (
                                    <SelectItem value="privado">
                                        <span className="flex items-center gap-2">
                                            <Lock className="w-3.5 h-3.5" /> Solo agencia (privado)
                                        </span>
                                    </SelectItem>
                                )}
                                <SelectItem value="trafficker">
                                    <span className="flex items-center gap-2">
                                        <Users className="w-3.5 h-3.5" /> Equipo (traffickers + admins)
                                    </span>
                                </SelectItem>
                                <SelectItem value="publico">
                                    <span className="flex items-center gap-2">
                                        <Globe className="w-3.5 h-3.5" /> Público (visible en enlace)
                                    </span>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    {error && <p className="text-sm text-red-500">{error}</p>}
                    <div className="flex justify-end gap-2 pt-1">
                        <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
                            Cancelar
                        </Button>
                        <Button onClick={handleSubmit} disabled={isPending}>
                            {isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                            {entry ? 'Guardar cambios' : 'Crear entrada'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}

export function BitacorasModule({ clientId, userRole }: { clientId: string; userRole: string }) {
    const [entries, setEntries] = useState<Bitacora[]>([])
    const [userId, setUserId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [createOpen, setCreateOpen] = useState(false)
    const [editEntry, setEditEntry] = useState<Bitacora | null>(null)
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [isPending, startTransition] = useTransition()

    const isAdminOrSuper = userRole === 'admin' || userRole === 'superadmin'
    const canEdit = (entry: Bitacora) => isAdminOrSuper || entry.author_id === userId
    const canDelete = (entry: Bitacora) => isAdminOrSuper || entry.author_id === userId

    const load = async () => {
        const [data, { data: { user } }] = await Promise.all([
            getBitacoras(clientId),
            createClient().auth.getUser(),
        ])
        setEntries(data)
        setUserId(user?.id ?? null)
        setLoading(false)
    }

    useEffect(() => { load() }, [clientId])

    const handleDone = () => {
        setLoading(true)
        load()
    }

    const handleDelete = (entry: Bitacora) => {
        if (!confirm(`¿Eliminar la entrada "${entry.titulo}"?`)) return
        setDeletingId(entry.id)
        startTransition(async () => {
            await deleteBitacora(entry.id, clientId)
            setDeletingId(null)
            handleDone()
        })
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
        )
    }

    return (
        <div className="space-y-4 max-w-3xl">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-base font-semibold">Bitácoras</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                        Registro de cambios, pruebas e ideas implementadas para este cliente
                    </p>
                </div>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="w-4 h-4 mr-1" />
                    Nueva entrada
                </Button>
            </div>

            {entries.length === 0 ? (
                <Card>
                    <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
                        <BookOpen className="w-8 h-8 text-muted-foreground/40" />
                        <div>
                            <p className="text-sm font-medium text-muted-foreground">Sin entradas aún</p>
                            <p className="text-xs text-muted-foreground/70 mt-0.5">
                                Crea la primera entrada para registrar cambios o pruebas
                            </p>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <div className="space-y-3">
                    {entries.map((entry) => (
                        <Card key={entry.id} className="group">
                            <CardContent className="p-4">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap mb-1">
                                            <span className="font-medium text-sm">{entry.titulo}</span>
                                            <VisibilidadBadge v={entry.visibilidad} />
                                        </div>
                                        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                                            {entry.contenido}
                                        </p>
                                        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground/70">
                                            {entry.author_name && <span>{entry.author_name}</span>}
                                            {entry.author_name && <span>·</span>}
                                            <span>
                                                {new Date(entry.created_at).toLocaleDateString('es', {
                                                    day: '2-digit',
                                                    month: 'short',
                                                    year: 'numeric',
                                                    hour: '2-digit',
                                                    minute: '2-digit',
                                                })}
                                            </span>
                                            {entry.updated_at !== entry.created_at && (
                                                <span className="italic">(editado)</span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                        {canEdit(entry) && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                                onClick={() => setEditEntry(entry)}
                                            >
                                                <Pencil className="w-3.5 h-3.5" />
                                            </Button>
                                        )}
                                        {canDelete(entry) && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                                                onClick={() => handleDelete(entry)}
                                                disabled={deletingId === entry.id || isPending}
                                            >
                                                {deletingId === entry.id ? (
                                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                ) : (
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                )}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            <BitacoraDialog
                clientId={clientId}
                userRole={userRole}
                open={createOpen}
                onOpenChange={setCreateOpen}
                onDone={handleDone}
            />

            {editEntry && (
                <BitacoraDialog
                    clientId={clientId}
                    userRole={userRole}
                    entry={editEntry}
                    open={!!editEntry}
                    onOpenChange={(v) => { if (!v) setEditEntry(null) }}
                    onDone={handleDone}
                />
            )}
        </div>
    )
}
