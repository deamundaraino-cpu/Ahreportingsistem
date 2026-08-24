'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { updateClienteConfig, deleteCliente, assignLayoutToCliente, testMetaConnection, testHotmartConnection, refreshMetaCustomConversions, testTikTokConnection, syncClienteMetrics, testGA4Connection, syncTandaConversiones, detectConversionesColumns, previewEliminarSheet, eliminarSheetConversiones, listConversionesTabs, getConversionesSyncStatus, listDriveSheets, listGa4Properties, fetchMetaAdAccounts, fetchTikTokAdAccounts } from '../_actions'
import type { ConversionesConfig, DriveSheet, SheetTabConfig, SheetTabInfo, SheetSyncStatus } from '@/lib/integrations/google-sheets-conversiones'
import type { SheetEliminarPreview } from '../_actions'
import type { GA4Property } from '@/lib/integrations/google-analytics'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SheetCamposSection } from './sheet-campos/SheetCamposSection'
import { Loader2, ArrowLeft, Save, Trash2, CheckCircle2, AlertCircle, RefreshCw, LayoutDashboard, DownloadCloud, DatabaseZap, Plus, FolderSearch, FileSpreadsheet, Search, BarChart3, ChevronDown, Lock } from 'lucide-react'

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
        <div className="bg-muted/40 border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Input
                    placeholder="Nombre de la cuenta (ej: Cuenta Principal)"
                    value={account.label}
                    onChange={(e) => onChange({ ...account, label: e.target.value })}
                    className="bg-background border-input h-8 text-sm"
                />
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRemove}
                    className="text-muted-foreground/70 hover:text-red-600 dark:hover:text-red-400 shrink-0 h-8 w-8 p-0"
                >
                    <Trash2 className="w-4 h-4" />
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Ad Account ID</Label>
                    <Input
                        placeholder="act_1234567890"
                        value={account.account_id}
                        onChange={(e) => onChange({ ...account, account_id: e.target.value })}
                        className="bg-background border-input h-8 text-sm"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Token propio (opcional)</Label>
                    <Input
                        type="password"
                        placeholder={sharedToken ? 'Usa token compartido' : 'EAA...'}
                        value={account.token}
                        onChange={(e) => onChange({ ...account, token: e.target.value })}
                        className="bg-background border-input h-8 text-sm"
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
                    <span className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1">
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
        <div className="bg-muted/40 border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Input
                    placeholder="Nombre de la cuenta (ej: Cuenta Principal)"
                    value={account.label}
                    onChange={(e) => onChange({ ...account, label: e.target.value })}
                    className="bg-background border-input h-8 text-sm"
                />
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onRemove}
                    className="text-muted-foreground/70 hover:text-red-600 dark:hover:text-red-400 shrink-0 h-8 w-8 p-0"
                >
                    <Trash2 className="w-4 h-4" />
                </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Advertiser ID</Label>
                    <Input
                        placeholder="1234567890123456789"
                        value={account.advertiser_id}
                        onChange={(e) => onChange({ ...account, advertiser_id: e.target.value })}
                        className="bg-background border-input h-8 text-sm"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">Token propio (opcional)</Label>
                    <Input
                        type="password"
                        placeholder={sharedToken ? 'Usa token compartido' : 'Token...'}
                        value={account.access_token}
                        onChange={(e) => onChange({ ...account, access_token: e.target.value })}
                        className="bg-background border-input h-8 text-sm"
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
                    <span className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1">
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

export function ClientConfigForm({ cliente, layouts = [], isAdmin = false, googleConnected = false, googleEmail = null }: { cliente: any; layouts?: any[]; isAdmin?: boolean; googleConnected?: boolean; googleEmail?: string | null }) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [config, setConfig] = useState<any>(() => {
        const initial = { ...(cliente.config_api || {}) }
        // Normalize google_sheets_conversiones to always be an array
        const rawConv = initial.google_sheets_conversiones
        if (rawConv && !Array.isArray(rawConv) && typeof rawConv === 'object') {
            // El id tiene que ser 'legacy', el mismo que le pone
            // `normalizeSheetConfigs` en el servidor. Con un `crypto.randomUUID()`
            // aquí, abrir esta pantalla y guardar le cambiaba el id al documento
            // y toda su historia quedaba huérfana — el sheet_id es la clave de
            // partición de conversiones_offline, _diarias y sheet_filas.
            initial.google_sheets_conversiones = [{
                id: 'legacy',
                name: 'Sheet Principal',
                ...rawConv,
            }]
        } else if (!Array.isArray(rawConv)) {
            initial.google_sheets_conversiones = []
        }
        return initial
    })
    const [tiktokOAuthStatus, setTiktokOAuthStatus] = useState<{ success?: boolean; error?: string } | null>(null)
    const [metaOAuthStatus, setMetaOAuthStatus] = useState<{ success?: boolean; error?: string } | null>(null)
    const [hotmartOAuthStatus, setHotmartOAuthStatus] = useState<{ success?: boolean; error?: string } | null>(null)
    const [showHotmartAdvanced, setShowHotmartAdvanced] = useState(false)

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
        if (searchParams.get('hotmart_connected')) {
            setHotmartOAuthStatus({ success: true })
            setConfig((prev: any) => ({ ...prev, hotmart_auth_mode: 'hotconnect', hotmart_connection_status: 'connected' }))
        } else if (searchParams.get('hotmart_error')) {
            setHotmartOAuthStatus({ error: decodeURIComponent(searchParams.get('hotmart_error')!) })
        }
    }, [searchParams])
