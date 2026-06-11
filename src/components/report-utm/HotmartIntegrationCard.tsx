'use client'

import { useState, useTransition } from 'react'
import { Copy, Check, RefreshCw, Power, KeyRound, AlertCircle, Webhook } from 'lucide-react'
import {
    activateHotmartIntegrationAction,
    rotateHotmartSecretAction,
    setHotmartIntegrationStatusAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions'

type Integration = {
    id: string
    cliente_id: string
    webhook_secret: string | null
    status: 'active' | 'inactive' | 'error'
    last_sync_at: string | null
    last_error: string | null
} | null

export function HotmartIntegrationCard({
    clienteId,
    integration,
    webhookOrigin,
}: {
    clienteId: string
    integration: Integration
    webhookOrigin: string
}) {
    const [pending, startTransition] = useTransition()
    const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [copied, setCopied] = useState<'url' | 'secret' | null>(null)

    const webhookUrl = `${webhookOrigin}/api/report-utm/webhooks/hotmart/${clienteId}`

    const onActivate = () => {
        setError(null)
        startTransition(async () => {
            const r = await activateHotmartIntegrationAction(clienteId)
            if (!r.ok) setError(r.error)
            else if (r.secret) setRevealedSecret(r.secret)
        })
    }

    const onRotate = () => {
        if (!confirm('¿Rotar el webhook secret? El antiguo dejará de funcionar inmediatamente.')) return
        setError(null)
        startTransition(async () => {
            const r = await rotateHotmartSecretAction(clienteId)
            if (!r.ok) setError(r.error)
            else if (r.secret) setRevealedSecret(r.secret)
        })
    }

    const onToggle = () => {
        if (!integration) return
        const next = integration.status === 'active' ? 'inactive' : 'active'
        setError(null)
        startTransition(async () => {
            const r = await setHotmartIntegrationStatusAction(clienteId, next)
            if (!r.ok) setError(r.error)
        })
    }

    const copy = async (value: string, kind: 'url' | 'secret') => {
        try {
            await navigator.clipboard.writeText(value)
            setCopied(kind)
            setTimeout(() => setCopied(null), 1500)
        } catch {
            /* ignore */
        }
    }

    if (!integration) {
        return (
            <div className="rounded-2xl border border-border bg-card p-6">
                <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                        <Webhook className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-sm font-semibold text-foreground">
                            Hotmart · Webhook
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Activá para generar un webhook secret y la URL para configurar en Hotmart.
                        </p>
                        <button
                            onClick={onActivate}
                            disabled={pending}
                            className="mt-4 inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm nav-active-emerald transition-opacity disabled:opacity-50"
                        >
                            <KeyRound className="h-3.5 w-3.5" />
                            {pending ? 'Activando…' : 'Activar integración Hotmart'}
                        </button>
                        {error && <ErrorLine msg={error} />}
                    </div>
                </div>
            </div>
        )
    }

    const isActive = integration.status === 'active'

    return (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-emerald-50 dark:bg-emerald-500/10">
                        <Webhook className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-foreground">
                            Hotmart · Webhook
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {integration.last_sync_at
                                ? `Última venta: ${new Date(integration.last_sync_at).toLocaleString()}`
                                : 'Sin eventos recibidos todavía'}
                        </p>
                    </div>
                </div>
                <span
                    className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${
                        isActive
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                            : 'bg-muted text-muted-foreground'
                    }`}
                >
                    {integration.status}
                </span>
            </div>

            {integration.last_error && (
                <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2">
                    <p className="text-[11px] font-mono text-amber-800 dark:text-amber-300 flex items-start gap-2">
                        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                        <span>Último error: {integration.last_error}</span>
                    </p>
                </div>
            )}

            {/* Webhook URL */}
            <Field
                label="Webhook URL"
                value={webhookUrl}
                onCopy={() => copy(webhookUrl, 'url')}
                copied={copied === 'url'}
            />

            {/* Secret revelado solo una vez */}
            {revealedSecret ? (
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-2">
                        Webhook secret · guardalo ahora
                    </p>
                    <Field
                        label=""
                        value={revealedSecret}
                        onCopy={() => copy(revealedSecret, 'secret')}
                        copied={copied === 'secret'}
                        mono
                    />
                    <p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-400">
                        Solo se muestra una vez. Configuralo en Hotmart como
                        <code className="mx-1 px-1 py-0.5 rounded bg-card/50">hottok</code>
                        o usalo como secret HMAC.
                    </p>
                </div>
            ) : (
                <p className="text-[11px] text-muted-foreground">
                    El secret está guardado y nunca se muestra después de activar. Si lo perdiste, rotalo.
                </p>
            )}

            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                <button
                    onClick={onRotate}
                    disabled={pending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                               text-foreground/90
                               border border-border
                               hover:bg-accent
                               disabled:opacity-50 transition-colors"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Rotar secret
                </button>
                <button
                    onClick={onToggle}
                    disabled={pending}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                                border transition-colors disabled:opacity-50 ${
                        isActive
                            ? 'border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
                            : 'border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10'
                    }`}
                >
                    <Power className="h-3.5 w-3.5" />
                    {isActive ? 'Pausar' : 'Reactivar'}
                </button>
            </div>

            {error && <ErrorLine msg={error} />}
        </div>
    )
}

function Field({
    label,
    value,
    onCopy,
    copied,
    mono,
}: {
    label: string
    value: string
    onCopy: () => void
    copied: boolean
    mono?: boolean
}) {
    return (
        <div>
            {label && (
                <p className="text-[11px] font-medium text-muted-foreground mb-1">{label}</p>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
                <code
                    className={`flex-1 text-xs ${
                        mono ? 'font-mono' : ''
                    } text-foreground/90 truncate`}
                >
                    {value}
                </code>
                <button
                    type="button"
                    onClick={onCopy}
                    className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                    {copied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                        <Copy className="h-3.5 w-3.5" />
                    )}
                </button>
            </div>
        </div>
    )
}

function ErrorLine({ msg }: { msg: string }) {
    return (
        <p className="mt-3 text-[11px] text-red-600 dark:text-red-400 flex items-center gap-1.5">
            <AlertCircle className="h-3.5 w-3.5" />
            {msg}
        </p>
    )
}
