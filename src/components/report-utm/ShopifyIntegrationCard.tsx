'use client'

import { useState, useTransition } from 'react'
import { RefreshCw, Power, KeyRound, Webhook } from 'lucide-react'
import {
    activateShopifyIntegrationAction,
    rotateShopifySecretAction,
    setShopifyIntegrationStatusAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions'
import { CopyField, useCopyHandler } from './CopyField'
import { FeedbackLine, LastErrorAlert } from './FeedbackLine'
import { IntegrationStatusBadge } from './StatusBadge'
import { formatDateTime } from '@/lib/report-utm/formatters'

const ACCENT = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
const ICON_BG = 'bg-emerald-50 dark:bg-emerald-500/10'
const ICON_COLOR = 'text-emerald-600 dark:text-emerald-400'

type Integration = {
    id: string
    cliente_id: string
    webhook_secret: string | null
    config: Record<string, unknown>
    status: 'active' | 'inactive' | 'error'
    last_sync_at: string | null
    last_error: string | null
} | null

export function ShopifyIntegrationCard({
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
    const [shopDomain, setShopDomain] = useState(
        String(integration?.config?.shop_domain ?? ''),
    )
    const [error, setError] = useState<string | null>(null)
    const [copiedUrl, setCopiedUrl] = useState(false)
    const [copiedSecret, setCopiedSecret] = useState(false)

    const webhookUrl = `${webhookOrigin}/api/report-utm/webhooks/shopify/${clienteId}`
    const copyUrl = useCopyHandler(setCopiedUrl)
    const copySecret = useCopyHandler(setCopiedSecret)

    const onActivate = () => {
        if (!shopDomain.trim()) { setError('Ingresá el Shop Domain primero'); return }
        setError(null)
        startTransition(async () => {
            const r = await activateShopifyIntegrationAction(clienteId, shopDomain.trim())
            if (!r.ok) setError(r.error)
            else if (r.secret) setRevealedSecret(r.secret)
        })
    }

    const onRotate = () => {
        if (!confirm('¿Rotar el webhook secret? El antiguo dejará de funcionar inmediatamente.')) return
        setError(null)
        startTransition(async () => {
            const r = await rotateShopifySecretAction(clienteId)
            if (!r.ok) setError(r.error)
            else if (r.secret) setRevealedSecret(r.secret)
        })
    }

    const onToggle = () => {
        if (!integration) return
        const next = integration.status === 'active' ? 'inactive' : 'active'
        setError(null)
        startTransition(async () => {
            const r = await setShopifyIntegrationStatusAction(clienteId, next)
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
                        <h3 className="text-sm font-semibold text-foreground">Shopify · Webhook</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Recibí eventos{' '}
                            <code className="font-mono text-xs">orders/paid</code>{' '}
                            de tu tienda Shopify con atribución multi-touch.
                        </p>
                        <div className="mt-4 space-y-3">
                            <label className="block">
                                <span className="block text-xs font-medium text-muted-foreground mb-1">
                                    Shop Domain
                                </span>
                                <input
                                    type="text"
                                    value={shopDomain}
                                    onChange={(e) => setShopDomain(e.target.value)}
                                    placeholder="mi-tienda.myshopify.com"
                                    className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 font-mono"
                                />
                            </label>
                            <button
                                onClick={onActivate}
                                disabled={pending || !shopDomain.trim()}
                                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-50"
                            >
                                <KeyRound className="h-3.5 w-3.5" />
                                {pending ? 'Activando…' : 'Activar integración Shopify'}
                            </button>
                        </div>
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
                        <h3 className="text-sm font-semibold text-foreground">Shopify · Webhook</h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {!!integration.config?.shop_domain && (
                                <span className="font-mono">{String(integration.config.shop_domain)} · </span>
                            )}
                            {integration.last_sync_at
                                ? `Última orden: ${formatDateTime(integration.last_sync_at)}`
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
                <div className="rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50/40 dark:bg-emerald-500/5 p-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-2">
                        Webhook secret · guardalo ahora
                    </p>
                    <CopyField
                        value={revealedSecret}
                        onCopy={() => copySecret(revealedSecret)}
                        copied={copiedSecret}
                    />
                    <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
                        Solo se muestra una vez. En Shopify Admin → Settings → Notifications → Webhooks,
                        pegá este secret y la URL de arriba.
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
                            : 'border-emerald-200 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-500/10'
                    }`}
                >
                    <Power className="h-3.5 w-3.5" />
                    {isActive ? 'Pausar' : 'Reactivar'}
                </button>
            </div>

            {error && <FeedbackLine variant="error" message={error} />}

            <div className="text-xs text-muted-foreground space-y-1 pt-1">
                <p>
                    Topic recomendado:{' '}
                    <code className="font-mono px-1 py-0.5 rounded bg-muted">orders/paid</code>.
                    La firma de Shopify es HMAC-SHA256 en Base64 (diferente a Hotmart/CartPanda).
                </p>
                <p>
                    UTMs leídos de{' '}
                    <code className="font-mono px-1 py-0.5 rounded bg-muted">note_attributes</code>{' '}
                    y del campo{' '}
                    <code className="font-mono px-1 py-0.5 rounded bg-muted">landing_site</code>{' '}
                    como fallback.
                </p>
            </div>
        </div>
    )
}