const [testStatus, setTestStatus] = useState<{ [key: string]: { loading: boolean, success?: boolean, error?: string, message?: string } }>({})
    const [layoutSaving, setLayoutSaving] = useState(false)
    // ── Conversiones Offline multi-sheet UI state ────────────────────────────
    // Por pestaña: clave `${sheetId}:${tabId}` → encabezados leídos del Sheet al
    // validar, para autocompletar el mapeo de columnas.
    const [sheetUI, setSheetUI] = useState<Record<string, { headers?: string[] }>>({})
    // Por sheet: pestañas reales descubiertas en el documento.
    const [tabsUI, setTabsUI] = useState<Record<string, { loading: boolean; error: string | null; available: SheetTabInfo[] }>>({})
    // Por sheet: resultado de "Validar configuración".
    const [validateUI, setValidateUI] = useState<Record<string, { loading: boolean; results: { tab: string; ok: boolean; message: string }[] }>>({})
    // Por sheet: último sync registrado (filas ok/descartadas, avisos por pestaña).
    const [convSyncStatus, setConvSyncStatus] = useState<Record<string, SheetSyncStatus>>({})
    // "Sincronizar todos" va documento a documento: sin esto el botón se queda
    // mudo un minuto largo y parece colgado.
    const [convSyncProgreso, setConvSyncProgreso] = useState<string | null>(null)

    /**
     * Sheets ya guardados: su URL queda en solo lectura.
     *
     * El `sheet_id` es la clave de partición de las tres tablas de Sheets, así que
     * apuntar un sheet existente a otro documento mezcla dos documentos en la
     * misma partición, y borrarlo para volver a crearlo deja la historia entera
     * huérfana. Se cambia de documento borrando este y añadiendo otro, que es
     * explícito sobre lo que le pasa al dato.
     */
    const [sheetsBloqueados, setSheetsBloqueados] = useState<Set<string>>(() => {
        const guardado = cliente.config_api?.google_sheets_conversiones
        // Los ids ausentes se derivan de la posición y el objeto legacy es
        // 'legacy': mismas reglas que `normalizeSheetConfigs` en el servidor.
        if (Array.isArray(guardado)) {
            return new Set(guardado.map((s: ConversionesConfig, i: number) => s?.id || `sheet_${i}`))
        }
        return new Set(guardado && typeof guardado === 'object' ? ['legacy'] : [])
    })

    // Borrado de un sheet: confirmación con lo que se lleva por delante, y progreso.
    const [borrarSheet, setBorrarSheet] = useState<{
        idx: number
        sid: string
        nombre: string
        preview?: SheetEliminarPreview
        cargando: boolean
        borrando: boolean
        progreso: number
        error?: string
    } | null>(null)

    // El estado del último sync vive en la BD (tabla de log), no en la config.
    useEffect(() => {
        let cancelled = false
        getConversionesSyncStatus(cliente.id).then(res => {
            if (!cancelled && 'lastSync' in res && res.lastSync) setConvSyncStatus(res.lastSync)
        }).catch(() => { /* la tabla de log puede no existir aún */ })
        return () => { cancelled = true }
    }, [cliente.id])
    // Sheet picker modal
    const [pickerOpen, setPickerOpen] = useState(false)
    const [pickerForSheetId, setPickerForSheetId] = useState<string | null>(null)
    const [driveSheets, setDriveSheets] = useState<DriveSheet[]>([])
    const [driveLoading, setDriveLoading] = useState(false)
    const [driveError, setDriveError] = useState<string | null>(null)
    const [driveQuery, setDriveQuery] = useState('')
    // ── Selector de propiedad GA4 (vía OAuth de agencia) ─────────────────────
    const [ga4PickerOpen, setGa4PickerOpen] = useState(false)
    const [ga4Properties, setGa4Properties] = useState<GA4Property[]>([])
    const [ga4Loading, setGa4Loading] = useState(false)
    const [ga4Error, setGa4Error] = useState<string | null>(null)
    const [ga4Query, setGa4Query] = useState('')
    const [showGa4Legacy, setShowGa4Legacy] = useState(!googleConnected)
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

    // ── Selector de cuentas Meta (elegir cuáles agregar) ─────────────────────
    const [loadingMetaAccounts, setLoadingMetaAccounts] = useState(false)
    const [availableMetaAccounts, setAvailableMetaAccounts] = useState<{ account_id: string; name: string }[] | null>(null)
    const [selectedMetaIds, setSelectedMetaIds] = useState<Set<string>>(new Set())
    const [metaPickerError, setMetaPickerError] = useState<string | null>(null)

    async function openMetaAccountPicker() {
        const token = config.meta_token
        if (!token) {
            alert('Primero conecta por OAuth o pega un Access Token compartido.')
            return
        }
        setLoadingMetaAccounts(true)
        setMetaPickerError(null)
        try {
            const res = await fetchMetaAdAccounts(token)
            if (res.error) {
                setMetaPickerError(res.error)
                setAvailableMetaAccounts([])
                return
            }
            setAvailableMetaAccounts(res.accounts || [])
            setSelectedMetaIds(new Set())
        } finally {
            setLoadingMetaAccounts(false)
        }
    }

    function toggleMetaSelection(accountId: string) {
        setSelectedMetaIds(prev => {
            const next = new Set(prev)
            if (next.has(accountId)) next.delete(accountId)
            else next.add(accountId)
            return next
        })
    }

    function addSelectedMetaAccounts() {
        if (!availableMetaAccounts) return
        const chosen = availableMetaAccounts.filter(a => selectedMetaIds.has(a.account_id))
        setMetaAccounts(prev => {
            const existingIds = new Set(prev.map(a => a.account_id))
            const newOnes = chosen
                .filter(a => !existingIds.has(a.account_id))
                .map(a => ({ id: crypto.randomUUID(), label: a.name, account_id: a.account_id, token: '' }))
            return [...prev, ...newOnes]
        })
        setAvailableMetaAccounts(null)
        setSelectedMetaIds(new Set())
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

    // ── Selector de cuentas TikTok (elegir cuáles agregar) ───────────────────
    const [loadingTiktokAccounts, setLoadingTiktokAccounts] = useState(false)
    const [availableTiktokAccounts, setAvailableTiktokAccounts] = useState<{ advertiser_id: string; name: string }[] | null>(null)
    const [selectedTiktokIds, setSelectedTiktokIds] = useState<Set<string>>(new Set())
    const [tiktokPickerError, setTiktokPickerError] = useState<string | null>(null)

    async function openTikTokAccountPicker() {
        const token = config.tiktok_access_token
        if (!token) {
            alert('Primero conecta por OAuth o pega un Access Token compartido.')
            return
        }
        setLoadingTiktokAccounts(true)
        setTiktokPickerError(null)
        try {
            const res = await fetchTikTokAdAccounts(token)
            if (res.error) {
                setTiktokPickerError(res.error)
                setAvailableTiktokAccounts([])
                return
            }
            setAvailableTiktokAccounts(res.accounts || [])
            setSelectedTiktokIds(new Set())
        } finally {
            setLoadingTiktokAccounts(false)
        }
    }

    function toggleTiktokSelection(advertiserId: string) {
        setSelectedTiktokIds(prev => {
            const next = new Set(prev)
            if (next.has(advertiserId)) next.delete(advertiserId)
            else next.add(advertiserId)
            return next
        })
    }

    function addSelectedTikTokAccounts() {
        if (!availableTiktokAccounts) return
        const chosen = availableTiktokAccounts.filter(a => selectedTiktokIds.has(a.advertiser_id))
        setTiktokAccounts(prev => {
            const existingIds = new Set(prev.map(a => a.advertiser_id))
            const newOnes = chosen
                .filter(a => !existingIds.has(a.advertiser_id))
                .map(a => ({ id: crypto.randomUUID(), label: a.name, advertiser_id: a.advertiser_id, access_token: '' }))
            return [...prev, ...newOnes]
        })
        setAvailableTiktokAccounts(null)
        setSelectedTiktokIds(new Set())
    }

    // ── Selector de propiedad GA4 ────────────────────────────────────────────
    async function openGa4Picker() {
        setGa4PickerOpen(true)
        setGa4Loading(true)
        setGa4Error(null)
        setGa4Query('')
        const res = await listGa4Properties()
        if ('error' in res && res.error) {
            setGa4Error(res.error)
            setGa4Properties([])
        } else {
            setGa4Properties(res.properties ?? [])
        }
        setGa4Loading(false)
    }

    function selectGa4Property(prop: GA4Property) {
        // Guardamos también el nombre para poder mostrarlo sin volver a llamar a la API.
        setConfig({
            ...config,
            ga_property_id: prop.id,
            ga_property_name: prop.name,
            ga_account_name: prop.accountName,
        })
        setGa4PickerOpen(false)
    }

    const filteredGa4Properties = ga4Properties.filter(p => {
        if (!ga4Query) return true
        const q = ga4Query.toLowerCase()
        return p.name.toLowerCase().includes(q)
            || p.accountName.toLowerCase().includes(q)
            || p.id.includes(q)
    })

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
                        : res.totalFilas !== undefined
                        // Un "0 filas" a secas no dice nada: se añade cuántas se
                        // descartaron y el primer aviso que lo explica.
                        ? [
                            `${res.totalFilas} filas importadas`,
                            `${res.diasProcesados ?? 0} días guardados`,
                            ...(res.filasDescartadas ? [`${res.filasDescartadas} descartadas`] : []),
                            ...(Array.isArray(res.warnings) && res.warnings.length > 0
                                ? [res.warnings.length === 1 ? res.warnings[0] : `${res.warnings[0]} (+${res.warnings.length - 1} avisos)`]
                                : []),
                          ].join(' | ')
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

    async function testHotmart() {
        setTestStatus(prev => ({ ...prev, hotmart: { loading: true } }))
        try {
            const res = await testHotmartConnection(config, cliente.id)
            const now = new Date().toISOString()
            if (res.error) {
                setConfig((p: any) => ({ ...p, hotmart_connection_status: 'error', hotmart_last_checked_at: now }))
                setTestStatus(prev => ({ ...prev, hotmart: { loading: false, error: res.error } }))
            } else {
                setConfig((p: any) => ({ ...p, hotmart_connection_status: 'connected', hotmart_last_checked_at: now }))
                setTestStatus(prev => ({ ...prev, hotmart: { loading: false, success: true } }))
            }
        } catch (err: any) {
            setTestStatus(prev => ({ ...prev, hotmart: { loading: false, error: err.message } }))
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
            // Lo guardado ya tiene (o tendrá) datos colgando de su sheet_id: a
            // partir de aquí el documento no se cambia, se elimina y se añade otro.
            setSheetsBloqueados(new Set(
                ((finalConfig.google_sheets_conversiones ?? []) as ConversionesConfig[])
                    .map((s, i) => s?.id || `sheet_${i}`)
            ))
            router.refresh()
        }
        setLoading(false)
        return { success, error: updateError }
    }

    /** Abre el diálogo de borrado y pide qué se llevará por delante. */
    async function abrirBorradoSheet(idx: number, sid: string, nombre: string) {
        setBorrarSheet({ idx, sid, nombre, cargando: true, borrando: false, progreso: 0 })
        const res = await previewEliminarSheet(cliente.id, sid)
        setBorrarSheet(prev => prev && prev.sid === sid
            ? ('error' in res
                ? { ...prev, cargando: false, error: res.error }
                : { ...prev, cargando: false, preview: res })
            : prev)
    }

    /**
     * Borra el sheet y sus datos. El endpoint va por tandas y contesta
     * `done:false` mientras queden filas, así que se le llama en bucle: un
     * documento de decenas de miles de filas se retira entero sin que ninguna
     * petición se acerque al límite de tiempo de la función.
     */
    async function confirmarBorradoSheet() {
        const objetivo = borrarSheet
        if (!objetivo) return
        setBorrarSheet({ ...objetivo, borrando: true, error: undefined })

        let borradas = 0
        for (let intento = 0; intento < 200; intento++) {
            const res = await eliminarSheetConversiones(cliente.id, objetivo.sid)
            if (res.error) {
                setBorrarSheet(prev => prev ? { ...prev, borrando: false, error: res.error } : prev)
                return
            }
            borradas += res.borradas ?? 0
            setBorrarSheet(prev => prev ? { ...prev, progreso: borradas } : prev)
            if (res.done) {
                // La config ya la actualizó el servidor; el estado local se pone al día
                // para no volver a guardar el sheet recién retirado.
                setConfig((prev: any) => ({
                    ...prev,
                    google_sheets_conversiones: (prev.google_sheets_conversiones ?? [])
                        .filter((s: ConversionesConfig, i: number) => (s?.id || `sheet_${i}`) !== objetivo.sid),
                }))
                setSheetsBloqueados(prev => {
                    const next = new Set(prev)
                    next.delete(objetivo.sid)
                    return next
                })
                setBorrarSheet(null)
                if (res.warning) setError(res.warning)
                router.refresh()
                return
            }
        }
        setBorrarSheet(prev => prev
            ? { ...prev, borrando: false, error: 'Quedan filas por borrar. Vuelve a pulsar Eliminar para continuar.' }
            : prev)
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
            <Card className="bg-card border-border">
                <CardHeader>
                    <CardTitle>Meta Ads Configuration</CardTitle>
                    <CardDescription>
                        Conecta una o más cuentas publicitarias de Meta. Los datos de todas las cuentas se consolidarán en el reporte.
                    </CardDescription>
                    {testStatus.metaSync?.success && (
                        <p className="text-emerald-600 dark:text-emerald-400 text-sm flex items-center mt-2 p-2 bg-emerald-500/10 rounded">
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
                    <div className="flex flex-col gap-2 pb-4 border-b border-border">
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
                        {metaOAuthStatus?.success && <p className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Cuenta de Facebook conectada exitosamente</p>}
                        {metaOAuthStatus?.error && <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {metaOAuthStatus.error}</p>}
                    </div>

                    {/* Shared token */}
                    <div className="space-y-2">
                        <Label htmlFor="meta_token" className="text-foreground/90">
                            Access Token Compartido
                        </Label>
                        <Input
                            id="meta_token"
                            type="password"
                            placeholder="EAA..."
                            value={config.meta_token || ''}
                            onChange={(e) => setConfig({ ...config, meta_token: e.target.value })}
                            className="bg-background border-input"
                        />
                        <p className="text-xs text-muted-foreground/70">
                            Se completa automáticamente al conectar por OAuth. Si una cuenta no tiene token propio, se usará este.
                            Para una conexión que <strong>no caduca</strong>, pega aquí un <strong>System User token</strong> del Business Manager.
                        </p>
                    </div>

                    {/* Account list */}
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <Label className="text-foreground/90">Cuentas Publicitarias</Label>
                            <div className="flex items-center gap-2">
                                <Button size="sm" variant="outline" onClick={openMetaAccountPicker} disabled={loadingMetaAccounts || !config.meta_token} className="h-7 text-xs">
                                    {loadingMetaAccounts ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <DownloadCloud className="w-3 h-3 mr-1" />} Elegir cuentas
                                </Button>
                                <Button size="sm" variant="outline" onClick={addAccount} className="h-7 text-xs">
                                    <Plus className="w-3 h-3 mr-1" /> Agregar Cuenta
                                </Button>
                            </div>
                        </div>

                        {/* Selector de cuentas disponibles desde el token */}
                        {availableMetaAccounts && (
                            <div className="bg-muted/40 border border-indigo-500/30 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <p className="text-sm text-foreground font-medium">Cuentas disponibles en tu Facebook</p>
                                    <Button variant="ghost" size="sm" onClick={() => setAvailableMetaAccounts(null)} className="h-6 text-xs text-muted-foreground/70 hover:text-foreground/90">Cancelar</Button>
                                </div>
                                {metaPickerError && (
                                    <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {metaPickerError}</p>
                                )}
                                {availableMetaAccounts.length === 0 && !metaPickerError && (
                                    <p className="text-xs text-muted-foreground/70">No se encontraron cuentas publicitarias para este token.</p>
                                )}
                                <div className="space-y-1 max-h-64 overflow-y-auto">
                                    {availableMetaAccounts.map(a => {
                                        const alreadyAdded = metaAccounts.some(m => m.account_id === a.account_id)
                                        return (
                                            <label key={a.account_id} className={`flex items-center gap-3 p-2 rounded-md ${alreadyAdded ? 'opacity-50' : 'hover:bg-accent cursor-pointer'}`}>
                                                <input
                                                    type="checkbox"
                                                    disabled={alreadyAdded}
                                                    checked={alreadyAdded || selectedMetaIds.has(a.account_id)}
                                                    onChange={() => toggleMetaSelection(a.account_id)}
                                                    className="rounded border-input bg-background text-indigo-500 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm text-foreground flex-1">{a.name}</span>
                                                <span className="text-xs text-muted-foreground/70 font-mono">{a.account_id}</span>
                                                {alreadyAdded && <span className="text-xs text-green-500">ya agregada</span>}
                                            </label>
                                        )
                                    })}
                                </div>
                                {availableMetaAccounts.length > 0 && (
                                    <div className="flex justify-end">
                                        <Button size="sm" onClick={addSelectedMetaAccounts} disabled={selectedMetaIds.size === 0} className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700">
                                            <Plus className="w-3 h-3 mr-1" /> Agregar {selectedMetaIds.size > 0 ? `(${selectedMetaIds.size})` : ''}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}

                        {metaAccounts.length === 0 && (
                            <p className="text-xs text-muted-foreground/70 py-3 text-center border border-dashed border-border rounded-lg">
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
                    <div className="pt-4 mt-2 border-t border-border">
                        <div className="flex justify-between items-center bg-muted/50 p-3 rounded-lg border border-border">
                            <div>
                                <h4 className="text-sm font-medium text-foreground">Conversiones Personalizadas</h4>
                                <p className="text-xs text-muted-foreground/70 mt-1">Busca y actualiza todos los eventos personalizados detectados en Meta durante los últimos 30 días.</p>
                            </div>
                            <Button
                                variant="secondary"
                                size="sm"
                                className="bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/30 border border-indigo-500/30 whitespace-nowrap"
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
            <Card className="bg-card border-indigo-500/20">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-indigo-700 dark:text-indigo-300">
                        <DatabaseZap className="w-5 h-5" />
                        Sincronizar Datos Diarios
                    </CardTitle>
                    <CardDescription className="text-muted-foreground">
                        Carga o recarga los datos de Meta y Hotmart para el rango de fechas seleccionado.
                        Usa esto cuando falten datos o para actualizar métricas históricas.
                    </CardDescription>
                    {testStatus.dataSync?.success && (
                        <p className="text-emerald-600 dark:text-emerald-400 text-sm flex items-start gap-2 mt-2 p-3 bg-emerald-500/10 rounded">
                            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>{testStatus.dataSync.message}</span>
                        </p>
                    )}
                    {testStatus.dataSync?.error && (
                        <p className="text-red-600 dark:text-red-400 text-sm flex items-start gap-2 mt-2 p-3 bg-red-500/10 rounded">
                            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                            <span>{testStatus.dataSync.error}</span>
                        </p>
                    )}
                </CardHeader>
                <CardContent>
                    <div className="flex items-end gap-3 flex-wrap">
                        <div className="space-y-1.5 flex-1 min-w-[140px]">
                            <Label className="text-muted-foreground text-xs">Fecha inicio</Label>
                            <Input
                                type="date"
                                value={syncStart}
                                onChange={e => setSyncStart(e.target.value)}
                                className="bg-background border-input text-foreground h-9"
                            />
                        </div>
                        <div className="space-y-1.5 flex-1 min-w-[140px]">
                            <Label className="text-muted-foreground text-xs">Fecha fin</Label>
                            <Input
                                type="date"
                                value={syncEnd}
                                onChange={e => setSyncEnd(e.target.value)}
                                className="bg-background border-input text-foreground h-9"
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
            <Card className="bg-card border-border">
                <CardHeader>
                    <div className="flex justify-between items-center">
                        <CardTitle>Hotmart</CardTitle>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={testHotmart}
                            disabled={testStatus.hotmart?.loading}
                        >
                            {testStatus.hotmart?.loading ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : <RefreshCw className="w-3 h-3 mr-2" />}
                            Probar Conexión
                        </Button>
                    </div>
                    <CardDescription>Conecta la cuenta de Hotmart del cliente para sincronizar ventas, comisiones y afiliados.</CardDescription>
                    {testStatus.hotmart?.success && <p className="text-green-600 dark:text-green-500 text-xs flex items-center mt-2"><CheckCircle2 className="w-3 h-3 mr-1" /> Conexión Exitosa</p>}
                    {testStatus.hotmart?.error && <p className="text-red-500 text-xs flex items-center mt-2"><AlertCircle className="w-3 h-3 mr-1" /> {testStatus.hotmart.error}</p>}
                </CardHeader>
                <CardContent className="space-y-5">
                    {/* OAuth (HotConnect) connect + estado de conexión */}
                    <div className="flex flex-col gap-2 pb-4 border-b border-border">
                        <a href={`/api/auth/hotmart?client_id=${cliente.id}`}>
                            <Button variant="default" size="sm" className="w-full bg-[#ef4a23] hover:bg-[#d63d18] text-white">
                                {config.hotmart_auth_mode === 'hotconnect' ? '🔄 Reconectar con Hotmart' : '🔗 Conectar con Hotmart'}
                            </Button>
                        </a>
                        {(() => {
                            if (config.hotmart_connection_status === 'expired') {
                                return <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Token vencido, reconecta con Hotmart</p>
                            }
                            if (config.hotmart_auth_mode === 'hotconnect' && config.hotmart_connection_status === 'connected') {
                                return <p className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Conectado por HotConnect · el token se renueva automáticamente</p>
                            }
                            if (config.hotmart_connection_status === 'connected') {
                                return <p className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Conectado con credenciales</p>
                            }
                            return null
                        })()}
                        {hotmartOAuthStatus?.success && <p className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Cuenta de Hotmart conectada exitosamente</p>}
                        {hotmartOAuthStatus?.error && <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {hotmartOAuthStatus.error}</p>}
                    </div>

                    {/* Guía paso a paso para pegar credenciales */}
                    <div className="bg-orange-500/5 border border-orange-500/20 rounded-lg p-3">
                        <p className="text-xs text-orange-700 dark:text-orange-300/90 leading-relaxed">
                            <strong className="text-orange-600 dark:text-orange-400">¿Prefieres pegar credenciales?</strong> En la cuenta de Hotmart del cliente:
                            <br />1. Entra a <strong>Herramientas → Credenciales de Desarrollador</strong>.
                            <br />2. Crea una credencial (entorno <strong>Producción</strong>).
                            <br />3. Copia el <strong>Client ID</strong> y <strong>Client Secret</strong> y pégalos abajo.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="hotmart_client_id" className="text-foreground/90">Client ID</Label>
                        <Input
                            id="hotmart_client_id"
                            value={config.hotmart_client_id || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_client_id: e.target.value })}
                            className="bg-background border-input"
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="hotmart_client_secret" className="text-foreground/90">Client Secret</Label>
                        <Input
                            id="hotmart_client_secret"
                            type="password"
                            value={config.hotmart_client_secret || ''}
                            onChange={(e) => setConfig({ ...config, hotmart_client_secret: e.target.value })}
                            className="bg-background border-input"
                        />
                    </div>

                    {/* Avanzado: campos manuales raramente necesarios */}
                    <div className="pt-1">
                        <button
                            type="button"
                            onClick={() => setShowHotmartAdvanced(v => !v)}
                            className="text-xs text-muted-foreground/70 hover:text-foreground/90"
                        >
                            {showHotmartAdvanced ? '▾ Ocultar avanzado' : '▸ Opciones avanzadas'}
                        </button>
                        {showHotmartAdvanced && (
                            <div className="space-y-4 mt-3">
                                <div className="space-y-2">
                                    <Label htmlFor="hotmart_token" className="text-foreground/90">Access Token Temporal (opcional)</Label>
                                    <Input
                                        id="hotmart_token"
                                        type="password"
                                        value={config.hotmart_token || ''}
                                        onChange={(e) => setConfig({ ...config, hotmart_token: e.target.value })}
                                        className="bg-background border-input"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="hotmart_basic" className="text-foreground/90">Basic Auth (Base64 Client ID:Secret)</Label>
                                    <Input
                                        id="hotmart_basic"
                                        type="password"
                                        value={config.hotmart_basic || ''}
                                        onChange={(e) => setConfig({ ...config, hotmart_basic: e.target.value })}
                                        className="bg-background border-input"
                                    />
                                    <p className="text-xs text-muted-foreground/70">Se calcula automáticamente desde Client ID + Secret al guardar. Solo edítalo si tienes el token Basic directamente.</p>
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="pt-4 border-t border-border">
                        <div className="bg-muted/40 border border-border/50 rounded-lg p-3">
                            <p className="text-xs text-muted-foreground leading-relaxed">
                                <strong className="text-foreground/90">Filtros de productos por funnel</strong> — La configuración de productos (Principal / Order Bump / Upsell) y URLs de página se hace <strong>por pestaña</strong> desde el dashboard del cliente. Cada pestaña representa un funnel independiente con sus propias métricas.
                            </p>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* ─── Google Analytics 4 (GA4) ─────────────────────────────────── */}
            <Card className="bg-card border-border">
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
                            disabled={testStatus.ga4?.loading || !config.ga_property_id || (!googleConnected && (!config.ga_client_email || !config.ga_private_key))}
                        >
                            {testStatus.ga4?.loading ? <RefreshCw className="w-3 h-3 animate-spin mr-2" /> : <RefreshCw className="w-3 h-3 mr-2" />}
                            Probar Conexión
                        </Button>
                    </div>
                    <CardDescription>
                        {googleConnected
                            ? 'Selecciona la propiedad de GA4 que corresponde a este cliente. Se usan los permisos de la cuenta de Google de la agencia.'
                            : 'Conecta una cuenta de servicio de Google Cloud para extraer métricas de GA4 (Sesiones, Rebote).'}
                    </CardDescription>
                    {testStatus.ga4?.success && <p className="text-green-600 dark:text-green-500 text-xs flex items-start mt-2"><CheckCircle2 className="w-4 h-4 mr-1 shrink-0" /> <span>{testStatus.ga4.message || 'Conexión Exitosa'}</span></p>}
                    {testStatus.ga4?.error && <p className="text-red-500 text-xs flex items-start mt-2"><AlertCircle className="w-4 h-4 mr-1 shrink-0" /> <span>{testStatus.ga4.error}</span></p>}
                </CardHeader>
                <CardContent className="space-y-4">
                    {googleConnected ? (
                        <div className="space-y-2">
                            <Label className="text-foreground/90">Propiedad de GA4</Label>
                            {config.ga_property_id ? (
                                <div className="flex items-center justify-between gap-3 bg-muted/50 border border-border rounded-lg px-3 py-2.5">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <BarChart3 className="w-4 h-4 text-orange-500 shrink-0" />
                                        <div className="min-w-0">
                                            <p className="text-sm font-medium text-foreground truncate">
                                                {config.ga_property_name || `Propiedad ${config.ga_property_id}`}
                                            </p>
                                            <p className="text-xs text-muted-foreground truncate">
                                                {config.ga_account_name ? `${config.ga_account_name} · ` : ''}ID {config.ga_property_id}
                                            </p>
                                        </div>
                                    </div>
                                    <Button variant="outline" size="sm" onClick={openGa4Picker} className="shrink-0">
                                        Cambiar
                                    </Button>
                                </div>
                            ) : (
                                <Button variant="outline" onClick={openGa4Picker} className="w-full justify-start">
                                    <FolderSearch className="w-4 h-4 mr-2" />
                                    Seleccionar propiedad de GA4…
                                </Button>
                            )}
                            <p className="text-xs text-muted-foreground">
                                Se listan las propiedades a las que tiene acceso {googleEmail || 'la cuenta de Google de la agencia'}.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            <Label htmlFor="ga_property_id" className="text-foreground/90">Property ID <span className="text-muted-foreground/70 font-normal ml-1">(ej: 400123456)</span></Label>
                            <Input
                                id="ga_property_id"
                                value={config.ga_property_id || ''}
                                onChange={(e) => setConfig({ ...config, ga_property_id: e.target.value })}
                                className="bg-background border-input"
                            />
                            <p className="text-xs text-amber-700 dark:text-amber-400/80 bg-amber-500/5 border border-amber-500/20 rounded p-2">
                                No hay una cuenta de Google de la agencia conectada. Conéctala en{' '}
                                <a href="/admin/settings" className="underline">Ajustes → Conexión Google</a> para elegir la
                                propiedad de una lista en vez de teclear el ID, o usa las credenciales de Service Account de abajo.
                            </p>
                        </div>
                    )}

                    {/* Service Account: modo legacy, plegado cuando hay OAuth de agencia. */}
                    <button
                        type="button"
                        onClick={() => setShowGa4Legacy(v => !v)}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showGa4Legacy ? '' : '-rotate-90'}`} />
                        Credenciales de Service Account (legacy, opcional)
                    </button>

                    <div className={`bg-muted/40 border border-border p-4 rounded-lg space-y-4 relative overflow-hidden ${showGa4Legacy ? '' : 'hidden'}`}>
                        <div className="absolute top-0 left-0 w-1 h-full bg-indigo-500/50"></div>
                        
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full bg-indigo-500/10 flex items-center justify-center shrink-0">
                                <DownloadCloud className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                            </div>
                            <div>
                                <h4 className="text-sm font-medium text-foreground">Credenciales de Autenticación</h4>
                                <p className="text-xs text-muted-foreground/70 mt-0.5">Sube el archivo JSON de tu Service Account de Google Cloud. Automáticamente extraeremos el Email y la Private Key aplicando el formato correcto.</p>
                            </div>
                        </div>

                        <div className="mt-3">
                            <Label className="cursor-pointer">
                                <div className="border border-dashed border-input hover:border-indigo-500/50 bg-muted/50 hover:bg-muted transition-colors p-4 rounded-lg text-center flex flex-col items-center justify-center gap-2">
                                    <DatabaseZap className="w-6 h-6 text-muted-foreground/70" />
                                    <span className="text-sm text-muted-foreground">Seleccionar o arrastrar archivo <strong>.json</strong></span>
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
                                <Label htmlFor="ga_client_email" className="text-muted-foreground text-xs">Client Email (Auto-extraído)</Label>
                                <Input
                                    id="ga_client_email"
                                    value={config.ga_client_email || ''}
                                    readOnly
                                    className="bg-muted/50 border-border text-muted-foreground/70 text-xs focus-visible:ring-0"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="ga_private_key" className="text-muted-foreground text-xs">Private Key (Auto-extraída)</Label>
                                <textarea
                                    id="ga_private_key"
                                    value={config.ga_private_key ? '•••••••••••••••••••••••••••• PRIVATE KEY LOADED ••••••••••••••••••••••••••••' : ''}
                                    readOnly
                                    className="w-full h-9 rounded-md bg-muted/50 border border-border px-3 py-2 text-xs text-muted-foreground/70 resize-none focus-visible:outline-none focus-visible:ring-0"
                                />
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* ── GA4 Property Picker Modal ─────────────────────────────────── */}
            <Dialog open={ga4PickerOpen} onOpenChange={(open) => { if (!open) setGa4PickerOpen(false) }}>
                <DialogContent className="sm:max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2">
                            <BarChart3 className="w-4 h-4 text-orange-500" />
                            Seleccionar propiedad de GA4
                        </DialogTitle>
                    </DialogHeader>

                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                        <Input
                            placeholder="Buscar por propiedad, cuenta o ID…"
                            value={ga4Query}
                            onChange={(e) => setGa4Query(e.target.value)}
                            className="pl-9 bg-background border-input"
                        />
                    </div>

                    <div className="overflow-y-auto max-h-72 space-y-0.5 -mx-1 px-1">
                        {ga4Loading && (
                            <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground text-sm">
                                <RefreshCw className="w-4 h-4 animate-spin" /> Cargando propiedades…
                            </div>
                        )}
                        {ga4Error && (
                            <p className="text-sm text-red-500 flex items-center gap-2 py-4">
                                <AlertCircle className="w-4 h-4 shrink-0" /> {ga4Error}
                            </p>
                        )}
                        {!ga4Loading && !ga4Error && filteredGa4Properties.length === 0 && (
                            <p className="text-sm text-muted-foreground text-center py-6">No se encontraron propiedades.</p>
                        )}
                        {filteredGa4Properties.map((prop) => (
                            <button
                                key={prop.id}
                                className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-muted/60 transition-colors ${config.ga_property_id === prop.id ? 'bg-muted/60' : ''}`}
                                onClick={() => selectGa4Property(prop)}
                            >
                                <BarChart3 className="w-4 h-4 text-orange-500 shrink-0" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-foreground truncate">{prop.name}</p>
                                    <p className="text-xs text-muted-foreground truncate">{prop.accountName} · ID {prop.id}</p>
                                </div>
                                {config.ga_property_id === prop.id && (
                                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                )}
                            </button>
                        ))}
                    </div>

                    <p className="text-xs text-muted-foreground/60 text-center border-t border-border pt-3">
                        ¿Falta una propiedad? Dale acceso de Lector a {googleEmail || 'la cuenta de la agencia'} en GA4 → Administrar.
                    </p>
                </DialogContent>
            </Dialog>

            {/* ─── TikTok ───────────────────────────────────────────────────── */}
            <Card className="bg-card border-border">
                <CardHeader>
                    <CardTitle>TikTok Ads</CardTitle>
                    <CardDescription>Conecta una o más cuentas publicitarias de TikTok Ads. Los datos de todas las cuentas se consolidan en el reporte y pueden filtrarse por cuenta en el layout.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Shared token */}
                    <div className="space-y-2">
                        <Label className="text-foreground/90">Access Token Compartido</Label>
                        <Input
                            type="password"
                            placeholder="Tu TikTok Marketing API Access Token"
                            value={config.tiktok_access_token || ''}
                            onChange={(e) => setConfig({ ...config, tiktok_access_token: e.target.value })}
                            className="bg-background border-input"
                        />
                        <p className="text-xs text-muted-foreground/70">Token OAuth o token manual. Las cuentas sin token propio usarán este.</p>
                    </div>

                    {/* OAuth button */}
                    <div className="flex flex-col gap-2">
                        <a href={`/api/auth/tiktok?client_id=${cliente.id}`}>
                            <Button variant="default" size="sm" className="w-full bg-[#ff2d55] hover:bg-[#e0003a] text-white">
                                {config.tiktok_access_token ? '🔄 Reconectar con TikTok Ads' : '🔗 Conectar con TikTok Ads'}
                            </Button>
                        </a>
                        {tiktokOAuthStatus?.success && <p className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Cuenta TikTok conectada exitosamente</p>}
                        {tiktokOAuthStatus?.error && <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {tiktokOAuthStatus.error}</p>}
                        {testStatus.tiktok?.success && <p className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Conexión Exitosa</p>}
                        {testStatus.tiktok?.error && <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {testStatus.tiktok.error}</p>}
                    </div>

                    {/* Multi-account list */}
                    <div className="space-y-3 pt-2 border-t border-border">
                        <div className="flex items-center justify-between">
                            <Label className="text-foreground/90">Cuentas Publicitarias TikTok</Label>
                            <div className="flex items-center gap-2">
                                <Button size="sm" variant="outline" onClick={openTikTokAccountPicker} disabled={loadingTiktokAccounts || !config.tiktok_access_token} className="h-7 text-xs">
                                    {loadingTiktokAccounts ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <DownloadCloud className="w-3 h-3 mr-1" />} Elegir cuentas
                                </Button>
                                <Button size="sm" variant="outline" onClick={addTikTokAccount} className="h-7 text-xs">
                                    <Plus className="w-3 h-3 mr-1" /> Agregar Cuenta
                                </Button>
                            </div>
                        </div>

                        {/* Selector de cuentas disponibles desde el token */}
                        {availableTiktokAccounts && (
                            <div className="bg-muted/40 border border-indigo-500/30 rounded-lg p-4 space-y-3">
                                <div className="flex items-center justify-between">
                                    <p className="text-sm text-foreground font-medium">Cuentas disponibles en tu TikTok</p>
                                    <Button variant="ghost" size="sm" onClick={() => setAvailableTiktokAccounts(null)} className="h-6 text-xs text-muted-foreground/70 hover:text-foreground/90">Cancelar</Button>
                                </div>
                                {tiktokPickerError && (
                                    <p className="text-red-500 text-xs flex items-center gap-1"><AlertCircle className="w-3 h-3" /> {tiktokPickerError}</p>
                                )}
                                {availableTiktokAccounts.length === 0 && !tiktokPickerError && (
                                    <p className="text-xs text-muted-foreground/70">No se encontraron cuentas publicitarias para este token.</p>
                                )}
                                <div className="space-y-1 max-h-64 overflow-y-auto">
                                    {availableTiktokAccounts.map(a => {
                                        const alreadyAdded = tiktokAccounts.some(t => t.advertiser_id === a.advertiser_id)
                                        return (
                                            <label key={a.advertiser_id} className={`flex items-center gap-3 p-2 rounded-md ${alreadyAdded ? 'opacity-50' : 'hover:bg-accent cursor-pointer'}`}>
                                                <input
                                                    type="checkbox"
                                                    disabled={alreadyAdded}
                                                    checked={alreadyAdded || selectedTiktokIds.has(a.advertiser_id)}
                                                    onChange={() => toggleTiktokSelection(a.advertiser_id)}
                                                    className="rounded border-input bg-background text-indigo-500 focus:ring-indigo-500"
                                                />
                                                <span className="text-sm text-foreground flex-1">{a.name}</span>
                                                <span className="text-xs text-muted-foreground/70 font-mono">{a.advertiser_id}</span>
                                                {alreadyAdded && <span className="text-xs text-green-500">ya agregada</span>}
                                            </label>
                                        )
                                    })}
                                </div>
                                {availableTiktokAccounts.length > 0 && (
                                    <div className="flex justify-end">
                                        <Button size="sm" onClick={addSelectedTikTokAccounts} disabled={selectedTiktokIds.size === 0} className="h-8 text-xs bg-indigo-600 hover:bg-indigo-700">
                                            <Plus className="w-3 h-3 mr-1" /> Agregar {selectedTiktokIds.size > 0 ? `(${selectedTiktokIds.size})` : ''}
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}

                        {tiktokAccounts.length === 0 && (
                            <p className="text-xs text-muted-foreground/70 py-3 text-center border border-dashed border-border rounded-lg">
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

            {/* ─── Google Sheets (Conversiones Offline) ────────────────────── */}
            {(() => {
                const convSheets: ConversionesConfig[] = config.google_sheets_conversiones || []

                const updateSheet = (idx: number, partial: Partial<ConversionesConfig>) => {
                    const next = convSheets.map((s, i) => i === idx ? { ...s, ...partial } : s)
                    setConfig({ ...config, google_sheets_conversiones: next })
                }

                const removeSheet = (idx: number) => {
                    setConfig({ ...config, google_sheets_conversiones: convSheets.filter((_, i) => i !== idx) })
                }

                const addSheet = () => {
                    const newSheet: ConversionesConfig = {
                        id: crypto.randomUUID(),
                        name: `Sheet ${convSheets.length + 1}`,
                        enabled: true,
                        sheet_url: '',
                    }
                    setConfig({ ...config, google_sheets_conversiones: [...convSheets, newSheet] })
                }

                const openPicker = async (sheetId: string) => {
                    setPickerForSheetId(sheetId)
                    setPickerOpen(true)
                    setDriveLoading(true)
                    setDriveError(null)
                    setDriveQuery('')
                    const res = await listDriveSheets()
                    if ('error' in res) {
                        setDriveError(res.error ?? 'Error al listar Sheets')
                    } else {
                        setDriveSheets(res.sheets ?? [])
                    }
                    setDriveLoading(false)
                }

                const selectDriveSheet = (file: DriveSheet) => {
                    const idx = convSheets.findIndex(s => s.id === pickerForSheetId)
                    if (idx !== -1) {
                        updateSheet(idx, { sheet_url: file.url, name: convSheets[idx].name || file.name })
                    }
                    setPickerOpen(false)
                    setPickerForSheetId(null)
                }

                // ── Pestañas ─────────────────────────────────────────────────
                // Las configs anteriores guardaban una sola pestaña con el mapeo
                // a nivel de sheet: se sintetiza como una pestaña única para que
                // se editen igual (al guardar quedan ya en formato `tabs`).
                const tabsOf = (sheet: ConversionesConfig): SheetTabConfig[] => {
                    if (Array.isArray(sheet.tabs)) return sheet.tabs
                    return [{
                        id: `${sheet.id ?? 'sheet'}_tab`,
                        sheet_name: sheet.sheet_name ?? '',
                        enabled: true,
                        col_fecha: sheet.col_fecha, col_tipo: sheet.col_tipo, col_cantidad: sheet.col_cantidad,
                        col_valor: sheet.col_valor, col_fuente: sheet.col_fuente, col_notas: sheet.col_notas,
                        custom_columns: sheet.custom_columns,
                    }]
                }

                // Al escribir `tabs` se retiran los campos planos legacy del sheet.
                const setTabs = (idx: number, tabs: SheetTabConfig[]) => {
                    const next = convSheets.map((s, i) => {
                        if (i !== idx) return s
                        const {
                            sheet_name: _sn, col_fecha: _cf, col_tipo: _ct, col_cantidad: _cc,
                            col_valor: _cv, col_fuente: _cfu, col_notas: _cn, custom_columns: _cx,
                            ...rest
                        } = s
                        return { ...rest, tabs }
                    })
                    setConfig({ ...config, google_sheets_conversiones: next })
                }

                const updateTab = (sheetIdx: number, tabId: string, partial: Partial<SheetTabConfig>) => {
                    setTabs(sheetIdx, tabsOf(convSheets[sheetIdx]).map(t => t.id === tabId ? { ...t, ...partial } : t))
                }

                const addTab = (sheetIdx: number, sheetName = '') => {
                    const existing = tabsOf(convSheets[sheetIdx])
                    if (sheetName && existing.some(t => t.sheet_name === sheetName)) return
                    setTabs(sheetIdx, [...existing, { id: crypto.randomUUID(), sheet_name: sheetName, enabled: true }])
                }

                const removeTab = (sheetIdx: number, tabId: string) => {
                    const t = tabsOf(convSheets[sheetIdx]).find(x => x.id === tabId)
                    const hasMapping = t && (Object.keys(t.custom_columns ?? {}).length > 0
                        || !!(t.col_fecha || t.col_tipo || t.col_cantidad || t.col_valor || t.col_fuente || t.col_notas))
                    if (hasMapping && !confirm(`¿Quitar la pestaña "${t!.sheet_name || '(primera pestaña)'}" y su mapeo de columnas?`)) return
                    setTabs(sheetIdx, tabsOf(convSheets[sheetIdx]).filter(x => x.id !== tabId))
                }

                const detectTabs = async (idx: number) => {
                    const sheet = convSheets[idx]
                    const sid = sheet.id ?? String(idx)
                    setTabsUI(prev => ({ ...prev, [sid]: { loading: true, error: null, available: prev[sid]?.available ?? [] } }))
                    const res = await listConversionesTabs(sheet)
                    if ('error' in res && res.error) {
                        setTabsUI(prev => ({ ...prev, [sid]: { loading: false, error: res.error!, available: [] } }))
                    } else {
                        setTabsUI(prev => ({ ...prev, [sid]: { loading: false, error: null, available: (res as any).tabs as SheetTabInfo[] } }))
                    }
                }

                const toggleAvailableTab = (idx: number, title: string) => {
                    const existing = tabsOf(convSheets[idx]).find(t => t.sheet_name === title)
                    if (existing) removeTab(idx, existing.id)
                    else addTab(idx, title)
                }

                // Comprueba acceso al doc, existencia de la pestaña y de las
                // columnas mapeadas. No bloquea el guardado: solo informa.
                const validateSheet = async (idx: number) => {
                    const sheet = convSheets[idx]
                    const sid = sheet.id ?? String(idx)
                    setValidateUI(prev => ({ ...prev, [sid]: { loading: true, results: [] } }))
                    const out: { tab: string; ok: boolean; message: string }[] = []
                    for (const tab of tabsOf(sheet).filter(t => t.enabled !== false)) {
                        const label = tab.sheet_name || '(primera pestaña)'
                        const res = await detectConversionesColumns(sheet, tab)
                        if ('error' in res && res.error) {
                            out.push({ tab: label, ok: false, message: res.error })
                            continue
                        }
                        // Los encabezados alimentan el autocompletado del mapeo de
                        // columnas. Antes los traía "Detectar columnas", que se retiró
                        // junto con las columnas adicionales; validar cumple la misma
                        // función y además es lo que se hace antes de sincronizar.
                        setSheetUI(prev => ({
                            ...prev,
                            [`${sid}:${tab.id}`]: { headers: res.headers ?? [] },
                        }))

                        const heads = (res.headers ?? []).map(h => h.toLowerCase().trim())
                        const mapped: [string, string][] = [
                            ['fecha',    tab.col_fecha    || 'fecha'],
                            ['valor',    tab.col_valor    || 'valor'],
                            ['fuente',   tab.col_fuente   || 'fuente'],
                            ['notas',    tab.col_notas    || 'notas'],
                        ]
                        if (!tab.tipo_fijo)  mapped.push(['tipo',     tab.col_tipo     || 'tipo'])
                        if (!tab.count_rows) mapped.push(['cantidad', tab.col_cantidad || 'cantidad'])

                        const missing = mapped.filter(([, c]) => !heads.includes(c.toLowerCase().trim()))
                        const faltaFecha = missing.some(([k]) => k === 'fecha')
                        // Sin cantidad TODAS las filas se descartan: es un fallo,
                        // no un aviso. Se resuelve con "cada fila es una conversión".
                        const faltaCantidad = missing.some(([k]) => k === 'cantidad')
                        const problemas: string[] = []
                        if (faltaFecha) problemas.push('Falta la columna de fecha: no se puede importar.')
                        if (faltaCantidad) problemas.push('Falta la columna de cantidad: se descartarían todas las filas. Marca "Cada fila es una conversión" si el Sheet tiene un lead o venta por fila.')
                        if (!tab.tipo_fijo && missing.some(([k]) => k === 'tipo')) {
                            problemas.push('Sin columna de tipo: las filas entrarán como "otro" y no sumarán en leads/ventas offline. Usa "Tipo fijo".')
                        }
                        const opcionales = missing.map(([k]) => k).filter(k => k !== 'fecha' && k !== 'cantidad' && k !== 'tipo')

                        out.push({
                            tab: label,
                            ok: !faltaFecha && !faltaCantidad,
                            message: problemas.length === 0
                                ? (opcionales.length === 0
                                    ? 'Todas las columnas mapeadas existen'
                                    : `Listo para importar. Sin columna (opcional) para: ${opcionales.join(', ')}`)
                                : problemas.join(' '),
                        })
                    }
                    setValidateUI(prev => ({ ...prev, [sid]: { loading: false, results: out } }))
                }

                const filteredDriveSheets = driveSheets.filter(s =>
                    !driveQuery || s.name.toLowerCase().includes(driveQuery.toLowerCase())
                )

                return (
                    <>
                        <Card className="bg-card border-border">
                            <CardHeader>
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <CardTitle>Google Sheets — Conversiones Offline</CardTitle>
                                        <CardDescription className="mt-1">
                                            Importa leads y ventas que no se capturan por píxel. Configura uno o varios Sheets por cliente.
                                        </CardDescription>
                                    </div>
                                    <Button variant="outline" size="sm" onClick={addSheet} className="shrink-0 h-8 text-xs gap-1.5">
                                        <Plus className="w-3 h-3" /> Agregar Sheet
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                {convSheets.length === 0 && (
                                    <p className="text-sm text-muted-foreground text-center py-6 border border-dashed border-border rounded-lg">
                                        No hay sheets configurados. Haz clic en &quot;Agregar Sheet&quot; para empezar.
                                    </p>
                                )}

                                {convSheets.map((sheet, idx) => {
                                    const sid = sheet.id ?? String(idx)
                                    const bloqueado = sheetsBloqueados.has(sid)
                                    const tabs = tabsOf(sheet)
                                    const tabsState = tabsUI[sid] || { loading: false, error: null, available: [] }
                                    const validation = validateUI[sid]
                                    const lastSync = convSyncStatus[sid]
                                    // Dos pestañas con columnas que sanitizan al mismo nombre se
                                    // suman en la variable sheet_<nombre>: conviene avisarlo.
                                    const dupCustomKeys = (() => {
                                        const seen = new Map<string, number>()
                                        for (const t of tabs) {
                                            // Solo cuentan las marcadas para sincronizar: el resto no llega a la base.
                                            for (const [k, def] of Object.entries(t.custom_columns ?? {})) {
                                                if (def.include) seen.set(k, (seen.get(k) ?? 0) + 1)
                                            }
                                        }
                                        return Array.from(seen.entries()).filter(([, n]) => n > 1).map(([k]) => k)
                                    })()

                                    return (
                                        <div key={sid} className="border border-border rounded-lg overflow-hidden">
                                            {/* Sheet header */}
                                            <div className="flex items-center gap-2 px-4 py-3 bg-muted/30 border-b border-border">
                                                <input
                                                    type="checkbox"
                                                    checked={sheet.enabled || false}
                                                    onChange={(e) => updateSheet(idx, { enabled: e.target.checked })}
                                                    className="rounded border-input bg-background text-indigo-500 focus:ring-indigo-500 shrink-0"
                                                />
                                                <Input
                                                    placeholder="Nombre del sheet (ej: Leads WhatsApp)"
                                                    value={sheet.name || ''}
                                                    onChange={(e) => updateSheet(idx, { name: e.target.value })}
                                                    className="bg-background border-input h-8 text-sm font-medium"
                                                />
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => {
                                                        // Un sheet que aún no se ha guardado no tiene datos
                                                        // que borrar: se quita y ya.
                                                        if (!bloqueado) { removeSheet(idx); return }
                                                        abrirBorradoSheet(idx, sid, sheet.name || `Sheet ${idx + 1}`)
                                                    }}
                                                    className="text-muted-foreground/70 hover:text-red-500 shrink-0 h-8 w-8 p-0"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </Button>
                                            </div>

                                            {/* Sheet body */}
                                            <div className="p-4 space-y-4">
                                                {/* URL + picker */}
                                                <div className="space-y-1.5">
                                                    <Label className="text-foreground/90 text-sm">URL del Google Sheet</Label>
                                                    <div className="flex gap-2">
                                                        <Input
                                                            placeholder="https://docs.google.com/spreadsheets/d/..."
                                                            value={sheet.sheet_url || ''}
                                                            onChange={(e) => updateSheet(idx, { sheet_url: e.target.value })}
                                                            readOnly={bloqueado}
                                                            title={bloqueado ? 'El documento no se puede cambiar. Elimina este sheet y añade otro.' : undefined}
                                                            className={`bg-background border-input ${bloqueado ? 'text-muted-foreground cursor-not-allowed' : ''}`}
                                                        />
                                                        {!bloqueado && (
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                className="shrink-0 h-10 text-xs gap-1.5"
                                                                onClick={() => openPicker(sid)}
                                                            >
                                                                <FolderSearch className="w-3.5 h-3.5" />
                                                                Seleccionar
                                                            </Button>
                                                        )}
                                                    </div>
                                                    {bloqueado && (
                                                        <p className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
                                                            <Lock className="w-3 h-3 shrink-0" />
                                                            El documento queda fijo al guardar. Todos los datos sincronizados cuelgan de
                                                            este sheet, así que para usar otro documento hay que eliminar este — con sus
                                                            datos — y añadir uno nuevo.
                                                        </p>
                                                    )}
                                                </div>

                                                {/* Pestañas del documento */}
                                                <div className="space-y-2">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div>
                                                            <Label className="text-foreground/90 text-sm">Pestañas a sincronizar</Label>
                                                            <p className="text-xs text-muted-foreground/70 mt-0.5">
                                                                Cada pestaña tiene su propio mapeo de columnas.
                                                            </p>
                                                        </div>
                                                        <div className="flex gap-2 shrink-0">
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                className="h-7 text-xs"
                                                                disabled={tabsState.loading || !sheet.sheet_url}
                                                                onClick={() => detectTabs(idx)}
                                                            >
                                                                {tabsState.loading
                                                                    ? <RefreshCw className="w-3 h-3 animate-spin mr-1" />
                                                                    : <FolderSearch className="w-3 h-3 mr-1" />}
                                                                Detectar pestañas
                                                            </Button>
                                                            <Button
                                                                variant="ghost"
                                                                size="sm"
                                                                className="h-7 text-xs"
                                                                onClick={() => addTab(idx)}
                                                            >
                                                                <Plus className="w-3 h-3 mr-1" /> Manual
                                                            </Button>
                                                        </div>
                                                    </div>

                                                    {tabsState.error && (
                                                        <p className="text-xs text-red-500 flex items-center gap-1">
                                                            <AlertCircle className="w-3 h-3" /> {tabsState.error}
                                                        </p>
                                                    )}

                                                    {tabsState.available.length > 0 && (
                                                        <div className="bg-muted/40 border border-border rounded-lg p-3 space-y-1.5">
                                                            <p className="text-xs text-muted-foreground/70">
                                                                Pestañas del documento — marca las que quieras sincronizar:
                                                            </p>
                                                            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
                                                                {tabsState.available.map(t => {
                                                                    const checked = tabs.some(x => x.sheet_name === t.title)
                                                                    return (
                                                                        <label key={t.title} className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={checked}
                                                                                onChange={() => toggleAvailableTab(idx, t.title)}
                                                                                className="rounded border-input bg-background text-indigo-500 focus:ring-indigo-500"
                                                                            />
                                                                            <span className="truncate" title={t.title}>{t.title}</span>
                                                                            <span className="text-muted-foreground/50 shrink-0">({t.rowCount})</span>
                                                                        </label>
                                                                    )
                                                                })}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {dupCustomKeys.length > 0 && (
                                                        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1">
                                                            <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                                                            Columnas repetidas entre pestañas ({dupCustomKeys.slice(0, 5).join(', ')}
                                                            {dupCustomKeys.length > 5 ? ` y ${dupCustomKeys.length - 5} más` : ''}): si las marcas
                                                            como &quot;Usar&quot; en varias pestañas, sus valores se suman en la misma variable <span className="font-mono">sheet_*</span>.
                                                        </p>
                                                    )}

                                                    {tabs.length === 0 && (
                                                        <p className="text-xs text-muted-foreground/50 text-center py-3 border border-dashed border-border rounded-lg">
                                                            Sin pestañas seleccionadas. Usa &quot;Detectar pestañas&quot; o agrégala manualmente.
                                                        </p>
                                                    )}

                                                    {/* Una sub-tarjeta por pestaña, con su mapeo propio */}
                                                    {tabs.map((tab) => {
                                                        const tabKey = `${sid}:${tab.id}`
                                                        const headerOpts = sheetUI[tabKey]?.headers ?? []
                                                        const listId = `headers-${tabKey}`

                                                        return (
                                                            <div key={tab.id} className="border border-border rounded-lg overflow-hidden">
                                                                <div className="flex items-center gap-2 px-3 py-2 bg-muted/30 border-b border-border">
                                                                    <input
                                                                        type="checkbox"
                                                                        checked={tab.enabled !== false}
                                                                        onChange={(e) => updateTab(idx, tab.id, { enabled: e.target.checked })}
                                                                        className="rounded border-input bg-background text-indigo-500 focus:ring-indigo-500 shrink-0"
                                                                    />
                                                                    <Input
                                                                        placeholder="Nombre de la pestaña — vacío = primera pestaña"
                                                                        value={tab.sheet_name || ''}
                                                                        onChange={(e) => updateTab(idx, tab.id, { sheet_name: e.target.value })}
                                                                        className="bg-background border-input h-7 text-xs"
                                                                    />
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        onClick={() => removeTab(idx, tab.id)}
                                                                        className="text-muted-foreground/70 hover:text-red-500 shrink-0 h-7 w-7 p-0"
                                                                    >
                                                                        <Trash2 className="w-3 h-3" />
                                                                    </Button>
                                                                </div>

                                                                <div className="p-3 space-y-3">
                                                                    {/* Mapeo de columnas de esta pestaña */}
                                                                    <div className="bg-muted/40 border border-border p-3 rounded-lg space-y-3 relative overflow-hidden">
                                                                        <div className="absolute top-0 left-0 w-1 h-full bg-violet-500/50" />
                                                                        <h4 className="text-sm font-medium text-foreground">Nombres de columnas</h4>
                                                                        <p className="text-xs text-muted-foreground/70 -mt-1">
                                                                            Nombres exactos en la pestaña. Vacío = usa el valor por defecto.
                                                                            {headerOpts.length > 0 && ' Se sugieren los encabezados detectados.'}
                                                                        </p>
                                                                        {headerOpts.length > 0 && (
                                                                            <datalist id={listId}>
                                                                                {headerOpts.map(h => <option key={h} value={h} />)}
                                                                            </datalist>
                                                                        )}
                                                                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                                                                            {[
                                                                                { field: 'col_fecha',    label: 'Fecha',    placeholder: 'fecha',    hint: 'DD/MM/YYYY o YYYY-MM-DD' },
                                                                                { field: 'col_tipo',     label: 'Tipo',     placeholder: 'tipo',     hint: '"lead", "venta", etc.' },
                                                                                { field: 'col_cantidad', label: 'Cantidad', placeholder: 'cantidad', hint: 'Número entero' },
                                                                                { field: 'col_valor',    label: 'Valor $',  placeholder: 'valor',    hint: 'Revenue (opcional)' },
                                                                                { field: 'col_fuente',   label: 'Fuente',   placeholder: 'fuente',   hint: '"meta", "tiktok"…' },
                                                                                { field: 'col_notas',    label: 'Notas',    placeholder: 'notas',    hint: 'Texto libre (opcional)' },
                                                                            ].map(({ field, label, placeholder, hint }) => {
                                                                                // Cantidad y Tipo pueden resolverse por configuración
                                                                                // en hojas donde una fila = una conversión.
                                                                                const porConfig =
                                                                                    (field === 'col_cantidad' && tab.count_rows) ||
                                                                                    (field === 'col_tipo' && !!tab.tipo_fijo)
                                                                                return (
                                                                                    <div key={field} className="space-y-1">
                                                                                        <Label className="text-muted-foreground text-xs">{label}</Label>
                                                                                        <Input
                                                                                            placeholder={porConfig ? 'definido abajo' : placeholder}
                                                                                            list={headerOpts.length > 0 ? listId : undefined}
                                                                                            disabled={porConfig}
                                                                                            value={porConfig ? '' : ((tab as any)[field] || '')}
                                                                                            onChange={(e) => updateTab(idx, tab.id, { [field]: e.target.value })}
                                                                                            className="bg-background border-input h-8 text-sm disabled:opacity-50"
                                                                                        />
                                                                                        <p className="text-xs text-muted-foreground/60">{hint}</p>
                                                                                    </div>
                                                                                )
                                                                            })}
                                                                        </div>

                                                                        {/* Hojas donde una fila = una conversión (exports de leads) */}
                                                                        <div className="border-t border-border pt-3 space-y-2">
                                                                            <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
                                                                                <input
                                                                                    type="checkbox"
                                                                                    checked={!!tab.count_rows}
                                                                                    onChange={(e) => updateTab(idx, tab.id, { count_rows: e.target.checked })}
                                                                                    className="rounded border-input bg-background text-indigo-500 focus:ring-indigo-500 mt-0.5"
                                                                                />
                                                                                <span>
                                                                                    Cada fila es una conversión
                                                                                    <span className="block text-muted-foreground/60">
                                                                                        Para hojas sin columna de cantidad (un lead o una venta por fila).
                                                                                    </span>
                                                                                </span>
                                                                            </label>
                                                                            <div className="flex items-center gap-2">
                                                                                <Label className="text-muted-foreground text-xs shrink-0">Tipo fijo</Label>
                                                                                <select
                                                                                    value={tab.tipo_fijo ?? ''}
                                                                                    onChange={(e) => updateTab(idx, tab.id, { tipo_fijo: e.target.value || undefined })}
                                                                                    className="h-7 text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                                                                >
                                                                                    <option value="">Usar la columna de tipo</option>
                                                                                    <option value="lead">Todas son leads</option>
                                                                                    <option value="venta">Todas son ventas</option>
                                                                                    <option value="otro">Otro</option>
                                                                                </select>
                                                                                <span className="text-xs text-muted-foreground/60">
                                                                                    Sin esto las filas entran como &quot;otro&quot; y no suman en leads/ventas offline.
                                                                                </span>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )
                                                    })}
                                                </div>

                                                {/* Validación + estado del último sync */}
                                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="h-7 text-xs"
                                                        disabled={validation?.loading || !sheet.sheet_url}
                                                        onClick={() => validateSheet(idx)}
                                                    >
                                                        {validation?.loading
                                                            ? <RefreshCw className="w-3 h-3 animate-spin mr-1" />
                                                            : <CheckCircle2 className="w-3 h-3 mr-1" />}
                                                        Validar configuración
                                                    </Button>
                                                    {lastSync && (
                                                        <span
                                                            className={`text-xs flex items-center gap-1 ${lastSync.status === 'error' ? 'text-red-500' : 'text-muted-foreground'}`}
                                                            title={(lastSync.detalle?.por_pestana ?? [])
                                                                .map(q => `${q.tab_name}: ${q.rows_ok} filas${q.warnings.length ? ` — ${q.warnings.join('; ')}` : ''}`)
                                                                .join('\n') || lastSync.detalle?.error || ''}
                                                        >
                                                            {lastSync.status === 'error'
                                                                ? <AlertCircle className="w-3 h-3" />
                                                                : <CheckCircle2 className="w-3 h-3" />}
                                                            Último sync: {lastSync.rows_ok} filas
                                                            {lastSync.rows_descartadas > 0 && ` · ${lastSync.rows_descartadas} descartadas`}
                                                            {' · '}{new Date(lastSync.run_at).toLocaleString('es-CO')}
                                                        </span>
                                                    )}
                                                </div>

                                                {validation?.results && validation.results.length > 0 && (
                                                    <div className="space-y-1">
                                                        {validation.results.map(r => (
                                                            <p
                                                                key={r.tab}
                                                                className={`text-xs flex items-start gap-1 ${r.ok ? 'text-green-600 dark:text-green-500' : 'text-red-500'}`}
                                                            >
                                                                {r.ok
                                                                    ? <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                                                                    : <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />}
                                                                <span><span className="font-medium">{r.tab}</span> — {r.message}</span>
                                                            </p>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}

                                {/* Sync all button */}
                                {convSheets.some(s => s.enabled && s.sheet_url) && (
                                    <div className="pt-2 border-t border-border flex gap-2 items-center">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => runTest('conversionesOffline', async () => {
                                                // Persistir la config actual antes de sincronizar: el endpoint
                                                // lee los sheets desde la BD, no desde el estado del formulario.
                                                const saved = await handleSave()
                                                if (saved && !saved.success) {
                                                    return { error: saved.error || 'Error al guardar la configuración antes de sincronizar' }
                                                }

                                                // Una PESTAÑA por petición. Un documento de decenas de miles de
                                                // filas no cabe en el tiempo de una función, así que se recorren
                                                // las pestañas con un mismo lote y se consolida al final: hasta
                                                // ese momento el dato anterior sigue intacto, y una corrida a
                                                // medias no deja al cliente sin nada. El id ausente se deriva de
                                                // la posición, igual que `normalizeSheetConfigs` en el servidor.
                                                const objetivo = convSheets
                                                    .map((s, i) => ({ ...s, id: s.id || `sheet_${i}` }))
                                                    .filter(s => s.enabled && s.sheet_url)

                                                const total = { totalFilas: 0, diasProcesados: 0, filasDescartadas: 0 }
                                                const avisos: string[] = []
                                                const fallos: string[] = []

                                                try {
                                                    for (const [i, sheet] of objetivo.entries()) {
                                                        const etiqueta = sheet.name || `Sheet ${i + 1}`
                                                        const pestanas = tabsOf(sheet)
                                                            .map((t, j) => ({ ...t, id: t.id || `tab_${j}` }))
                                                            .filter(t => t.enabled !== false)
                                                        if (pestanas.length === 0) {
                                                            fallos.push(`${etiqueta}: no tiene pestañas habilitadas`)
                                                            continue
                                                        }

                                                        const batchId = crypto.randomUUID()
                                                        const agregados: unknown[] = []
                                                        const calidad: unknown[] = []
                                                        let algunaOk = false
                                                        const fallosTabs: string[] = []

                                                        for (const [j, tab] of pestanas.entries()) {
                                                            const nombreTab = tab.sheet_name || `Pestaña ${j + 1}`
                                                            setConvSyncProgreso(
                                                                `${etiqueta} · pestaña ${j + 1}/${pestanas.length} (${nombreTab})`
                                                            )
                                                            const res = await syncTandaConversiones(cliente.id, {
                                                                sheetId: sheet.id, batchId, tabId: tab.id,
                                                            })
                                                            if (res.error) { fallosTabs.push(`${nombreTab}: ${res.error}`); continue }
                                                            algunaOk = true
                                                            total.totalFilas += res.totalFilas ?? 0
                                                            total.filasDescartadas += res.filasDescartadas ?? 0
                                                            if (res.aggregates) agregados.push(...res.aggregates)
                                                            if (res.quality) calidad.push(...res.quality)
                                                            if (res.warnings) avisos.push(...res.warnings)
                                                        }

                                                        // Sin ninguna pestaña buena no se consolida: consolidar
                                                        // retiraría los lotes anteriores y dejaría el sheet vacío.
                                                        if (!algunaOk) {
                                                            fallos.push(`${etiqueta}: ${fallosTabs.join(' · ')}`)
                                                            continue
                                                        }
                                                        if (fallosTabs.length > 0) {
                                                            avisos.push(...fallosTabs.map(f => `${etiqueta} › ${f}`))
                                                        }

                                                        // Los campos se recalculan una sola vez, tras el último sheet.
                                                        const ultimo = i === objetivo.length - 1
                                                        setConvSyncProgreso(
                                                            ultimo ? `${etiqueta} · consolidando y recalculando campos…`
                                                                : `${etiqueta} · consolidando…`
                                                        )
                                                        const cierre = await syncTandaConversiones(cliente.id, {
                                                            sheetId: sheet.id, batchId, consolidar: true,
                                                            aggregates: agregados, quality: calidad,
                                                            ...(ultimo ? {} : { recalcularCampos: false }),
                                                        })
                                                        if (cierre.error) { fallos.push(`${etiqueta}: ${cierre.error}`); continue }
                                                        total.diasProcesados += cierre.diasProcesados ?? 0
                                                        if (cierre.warnings) avisos.push(...cierre.warnings)
                                                    }

                                                    if (objetivo.length > 0 && fallos.length === objetivo.length) {
                                                        return { error: fallos.join(' · ') }
                                                    }
                                                } finally {
                                                    setConvSyncProgreso(null)
                                                }

                                                return { ...total, warnings: [...fallos, ...avisos] }
                                            })}
                                            disabled={testStatus['conversionesOffline']?.loading}
                                            className="h-8 text-xs"
                                        >
                                            {testStatus['conversionesOffline']?.loading
                                                ? <RefreshCw className="w-3 h-3 animate-spin mr-2" />
                                                : <DownloadCloud className="w-3 h-3 mr-2" />
                                            }
                                            {convSyncProgreso
                                                ? `Sincronizando ${convSyncProgreso}`
                                                : 'Sincronizar todos ahora'}
                                        </Button>
                                        {testStatus['conversionesOffline']?.success && (
                                            <span className="text-green-600 dark:text-green-500 text-xs flex items-center gap-1">
                                                <CheckCircle2 className="w-3 h-3" /> {testStatus['conversionesOffline']?.message || 'Sincronizado'}
                                            </span>
                                        )}
                                        {testStatus['conversionesOffline']?.error && (
                                            <span className="text-red-500 text-xs flex items-center gap-1">
                                                <AlertCircle className="w-3 h-3" /> {testStatus['conversionesOffline']?.error}
                                            </span>
                                        )}
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* ── Confirmación de borrado de un sheet ─────────────── */}
                        <Dialog
                            open={!!borrarSheet}
                            onOpenChange={(open) => { if (!open && !borrarSheet?.borrando) setBorrarSheet(null) }}
                        >
                            <DialogContent className="sm:max-w-lg">
                                <DialogHeader>
                                    <DialogTitle className="flex items-center gap-2">
                                        <Trash2 className="w-4 h-4 text-red-500" />
                                        Eliminar «{borrarSheet?.nombre}»
                                    </DialogTitle>
                                </DialogHeader>

                                {borrarSheet?.cargando && (
                                    <p className="text-sm text-muted-foreground flex items-center gap-2 py-4">
                                        <Loader2 className="w-4 h-4 animate-spin" /> Comprobando qué datos tiene…
                                    </p>
                                )}

                                {borrarSheet?.preview && !borrarSheet.borrando && (
                                    <div className="space-y-3 text-sm">
                                        <p className="text-foreground/90">
                                            Se borrarán <strong>{borrarSheet.preview.filas.total.toLocaleString('es')}</strong> filas
                                            y el documento saldrá de la configuración. No se puede deshacer.
                                        </p>
                                        <ul className="text-xs text-muted-foreground space-y-0.5 pl-4 list-disc">
                                            <li>{borrarSheet.preview.filas.conversiones.toLocaleString('es')} conversiones</li>
                                            <li>{borrarSheet.preview.filas.diarias.toLocaleString('es')} agregados diarios</li>
                                            <li>{borrarSheet.preview.filas.crudas.toLocaleString('es')} filas de la capa cruda</li>
                                        </ul>

                                        {borrarSheet.preview.campos.length > 0 && (
                                            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 space-y-1.5">
                                                <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                                                    Campos de Sheet que pierden este origen
                                                </p>
                                                <ul className="text-xs text-muted-foreground space-y-0.5">
                                                    {borrarSheet.preview.campos.map(c => (
                                                        <li key={c.clave}>
                                                            <span className="text-foreground/80">{c.nombre}</span>
                                                            {c.quedaSinOrigen
                                                                ? ' — se queda sin ningún origen y quedará vacío'
                                                                : ' — se recalculará sin este documento'}
                                                        </li>
                                                    ))}
                                                </ul>
                                                <p className="text-xs text-muted-foreground/70">
                                                    Los campos no se borran. Las fórmulas del dashboard que los usen seguirán resolviendo.
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {borrarSheet?.borrando && (
                                    <p className="text-sm text-muted-foreground flex items-center gap-2 py-4">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Borrando… {borrarSheet.progreso.toLocaleString('es')} filas retiradas
                                    </p>
                                )}

                                {borrarSheet?.error && (
                                    <p className="text-sm text-red-500 flex items-start gap-2">
                                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> {borrarSheet.error}
                                    </p>
                                )}

                                <div className="flex justify-end gap-2 pt-2">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setBorrarSheet(null)}
                                        disabled={borrarSheet?.borrando}
                                    >Cancelar</Button>
                                    <Button
                                        size="sm"
                                        onClick={confirmarBorradoSheet}
                                        disabled={borrarSheet?.cargando || borrarSheet?.borrando}
                                        className="bg-red-600 hover:bg-red-700 text-white"
                                    >
                                        {borrarSheet?.borrando
                                            ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-2" /> Borrando</>
                                            : 'Eliminar sheet y datos'}
                                    </Button>
                                </div>
                            </DialogContent>
                        </Dialog>

                        {/* ── Sheet Picker Modal ──────────────────────────────── */}
                        <Dialog open={pickerOpen} onOpenChange={(open) => { if (!open) { setPickerOpen(false); setPickerForSheetId(null) } }}>
                            <DialogContent className="sm:max-w-lg">
                                <DialogHeader>
                                    <DialogTitle className="flex items-center gap-2">
                                        <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
                                        Seleccionar Google Sheet
                                    </DialogTitle>
                                </DialogHeader>

                                {/* Search */}
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                                    <Input
                                        placeholder="Buscar por nombre…"
                                        value={driveQuery}
                                        onChange={(e) => setDriveQuery(e.target.value)}
                                        className="pl-9 bg-background border-input"
                                    />
                                </div>

                                {/* List */}
                                <div className="overflow-y-auto max-h-72 space-y-0.5 -mx-1 px-1">
                                    {driveLoading && (
                                        <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground text-sm">
                                            <RefreshCw className="w-4 h-4 animate-spin" /> Cargando Sheets…
                                        </div>
                                    )}
                                    {driveError && (
                                        <p className="text-sm text-red-500 flex items-center gap-2 py-4">
                                            <AlertCircle className="w-4 h-4 shrink-0" /> {driveError}
                                        </p>
                                    )}
                                    {!driveLoading && !driveError && filteredDriveSheets.length === 0 && (
                                        <p className="text-sm text-muted-foreground text-center py-6">No se encontraron Sheets.</p>
                                    )}
                                    {filteredDriveSheets.map((file) => (
                                        <button
                                            key={file.id}
                                            className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-muted/60 transition-colors"
                                            onClick={() => selectDriveSheet(file)}
                                        >
                                            <FileSpreadsheet className="w-4 h-4 text-emerald-500 shrink-0" />
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-foreground truncate">{file.name}</p>
                                                <p className="text-xs text-muted-foreground">
                                                    {file.modifiedTime
                                                        ? `Modificado: ${new Date(file.modifiedTime).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })}`
                                                        : ''}
                                                </p>
                                            </div>
                                        </button>
                                    ))}
                                </div>

                                <p className="text-xs text-muted-foreground/60 text-center border-t border-border pt-3">
                                    O pega la URL directamente en el campo de URL del Sheet.
                                </p>
                            </DialogContent>
                        </Dialog>
                    </>
                )
            })()}

            {/* ─── Campos de Sheet ──────────────────────────────────────────── */}
            {/* La card de arriba define la CONEXIÓN (documento, pestañas, fecha);
                esta define QUÉ SE MIDE. Va aparte porque un campo cruza varias
                pestañas y puede cruzar varios documentos. */}
            <SheetCamposSection clienteId={cliente.id} />

            {/* ─── Filtros de Dashboard ─────────────────────────────────────── */}
            <Card className="bg-card border-border">
                <CardHeader>
                    <CardTitle>Filtros de Dashboard</CardTitle>
                    <CardDescription>Configura botones de filtrado rápido para el Dashboard (ej. nombres de campañas o proyectos).</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="meta_keywords" className="text-foreground/90">Keywords de Campañas (Separadas por comas)</Label>
                        <Input
                            id="meta_keywords"
                            placeholder="Psicología, Pedagogía, Diplomado"
                            value={config.meta_keywords || ''}
                            onChange={(e) => setConfig({ ...config, meta_keywords: e.target.value })}
                            className="bg-background border-input"
                        />
                        <p className="text-xs text-muted-foreground/70">Estos textos aparecerán como botones de filtro rápido en la vista superior del embudo de Meta Ads.</p>
                    </div>
                </CardContent>
            </Card>

            {/* ─── Plantilla de Reporte ─────────────────────────────────────── */}
            <Card className="bg-card border-indigo-500/30">
                <CardHeader>
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-indigo-500/10 rounded-lg">
                            <LayoutDashboard className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                        </div>
                        <div>
                            <CardTitle className="text-foreground">Plantilla de Reporte</CardTitle>
                            <CardDescription className="text-muted-foreground mt-1">Selecciona la plantilla de métricas que quieres ver en el Dashboard de este cliente.</CardDescription>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="space-y-3">
                        <Label className="text-foreground/90">Layout Activo</Label>
                        <select
                            value={selectedLayoutId}
                            onChange={async (e) => {
                                const newId = e.target.value
                                setSelectedLayoutId(newId)
                                setLayoutSaving(true)
                                await assignLayoutToCliente(cliente.id, newId || null)
                                setLayoutSaving(false)
                            }}
                            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <option value="">— Sin plantilla (Vista clásica) —</option>
                            {layouts.map((l: any) => (
                                <option key={l.id} value={l.id}>{l.nombre}</option>
                            ))}
                        </select>

                        {layoutSaving && (
                            <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400">
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
                                        <CheckCircle2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                                        <span className="text-sm font-medium text-indigo-700 dark:text-indigo-300">{activeLayout.nombre}</span>
                                    </div>
                                    {activeLayout.descripcion && (
                                        <p className="text-xs text-muted-foreground ml-6">{activeLayout.descripcion}</p>
                                    )}
                                    <div className="ml-6 flex flex-wrap gap-2 mt-2">
                                        {(activeLayout.tarjetas || []).map((t: any) => (
                                            <span key={t.id} className="text-xs bg-muted text-foreground/90 px-2 py-1 rounded-md border border-border">{t.label}</span>
                                        ))}
                                    </div>
                                </div>
                            )
                        })()}

                        {!selectedLayoutId && (
                            <p className="text-xs text-muted-foreground/70">Sin plantilla activa → el Dashboard usará la vista clásica con columnas basadas en APIs conectadas.</p>
                        )}
                    </div>
                </CardContent>
                <CardFooter className="bg-muted/30 border-t border-border flex justify-between pt-6">
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
