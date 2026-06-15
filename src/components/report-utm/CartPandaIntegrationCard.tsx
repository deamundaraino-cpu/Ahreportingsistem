'use client'

import { useState, useTransition } from 'react'
import { RefreshCw, Power, KeyRound, Webhook } from 'lucide-react'
import {
    activateCartPandaIntegrationAction,
    rotateCartPandaSecretAction,
    setCartPandaIntegrationStatusAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions'
import { CopyField, useCopyHandler } from './CopyField'
import { FeedbackLine, LastErrorAlert } from './FeedbackLine'
import { IntegrationStatusBadge } from './StatusBadge'
import { formatDateTime } from '@/lib/report-utm/formatters'

const ACCENT = 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-400'
const ICON_BG = 'bg-indigo-50 dark:bg-indigo-500/10'
const ICON_COLOR = 'text-indigo-600 dark:text-indigo-400'

type Integration = {
    id: string
    cliente_id: string
    webhook_secret: string | null
    status: 'active' | 'inactive' | 'error'
    last_sync_at: string | null
    last_error: string | null
} | null

export function CartPandaIntegrationCard({
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
    const [copiedUrl, setCopiedUrl] = useState(false)
    const [copiedSecret, setCopiedSecret] = useState(false)

    const webhookUrl = `${webhookOrigin}/api/report-utm/webhooks/cartpanda/${clienteId}`
    const copyUrl = useCopyHandler(setCopiedUrl)
    const copySecret = useCopyHandler(setCopiedSecret)

    const onActivate = () => {
        setError(null)
        startTransition(async () => {
            const r = await activateCartPandaIntegrationAction(clienteId)
            if (!r.ok) setError(r.error)
            else if (r.secret) setRevealedSecret(r.secret)
        })
    }

    const onRotate = () => {
        if (!confirm('¿Rotar el webhook secret? El antiguo dejará de funcionar inmediatamente.')) return
        setError(null)
        startTransition(async () => {
            const r = await rotateCartPandaSecretAction(clienteId)
            if (!r.ok) setError(r.error)
            else if (r.secret) setRevealedSecret(r.secret)
        })
    }

    const onToggle = () => {
        if (!integration) return
        const next = integration.status === 'active' ? 'inactive' : 'active'
        setError(null)
        startTransition(async () => {
            const r = await setCartPandaIntegrationStatusAction(clienteId, next)
            if (!r.ok) setError(r.error)
        })
    }

    if (!integration) {
        return (
            <div className="rounded-2xl border border-border bg-card p-6">
                <div className="flex items-start gap-3">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
                        <Webhook className={`h-5 w-5 ${ICON_COLOR}`} />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-sm font-semibold text-foreground">CartPanda · Webhook</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Activá para generar un webhook secret y la URL para configurar en CartPanda.
                        </p>
                        <button
                            onClick={onActivate}
                            disabled={pending}
                            className="mt-4 inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-50"
                        >
                            <KeyRound className="h-3.5 w-3.5" />
                            {pending ? 'Activando…' : 'Activar integración CartPanda'}
                        </button>
                        {error && <FeedbackLine variant="error" message={error} />}
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
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
                        <Webhook className={`h-5 w-5 ${ICON_COLOR}`} />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-foreground">CartPanda · Webhook</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {integration.last_sync_at
                                ? `Última venta: ${formatDateTime(integration.last_sync_at)}`
                                : 'Sin eventos recibidos todavía'}
                        </p>
                    </div>
                </div>
                <IntegrationStatusBadge status={integration.status} activeCls={ACCENT} />
            </div>

            {integration.last_error && <LastErrorAlert message={integration.last_error} />}

            <CopyField
                label="Webhook URL"
                value={webhookUrl}
                onCopy={() => copyUrl(webhookUrl)}
                copied={copiedUrl}
            />

            {revealedSecret ? (
                <div className="rounded-lg border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50/40 dark:bg-indigo-500/5 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-400 mb-2">
                        Webhook secret · guardalo ahora
                    </p>
                    <CopyField
                        value={revealedSecret}
                        onCopy={() => copySecret(revealedSecret)}
                        copied={copiedSecret}
                    />
                    <p className="mt-2 text-xs text-indigo-700 dark:text-indigo-400">
                        Solo se muestra una vez. Configuralo en CartPanda → Configurações → Webhooks.
                    </p>
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    El secret está guardado y nunca se muestra. Si lo perdiste, rotalo.
                </p>
            )}

            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                <button
                    onClick={onRotate}
                    disabled={pending}
                    aria-label="Rotar webhook secret"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                               text-foreground/90 border border-border hover:bg-accent
                               disabled:opacity-50 transition-colors"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Rotar secret
                </button>
                <button
                    onClick={onToggle}
                    disabled={pending}
                    aria-label={isActive ? 'Pausar integración' : 'Reactivar integración'}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                                border transition-colors disabled:opacity-50 ${
                        isActive
                            ? 'border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
                            : 'border-indigo-200 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-500/10'
                    }`}
                >
                    <Power className="h-3.5 w-3.5" />
                    {isActive ? 'Pausar' : 'Reactivar'}
                </button>
            </div>

            {error && <FeedbackLine variant="error" message={error} />}
        </div>
    )
}
