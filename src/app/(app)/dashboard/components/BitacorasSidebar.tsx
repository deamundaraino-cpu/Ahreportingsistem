'use client'

import { useState, useEffect, useRef, useTransition, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

const RichTextEditor = dynamic(
    () => import('@/components/editor/RichTextEditor').then(m => ({ default: m.RichTextEditor })),
    { loading: () => <Skeleton className="h-32 rounded-md" />, ssr: false }
)

import {
    BookOpen, X, Plus, Pencil, Trash2, Loader2,
    Lock, Users, Globe, ArrowLeft, CheckCircle2, AlertCircle,
} from 'lucide-react'
import {
    getBitacoras, createBitacora, updateBitacora, deleteBitacora,
} from '../../admin/settings/[id]/_actions'
import type { Bitacora, BitacoraVisibilidad } from '../../admin/settings/[id]/_actions'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

const VISIBILITY_CONFIG = {
    privado:    { label: 'Solo agencia', icon: Lock,  className: 'bg-muted text-muted-foreground' },
    trafficker: { label: 'Equipo',       icon: Users, className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
    publico:    { label: 'Público',      icon: Globe, className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
} as const

function VisibilidadBadge({ v }: { v: BitacoraVisibilidad }) {
    const cfg = VISIBILITY_CONFIG[v]
    const Icon = cfg.icon
    return (
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${cfg.className}`}>
            <Icon className="w-3 h-3" />{cfg.label}
        </span>
    )
}

type AutoSaveState = 'idle' | 'saving' | 'saved' | 'error'

// ─── Main component ───────────────────────────────────────────────────────────

export function BitacorasSidebar({ clientId, userRole, userId: serverUserId, initialEntries = [] }: {
    clientId: string
    userRole: string
    userId: string | null
    initialEntries?: Bitacora[]
}) {
    const [open, setOpen] = useState(false)
    const [view, setView] = useState<'list' | 'editor'>('list')

    // List state
    const [entries, setEntries] = useState<Bitacora[]>(initialEntries)
    const [loading, setLoading] = useState(false)
    const [deletingId, setDeletingId] = useState<string | null>(null)
    const [, startTransition] = useTransition()

    // Editor state
    const [editEntry, setEditEntry] = useState<Bitacora | null>(null) // null = new entry
    const [titulo, setTitulo] = useState('')
    const [contenido, setContenido] = useState('')
    const [visibilidad, setVisibilidad] = useState<BitacoraVisibilidad>('trafficker')
    const [saving, setSaving] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)
    const [autoSaveState, setAutoSaveState] = useState<AutoSaveState>('idle')
    const [hasDraft, setHasDraft] = useState(false)

    const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const autoSaveSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const initialLoadDone = useRef(initialEntries.length > 0)

    const isAdminOrSuper = userRole === 'admin' || userRole === 'superadmin'
    const canSelectPrivado = isAdminOrSuper
    const canEdit = (e: Bitacora) => isAdminOrSuper || e.author_id === serverUserId
    const canDelete = (e: Bitacora) => isAdminOrSuper || e.author_id === serverUserId
    const isNewEntry = editEntry === null

    const DRAFT_KEY = `bitacora_draft_${clientId}`

    // ── Load entries + user ──────────────────────────────────────────────────

    const loadEntries = useCallback(async () => {
        setLoading(true)
        try {
            const data = await getBitacoras(clientId)
            setEntries(data)
        } catch (err) {
            console.error('Error cargando bitácoras:', err)
        } finally {
            setLoading(false)
        }
    }, [clientId])

    useEffect(() => {
        if (open && !initialLoadDone.current) {
            initialLoadDone.current = true
            loadEntries()
        }
    }, [open, loadEntries])

    // ── Draft persistence ────────────────────────────────────────────────────

    const saveDraft = useCallback((t: string, c: string, v: BitacoraVisibilidad) => {
        if (t || c !== '<p></p>') {
            localStorage.setItem(DRAFT_KEY, JSON.stringify({ titulo: t, contenido: c, visibilidad: v }))
            setHasDraft(true)
        }
    }, [DRAFT_KEY])

    const clearDraft = useCallback(() => {
        localStorage.removeItem(DRAFT_KEY)
        setHasDraft(false)
    }, [DRAFT_KEY])

    const openEditorForNew = useCallback(() => {
        setEditEntry(null)
        const raw = localStorage.getItem(DRAFT_KEY)
        if (raw) {
            try {
                const d = JSON.parse(raw)
                setTitulo(d.titulo ?? '')
                setContenido(d.contenido ?? '')
                setVisibilidad(d.visibilidad ?? 'trafficker')
                setHasDraft(true)
            } catch {
                setTitulo(''); setContenido(''); setVisibilidad('trafficker'); setHasDraft(false)
            }
        } else {
            setTitulo(''); setContenido(''); setVisibilidad('trafficker'); setHasDraft(false)
        }
        setSaveError(null)
        setAutoSaveState('idle')
        setView('editor')
    }, [DRAFT_KEY])

    const openEditorForEdit = useCallback((entry: Bitacora) => {
        setEditEntry(entry)
        setTitulo(entry.titulo)
        setContenido(entry.contenido)
        setVisibilidad(entry.visibilidad)
        setHasDraft(false)
        setSaveError(null)
        setAutoSaveState('idle')
        setView('editor')
    }, [])

    // ── Auto-save (edit mode only) ───────────────────────────────────────────

    const triggerAutoSave = useCallback((t: string, c: string, v: BitacoraVisibilidad, entryId: string) => {
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
        if (autoSaveSavedTimer.current) clearTimeout(autoSaveSavedTimer.current)
        setAutoSaveState('saving')
        autoSaveTimer.current = setTimeout(async () => {
            const res = await updateBitacora(entryId, clientId, t, c, v)
            if (res.error) {
                setAutoSaveState('error')
            } else {
                setAutoSaveState('saved')
                autoSaveSavedTimer.current = setTimeout(() => setAutoSaveState('idle'), 2500)
                setEntries(prev => prev.map(e => e.id === entryId ? { ...e, titulo: t, contenido: c, visibilidad: v, updated_at: new Date().toISOString() } : e))
            }
        }, 2000)
    }, [clientId])

    // Fires when any field changes
    const handleFieldChange = useCallback((t: string, c: string, v: BitacoraVisibilidad) => {
        setTitulo(t); setContenido(c); setVisibilidad(v)
        if (isNewEntry) {
            saveDraft(t, c, v)
        } else if (editEntry) {
            triggerAutoSave(t, c, v, editEntry.id)
        }
    }, [isNewEntry, editEntry, saveDraft, triggerAutoSave])

    // ── Save new entry ───────────────────────────────────────────────────────

    const handleCreate = async () => {
        if (!titulo.trim()) { setSaveError('El título es obligatorio'); return }
        setSaving(true); setSaveError(null)
        const res = await createBitacora(clientId, titulo.trim(), contenido, visibilidad)
        setSaving(false)
        if (res.error) { setSaveError(res.error); return }
        clearDraft()
        await loadEntries()
        setView('list')
    }

    // ── Delete ───────────────────────────────────────────────────────────────

    const handleDelete = (entry: Bitacora) => {
        if (!confirm(`¿Eliminar "${entry.titulo}"?`)) return
        setDeletingId(entry.id)
        startTransition(async () => {
            await deleteBitacora(entry.id, clientId)
            setDeletingId(null)
            setEntries(prev => prev.filter(e => e.id !== entry.id))
        })
    }

    // ── Cancel editor ────────────────────────────────────────────────────────

    const handleCancel = () => {
        if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
        setView('list')
    }

    // ─── Render ──────────────────────────────────────────────────────────────

    return (
        <>
            {/* Toggle button */}
            <button
                onClick={() => setOpen(o => !o)}
                className="fixed bottom-6 right-6 z-40 flex items-center gap-2 bg-card border border-border shadow-lg rounded-full px-4 py-2.5 text-sm font-medium text-foreground hover:bg-accent transition-colors"
            >
                <BookOpen className="w-4 h-4" />
                Bitácoras
            </button>

            {/* Backdrop */}
            {open && (
                <div
                    className="fixed inset-0 bg-black/20 z-40"
                    onClick={() => setOpen(false)}
                />
            )}

            {/* Side panel */}
            <div
                className={`fixed right-0 top-0 h-full w-[480px] max-w-[95vw] bg-background border-l border-border shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-in-out ${open ? 'translate-x-0' : 'translate-x-full'}`}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                    <div className="flex items-center gap-2">
                        {view === 'editor' && (
                            <button
                                onClick={handleCancel}
                                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            >
                                <ArrowLeft className="w-4 h-4" />
                            </button>
                        )}
                        <BookOpen className="w-4 h-4 text-muted-foreground" />
                        <span className="font-semibold text-sm">
                            {view === 'editor' ? (isNewEntry ? 'Nueva entrada' : 'Editar entrada') : 'Bitácoras'}
                        </span>
                        {/* Auto-save indicator */}
                        {view === 'editor' && !isNewEntry && (
                            <span className="ml-2 flex items-center gap-1 text-xs text-muted-foreground">
                                {autoSaveState === 'saving' && <><Loader2 className="w-3 h-3 animate-spin" /> Guardando</>}
                                {autoSaveState === 'saved'  && <><CheckCircle2 className="w-3 h-3 text-emerald-500" /> Guardado</>}
                                {autoSaveState === 'error'  && <><AlertCircle className="w-3 h-3 text-red-500" /> Error</>}
                            </span>
                        )}
                    </div>
                    <button
                        onClick={() => setOpen(false)}
                        className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* ── LIST VIEW ─────────────────────────────────────────── */}
                {view === 'list' && (
                    <div className="flex flex-col flex-1 overflow-hidden">
                        <div className="px-4 pt-3 pb-2 shrink-0">
                            <Button size="sm" className="w-full" onClick={openEditorForNew}>
                                <Plus className="w-4 h-4 mr-1" /> Nueva entrada
                            </Button>
                        </div>

                        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2.5">
                            {loading ? (
                                <div className="flex justify-center py-12">
                                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                                </div>
                            ) : entries.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
                                    <BookOpen className="w-8 h-8 text-muted-foreground/30" />
                                    <p className="text-sm text-muted-foreground">Sin entradas aún</p>
                                    <p className="text-xs text-muted-foreground/60">Crea la primera para registrar cambios o ideas</p>
                                </div>
                            ) : (
                                entries.map(entry => (
                                    <div key={entry.id} className="group border border-border rounded-lg p-3 bg-card hover:border-muted-foreground/30 transition-colors">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex-1 min-w-0 cursor-pointer" onClick={() => openEditorForEdit(entry)}>
                                                <div className="flex items-center gap-2 flex-wrap mb-1">
                                                    <span className="font-medium text-sm truncate">{entry.titulo}</span>
                                                    <VisibilidadBadge v={entry.visibilidad} />
                                                </div>
                                                <p className="text-xs text-muted-foreground line-clamp-2">
                                                    {stripHtml(entry.contenido)}
                                                </p>
                                                <div className="flex items-center gap-1.5 mt-1.5 text-xs text-muted-foreground/60">
                                                    {entry.author_name && <span>{entry.author_name} ·</span>}
                                                    <span>
                                                        {new Date(entry.created_at).toLocaleDateString('es', {
                                                            day: '2-digit', month: 'short', year: 'numeric',
                                                        })}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                                {canEdit(entry) && (
                                                    <button
                                                        onClick={() => openEditorForEdit(entry)}
                                                        className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                                    >
                                                        <Pencil className="w-3.5 h-3.5" />
                                                    </button>
                                                )}
                                                {canDelete(entry) && (
                                                    <button
                                                        onClick={() => handleDelete(entry)}
                                                        disabled={deletingId === entry.id}
                                                        className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-red-600 dark:hover:text-red-400 transition-colors disabled:opacity-50"
                                                    >
                                                        {deletingId === entry.id
                                                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            : <Trash2 className="w-3.5 h-3.5" />
                                                        }
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                )}

                {/* ── EDITOR VIEW ───────────────────────────────────────── */}
                {view === 'editor' && (
                    <div className="flex flex-col flex-1 overflow-hidden">
                        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
                            {/* Draft recovery banner */}
                            {isNewEntry && hasDraft && (
                                <div className="flex items-center justify-between gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                                    <span>Borrador recuperado</span>
                                    <button
                                        onClick={() => { clearDraft(); setTitulo(''); setContenido(''); }}
                                        className="underline hover:no-underline"
                                    >
                                        Descartar
                                    </button>
                                </div>
                            )}

                            {/* Title */}
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Título</Label>
                                <Input
                                    placeholder="Ej: Cambio de presupuesto Meta"
                                    value={titulo}
                                    onChange={(e) => handleFieldChange(e.target.value, contenido, visibilidad)}
                                />
                            </div>

                            {/* Visibility */}
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Visibilidad</Label>
                                <Select value={visibilidad} onValueChange={(v) => handleFieldChange(titulo, contenido, v as BitacoraVisibilidad)}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {canSelectPrivado && (
                                            <SelectItem value="privado">
                                                <span className="flex items-center gap-2"><Lock className="w-3.5 h-3.5" /> Solo agencia (privado)</span>
                                            </SelectItem>
                                        )}
                                        <SelectItem value="trafficker">
                                            <span className="flex items-center gap-2"><Users className="w-3.5 h-3.5" /> Equipo (traffickers + admins)</span>
                                        </SelectItem>
                                        <SelectItem value="publico">
                                            <span className="flex items-center gap-2"><Globe className="w-3.5 h-3.5" /> Público (visible en enlace)</span>
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Rich text editor */}
                            <div className="space-y-1">
                                <Label className="text-xs text-muted-foreground">Contenido</Label>
                                <RichTextEditor
                                    content={contenido}
                                    onChange={(html) => handleFieldChange(titulo, html, visibilidad)}
                                    placeholder="Describe el cambio, prueba o idea implementada..."
                                    clientId={clientId}
                                />
                            </div>

                            {saveError && (
                                <p className="text-xs text-red-500 flex items-center gap-1">
                                    <AlertCircle className="w-3.5 h-3.5" />{saveError}
                                </p>
                            )}
                        </div>

                        {/* Footer actions — only for new entries */}
                        {isNewEntry && (
                            <div className="flex items-center gap-2 px-4 py-3 border-t border-border shrink-0">
                                <Button variant="outline" size="sm" onClick={handleCancel} disabled={saving} className="flex-1">
                                    Cancelar
                                </Button>
                                <Button size="sm" onClick={handleCreate} disabled={saving} className="flex-1">
                                    {saving && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                                    Crear entrada
                                </Button>
                            </div>
                        )}

                        {/* For edit mode: auto-save handles it, but show a "done" back button */}
                        {!isNewEntry && (
                            <div className="px-4 py-3 border-t border-border shrink-0">
                                <Button variant="outline" size="sm" className="w-full" onClick={handleCancel}>
                                    ← Volver a la lista
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </>
    )
}
