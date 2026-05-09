'use client'

import { useState, useTransition } from 'react'
import { Send, Plus, Copy, Check, Power, Trash2, RefreshCw, AlertCircle } from 'lucide-react'
import {
    createOutboundWebhookAction,
    toggleOutboundWebhookAction,
    deleteOutboundWebhookAction,
    rotateOutboundSecretAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions'

type Webhook = {
    id: string
    nombre: string
    url: string
    event_types: string[]
    enabled: boolean
    last_fired_at: string | null
    last_status: number | null
    last_error: string | null
    success_count: number
    failure_count: number
}

const EVENT_TYPES = [
    { id: 'sale.approved', label: 'Venta aprobada', accent: 'emerald' },
    { id: 'sale.pending', label: 'Venta pendiente', accent: 'amber' },
    { id: 'sale.refunded', label: 'Reembolso', accent: 'red' },
    { id: 'sale.chargeback', label: 'Chargeback', accent: 'red' },
] as const

export function OutboundWebhooksCard({
    clienteId,
    webhooks,
}: {
    clienteId: string
    webhooks: Webhook[]
}) {
    const [pending, startTransition] = useTransition()
    const [showForm, setShowForm] = useState(false)
    const [revealed, setRevealed] = useState<{ id: string; secret: string } | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const onCreate = (formData: FormData) => {
        setError(null)
        startTransition(async () => {
            const r = await createOutboundWebhookAction(clienteId, formData)
            if (!r.ok) {
                setError(r.error)
            } else {
                setShowForm(false)
                if (r.secret) setRevealed({ id: 'new', secret: r.secret })
            }
        })
    }

    const onToggle = (id: string, enabled: boolean) => {
        startTransition(async () => {
            await toggleOutboundWebhookAction(id, clienteId, enabled)
        })
    }

    const onDelete = (id: string, nombre: string) => {
        if (!confirm(`¿Eliminar webhook "${nombre}"? El secret se invalida y no se podrá restaurar.`)) return
        startTransition(async () => {
            await deleteOutboundWebhookAction(id, clienteId)
        })
    }

    const onRotate = (id: string) => {
        if (!confirm('¿Rotar secret? El antiguo deja de funcionar inmediatamente.')) return
        startTransition(async () => {
            const r = await rotateOutboundSecretAction(id, clienteId)
            if (r.ok && r.secret) setRevealed({ id, secret: r.secret })
        })
    }

    const copy = async (s: string) => {
        try {
            await navigator.clipboard.writeText(s)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {}
    }

    return (
        <div className="rounded-2xl border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950/50 p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-violet-50 dark:bg-violet-500/10">
                        <Send className="h-5 w-5 text-violet-600 dark:text-violet-400" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                            Outbound webhooks
                        </h3>
                        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-0.5">
                            Notificá a sistemas del cliente cuando entran ventas. Firmados con HMAC-SHA256.
                        </p>
                    </div>
                </div>
                <button
                    onClick={() => {
                        setShowForm(!showForm)
                        setRevealed(null)
                        setError(null)
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-500/10 hover:bg-violet-100 dark:hover:bg-violet-500/20 transition-colors"
                >
                    <Plus className="h-3.5 w-3.5" />
                    Agregar
                </button>
            </div>

            {revealed && (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-2">
                        Secret · guardalo ahora
                    </p>
                    <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-500/20 bg-white dark:bg-zinc-950 px-3 py-2">
                        <code className="flex-1 text-xs font-mono text-zinc-700 dark:text-zinc-300 truncate">
                            {revealed.secret}
                        </code>
                        <button
                            type="button"
                            onClick={() => copy(revealed.secret)}
                            className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-white/[0.06]"
                        >
                            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                    </div>
                    <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-400">
                        El receptor debe verificar HMAC-SHA256 del body con este secret.
                        Header: <code className="font-mono px-1 py-0.5 rounded bg-white/50 dark:bg-white/[0.04]">X-Rutm-Signature</code>
                    </p>
                </div>
            )}

            {showForm && (
                <form
                    action={(fd) => onCreate(fd)}
                    className="rounded-lg border border-zinc-200 dark:border-white/[0.06] bg-zinc-50/50 dark:bg-white/[0.02] p-4 space-y-3"
                >
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <Field label="Nombre" required>
                            <input name="nombre" required placeholder="Mi CRM" className={INPUT_CLASS} />
                        </Field>
                        <Field label="URL" required>
                            <input
                                name="url"
                                type="url"
                                required
                                placeholder="https://example.com/webhooks/rutm"
                                className={INPUT_CLASS}
                            />
                        </Field>
                    </div>
                    <Field label="Eventos a enviar" required>
                        <div className="grid grid-cols-2 gap-2">
                            {EVENT_TYPES.map((e) => (
                                <label
                                    key={e.id}
                                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-white/[0.06] bg-white dark:bg-zinc-950 cursor-pointer hover:bg-zinc-50 dark:hover:bg-white/[0.04] transition-colors text-xs"
                                >
                                    <input
                                        type="checkbox"
                                        name="event_types"
                                        value={e.id}
                                        defaultChecked={e.id === 'sale.approved'}
                                        className="rounded text-emerald-500 focus:ring-emerald-500"
                                    />
                                    <span className="font-medium text-zinc-700 dark:text-zinc-300">
                                        {e.label}
                                    </span>
                                    <code className="ml-auto text-[10px] font-mono text-zinc-400">{e.id}</code>
                                </label>
                            ))}
                        </div>
                    </Field>
                    {error && (
                        <p className="text-[11px] text-red-600 dark:text-red-400 flex items-center gap-1.5">
                            <AlertCircle className="h-3.5 w-3.5" />
                            {error}
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={() => setShowForm(false)}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/[0.04]"
                        >
                            Cancelar
                        </button>
                        <button
                            type="submit"
                            disabled={pending}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-white shadow-sm disabled:opacity-50"
                            style={{ background: 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 100%)' }}
                        >
                            {pending ? 'Creando…' : 'Crear webhook'}
                        </button>
                    </div>
                </form>
            )}

            {webhooks.length === 0 ? (
                <p className="text-xs text-zinc-500 dark:text-zinc-500 text-center py-4">
                    Sin webhooks salientes configurados.
                </p>
            ) : (
                <div className="space-y-2">
                    {webhooks.map((w) => (
                        <div
                            key={w.id}
                            className={`rounded-lg border border-zinc-200 dark:border-white/[0.06] bg-zinc-50/30 dark:bg-white/[0.02] p-3 ${
                                !w.enabled ? 'opacity-60' : ''
                            }`}
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                                            {w.nombre}
                                        </p>
                                        <span
                                            className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                                                w.enabled
                                                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                                                    : 'bg-zinc-100 text-zinc-600 dark:bg-white/[0.06] dark:text-zinc-400'
                                            }`}
                                        >
                                            {w.enabled ? 'activo' : 'pausado'}
                                        </span>
                                    </div>
                                    <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-500 mt-0.5 truncate">
                                        {w.url}
                                    </p>
                                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                                        {w.event_types.map((t) => (
                                            <span
                                                key={t}
                                                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400"
                                            >
                                                {t}
                                            </span>
                                        ))}
                                    </div>
                                    <div className="flex items-center gap-3 mt-2 text-[10px] text-zinc-500 dark:text-zinc-500">
                                        <span className="text-emerald-600 dark:text-emerald-400">
                                            ✓ {w.success_count}
                                        </span>
                                        <span className="text-red-600 dark:text-red-400">
                                            ✗ {w.failure_count}
                                        </span>
                                        {w.last_fired_at && (
                                            <span>
                                                último: {new Date(w.last_fired_at).toLocaleString()}
                                                {w.last_status ? ` · HTTP ${w.last_status}` : ''}
                                            </span>
                                        )}
                                    </div>
                                    {w.last_error && (
                                        <p className="text-[10px] text-red-600 dark:text-red-400 mt-1 font-mono truncate">
                                            ⚠ {w.last_error}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => onRotate(w.id)}
                                        disabled={pending}
                                        className="p-1.5 rounded text-zinc-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-zinc-100 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
                                        title="Rotar secret"
                                    >
                                        <RefreshCw className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        onClick={() => onToggle(w.id, !w.enabled)}
                                        disabled={pending}
                                        className="p-1.5 rounded text-zinc-400 hover:text-amber-600 dark:hover:text-amber-400 hover:bg-zinc-100 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
                                        title={w.enabled ? 'Pausar' : 'Activar'}
                                    >
                                        <Power className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                        onClick={() => onDelete(w.id, w.nombre)}
                                        disabled={pending}
                                        className="p-1.5 rounded text-zinc-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-zinc-100 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
                                        title="Eliminar"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

const INPUT_CLASS =
    'w-full px-3 py-2 text-sm rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-white/[0.06] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40 transition-colors'

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
    return (
        <label className="block">
            <span className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-400 mb-1">
                {label}
                {required && <span className="text-red-500"> *</span>}
            </span>
            {children}
        </label>
    )
}
