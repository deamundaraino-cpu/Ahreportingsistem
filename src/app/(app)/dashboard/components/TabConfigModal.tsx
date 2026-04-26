'use client'

import { useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Trash2, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { saveClienteTab, deleteClienteTab } from '../_actions'

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
    tabToEdit = null,
    clienteHasHotmart = false,
}: {
    isOpen: boolean
    onClose: () => void
    clienteId: string
    allLayouts: any[]
    tabToEdit?: any | null
    clienteHasHotmart?: boolean
}) {
    const [nombre, setNombre] = useState(tabToEdit?.nombre || '')
    const [keyword, setKeyword] = useState(tabToEdit?.keyword_meta || '')
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

    const handleSave = async () => {
        if (!nombre || !keyword) return
        setSaving(true)

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
            keyword_meta: keyword,
            plantilla_id: layoutId === 'none' ? undefined : layoutId,
            fecha_inicio: fechaInicio || undefined,
            fecha_finalizacion: fechaFinalizacion || undefined,
            presupuesto_objetivo: presupuestoObjetivo ? parseFloat(presupuestoObjetivo) : undefined,
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
            <DialogContent className="bg-zinc-950 border-zinc-800 text-zinc-200 max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{tabToEdit ? 'Editar Pestaña' : 'Nueva Pestaña'}</DialogTitle>
                    <DialogDescription className="text-zinc-500">
                        Configura un nombre, la palabra clave para filtrar campañas de Meta, y la plantilla de métricas a mostrar.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-zinc-400">Nombre de la Pestaña</label>
                        <Input
                            placeholder="Ej. Diplomado TCC"
                            value={nombre}
                            onChange={e => setNombre(e.target.value)}
                            className="bg-zinc-900 border-zinc-800"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-zinc-400">Palabra Clave (Filtro Meta)</label>
                        <Input
                            placeholder="Ej. EDU-TCC"
                            value={keyword}
                            onChange={e => setKeyword(e.target.value)}
                            className="bg-zinc-900 border-zinc-800"
                        />
                    </div>

                    <div className="space-y-2">
                        <label className="text-xs font-semibold text-zinc-400">Plantilla de Layout Asociada</label>
                        <Select value={layoutId} onValueChange={setLayoutId}>
                            <SelectTrigger className="w-full bg-zinc-900 border-zinc-800">
                                <SelectValue placeholder="Seleccionar plantilla..." />
                            </SelectTrigger>
                            <SelectContent className="bg-zinc-900 border-zinc-800 text-white z-[120]">
                                <SelectItem value="none">Por Defecto (Del cliente)</SelectItem>
                                {allLayouts.map(l => (
                                    <SelectItem key={l.id} value={l.id}>{l.nombre}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400">Fecha de Inicio (Opcional)</label>
                            <Input
                                type="date"
                                value={fechaInicio}
                                onChange={e => setFechaInicio(e.target.value)}
                                className="bg-zinc-900 border-zinc-800"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-zinc-400">Fecha de Cierre (Opcional)</label>
                            <Input
                                type="date"
                                value={fechaFinalizacion}
                                onChange={e => setFechaFinalizacion(e.target.value)}
                                className="bg-zinc-900 border-zinc-800"
                            />
                        </div>

                        <div className="space-y-2 col-span-2">
                            <label className="text-xs font-semibold text-zinc-400">Presupuesto ($) (Opcional)</label>
                            <Input
                                type="number"
                                placeholder="Ej. 4000000"
                                value={presupuestoObjetivo}
                                onChange={e => setPresupuestoObjetivo(e.target.value)}
                                className="bg-zinc-900 border-zinc-800"
                            />
                        </div>
                    </div>

                    {/* ─── Sección Hotmart Funnel (solo si cliente tiene Hotmart conectado) ─── */}
                    {clienteHasHotmart && (
                        <div className="border border-zinc-800 rounded-lg overflow-hidden">
                            <button
                                type="button"
                                onClick={() => setFunnelExpanded(v => !v)}
                                className="w-full flex items-center justify-between px-4 py-3 bg-zinc-900 hover:bg-zinc-800/80 transition"
                            >
                                <div className="flex items-center gap-2">
                                    <Zap className="w-4 h-4 text-orange-400" />
                                    <span className="text-sm font-semibold text-zinc-200">Funnel Hotmart</span>
                                    {funnelEnabled && <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded-full">Activo</span>}
                                </div>
                                {funnelExpanded ? <ChevronDown className="w-4 h-4 text-zinc-500" /> : <ChevronRight className="w-4 h-4 text-zinc-500" />}
                            </button>

                            {funnelExpanded && (
                                <div className="p-4 space-y-4 bg-zinc-950">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={funnelEnabled}
                                            onChange={e => setFunnelEnabled(e.target.checked)}
                                            className="w-4 h-4 rounded border-zinc-700 bg-zinc-900"
                                        />
                                        <span className="text-sm text-zinc-300">Esta pestaña representa un funnel de Hotmart</span>
                                    </label>

                                    {funnelEnabled && (
                                        <>
                                            <p className="text-xs text-zinc-500 leading-relaxed">
                                                Separa nombres de productos por comas. Soporta wildcards SQL <code className="bg-zinc-900 px-1 rounded">%</code> (cualquier secuencia) y <code className="bg-zinc-900 px-1 rounded">_</code> (un carácter). Ej. <code className="bg-zinc-900 px-1 rounded">Camaradictos%</code>.
                                            </p>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-zinc-400">Productos Principal</label>
                                                <Input
                                                    placeholder="Ej. Photocards Pro, Curso%"
                                                    value={principalNames}
                                                    onChange={e => setPrincipalNames(e.target.value)}
                                                    className="bg-zinc-900 border-zinc-800"
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-zinc-400">Precio Producto Principal (USD)</label>
                                                <Input
                                                    type="number"
                                                    step="0.01"
                                                    placeholder="Ej. 19.00"
                                                    value={principalPriceUsd}
                                                    onChange={e => setPrincipalPriceUsd(e.target.value)}
                                                    className="bg-zinc-900 border-zinc-800"
                                                />
                                                <p className="text-[10px] text-zinc-600">Precio de venta en USD. Se usa para calcular la Facturación Bruta (ventas × precio). Si no se configura, se usa el valor de la transacción reportado por Hotmart.</p>
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-zinc-400">Productos Order Bump</label>
                                                <Input
                                                    placeholder="Ej. Bump Photocards"
                                                    value={bumpNames}
                                                    onChange={e => setBumpNames(e.target.value)}
                                                    className="bg-zinc-900 border-zinc-800"
                                                />
                                            </div>

                                            <div className="space-y-2">
                                                <label className="text-xs font-semibold text-zinc-400">Productos Upsell</label>
                                                <Input
                                                    placeholder="Ej. Upsell Photocards"
                                                    value={upsellNames}
                                                    onChange={e => setUpsellNames(e.target.value)}
                                                    className="bg-zinc-900 border-zinc-800"
                                                />
                                            </div>

                                            <div className="border-t border-zinc-800 pt-3 space-y-3">
                                                <p className="text-xs text-zinc-500">Páginas en GA4 (las visitas/sesiones se cuentan desde Analytics, no desde Hotmart):</p>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-zinc-400">Landing Page(s) — Visitas al funnel</label>
                                                    <Input
                                                        placeholder="Ej. PH PRO NUEVA VERSION – Camaradictos, /landing-v2"
                                                        value={landingPageUrls}
                                                        onChange={e => setLandingPageUrls(e.target.value)}
                                                        className="bg-zinc-900 border-zinc-800 font-mono text-xs"
                                                    />
                                                    <p className="text-[10px] text-zinc-600">Separá por comas. Si empieza con <code className="bg-zinc-900 px-1 rounded">/</code> filtra por URL, si no por título de página (pageTitle en GA4). Para A/B tests podés poner varias: las sesiones se suman.</p>
                                                </div>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-zinc-400">Página de Pago en GA4 (para "Pagos Iniciados")</label>
                                                    <Input
                                                        placeholder="Ej. /checkout/photocards  o  PHOTOCARDS PRO (KIT COMPLETO)"
                                                        value={paymentPageUrl}
                                                        onChange={e => setPaymentPageUrl(e.target.value)}
                                                        className="bg-zinc-900 border-zinc-800 font-mono text-xs"
                                                    />
                                                    <p className="text-[10px] text-zinc-600">Si empieza con <code className="bg-zinc-900 px-1 rounded">/</code> se busca por URL (pagePath). Si no, se busca por título de página (pageTitle) tal como aparece en GA4.</p>
                                                </div>

                                                <div className="space-y-2">
                                                    <label className="text-xs font-semibold text-zinc-400">Página de Upsell en GA4 (para "Visitas pág. Upsell")</label>
                                                    <Input
                                                        placeholder="Ej. /upsell/photocards  o  UPSELL PHOTOCARDS"
                                                        value={upsellPageUrl}
                                                        onChange={e => setUpsellPageUrl(e.target.value)}
                                                        className="bg-zinc-900 border-zinc-800 font-mono text-xs"
                                                    />
                                                    <p className="text-[10px] text-zinc-600">Si empieza con <code className="bg-zinc-900 px-1 rounded">/</code> se busca por URL (pagePath). Si no, se busca por título de página (pageTitle).</p>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="gap-2 sm:gap-0">
                    {tabToEdit && (
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={saving}
                            className="mr-auto text-xs h-9 bg-red-900/30 text-red-400 hover:bg-red-900/50 hover:text-red-300"
                        >
                            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                            Eliminar
                        </Button>
                    )}
                    <Button variant="outline" onClick={onClose} disabled={saving} className="bg-zinc-900 border-zinc-700 hover:bg-zinc-800">
                        Cancelar
                    </Button>
                    <Button onClick={handleSave} disabled={saving || !nombre || !keyword} className="bg-blue-600 hover:bg-blue-700 text-white">
                        {saving ? 'Guardando...' : 'Guardar Pestaña'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}
