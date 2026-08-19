'use client'

import { useState, useTransition } from 'react'
import { RefreshCw, Power, Contact, AlertTriangle, KeyRound } from 'lucide-react'
import {
    saveGhlIntegrationAction,
    saveGhlFiltroAction,
    setGhlStatusAction,
    syncGhlLeadsNowAction,
    rotateGhlWebhookSecretAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions'
import { CopyField, useCopyHandler } from './CopyField'
import { FeedbackLine, LastErrorAlert } from './FeedbackLine'
import { IntegrationStatusBadge } from './StatusBadge'

const ACCENT = 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-400'
const ICON_BG = 'bg-violet-50 dark:bg-violet-500/10'
const ICON_COLOR = 'text-violet-600 dark:text-violet-400'
const BTN = 'bg-violet-600 hover:bg-violet-700'

type Integration = {
    id: string
    status: 'active' | 'inactive' | 'error'
    config: Record<string, unknown>
    last_sync_at: string | null
    last_error: string | null
} | null

type Filtro = { tags?: string[]; excluir_tags?: string[] } | null

function listaATexto(v: string[] | undefined): string {
    return (v ?? []).join(', ')
}

function textoALista(v: string): string[] {
    return v
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
}

export function GhlLeadsCard({
    clienteId,
    integration,
    webhookOrigin,
}: {
    clienteId: string
    integration: Integration
    webhookOrigin: string
}) {
    const [pending, startTransition] = useTransition()
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const copy = useCopyHandler(setCopied)

    const config = (integration?.config ?? {}) as Record<string, unknown>
    const filtro = (config.filtro ?? null) as Filtro

    const [locationId, setLocationId] = useState(String(config.location_id ?? ''))
    const [token, setToken] = useState('')
    const [tags, setTags] = useState(listaATexto(filtro?.tags))
    const [excluirTags, setExcluirTags] = useState(listaATexto(filtro?.excluir_tags))
    const [confirmado, setConfirmado] = useState(false)
    const [secreto, setSecreto] = useState<string | null>(null)

    const webhookUrl = `${webhookOrigin}/api/report-utm/webhooks/ghl/${clienteId}`

    const onSave = () => {
        setError(null)
        setSuccess(null)
        startTransition(async () => {
            const r = await saveGhlIntegrationAction(clienteId, {
                locationId,
                token,
                tags: textoALista(tags),
                excluirTags: textoALista(excluirTags),
            })
            if (!r.ok) {
                setError(r.error)
                return
            }
            setSecreto(r.secret)
            setToken('')
            const pausadas = r.pausadas.length > 0 ? ` Se pausaron: ${r.pausadas.join(', ')}.` : ''
            setSuccess(
                `Conectado — ${r.total} contacto(s) en la location. El backfill (90 días) corre en la próxima sincronización.${pausadas}`,
            )
        })
    }

    const onSaveFiltro = () => {
        setError(null)
        setSuccess(null)
        startTransition(async () => {
            const r = await saveGhlFiltroAction(clienteId, {
                tags: textoALista(tags),
                excluirTags: textoALista(excluirTags),
            })
            if (!r.ok) setError(r.error)
            else setSuccess('Filtro guardado. Se aplica desde la próxima sincronización.')
        })
    }

    const onSync = () => {
        setError(null)
        setSuccess(null)
        startTransition(async () => {
            const r = await syncGhlLeadsNowAction(clienteId)
            if (!r.ok) setError(r.error)
            else
                setSuccess(
                    `Sincronizado — ${r.imported} lead(s) nuevo(s) de ${r.scanned} contacto(s) revisados` +
                        `${r.filtered > 0 ? `, ${r.filtered} descartado(s) por el filtro` : ''}.`,
                )
        })
    }

    const onToggle = () => {
        if (!integration) return
        const next = integration.status === 'active' ? 'inactive' : 'active'
        setError(null)
        setSuccess(null)
        startTransition(async () => {
            const r = await setGhlStatusAction(clienteId, next)
            if (!r.ok) setError(r.error)
        })
    }

    const onRotate = () => {
        setError(null)
        setSuccess(null)
        startTransition(async () => {
            const r = await rotateGhlWebhookSecretAction(clienteId)
            if (!r.ok) setError(r.error)
            else {
                setSecreto(r.secret ?? null)
                setSuccess('Secreto rotado. Actualizá el header en el Workflow de GHL.')
            }
        })
    }

    const header = (
        <div className="flex items-start gap-3">
            <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
                <Contact className={`h-5 w-5 ${ICON_COLOR}`} />
            </div>
            <div>
                <h3 className="text-sm font-semibold text-foreground">GoHighLevel · CRM</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                    Importa los contactos de una location como leads, con sus campos personalizados y la
                    atribución del anuncio que los trajo.
                </p>
            </div>
        </div>
    )

    const avisoFuenteUnica = (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50/50 dark:bg-amber-500/5 p-3">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-400">
                GoHighLevel pasa a ser la <strong>fuente única de leads</strong> de este cliente: al guardar se
                pausan sus integraciones <code className="font-mono px-1 py-0.5 rounded bg-muted">s2s</code> y{' '}
                <code className="font-mono px-1 py-0.5 rounded bg-muted">meta_lead_ads</code>. La tabla de leads
                no deduplica por email ni teléfono, así que dejar dos vías activas contaría dos veces a la misma
                persona.
            </p>
        </div>
    )

    const campos = (
        <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
                <Campo
                    label="Location ID"
                    value={locationId}
                    onChange={setLocationId}
                    placeholder="sWSeAhElmT7anfpZSqXS"
                />
                <Campo
                    label="Private Integration Token"
                    value={token}
                    onChange={setToken}
                    placeholder={integration ? 'Dejalo vacío para conservar el actual' : 'pit-xxxxxxxx…'}
                    type="password"
                />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <Campo
                    label="Solo etiquetas (opcional)"
                    value={tags}
                    onChange={setTags}
                    placeholder="lead-web, campaña-julio"
                />
                <Campo
                    label="Excluir etiquetas (opcional)"
                    value={excluirTags}
                    onChange={setExcluirTags}
                    placeholder="gestionado_por_chatbot"
                />
            </div>
            <p className="text-xs text-muted-foreground">
                Sin filtro entra <strong>todo contacto nuevo</strong>. En una location con chatbot eso hunde el
                CPL con contactos que no son captación: usá las etiquetas para acotar qué cuenta como lead.
            </p>
        </div>
    )

    // Sin configurar.
    if (!integration) {
        return (
            <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
                {header}
                {avisoFuenteUnica}
                {campos}
                <label className="flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={confirmado}
                        onChange={(e) => setConfirmado(e.target.checked)}
                        className="mt-0.5"
                    />
                    Entiendo que se pausarán las otras fuentes de leads de este cliente.
                </label>
                <button
                    onClick={onSave}
                    disabled={pending || !confirmado}
                    className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm ${BTN} transition-colors disabled:opacity-50`}
                >
                    <Contact className="h-3.5 w-3.5" />
                    {pending ? 'Probando conexión…' : 'Guardar y probar conexión'}
                </button>
                {error && <FeedbackLine variant="error" message={error} />}
                {success && <FeedbackLine variant="success" message={success} />}
            </div>
        )
    }

    const isActive = integration.status === 'active'
    const lastImported = Number(config.last_imported ?? 0)
    const totales = Number(config.contactos_totales ?? 0)
    const camposResueltos = Array.isArray(
        (config.custom_fields as { items?: unknown[] } | undefined)?.items,
    )
        ? ((config.custom_fields as { items: unknown[] }).items.length as number)
        : 0

    return (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-start justify-between gap-4">
                {header}
                <IntegrationStatusBadge status={integration.status} activeCls={ACCENT} />
            </div>

            {integration.last_error && <LastErrorAlert message={integration.last_error} />}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                <Metric label="Contactos en la location" value={String(totales)} />
                <Metric label="Leads última sync" value={String(lastImported)} />
                <Metric label="Campos personalizados" value={String(camposResueltos)} />
                <Metric
                    label="Última sincronización"
                    value={
                        integration.last_sync_at ? new Date(integration.last_sync_at).toLocaleString() : '—'
                    }
                    suppressHydration
                />
            </div>

            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-xs font-semibold text-foreground">Webhook en tiempo real</p>
                <CopyField
                    label="URL (acción Webhook del Workflow, método POST)"
                    value={webhookUrl}
                    onCopy={() => copy(webhookUrl)}
                    copied={copied}
                />
                {secreto ? (
                    <CopyField
                        label="Header X-Rutm-Ghl-Token (se muestra una sola vez)"
                        value={secreto}
                        onCopy={() => copy(secreto)}
                        copied={copied}
                    />
                ) : (
                    <p className="text-xs text-muted-foreground">
                        El secreto solo se muestra al crearlo o rotarlo. Si lo perdiste, rotalo y actualizá el
                        header <code className="font-mono px-1 py-0.5 rounded bg-muted">X-Rutm-Ghl-Token</code>{' '}
                        en el Workflow.
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    En GHL: <strong>Automation → Workflow</strong> → trigger <em>Contact Created</em> → acción{' '}
                    <em>Webhook</em> → POST a esa URL con el header{' '}
                    <code className="font-mono px-1 py-0.5 rounded bg-muted">X-Rutm-Ghl-Token</code>. El payload
                    solo necesita el <code className="font-mono px-1 py-0.5 rounded bg-muted">contact_id</code>:
                    el resto se relee con el token.
                </p>
            </div>

            {campos}

            <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                <button
                    onClick={onSync}
                    disabled={pending}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white ${BTN} disabled:opacity-50 transition-colors`}
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${pending ? 'animate-spin' : ''}`} />
                    {pending ? 'Sincronizando…' : 'Sincronizar ahora'}
                </button>
                <button
                    onClick={onSaveFiltro}
                    disabled={pending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                >
                    Guardar filtro
                </button>
                <button
                    onClick={onSave}
                    disabled={pending || !locationId}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                >
                    Actualizar credenciales
                </button>
                <button
                    onClick={onRotate}
                    disabled={pending}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                >
                    <KeyRound className="h-3.5 w-3.5" />
                    Rotar secreto
                </button>
                <button
                    onClick={onToggle}
                    disabled={pending}
                    aria-label={isActive ? 'Pausar integración' : 'Reactivar integración'}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
                        isActive
                            ? 'border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
                            : 'border-violet-200 dark:border-violet-500/30 text-violet-700 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-500/10'
                    }`}
                >
                    <Power className="h-3.5 w-3.5" />
                    {isActive ? 'Pausar' : 'Reactivar'}
                </button>
            </div>

            {error && <FeedbackLine variant="error" message={error} />}
            {success && <FeedbackLine variant="success" message={success} />}

            <p className="text-xs text-muted-foreground">
                Los contactos que llegan de un anuncio traen el id del anuncio en su atribución, y ese valor va a{' '}
                <code className="font-mono px-1 py-0.5 rounded bg-muted">utm_id</code> para cruzar exacto con el
                gasto. Los orgánicos quedan en <em>(sin campaña)</em> con gasto 0, que es lo correcto.
            </p>
        </div>
    )
}

function Campo({
    label,
    value,
    onChange,
    placeholder,
    type = 'text',
}: {
    label: string
    value: string
    onChange: (v: string) => void
    placeholder?: string
    type?: string
}) {
    return (
        <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
            <input
                type={type}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground
                           placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/40"
            />
        </div>
    )
}

function Metric({
    label,
    value,
    suppressHydration,
}: {
    label: string
    value: string
    suppressHydration?: boolean
}) {
    return (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
            <p
                className="mt-1 text-sm font-semibold text-foreground truncate"
                suppressHydrationWarning={suppressHydration}
            >
                {value}
            </p>
        </div>
    )
}
