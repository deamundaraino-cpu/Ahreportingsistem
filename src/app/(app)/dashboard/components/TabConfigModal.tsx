'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Trash2, ChevronDown, ChevronRight, Zap, Copy, Bookmark, Plus, X } from 'lucide-react'
import { saveClienteTab, deleteClienteTab, duplicateClienteTab, saveTabAsTemplate } from '../_actions'
import { parseTabFilter, serializeTabFilter } from '@/lib/campaign-filter'
import type { CampaignFilterOperator } from '@/lib/layout-types'
import { toast } from 'sonner'

/** Operadores ofrecidos en el filtro de pestaña (subset con etiquetas claras). */
const TAB_FILTER_OPS: { value: CampaignFilterOperator; label: string }[] = [
    { value: 'includes',    label: 'Contiene' },
    { value: 'excludes',    label: 'No contiene' },
    { value: 'exact',       label: 'Es igual a' },
    { value: 'not_exact',   label: 'No es igual a' },
    { value: 'starts_with', label: 'Empieza con' },
    { value: 'ends_with',   label: 'Termina con' },
]

type FilterCond = { operator: CampaignFilterOperator; value: string }

/** Estado inicial de condiciones a partir del keyword_meta guardado (string o compuesto). */
function initConditions(raw: string | null | undefined): { mode: 'and' | 'or'; conditions: FilterCond[] } {
    const parsed = parseTabFilter(raw)
    if (typeof parsed === 'string') {
        return { mode: 'and', conditions: [{ operator: 'includes', value: parsed }] }
    }
    return {
        mode: parsed.mode,
        conditions: parsed.conditions.map(c => ({
            operator: (c.operator ?? 'includes') as CampaignFilterOperator,
            value: Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? ''),
        })),
    }
}

type HotmartFunnel = {
    enabled?: boolean
    principal_names?: string[]
    bump_names?: string[]
    upsell_names?: string[]
    landing_page_urls?: string[]
    payment_page_url?: string
    upsell_page_url?: string
    principal_price_usd?: number
}

function arrayToText(arr?: string[]): string {
    return Array.isArray(arr) ? arr.join(', ') : ''
}
function textToArray(txt: string): string[] {
    return txt.split(',').map(s => s.trim()).filter(Boolean)
}

