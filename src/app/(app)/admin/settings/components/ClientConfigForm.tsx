'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { updateClienteConfig, deleteCliente, assignLayoutToCliente, testMetaConnection, testHotmartConnection, refreshMetaCustomConversions, testTikTokConnection, syncClienteMetrics, testGA4Connection, syncGoogleSheets, fetchMetaAdAccounts } from '../_actions'
import { Loader2, ArrowLeft, Save, Trash2, CheckCircle2, AlertCircle, RefreshCw, LayoutDashboard, DownloadCloud, DatabaseZap, Plus } from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface MetaAccount {
    id: string
    label: string
    account_id: string
    token: string
}

// ─── MetaAccountRow sub-component ────────────────────────────────────────────

function MetaAccountRow({ account, sharedToken, testStatus, onChange, onRemove, onTest }: {
    account: MetaAccount
    sharedToken: string
    testStatus?: { loading: boolean; success?: boolean; error?: string }
    onChange: (updated: MetaAccount) => void
    onRemove: () => void
    onTest: () => void
}) {
    return (
        <div className="bg-zinc-950/60 border border-zinc-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Input
                    placeholder="Nombre de la cuenta (ej: Cuenta Principal)"
                    value={account.label}
                    onChange={(e) => onChange({ ...account, label: e.target.value })}
                    className="bg-zinc-900 border-zinc-700 h-8 text-sm"
                />
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRemove}
                    className="text-zinc-500 hover:text-red-400 shrink-0 h-8 w-8 p-0"
                >
                    <Trash2 className="w-4 h-4" />
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                    <Label className="text-zinc-400 text-xs">Ad Account ID</Label>
                    <Input
                        placeholder="act_1234567890"
                        value={account.account_id}
                        onChange={(e) => onChange({ ...account, account_id: e.target.value })}
                        className="bg-zinc-900 border-zinc-700 h-8 text-sm"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label className="text-zinc-400 text-xs">Token propio (opcional)</Label>
                    <Input
                        type="password"
                        placeholder={sharedToken ? 'Usa token compartido' : 'EAA...'}
                        value={account.token}
                        onChange={(e) => onChange({ ...account, token: e.target.value })}
                        className="bg-zinc-900 border-zinc-700 h-8 text-sm"
                    />
                </div>
            </div>
            <div className="flex items-center gap-3">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={onTest}
                    disabled={testStatus?.loading || !account.account_id}
                    className="h-7 text-xs"
                >
                    {testStatus?.loading
                        ? <RefreshCw className="w-3 h-3 animate-spin mr-1" />
                        : <RefreshCw className="w-3 h-3 mr-1" />
                    }
                    Probar conexión
                </Button>
                {testStatus?.success && (
                    <span className="text-green-500 text-xs flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Conexión exitosa
                    </span>
                )}
                {testStatus?.error && (
                    <span className="text-red-500 text-xs flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> {testStatus.error}
                    </span>
                )}
            </div>
        </div>
    )
}

// ─── TikTok Account Row ───────────────────────────────────────────────────────

interface TikTokAccount {
    id: string
    label: string
    advertiser_id: string
    access_token: string
}

function TikTokAccountRow({ account, sharedToken, testStatus, onChange, onRemove, onTest }: {
    account: TikTokAccount
    sharedToken: string
    testStatus?: { loading: boolean; success?: boolean; error?: string }
    onChange: (updated: TikTokAccount) => void
    onRemove: () => void
    onTest: () => void
}) {
    return (
        <div className="bg-zinc-950/60 border border-zinc-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Input
                    placeholder="Nombre de la cuenta (ej: Cuenta Principal)"
                    value={account.label}
                    onChange={(e) => onChange({ ...account, label: e.target.value })}
                    className="bg-zinc-900 border-zinc-700 h-8 text-sm"
                />
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRemove}
                    className="text-zinc-500 hover:text-red-400 shrink-0 h-8 w-8 p-0"
                >
                    <Trash2 className="w-4 h-4" />
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                    <Label className="text-zinc-400 text-xs">Advertiser ID</Label>
                    <Input
                        placeholder="1234567890123456789"
                        value={account.advertiser_id}
                        onChange={(e) => onChange({ ...account, advertiser_id: e.target.value })}
                        className="bg-zinc-900 border-zinc-700 h-8 text-sm"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label className="text-zinc-400 text-xs">Token propio (opcional)</Label>
                    <Input
                        type="password"
                        placeholder={sharedToken ? 'Usa token compartido' : 'Token...'}
                        value={account.access_token}
                        onChange={(e) => onChange({ ...account, access_token: e.target.value })}
                        className="bg-zinc-900 border-zinc-700 h-8 text-sm"
                    />
                </div>
            </div>
            <div className="flex items-center gap-3">
                <Button
                    variant="outline"
                    size="sm"
                    onClick={onTest}
                    disabled={testStatus?.loading || !account.advertiser_id}
                    className="h-7 text-xs"
                >
                    {testStatus?.loading
                        ? <RefreshCw className="w-3 h-3 animate-spin mr-1" />
                        : <RefreshCw className="w-3 h-3 mr-1" />
                    }
                    Probar conexión
                </Button>
                {testStatus?.success && (
                    <span className="text-green-500 text-xs flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> Conexión exitosa
                    </span>
                )}
                {testStatus?.error && (
                    <span className="text-red-500 text-xs flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> {testStatus.error}
                    </span>
                )}
            </div>
        </div>
    )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ClientConfigForm({ cliente, layouts = [], isAdmin = false }: { cliente: any; layouts?: any[]; isAdmin?: boolean }) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [config, setConfig] = useState(cliente.config_api || {})
    const [tiktokOAuthStatus, setTiktokOAuthStatus] = useState<{ success?: boolean; error?: string } | null>(null)
    const [metaOAuthStatus, setMetaOAuthStatus] = useState<{ success?: boolean; error?: string } | null>(null)

    useEffect(() => {
        if (searchParams.get('tiktok_connected')) {
            setTiktokOAuthStatus({ success: true })
            setConfig((prev: any) => ({ ...prev }))
        } else if (searchParams.get('tiktok_error')) {
            setTiktokOAuthStatus({ error: decodeURIComponent(searchParams.get('tiktok_error')!) })
        }
        if (searchParams.get('meta_connected')) {
            setMetaOAuthStatus({ success: true })
            setConfig((prev: any) => ({ ...prev }))
        } else if (searchParams.get('meta_error')) {
            setMetaOAuthStatus({ error: decodeURIComponent(searchParams.get('meta_error')!) })
        }
    }, [searchParams])
