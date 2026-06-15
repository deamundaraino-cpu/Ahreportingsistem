'use client'

import { useState, useTransition } from 'react'
import { Zap, Eye, EyeOff, Save, FlaskConical } from 'lucide-react'
import {
    saveMetaCAPIConfigAction,
    testMetaCAPIAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions'
import { FeedbackLine, LastErrorAlert } from './FeedbackLine'
import { IntegrationStatusBadge } from './StatusBadge'

const ACCENT = 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400'
const ICON_BG = 'bg-blue-50 dark:bg-blue-500/10'
const ICON_COLOR = 'text-blue-600 dark:text-blue-400'

type Integration = {
    id: string
    status: 'active' | 'inactive' | 'error'
    config: Record<string, unknown>
    last_sync_at: string | null
    last_error: string | null
} | null

export function MetaCAPICard({
    clienteId,
    integration,
}: {
    clienteId: string
    integration: Integration
}) {
    const [pending, startTransition] = useTransition()
    const [pixelId, setPixelId] = useState(String(integration?.config?.pixel_id ?? ''))
    const [accessToken, setAccessToken] = useState('')
    const [testCode, setTestCode] = useState(String(integration?.config?.test_event_code ?? ''))
    const [showToken, setShowToken] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    const onSave = () => {
        if (!pixelId.trim()) { setError('Pixel ID requerido'); return }
        setError(null)
        setSuccess(null)
        startTransition(async () => {
            const r = await saveMetaCAPIConfigAction(clienteId, {
                pixelId: pixelId.trim(),
                accessToken: accessToken.trim() || null,
                testEventCode: testCode.trim() || null,
            })
            if (!r.ok) setError(r.error)
            else { setSuccess('Configuración guardada'); setAccessToken('') }
        })
    }

    const onTest = () => {
        setError(null)
        setSuccess(null)
        startTransition(async () => {
            const r = await testMetaCAPIAction(clienteId)
            if (!r.ok) setError(r.error)
            else setSuccess(
                `Evento de prueba enviado — events_received: ${(r as { events_received?: number }).events_received ?? 1}`,
            )
        })
    }

    const isConfigured = Boolean(integration?.config?.pixel_id)

    return (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
                        <Zap className={`h-5 w-5 ${ICON_COLOR}`} />
                    </div>
                    <div>
                        <h3 className="text-sm font-semibold text-foreground">
                            Meta Conversions API (CAPI)
                        </h3>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            {isConfigured
                                ? `Pixel ${String(integration?.config?.pixel_id)} · Envío server-side activo`
                                : 'Envía conversiones server-side a Meta para mejorar el matching'}
                        </p>
                    </div>
                </div>
                {isConfigured && (
                    <IntegrationStatusBadge
                        status={integration?.status ?? 'active'}
                        activeCls={ACCENT}
                    />
                )}
            </div>

            {integration?.last_error && <LastErrorAlert message={integration.last_error} />}

            <div className="space-y-3">
                <label className="block">
                    <span className="block text-xs font-medium text-muted-foreground mb-1">Pixel ID</span>
                    <input
                        type="text"
                        value={pixelId}
                        onChange={(e) => setPixelId(e.target.value)}
                        placeholder="123456789012345"
                        className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    />
                </label>

                <label className="block">
                    <span className="block text-xs font-medium text-muted-foreground mb-1">
                        Access Token{' '}
                        {isConfigured && (
                            <span className="text-muted-foreground/60">(dejá vacío para mantener el actual)</span>
                        )}
                    </span>
                    <div className="flex items-center gap-2">
                        <input
                            type={showToken ? 'text' : 'password'}
                            value={accessToken}
                            onChange={(e) => setAccessToken(e.target.value)}
                            placeholder={isConfigured ? '••••••••••••' : 'EAAxxxxxxxxxxxx...'}
                            className="flex-1 px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/40 font-mono"
                        />
                        <button
                            type="button"
                            onClick={() => setShowToken(!showToken)}
                            aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
                            className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        >
                            {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                    </div>
                </label>

                <label className="block">
                    <span className="block text-xs font-medium text-muted-foreground mb-1">
                        Test Event Code{' '}
                        <span className="text-muted-foreground/60">(opcional · solo para pruebas)</span>
                    </span>
                    <input
                        type="text"
                        value={testCode}
                        onChange={(e) => setTestCode(e.target.value)}
                        placeholder="TEST12345"
                        className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/40 font-mono"
                    />
                </label>
            </div>

            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                <button
                    onClick={onSave}
                    disabled={pending || !pixelId.trim()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                               text-white bg-blue-600 hover:bg-blue-700
                               disabled:opacity-50 transition-colors"
                >
                    <Save className="h-3.5 w-3.5" />
                    {pending ? 'Guardando…' : 'Guardar configuración'}
                </button>
                {isConfigured && (
                    <button
                        onClick={onTest}
                        disabled={pending}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                                   border border-blue-200 dark:border-blue-500/30
                                   text-blue-700 dark:text-blue-400
                                   hover:bg-blue-50 dark:hover:bg-blue-500/10
                                   disabled:opacity-50 transition-colors"
                    >
                        <FlaskConical className="h-3.5 w-3.5" />
                        Probar CAPI
                    </button>
                )}
            </div>

            {error && <FeedbackLine variant="error" message={error} />}
            {success && <FeedbackLine variant="success" message={success} />}

            <div className="text-xs text-muted-foreground space-y-1 pt-1">
                <p>
                    Las ventas <strong>aprobadas</strong> se envían automáticamente como evento{' '}
                    <code className="font-mono px-1 py-0.5 rounded bg-muted">Purchase</code> con PII hasheado (SHA-256).
                </p>
                <p>
                    El event_id es determinístico ({' '}
                    <code className="font-mono px-1 py-0.5 rounded bg-muted">sha256(pixelId:saleId)</code>
                    {' '}) — Meta deduplica automáticamente si el pixel JS también disparó el evento.
                </p>
            </div>
        </div>
    )
}
