'use client'

import { useState, useTransition } from 'react'
import { RefreshCw, Power, Megaphone, AlertTriangle } from 'lucide-react'
import {
    activateMetaLeadsAction,
    setMetaLeadsStatusAction,
    syncMetaLeadsNowAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions'
import { FeedbackLine, LastErrorAlert } from './FeedbackLine'
import { IntegrationStatusBadge } from './StatusBadge'

const ACCENT = 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400'
const ICON_BG = 'bg-sky-50 dark:bg-sky-500/10'
const ICON_COLOR = 'text-sky-600 dark:text-sky-400'

type Integration = {
    id: string
    status: 'active' | 'inactive' | 'error'
    config: Record<string, unknown>
    last_sync_at: string | null
    last_error: string | null
} | null

export function MetaLeadsCard({
    clienteId,
    integration,
    metaConnected,
}: {
    clienteId: string
    integration: Integration
    metaConnected: boolean
}) {
    const [pending, startTransition] = useTransition()
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    const onActivate = () => {
        setError(null); setSuccess(null)
        startTransition(async () => {
            const r = await activateMetaLeadsAction(clienteId)
            if (!r.ok) setError(r.error)
            else setSuccess('Meta Lead Ads activado. El backfill (~90 días) corre en la próxima sincronización.')
        })
    }

    const onToggle = () => {
        if (!integration) return
        const next = integration.status === 'active' ? 'inactive' : 'active'
        setError(null); setSuccess(null)
        startTransition(async () => {
            const r = await setMetaLeadsStatusAction(clienteId, next)
            if (!r.ok) setError(r.error)
        })
    }

    const onSync = () => {
        setError(null); setSuccess(null)
        startTransition(async () => {
            const r = await syncMetaLeadsNowAction(clienteId)
            if (!r.ok) setError(r.error)
            else setSuccess(`Sincronizado — ${r.imported} lead(s) nuevo(s) de ${r.forms} formulario(s).`)
        })
    }

    const header = (
        <div className="flex items-start gap-3">
            <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
                <Megaphone className={`h-5 w-5 ${ICON_COLOR}`} />
            </div>
            <div>
                <h3 className="text-sm font-semibold text-foreground">Meta Lead Ads · Formularios instantáneos</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                    Importa los leads de campañas de formularios de Meta con UTMs sintetizadas desde la campaña.
                </p>
            </div>
        </div>
    )

    // Sin Meta conectado: precondición no cumplida.
    if (!metaConnected) {
        return (
            <div className="rounded-2xl border border-border bg-card p-6 space-y-3">
                {header}
                <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5 p-3">
                    <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                        Este cliente no tiene <strong>Meta conectado</strong> (token + cuenta publicitaria) ni vínculo
                        con un cliente del reporting. Conectá Meta en la configuración del cliente y vinculá
                        <code className="font-mono px-1 py-0.5 rounded bg-muted mx-1">public_cliente_id</code>
                        para habilitar esta integración.
                    </p>
                </div>
            </div>
        )
    }

    // Conectado pero no activado.
    if (!integration) {
        return (
            <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
                {header}
                <button
                    onClick={onActivate}
                    disabled={pending}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm bg-sky-600 hover:bg-sky-700 transition-colors disabled:opacity-50"
                >
                    <Megaphone className="h-3.5 w-3.5" />
                    {pending ? 'Activando…' : 'Activar Meta Lead Ads'}
                </button>
                {error && <FeedbackLine variant="error" message={error} />}
                {success && <FeedbackLine variant="success" message={success} />}
            </div>
        )
    }

    const isActive = integration.status === 'active'
    const formsDetected = Number(integration.config?.last_forms_detected ?? 0)
    const lastImported = Number(integration.config?.last_imported ?? 0)

    return (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
                {header}
                <IntegrationStatusBadge status={integration.status} activeCls={ACCENT} />
            </div>

            {integration.last_error && <LastErrorAlert message={integration.last_error} />}

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                <Metric label="Formularios detectados" value={String(formsDetected)} />
                <Metric label="Leads última sync" value={String(lastImported)} />
                <Metric
                    label="Última sincronización"
                    value={integration.last_sync_at ? new Date(integration.last_sync_at).toLocaleString() : '—'}
                />
            </div>

            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                <button
                    onClick={onSync}
                    disabled={pending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                               text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-50 transition-colors"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} />
                    {pending ? 'Sincronizando…' : 'Sincronizar ahora'}
                </button>
                <button
                    onClick={onToggle}
                    disabled={pending}
                    aria-label={isActive ? 'Pausar integración' : 'Reactivar integración'}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                                border transition-colors disabled:opacity-50 ${
                        isActive
                            ? 'border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
                            : 'border-sky-200 dark:border-sky-500/30 text-sky-700 dark:text-sky-400 hover:bg-sky-50 dark:hover:bg-sky-500/10'
                    }`}
                >
                    <Power className="h-3.5 w-3.5" />
                    {isActive ? 'Pausar' : 'Reactivar'}
                </button>
            </div>

            {error && <FeedbackLine variant="error" message={error} />}
            {success && <FeedbackLine variant="success" message={success} />}

            <p className="text-xs text-muted-foreground">
                Los formularios instantáneos no llevan UTMs reales: se sintetizan desde la campaña
                (<code className="font-mono px-1 py-0.5 rounded bg-muted">utm_id = campaign_id</code>) para cruzar con el
                gasto. El polling corre cada hora; el webhook en tiempo real es aditivo.
            </p>
        </div>
    )
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
            <p className="mt-1 text-sm font-semibold text-foreground truncate">{value}</p>
        </div>
    )
}