const [testStatus, setTestStatus] = useState<{ [key: string]: { loading: boolean, success?: boolean, error?: string, message?: string } }>({})
    const [layoutSaving, setLayoutSaving] = useState(false)
    const [selectedLayoutId, setSelectedLayoutId] = useState<string>(cliente.layout_id || '')
    const today = new Date().toISOString().split('T')[0]
    const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    const [syncStart, setSyncStart] = useState(defaultStart)
    const [syncEnd, setSyncEnd] = useState(today)

    // ── metaAccounts state (with backward compat migration) ──────────────────
    const initAccounts = (): MetaAccount[] => {
        const cfg = cliente.config_api || {}
        if (cfg.meta_accounts && Array.isArray(cfg.meta_accounts) && cfg.meta_accounts.length > 0) {
            return cfg.meta_accounts
        }
        if (cfg.meta_token || cfg.meta_account_id) {
            return [{ id: crypto.randomUUID(), label: 'Cuenta Principal', account_id: cfg.meta_account_id || '', token: '' }]
        }
        return []
    }
    const [metaAccounts, setMetaAccounts] = useState<MetaAccount[]>(initAccounts)

    function addAccount() {
        setMetaAccounts(prev => [...prev, { id: crypto.randomUUID(), label: `Cuenta ${prev.length + 1}`, account_id: '', token: '' }])
    }
    function removeAccount(idx: number) {
        setMetaAccounts(prev => prev.filter((_, i) => i !== idx))
    }
    function updateAccount(idx: number, updated: MetaAccount) {
        setMetaAccounts(prev => prev.map((a, i) => i === idx ? updated : a))
    }

    const [importingMeta, setImportingMeta] = useState(false)
    async function importMetaAccounts() {
        const token = config.meta_token
        if (!token) {
            alert('Primero conecta por OAuth o pega un Access Token compartido.')
            return
        }
        setImportingMeta(true)
        try {
            const res = await fetchMetaAdAccounts(token)
            if (res.error) {
                alert(`Error importando cuentas: ${res.error}`)
                return
            }
            setMetaAccounts(prev => {
                const existingIds = new Set(prev.map(a => a.account_id))
                const newOnes = (res.accounts || [])
                    .filter((a: any) => !existingIds.has(a.account_id))
                    .map((a: any) => ({ id: crypto.randomUUID(), label: a.name, account_id: a.account_id, token: '' }))
                return [...prev, ...newOnes]
            })
        } finally {
            setImportingMeta(false)
        }
    }

    // ── tiktokAccounts state (with backward compat migration) ────────────────
    const initTikTokAccounts = (): TikTokAccount[] => {
        const cfg = cliente.config_api || {}
        if (cfg.tiktok_accounts && Array.isArray(cfg.tiktok_accounts) && cfg.tiktok_accounts.length > 0) {
            return cfg.tiktok_accounts
        }
        if (cfg.tiktok_access_token || cfg.tiktok_advertiser_id) {
            return [{ id: crypto.randomUUID(), label: 'Cuenta Principal', advertiser_id: cfg.tiktok_advertiser_id || '', access_token: '' }]
        }
        return []
    }
    const [tiktokAccounts, setTiktokAccounts] = useState<TikTokAccount[]>(initTikTokAccounts)

    function addTikTokAccount() {
        setTiktokAccounts(prev => [...prev, { id: crypto.randomUUID(), label: `Cuenta ${prev.length + 1}`, advertiser_id: '', access_token: '' }])
    }
    function removeTikTokAccount(idx: number) {
        setTiktokAccounts(prev => prev.filter((_, i) => i !== idx))
    }
    function updateTikTokAccount(idx: number, updated: TikTokAccount) {
        setTiktokAccounts(prev => prev.map((a, i) => i === idx ? updated : a))
    }

    async function runTest(key: string, fn: () => Promise<any>) {
        setTestStatus(prev => ({ ...prev, [key]: { loading: true } }))
        try {
            const res = await fn()
            if (res.error) {
                setTestStatus(prev => ({ ...prev, [key]: { loading: false, error: res.error } }))
            } else {
                // Build a descriptive message from sync stats if available
                const message = res.message
                    || (res.totalLeads !== undefined
                        ? `${res.totalLeads} leads | ${res.qualifiedLeads ?? 0} calificados | ${res.daysProcessed ?? 0} días guardados`
                        : undefined)
                setTestStatus(prev => ({
                    ...prev,
                    [key]: { loading: false, success: true, message }
                }))
            }
        } catch (err: any) {
            setTestStatus(prev => ({ ...prev, [key]: { loading: false, error: err.message } }))
        }
    }

    async function handleSave() {
        setLoading(true)
        setError(null)
        const computedBasic = !config.hotmart_basic && config.hotmart_client_id && config.hotmart_client_secret
            ? btoa(`${config.hotmart_client_id}:${config.hotmart_client_secret}`)
            : config.hotmart_basic
        const finalConfig = {
            ...config,
            meta_accounts: metaAccounts,
            meta_account_id: metaAccounts[0]?.account_id || config.meta_account_id || '',
            tiktok_accounts: tiktokAccounts,
            hotmart_basic: computedBasic || config.hotmart_basic || '',
        }
        const { success, error: updateError } = await updateClienteConfig(cliente.id, finalConfig)
        if (!success) {
            setError(updateError || 'Error al guardar la configuración')
        } else {
            router.refresh()
        }
        setLoading(false)
    }

    const handleGoogleSheetsJSONUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        const reader = new FileReader()
        reader.onload = (event) => {
            try {
                const json = JSON.parse(event.target?.result as string)
                if (json.client_email && json.private_key) {
                    setConfig((prev: any) => ({
                        ...prev,
                        google_sheets: {
                            ...prev.google_sheets,
                            client_email: json.client_email,
                            private_key: json.private_key.replace(/\\n/g, '\n'),
                        }
                    }))
                    alert('Credenciales de Google Sheets extraídas correctamente.')
                } else {
                    alert('El archivo JSON no parece ser una cuenta de servicio válida (faltan client_email o private_key).')
                }
            } catch (err) {
                alert('Error al parsear el archivo JSON.')
            }
        }
        reader.readAsText(file)
    }

    const handleGA4JSONUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (!file) return

        const reader = new FileReader()
        reader.onload = (event) => {
            try {
                const json = JSON.parse(event.target?.result as string)
                if (json.client_email && json.private_key) {
                    setConfig((prev: any) => ({
                        ...prev,
                        ga_client_email: json.client_email,
                        // Normalizamos literales de escape a saltos de línea reales si existen, 
                        // aunque esto ya será re-confirmado en el backend
                        ga_private_key: json.private_key.replace(/\\n/g, '\n'),
                        ga_project_id: json.project_id
                    }))
                    alert('Credenciales de Google Cloud extraídas correctamente.')
                } else {
                    alert('El archivo JSON no parece ser una cuenta de servicio válida (faltan client_email o private_key).')
                }
            } catch (err) {
                alert('Error al parsear el archivo JSON.')
            }
        }
        reader.readAsText(file)
    }

    async function handleDelete() {
        if (confirm('¿Estás seguro de que deseas eliminar este cliente y todos sus datos?')) {
            const { success } = await deleteCliente(cliente.id)
            if (success) {
                router.push('/admin/clientes')
            }
        }
    }

    const hasMetaConfig = metaAccounts.length > 0 || config.meta_token

    return (
        <div className="space-y-6">
            <div className="flex gap-4 items-center">
                <Button variant="outline" onClick={() => router.push('/admin/settings')}>
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Volver
                </Button>
                <h2 className="text-2xl font-bold">{cliente.nombre}</h2>
            </div>

            {error && <p className="text-red-500 bg-red-500/10 p-4 rounded">{error}</p>}

            {/* ─── Meta Ads ─────────────────────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <CardTitle>Meta Ads Configuration</CardTitle>
                    <CardDescription>
                        Conecta una o más cuentas publicitarias de Meta. Los datos de todas las cuentas se consolidarán en el reporte.
                    </CardDescription>
                    {testStatus.metaSync?.success && (
                        <p className="text-emerald-400 text-sm flex items-center mt-2 p-2 bg-emerald-500/10 rounded">
                            <CheckCircle2 className="w-4 h-4 mr-2" /> {testStatus.metaSync.message}
                        </p>
                    )}
                    {testStatus.metaSync?.error && (
                        <p className="text-red-500 text-xs flex items-center mt-2">
                            <AlertCircle className="w-3 h-3 mr-1" /> {testStatus.metaSync.error}
                        </p>
                    )}
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* OAuth connect + estado de conexión */}
                    <div className="flex flex-col gap-2 pb-4 border-b border-zinc-800">
                        <a href={`/api/auth/meta?client_id=${cliente.id}`}>
                            <Button variant="default" size="sm" className="w-full bg-[#1877f2] hover:bg-[#0f5ed8] text-white">
                                {config.meta_token ? '🔄 Reconectar con Facebook Ads' : '🔗 Conectar con Facebook Ads'}
                            </Button>
                        </a>
                        {(() => {
                            const expiresAt = config.meta_token_expires_at
                            if (config.meta_connection_status === 'expired') {
                                return <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Token vencido, reconecta con Facebook</p>
                            }
                            if (config.meta_token && expiresAt) {
                                const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
                                if (days <= 0) {
                                    return <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Token vencido, reconecta con Facebook</p>
                                }
                                const cls = days <= 10 ? 'text-amber-500' : 'text-green-500'
                                return <p className={`${cls} text-xs flex items-center gap-1`}><CheckCircle2 className="w-3 h-3" /> Conectado · el token se renueva automáticamente (vence en {days} días)</p>
                            }
                            return null
                        })()}
                        {metaOAuthStatus?.success && <p className="text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Cuenta de Facebook conectada exitosamente</p>}
                        {metaOAuthStatus?.error && <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {metaOAuthStatus.error}</p>}
                    </div>

                    {/* Shared token */}
                    <div className="space-y-2">
                        <Label htmlFor="meta_token" className="text-zinc-300">
                            Access Token Compartido
                        </Label>
                        <Input
                            id="meta_token"
                            type="password"
                            placeholder="EAA..."
                            value={config.meta_token || ''}
                            onChange={(e) => setConfig({ ...config, meta_token: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                        <p className="text-xs text-zinc-500">
                            Se completa automáticamente al conectar por OAuth. Si una cuenta no tiene token propio, se usará este.
                            Para una conexión que <strong>no caduca</strong>, pega aquí un <strong>System User token</strong> del Business Manager.
                        </p>
                    </div>

                    {/* Account list */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <Label className="text-zinc-300">Cuentas Publicitarias</Label>
                            <div className="flex items-center gap-2">
                                <Button size="sm" variant="outline" onClick={importMetaAccounts} disabled={importingMeta || !config.meta_token} className="h-7 text-xs">
                                    {importingMeta ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <DownloadCloud className="w-3 h-3 mr-1" />} Importar del token
                                </Button>
                                <Button size="sm" variant="outline" onClick={addAccount} className="h-7 text-xs">
                                    <Plus className="w-3 h-3 mr-1" /> Agregar Cuenta
                                </Button>
                            </div>
                        </div>

                        {metaAccounts.length === 0 && (
                            <p className="text-xs text-zinc-500 py-3 text-center border border-dashed border-zinc-800 rounded-lg">
                                Sin cuentas configuradas. Agrega al menos una para activar Meta Ads.
                            </p>
                        )}

                        {metaAccounts.map((acct, idx) => (
                            <MetaAccountRow
                                key={acct.id}
                                account={acct}
                                sharedToken={config.meta_token || ''}
                                testStatus={testStatus[`meta_${acct.id}`]}
                                onChange={(updated) => updateAccount(idx, updated)}
                                onRemove={() => removeAccount(idx)}
                                onTest={() => runTest(`meta_${acct.id}`, () =>
                                    testMetaConnection(acct.token || config.meta_token, acct.account_id)
                                )}
                            />
                        ))}
                    </div>

                    {/* Conversiones personalizadas */}
                    <div className="pt-4 mt-2 border-t border-zinc-800">
                        <div className="flex justify-between items-center bg-zinc-950/50 p-3 rounded-lg border border-zinc-800">
                            <div>
                                <h4 className="text-sm font-medium text-zinc-200">Conversiones Personalizadas</h4>
                                <p className="text-xs text-zinc-500 mt-1">Busca y actualiza todos los eventos personalizados detectados en Meta durante los últimos 30 días.</p>
                            </div>
                            <Button
                                variant="secondary"
                                size="sm"
                                className="bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30 border border-indigo-500/30 whitespace-nowrap"
                                onClick={() => runTest('metaSync', () => refreshMetaCustomConversions(cliente.id, config))}
                                disabled={testStatus.metaSync?.loading || !hasMetaConfig}
                            >
                                {testStatus.metaSync?.loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <DownloadCloud className="w-4 h-4 mr-2" />}
                                Sincronizar Conversiones
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* ─── Sincronización de Datos ──────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800 border-indigo-500/20">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-indigo-300">
                        <DatabaseZap className="w-5 h-5" />
                        Sincronizar Datos Diarios
                    </CardTitle>
                    <CardDescription className="text-zinc-400">
                        Carga o recarga los datos de Meta y Hotmart para el rango de fechas seleccionado.
                        Usa esto cuando falten datos o para actualizar métricas históricas.
                    </CardDescription>
                    {testStatus.dataSync?.success && (
                        <p className="text-emerald-400 text-sm flex items-start gap-2 mt-2 p-3 bg-emerald-500/10 rounded">
                            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>{testStatus.dataSync.message}</span>
                        </p>
                    )}
                    {testStatus.dataSync?.error && (
                        <p className="text-red-400 text-sm flex items-start gap-2 mt-2 p-3 bg-red-500/10 rounded">
                            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>{testStatus.dataSync.error}</span>
                        </p>
                    )}
                </CardHeader>
                <CardContent>
                    <div className="flex items-end gap-3 flex-wrap">
                        <div className="space-y-1.5 flex-1 min-w-[140px]">
                            <Label className="text-zinc-400 text-xs">Fecha inicio</Label>
                            <Input
                                type="date"
                                value={syncStart}
                                onChange={e => setSyncStart(e.target.value)}
                                className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9"
                            />
                        </div>
                        <div className="space-y-1.5 flex-1 min-w-[140px]">
                            <Label className="text-zinc-400 text-xs">Fecha fin</Label>
                            <Input
                                type="date"
                                value={syncEnd}
                                onChange={e => setSyncEnd(e.target.value)}
                                className="bg-zinc-950 border-zinc-700 text-zinc-100 h-9"
                            />
                        </div>
                        <Button
                            onClick={() => runTest('dataSync', () => syncClienteMetrics(cliente.id, syncStart, syncEnd))}
                            disabled={testStatus.dataSync?.loading || !syncStart || !syncEnd}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white h-9 whitespace-nowrap"
                        >
                            {testStatus.dataSync?.loading
                                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sincronizando...</>
                                : <><DatabaseZap className="w-4 h-4 mr-2" /> Sincronizar Datos</>
                            }
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* ─── Hotmart ──────────────────────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle>Hotmart API Settings</CardTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runTest('hotmart', () => testHotmartConnection(config))}
                            disabled={testStatus.hotmart?.loading}
                        >
                            {testStatus.hotmart?.loading ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : <RefreshCw className="w-3 h-3 mr-2" />}
                            Probar Conexión
                        </Button>
                    </div>
                    <CardDescription>Proporciona tus credenciales de Hotmart Developers.</CardDescription>
                    {testStatus.hotmart?.success && <p className="text-green-500 text-xs flex items-center mt-2"><CheckCircle2 className="w-3 h-3 mr-1" /> Conexión Exitosa</p>}
                    {testStatus.hotmart?.error && <p className="text-red-500 text-xs flex items-center mt-2"><AlertCircle className="w-3 h-3 mr-1" /> {testStatus.hotmart.error}</p>}
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_token" className="text-zinc-300">Access Token Temporal (Opcional si usas Basic Auth)</Label>
                        <Input
                            id="hotmart_token"
                            type="password"
                            value={config.hotmart_token || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_token: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_basic" className="text-zinc-300">Basic Auth (Base64 Client ID:Secret)</Label>
                        <Input
                            id="hotmart_basic"
                            type="password"
                            value={config.hotmart_basic || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_basic: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_client_id" className="text-zinc-300">Client ID</Label>
                        <Input
                            id="hotmart_client_id"
                            value={config.hotmart_client_id || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_client_id: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_client_secret" className="text-zinc-300">Client Secret</Label>
                        <Input
                            id="hotmart_client_secret"
                            type="password"
                            value={config.hotmart_client_secret || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_client_secret: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>

                    <div className="pt-4 border-t border-zinc-800">
                        <div className="bg-orange-500/5 border border-orange-500/20 rounded-lg p-3">
                            <p className="text-xs text-orange-300/90 leading-relaxed">
                                <strong className="text-orange-400">Filtros de productos por funnel</strong> — La configuración de productos (Principal / Order Bump / Upsell) y URLs de página ahora se hace <strong>por pestaña</strong> desde el dashboard del cliente. Cada pestaña representa un funnel independiente con sus propias métricas, lo que permite medir varios productos del mismo cliente por separado.
                            </p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* ─── Google Analytics 4 (GA4) ─────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle>Google Analytics (GA4)</CardTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => runTest('ga4', () => testGA4Connection({
                                ga_property_id: config.ga_property_id,
                                ga_client_email: config.ga_client_email,
                                ga_private_key: config.ga_private_key,
                            }))}
                            disabled={testStatus.ga4?.loading || !config.ga_property_id || !config.ga_client_email || !config.ga_private_key}
                        >
                            {testStatus.ga4?.loading ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : <RefreshCw className="w-3 h-3 mr-2" />}
                            Probar Conexión
                        </Button>
                    </div>
                    <CardDescription>
                        Conecta una cuenta de servicio de Google Cloud para extraer métricas de GA4 (Sesiones, Rebote).
                    </CardDescription>
                    {testStatus.ga4?.success && <p className="text-green-500 text-xs flex items-start mt-2"><CheckCircle2 className="w-4 h-4 mr-1 shrink-0" /> <span dangerouslySetInnerHTML={{ __html: testStatus.ga4.message || 'Conexión Exitosa' }} /></p>}
                    {testStatus.ga4?.error && <p className="text-red-500 text-xs flex items-start mt-2"><AlertCircle className="w-4 h-4 mr-1 shrink-0" /> <span>{testStatus.ga4.error}</span></p>}
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="ga_property_id" className="text-zinc-300">Property ID <span className="text-zinc-500 font-normal ml-1">(ej: 400123456)</span></Label>
                        <Input
                            id="ga_property_id"
                            value={config.ga_property_id || ''}
                            onChange={(e) => setConfig({ ...config, ga_property_id: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                    </div>

                    <div className="bg-zinc-950/60 border border-zinc-800 p-4 rounded-lg space-y-4 relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-1 h-full bg-indigo-500/50"></div>
                        
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center shrink-0">
                                <DownloadCloud className="w-5 h-5 text-indigo-400" />
                            </div>
                            <div>
                                <h4 className="text-sm font-medium text-zinc-200">Credenciales de Autenticación</h4>
                                <p className="text-xs text-zinc-500 mt-0.5">Sube el archivo JSON de tu Service Account de Google Cloud. Automáticamente extraeremos el Email y la Private Key aplicando el formato correcto.</p>
                            </div>
                        </div>

                        <div className="mt-3">
                            <Label className="cursor-pointer">
                                <div className="border border-dashed border-zinc-700 hover:border-indigo-500/50 bg-zinc-900/50 hover:bg-zinc-900 transition-colors p-4 rounded-lg text-center flex flex-col items-center justify-center gap-2">
                                    <DatabaseZap className="w-6 h-6 text-zinc-500" />
                                    <span className="text-sm text-zinc-400">Seleccionar o arrastrar archivo <strong>.json</strong></span>
                                </div>
                                <input
                                    type="file"
                                    accept=".json,application/json"
                                    onChange={handleGA4JSONUpload}
                                    className="hidden"
                                />
                            </Label>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                            <div className="space-y-2">
                                <Label htmlFor="ga_client_email" className="text-zinc-400 text-xs">Client Email (Auto-extraído)</Label>
                                <Input
                                    id="ga_client_email"
                                    value={config.ga_client_email || ''}
                                    readOnly
                                    className="bg-zinc-950/50 border-zinc-800 text-zinc-500 text-xs focus-visible:ring-0"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="ga_private_key" className="text-zinc-400 text-xs">Private Key (Auto-extraída)</Label>
                                <textarea
                                    id="ga_private_key"
                                    value={config.ga_private_key ? '•••••••••••••••••••••••••••• PRIVATE KEY LOADED ••••••••••••••••••••••••••••' : ''}
                                    readOnly
                                    className="w-full h-9 rounded-md bg-zinc-950/50 border border-zinc-800 px-3 py-2 text-xs text-zinc-500 resize-none focus-visible:outline-none focus-visible:ring-0"
                                />
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* ─── TikTok ───────────────────────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <CardTitle>TikTok Ads</CardTitle>
                    <CardDescription>Conecta una o más cuentas publicitarias de TikTok Ads. Los datos de todas las cuentas se consolidan en el reporte y pueden filtrarse por cuenta en el layout.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Shared token */}
                    <div className="space-y-2">
                        <Label className="text-zinc-300">Access Token Compartido</Label>
                        <Input
                            type="password"
                            placeholder="Tu TikTok Marketing API Access Token"
                            value={config.tiktok_access_token || ''}
                            onChange={(e) => setConfig({ ...config, tiktok_access_token: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                        <p className="text-xs text-zinc-500">Token OAuth o token manual. Las cuentas sin token propio usarán este.</p>
                    </div>

                    {/* OAuth button */}
                    <div className="flex flex-col gap-2">
                        <a href={`/api/auth/tiktok?client_id=${cliente.id}`}>
                            <Button variant="default" size="sm" className="w-full bg-[#ff2d55] hover:bg-[#e0003a] text-white">
                                {config.tiktok_access_token ? '🔄 Reconectar con TikTok Ads' : '🔗 Conectar con TikTok Ads'}
                            </Button>
                        </a>
                        {tiktokOAuthStatus?.success && <p className="text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Cuenta TikTok conectada exitosamente</p>}
                        {tiktokOAuthStatus?.error && <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {tiktokOAuthStatus.error}</p>}
                        {testStatus.tiktok?.success && <p className="text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Conexión Exitosa</p>}
                        {testStatus.tiktok?.error && <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {testStatus.tiktok.error}</p>}
                    </div>

                    {/* Multi-account list */}
                    <div className="space-y-3 pt-2 border-t border-zinc-800">
                        <div className="flex items-center justify-between">
                            <Label className="text-zinc-300">Cuentas Publicitarias TikTok</Label>
                            <Button size="sm" variant="outline" onClick={addTikTokAccount} className="h-7 text-xs">
                                <Plus className="w-3 h-3 mr-1" /> Agregar Cuenta
                            </Button>
                        </div>

                        {tiktokAccounts.length === 0 && (
                            <p className="text-xs text-zinc-500 py-3 text-center border border-dashed border-zinc-800 rounded-lg">
                                Sin cuentas configuradas. Conéctate via OAuth o agrega manualmente.
                            </p>
                        )}

                        {tiktokAccounts.map((acct, idx) => (
                            <TikTokAccountRow
                                key={acct.id}
                                account={acct}
                                sharedToken={config.tiktok_access_token || ''}
                                testStatus={testStatus[`tiktok_${acct.id}`]}
                                onChange={(updated) => updateTikTokAccount(idx, updated)}
                                onRemove={() => removeTikTokAccount(idx)}
                                onTest={() => runTest(`tiktok_${acct.id}`, () =>
                                    testTikTokConnection(acct.access_token || config.tiktok_access_token, acct.advertiser_id)
                                )}
                            />
                        ))}
                    </div>
                </CardContent>
            </Card>

            {/* ─── Google Sheets (Leads) ────────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <CardTitle>Google Sheets — Leads</CardTitle>
                    <CardDescription>
                        Conecta un Google Sheet de Meta Leads para calcular leads calificados automáticamente cada día a las 8 AM (hora Colombia).
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center gap-3">
                        <input
                            type="checkbox"
                            id="gs_enabled"
                            checked={config.google_sheets?.enabled || false}
                            onChange={(e) => setConfig({
                                ...config,
                                google_sheets: { ...config.google_sheets, enabled: e.target.checked }
                            })}
                            className="rounded border-zinc-600 bg-zinc-950 text-indigo-500 focus:ring-indigo-500"
                        />
                        <Label htmlFor="gs_enabled" className="text-zinc-300 cursor-pointer">Activar integración de Google Sheets</Label>
                    </div>

                    {config.google_sheets?.enabled && (
                        <>
                            {/* ── Credenciales de Autenticación (JSON upload) ── */}
                            <div className="bg-zinc-950/60 border border-zinc-800 p-4 rounded-lg space-y-4 relative overflow-hidden">
                                <div className="absolute top-0 left-0 w-1 h-full bg-green-500/50"></div>

                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
                                        <DownloadCloud className="w-5 h-5 text-green-400" />
                                    </div>
                                    <div>
                                        <h4 className="text-sm font-medium text-zinc-200">Credenciales de Autenticación</h4>
                                        <p className="text-xs text-zinc-500 mt-0.5">Sube el archivo JSON de tu Service Account de Google Cloud. Automáticamente extraeremos el Email y la Private Key aplicando el formato correcto.</p>
                                    </div>
                                </div>

                                <div className="mt-3">
                                    <Label className="cursor-pointer">
                                        <div className="border border-dashed border-zinc-700 hover:border-green-500/50 bg-zinc-900/50 hover:bg-zinc-900 transition-colors p-4 rounded-lg text-center flex flex-col items-center justify-center gap-2">
                                            <DatabaseZap className="w-6 h-6 text-zinc-500" />
                                            <span className="text-sm text-zinc-400">Seleccionar o arrastrar archivo <strong>.json</strong></span>
                                        </div>
                                        <input
                                            type="file"
                                            accept=".json,application/json"
                                            onChange={handleGoogleSheetsJSONUpload}
                                            className="hidden"
                                        />
                                    </Label>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                                    <div className="space-y-2">
                                        <Label className="text-zinc-400 text-xs">Client Email (Auto-extraído)</Label>
                                        <Input
                                            value={config.google_sheets?.client_email || ''}
                                            readOnly
                                            className="bg-zinc-950/50 border-zinc-800 text-zinc-500 text-xs focus-visible:ring-0"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label className="text-zinc-400 text-xs">Private Key (Auto-extraída)</Label>
                                        <textarea
                                            value={config.google_sheets?.private_key ? '•••••••••••••••••••••••••••• PRIVATE KEY LOADED ••••••••••••••••••••••••••••' : ''}
                                            readOnly
                                            className="w-full h-9 rounded-md bg-zinc-950/50 border border-zinc-800 px-3 py-2 text-xs text-zinc-500 resize-none focus-visible:outline-none focus-visible:ring-0"
                                        />
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="gs_url" className="text-zinc-300">URL del Google Sheet</Label>
                                <Input
                                    id="gs_url"
                                    placeholder="https://docs.google.com/spreadsheets/d/..."
                                    value={config.google_sheets?.sheet_url || ''}
                                    onChange={(e) => setConfig({
                                        ...config,
                                        google_sheets: { ...config.google_sheets, sheet_url: e.target.value }
                                    })}
                                    className="bg-zinc-950 border-zinc-700"
                                />
                                <p className="text-xs text-zinc-500">Asegúrate de compartir el Sheet con la cuenta de servicio de Google.</p>
                            </div>

                            <div className="space-y-2">
                                <Label className="text-zinc-300">Hojas a leer (pestañas del documento)</Label>
                                <p className="text-xs text-zinc-500 mb-2">Escribe el nombre exacto de cada pestaña, una por línea. Si dejas vacío, leerá la primera hoja. Los datos de todas las hojas se combinan.</p>
                                <textarea
                                    value={(config.google_sheets?.sheet_names || []).join('\n')}
                                    onChange={(e) => {
                                        const names = e.target.value.split('\n').filter((v: string) => v.trim())
                                        setConfig({
                                            ...config,
                                            google_sheets: { ...config.google_sheets, sheet_names: names }
                                        })
                                    }}
                                    placeholder={"Mes enero\nform filtro logico"}
                                    rows={3}
                                    className="w-full rounded-md bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 resize-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500"
                                />
                                <p className="text-xs text-zinc-500">Ejemplo: <span className="text-zinc-400 font-mono">Mes enero</span>, <span className="text-zinc-400 font-mono">form filtro logico</span></p>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="gs_quality_field" className="text-zinc-300">Campo de calidad (columna del Sheet)</Label>
                                <Input
                                    id="gs_quality_field"
                                    placeholder="cual_es_tu_rango_de_ingresos"
                                    value={config.google_sheets?.quality_field || ''}
                                    onChange={(e) => setConfig({
                                        ...config,
                                        google_sheets: { ...config.google_sheets, quality_field: e.target.value }
                                    })}
                                    className="bg-zinc-950 border-zinc-700"
                                />
                            </div>

                            <div className="space-y-2">
                                <Label className="text-zinc-300">Valores que califican como &quot;Lead Calificado&quot;</Label>
                                <p className="text-xs text-zinc-500 mb-2">Separar valores por línea. Un lead se considera calificado si su respuesta coincide con alguno de estos valores.</p>
                                <textarea
                                    value={(config.google_sheets?.qualified_values || []).join('\n')}
                                    onChange={(e) => {
                                        const values = e.target.value.split('\n').filter((v: string) => v.trim())
                                        setConfig({
                                            ...config,
                                            google_sheets: { ...config.google_sheets, qualified_values: values }
                                        })
                                    }}
                                    placeholder={"$5,000 - $20,000 USD\n$20,000+ USD\nMás de $50,000 USD"}
                                    rows={4}
                                    className="w-full rounded-md bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                                />
                            </div>

                            <div className="pt-4 border-t border-zinc-800">
                                <div className="flex gap-2 items-center">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => runTest('googleSheets', () => syncGoogleSheets(cliente.id))}
                                        disabled={testStatus['googleSheets']?.loading || !config.google_sheets?.sheet_url}
                                        className="h-8 text-xs"
                                    >
                                        {testStatus['googleSheets']?.loading
                                            ? <RefreshCw className="w-3 h-3 animate-spin mr-2" />
                                            : <DownloadCloud className="w-3 h-3 mr-2" />
                                        }
                                        Sincronizar ahora
                                    </Button>
                                    {testStatus['googleSheets']?.success && (
                                        <span className="text-green-500 text-xs flex items-center gap-1">
                                            <CheckCircle2 className="w-3 h-3" /> {testStatus['googleSheets']?.message || 'Sincronizado'}
                                        </span>
                                    )}
                                    {testStatus['googleSheets']?.error && (
                                        <span className="text-red-500 text-xs flex items-center gap-1">
                                            <AlertCircle className="w-3 h-3" /> {testStatus['googleSheets']?.error}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </CardContent>
            </Card>

            {/* ─── Filtros de Dashboard ─────────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800">
                <CardHeader>
                    <CardTitle>Filtros de Dashboard</CardTitle>
                    <CardDescription>Configura botones de filtrado rápido para el Dashboard (ej. nombres de campañas o proyectos).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="meta_keywords" className="text-zinc-300">Keywords de Campañas (Separadas por comas)</Label>
                        <Input
                            id="meta_keywords"
                            placeholder="Psicología, Pedagogía, Diplomado"
                            value={config.meta_keywords || ''}
                            onChange={(e) => setConfig({ ...config, meta_keywords: e.target.value })}
                            className="bg-zinc-950 border-zinc-700"
                        />
                        <p className="text-xs text-zinc-500">Estos textos aparecerán como botones de filtro rápido en la vista superior del embudo de Meta Ads.</p>
                    </div>
                </CardContent>
            </Card>

            {/* ─── Plantilla de Reporte ─────────────────────────────────────── */}
            <Card className="bg-zinc-900 border-zinc-800 border-indigo-500/30">
                <CardHeader>
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                            <LayoutDashboard className="w-5 h-5 text-indigo-400" />
                        </div>
                        <div>
                            <CardTitle className="text-white">Plantilla de Reporte</CardTitle>
                            <CardDescription className="text-zinc-400 mt-1">Selecciona la plantilla de métricas que quieres ver en el Dashboard de este cliente.</CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-3">
                        <Label className="text-zinc-300">Layout Activo</Label>
                        <select
                            value={selectedLayoutId}
                            onChange={async (e) => {
                                const newId = e.target.value
                                setSelectedLayoutId(newId)
                                setLayoutSaving(true)
                                await assignLayoutToCliente(cliente.id, newId || null)
                                setLayoutSaving(false)
                            }}
                            className="flex h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 ring-offset-zinc-950 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <option value="">— Sin plantilla (Vista clásica) —</option>
                            {layouts.map((l: any) => (
                                <option key={l.id} value={l.id}>{l.nombre}</option>
                            ))}
                        </select>

                        {layoutSaving && (
                            <div className="flex items-center gap-2 text-xs text-indigo-400">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Guardando asignación...
                            </div>
                        )}

                        {selectedLayoutId && (() => {
                            const activeLayout = layouts.find((l: any) => l.id === selectedLayoutId)
                            if (!activeLayout) return null
                            return (
                                <div className="bg-indigo-500/5 border border-indigo-500/20 rounded-lg p-4 space-y-2">
                                    <div className="flex items-center gap-2">
                                        <CheckCircle2 className="w-4 h-4 text-indigo-400" />
                                        <span className="text-sm font-medium text-indigo-300">{activeLayout.nombre}</span>
                                    </div>
                                    {activeLayout.descripcion && (
                                        <p className="text-xs text-zinc-400 ml-6">{activeLayout.descripcion}</p>
                                    )}
                                    <div className="ml-6 flex flex-wrap gap-2 mt-2">
                                        {(activeLayout.tarjetas || []).map((t: any) => (
                                            <span key={t.id} className="text-xs bg-zinc-800 text-zinc-300 px-2 py-1 rounded-md border border-zinc-700">{t.label}</span>
                                        ))}
                                    </div>
                                </div>
                            )
                        })()}

                        {!selectedLayoutId && (
                            <p className="text-xs text-zinc-500">Sin plantilla activa → el Dashboard usará la vista clásica con columnas basadas en APIs conectadas.</p>
                        )}
                    </div>
                </CardContent>
                <CardFooter className="bg-zinc-950/50 border-t border-zinc-800 flex justify-between pt-6">
                    {isAdmin && (
                        <Button variant="destructive" onClick={handleDelete} className="gap-2">
                            <Trash2 className="w-4 h-4" />
                            Eliminar Cliente
                        </Button>
                    )}
                    {!isAdmin && <div />}
                    <Button onClick={handleSave} disabled={loading} className="gap-2">
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                        Guardar Todo
                    </Button>
                </CardFooter>
            </Card>

        </div>
    )
}