export function TabConfigModal({
    isOpen,
    onClose,
    clienteId,
    allLayouts,
    tabTemplates = [],
    tabToEdit = null,
    clienteHasHotmart = false,
}: {
    isOpen: boolean
    onClose: () => void
    clienteId: string
    allLayouts: any[]
    tabTemplates?: any[]
    tabToEdit?: any | null
    clienteHasHotmart?: boolean
}) {
    const [nombre, setNombre] = useState(tabToEdit?.nombre || '')
    // Filtro de campaña: una o varias condiciones combinadas con Y/O.
    const initial = initConditions(tabToEdit?.keyword_meta)
    const [filterMode, setFilterMode] = useState<'and' | 'or'>(initial.mode)
    const [conditions, setConditions] = useState<FilterCond[]>(initial.conditions)
    // Plantilla de pestaña a aplicar al crear una nueva (solo visualización)
    const [templateId, setTemplateId] = useState('none')
    const [savingTemplate, setSavingTemplate] = useState(false)
    const [layoutId, setLayoutId] = useState(tabToEdit?.plantilla_id || 'none')
    const [fechaInicio, setFechaInicio] = useState(tabToEdit?.fecha_inicio || '')
    const [fechaFinalizacion, setFechaFinalizacion] = useState(tabToEdit?.fecha_finalizacion || '')
    const [presupuestoObjetivo, setPresupuestoObjetivo] = useState(tabToEdit?.presupuesto_objetivo?.toString() || '')

    // Hotmart funnel state
    const initialFunnel: HotmartFunnel = (tabToEdit?.hotmart_funnel as HotmartFunnel) || {}
    const [funnelEnabled, setFunnelEnabled] = useState<boolean>(!!initialFunnel.enabled)
    const [funnelExpanded, setFunnelExpanded] = useState<boolean>(!!initialFunnel.enabled)
    const [principalNames, setPrincipalNames] = useState<string>(arrayToText(initialFunnel.principal_names))
    const [principalPriceUsd, setPrincipalPriceUsd] = useState<string>(initialFunnel.principal_price_usd?.toString() || '')
    const [bumpNames, setBumpNames] = useState<string>(arrayToText(initialFunnel.bump_names))
    const [upsellNames, setUpsellNames] = useState<string>(arrayToText(initialFunnel.upsell_names))
    const [landingPageUrls, setLandingPageUrls] = useState<string>(arrayToText(initialFunnel.landing_page_urls))
    const [paymentPageUrl, setPaymentPageUrl] = useState<string>(initialFunnel.payment_page_url || '')
    const [upsellPageUrl, setUpsellPageUrl] = useState<string>(initialFunnel.upsell_page_url || '')

    const [saving, setSaving] = useState(false)
    const [duplicating, setDuplicating] = useState(false)

    async function handleDuplicate() {
        if (!tabToEdit?.id) return
        setDuplicating(true)
        const res = await duplicateClienteTab(clienteId, tabToEdit.id)
        setDuplicating(false)
        if (res.error) { toast.error('Error al duplicar: ' + res.error); return }
        onClose()
    }

    async function handleSaveAsTemplate() {
        if (!tabToEdit?.id) return
        const name = window.prompt(
            'Nombre de la plantilla (guarda la visualización de esta pestaña para reutilizarla en otras campañas):',
            tabToEdit.nombre || ''
        )
        if (name === null) return
        if (!name.trim()) { toast.error('El nombre de la plantilla es obligatorio'); return }
        setSavingTemplate(true)
        const res = await saveTabAsTemplate(clienteId, tabToEdit.id, name)
        setSavingTemplate(false)
        if (res.error) { toast.error('Error al guardar plantilla: ' + res.error); return }
        toast.success(`Plantilla "${name.trim()}" guardada`)
    }

    const hasValidCondition = conditions.some(c => c.value.trim() !== '')

    const updateCondition = (idx: number, patch: Partial<FilterCond>) =>
        setConditions(prev => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
    const addCondition = () =>
        setConditions(prev => [...prev, { operator: 'includes', value: '' }])
    const removeCondition = (idx: number) =>
        setConditions(prev => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))

    const handleSave = async () => {
        if (!nombre || !hasValidCondition) return
        setSaving(true)

        // Serializa a keyword_meta: string plano si es una sola condición "Contiene",
        // o JSON con prefijo __cf: si es compuesto. Retro-compatible con lo existente.
        const keyword_meta = serializeTabFilter({
            mode: filterMode,
            conditions: conditions
                .filter(c => c.value.trim() !== '')
                .map(c => ({ type: 'keyword' as const, operator: c.operator, value: c.value.trim() })),
        })

        let hotmart_funnel: HotmartFunnel | null = null
        if (clienteHasHotmart && funnelEnabled) {
            hotmart_funnel = {
                enabled: true,
                principal_names: textToArray(principalNames),
                principal_price_usd: principalPriceUsd ? parseFloat(principalPriceUsd) : undefined,
                bump_names: textToArray(bumpNames),
                upsell_names: textToArray(upsellNames),
                landing_page_urls: textToArray(landingPageUrls),
                payment_page_url: paymentPageUrl.trim() || undefined,
                upsell_page_url: upsellPageUrl.trim() || undefined,
            }
        }

        await saveClienteTab(clienteId, {
            id: tabToEdit?.id,
            nombre,
            keyword_meta,
            plantilla_id: layoutId === 'none' ? undefined : layoutId,
            fecha_inicio: fechaInicio || undefined,
            fecha_finalizacion: fechaFinalizacion || undefined,
            presupuesto_objetivo: presupuestoObjetivo ? parseFloat(presupuestoObjetivo) : undefined,
            template_id: !tabToEdit && templateId !== 'none' ? templateId : undefined,
            hotmart_funnel,
        })
        setSaving(false)
        onClose()
    }

    const handleDelete = async () => {
        if (!tabToEdit?.id) return
        if (!confirm('¿Seguro que deseas eliminar esta pestaña?')) return
        setSaving(true)
        await deleteClienteTab(clienteId, tabToEdit.id)
        setSaving(false)
        onClose()
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="bg-background border-border text-foreground max-h-[90vh] overflow-y-auto overflow-x-hidden">
                <DialogHeader>
                    <DialogTitle>{tabToEdit ? 'Editar Pestaña' : 'Nueva Pestaña'}</DialogTitle>
                    <DialogDescription className="text-muted-foreground/70">
                        Configura un nombre, la palabra clave para filtrar campañas de Meta, y la plantilla de métricas a mostrar.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4 min-w-0">
                    {/* Partir de plantilla (solo al crear una pestaña nueva) */}
                    {!tabToEdit && tabTemplates.length > 0 && (
                        <div className="space-y-2 rounded-lg border border-border bg-card/50 p-3">
                            <label className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                                <Bookmark className="w-3.5 h-3.5" />
                                Partir de una plantilla
                            </label>
                            <Select value={templateId} onValueChange={setTemplateId}>
                                <SelectTrigger className="w-full bg-card border-border">
                                    <SelectValue placeholder="En blanco..." />
                                </SelectTrigger>
                                <SelectContent className="bg-card border-border text-foreground z-[120]">
                                    <SelectItem value="none">En blanco</SelectItem>
                                    {tabTemplates.map(t => (
                                        <SelectItem key={t.id} value={t.id}>{t.nombre}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-[10px] text-muted-foreground/70">
                                Copia la visualización (tarjetas, gráficos, ranking, métricas) de una pestaña guardada. El filtro de campaña lo defines abajo.
                            </p>
                        </div>
                    )}

                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground">Nombre de la Pestaña</label>
                        <Input
                            placeholder="Ej. Diplomado TCC"
                            value={nombre}
                            onChange={e => setNombre(e.target.value)}
                            className="bg-card border-border"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground">Filtro de Campañas (Meta / TikTok)</label>

                        {/* Selector Y/O (solo con 2+ condiciones) */}
                        {conditions.length > 1 && (
                            <div className="flex items-center gap-2">
                                <span className="text-[11px] text-muted-foreground/70">Cumplir</span>
                                <div className="inline-flex rounded-md border border-border overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setFilterMode('and')}
                                        className={`px-2.5 py-1 text-xs transition ${filterMode === 'and' ? 'bg-blue-600 text-white' : 'bg-card text-muted-foreground hover:bg-accent'}`}
                                    >Todas (Y)</button>
                                    <button
                                        type="button"
                                        onClick={() => setFilterMode('or')}
                                        className={`px-2.5 py-1 text-xs transition ${filterMode === 'or' ? 'bg-blue-600 text-white' : 'bg-card text-muted-foreground hover:bg-accent'}`}
                                    >Alguna (O)</button>
                                </div>
                                <span className="text-[11px] text-muted-foreground/70">las condiciones</span>
                            </div>
                        )}

                        <div className="space-y-2">
                            {conditions.map((cond, idx) => (
                                <div key={idx} className="flex items-center gap-2">
                                    <Select value={cond.operator} onValueChange={v => updateCondition(idx, { operator: v as CampaignFilterOperator })}>
                                        <SelectTrigger className="w-[140px] flex-shrink-0 bg-card border-border h-9">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className="bg-card border-border text-foreground z-[120]">
                                            {TAB_FILTER_OPS.map(op => (
                                                <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    <Input
                                        placeholder="Ej. LSP"
                                        value={cond.value}
                                        onChange={e => updateCondition(idx, { value: e.target.value })}
                                        className="bg-card border-border"
                                    />
                                    {conditions.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => removeCondition(idx)}
                                            className="flex-shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition"
                                            title="Quitar condición"
                                        >
                                            <X className="w-4 h-4" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>

                        <button
                            type="button"
                            onClick={addCondition}
                            className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                            <Plus className="w-3.5 h-3.5" /> Añadir condición
                        </button>
                        <p className="text-[10px] text-muted-foreground/70">
                            Filtra las campañas de esta pestaña por su nombre. Combina varias condiciones para afinar (ej. <span className="font-mono">Contiene «LSP»</span> y <span className="font-mono">Contiene «LAGORANCOII»</span>).
                        </p>
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-muted-foreground">Plantilla de Layout Asociada</label>
                        <Select value={layoutId} onValueChange={setLayoutId}>
                            <SelectTrigger className="w-full bg-card border-border">
                                <SelectValue placeholder="Seleccionar plantilla..." />
                            </SelectTrigger>
                            <SelectContent className="bg-card border-border text-foreground z-[120]">
                                <SelectItem value="none">Por Defecto (Del cliente)</SelectItem>
                                {allLayouts.map(l => (
                                    <SelectItem key={l.id} value={l.id}>{l.nombre}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-muted-foreground">Fecha de Inicio (Opcional)</label>
                            <Input
                                type="date"
                                value={fechaInicio}
                                onChange={e => setFechaInicio(e.target.value)}
                                className="bg-card border-border"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-muted-foreground">Fecha de Cierre (Opcional)</label>
                            <Input
                                type="date"
                                value={fechaFinalizacion}
                                onChange={e => setFechaFinalizacion(e.target.value)}
                                className="bg-card border-border"
                            />
                        </div>

                        <div className="space-y-2 col-span-2">
                            <label className="text-xs font-semibold text-muted-foreground">Presupuesto ($) (Opcional)</label>
                            <Input
                                type="number"
                                placeholder="Ej. 4000000"
                                value={presupuestoObjetivo}
                                onChange={e => setPresupuestoObjetivo(e.target.value)}
                                className="bg-card border-border"
                            />
                        </div>
                    </div>

                    {/* ─── Sección Hotmart Funnel (solo si cliente tiene Hotmart conectado) ─── */}
                    {clienteHasHotmart && (
                        <div className="border border-border rounded-lg overflow-hidden">
                            <button
                                type="button"
                                onClick={() => setFunnelExpanded(v => !v)}
                                className="w-full flex items-center justify-between px-4 py-3 bg-card hover:bg-accent transition"
                            >
                                <div className="flex items-center gap-2">
                                    <Zap className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                                    <span className="text-sm font-semibold text-foreground">Funnel Hotmart</span>
                                    {funnelEnabled && <span className="text-[10px] bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full">Activo</span>}
                                </div>
                                {funnelExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground/70" /> : <ChevronRight className="w-4 h-4 text-muted-foreground/70" />}
                            </button>

                            {funnelExpanded && (
                                <div className="p-4 space-y-4 bg-background">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={funnelEnabled}
                                            onChange={e => setFunnelEnabled(e.target.checked)}
                                            className="w-4 h-4 rounded border-border bg-card"
                                        />
                                        <span className="text-sm text-foreground/90">Esta pestaña representa un funnel de Hotmart</span>
                                    </label>

                                    {funnelEnabled && (
                                        <>
                                            <p className="text-xs text-muted-foreground/70 leading-relaxed">
                                                Separa nombres de productos por comas. Soporta wildcards SQL <code className="bg-card px-1 rounded">%</code> (cualquier secuencia) y <code className="bg-card px-1 rounded">_</code> (un carácter). Ej. <code className="bg-card px-1 rounded">Camaradictos%</code>.
                                            </p>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-muted-foreground">Productos Principal</label>
                                                <Input
                                                    placeholder="Ej. Photocards Pro, Curso%"
                                                    value={principalNames}
                                                    onChange={e => setPrincipalNames(e.target.value)}
                                                    className="bg-card border-border"
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-muted-foreground">Precio Producto Principal (USD)</label>
                                                <Input
                                                    type="number"
                                                    step="0.01"
                                                    placeholder="Ej. 19.00"
                                                    value={principalPriceUsd}
                                                    onChange={e => setPrincipalPriceUsd(e.target.value)}
                                                    className="bg-card border-border"
                                                />
                                                <p className="text-[10px] text-muted-foreground/70">Precio de venta en USD. Se usa para calcular la Facturación Bruta (ventas × precio). Si no se configura, se usa el valor de la transacción reportado por Hotmart.</p>
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-muted-foreground">Productos Order Bump</label>
                                                <Input
                                                    placeholder="Ej. Bump Photocards"
                                                    value={bumpNames}
                                                    onChange={e => setBumpNames(e.target.value)}
                                                    className="bg-card border-border"
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-muted-foreground">Productos Upsell</label>
                                                <Input
                                                    placeholder="Ej. Upsell Photocards"
                                                    value={upsellNames}
                                                    onChange={e => setUpsellNames(e.target.value)}
                                                    className="bg-card border-border"
                                                />
                                            </div>

                                            <div className="border-t border-border pt-3 space-y-3">
                                                <p className="text-xs text-muted-foreground/70">Páginas en GA4 (las visitas/sesiones se cuentan desde Analytics, no desde Hotmart):</p>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-muted-foreground">Landing Page(s) — Visitas al funnel</label>
                                                    <Input
                                                        placeholder="Ej. PH PRO NUEVA VERSION – Camaradictos, /landing-v2"
                                                        value={landingPageUrls}
                                                        onChange={e => setLandingPageUrls(e.target.value)}
                                                        className="bg-card border-border font-mono text-xs"
                                                    />
                                                    <p className="text-[10px] text-muted-foreground/70">Separá por comas. Si empieza con <code className="bg-card px-1 rounded">/</code> filtra por URL, si no por título de página (pageTitle en GA4). Para A/B tests podés poner varias: las sesiones se suman.</p>
                                                </div>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-muted-foreground">Página de Pago en GA4 (para "Pagos Iniciados")</label>
                                                    <Input
                                                        placeholder="Ej. /checkout/photocards  o  PHOTOCARDS PRO (KIT COMPLETO)"
                                                        value={paymentPageUrl}
                                                        onChange={e => setPaymentPageUrl(e.target.value)}
                                                        className="bg-card border-border font-mono text-xs"
                                                    />
                                                    <p className="text-[10px] text-muted-foreground/70">Si empieza con <code className="bg-card px-1 rounded">/</code> se busca por URL (pagePath). Si no, se busca por título de página (pageTitle) tal como aparece en GA4.</p>
                                                </div>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-muted-foreground">Página de Upsell en GA4 (para "Visitas pág. Upsell")</label>
                                                    <Input
                                                        placeholder="Ej. /upsell/photocards  o  UPSELL PHOTOCARDS"
                                                        value={upsellPageUrl}
                                                        onChange={e => setUpsellPageUrl(e.target.value)}
                                                        className="bg-card border-border font-mono text-xs"
                                                    />
                                                    <p className="text-[10px] text-muted-foreground/70">Si empieza con <code className="bg-card px-1 rounded">/</code> se busca por URL (pagePath). Si no, se busca por título de página (pageTitle).</p>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border mt-2">
                    <div className="flex flex-wrap items-center gap-2">
                        {tabToEdit && (
                            <Button
                                variant="destructive"
                                onClick={handleDelete}
                                disabled={saving}
                                className="text-xs h-8 px-3 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 hover:text-red-700 dark:hover:text-red-300"
                            >
                                <Trash2 className="w-3.5 h-3.5 mr-1" />
                                Eliminar
                            </Button>
                        )}
                        {tabToEdit && (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleDuplicate}
                                disabled={duplicating || saving}
                                className="text-xs h-8 px-3 border-border text-foreground/90 hover:bg-accent gap-1.5"
                            >
                                <Copy className="w-3.5 h-3.5" />
                                {duplicating ? 'Duplicando...' : 'Duplicar'}
                            </Button>
                        )}
                        {tabToEdit && (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleSaveAsTemplate}
                                disabled={savingTemplate || saving}
                                className="text-xs h-8 px-3 border-border text-foreground/90 hover:bg-accent gap-1.5"
                            >
                                <Bookmark className="w-3.5 h-3.5" />
                                {savingTemplate ? 'Guardando...' : 'Guardar como plantilla'}
                            </Button>
                        )}
                    </div>
                    <div className="flex items-center gap-2 ml-auto">
                        <Button variant="outline" onClick={onClose} disabled={saving} className="text-xs h-8 px-3 bg-card border-border hover:bg-accent">
                            Cancelar
                        </Button>
                        <Button onClick={handleSave} disabled={saving || !nombre || !hasValidCondition} className="text-xs h-8 px-3 bg-blue-600 hover:bg-blue-700 text-white">
                            {saving ? 'Guardando...' : 'Guardar Pestaña'}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
