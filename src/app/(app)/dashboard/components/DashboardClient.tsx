'use client'

import React, { useState, useEffect, useMemo, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { format, parseISO, addDays, getDay, differenceInDays, isValid } from 'date-fns'
import { es } from 'date-fns/locale'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'
import { evaluateFormula, aggregateFormula, formatValue, filterRowByTikTokAccount } from '@/lib/formula-engine'
import type { QuickEditTarget } from './QuickEditModal'
import { MetricCharts } from './MetricCharts'

const LayoutConfigModal = dynamic(
    () => import('./LayoutConfigModal').then(m => ({ default: m.LayoutConfigModal })),
    { loading: () => null }
)
const QuickEditModal = dynamic(
    () => import('./QuickEditModal').then(m => ({ default: m.QuickEditModal })),
    { loading: () => null }
)
const TabConfigModal = dynamic(
    () => import('./TabConfigModal').then(m => ({ default: m.TabConfigModal })),
    { loading: () => null }
)
import { LayoutDashboard, Settings2, Plus, Edit2, CalendarDays, Timer, BadgeDollarSign, Wallet, GripVertical, Search, X, Puzzle, Type, AlignLeft, AlignCenter, AlignRight, Trash2, Save, Loader2, Minus, Archive, Copy, BarChart3, Table2, CreditCard, ListChecks } from 'lucide-react'
import type { ColDef, CardDef, ReportLayout, ChartDef, MetricDef, TextBlockDef, RankingTableDef, LeadAnswerBlockDef } from '@/lib/layout-types'
import { updateManualMetric, getTabTotalSpend, saveClienteLayout, saveTabOverrides, updateLayoutPuzzleState, toggleTabArchived } from '../_actions'
import { SortableCard, SortableChart, SortableTable, SortableText } from './PuzzleComponents'
import { CountryBreakdown } from './CountryBreakdown'
import { RankingTableBlock } from './RankingTableBlock'
import { LeadAnswerBlock } from './LeadAnswerBlock'
import type { LeadAnswerDatasetLite } from '@/lib/dashboard/lead-answer-aggregation'
import { refDeCubo, clavesYRefDelDia } from '@/lib/dashboard/lead-answer-row'
import { TabArchiveView } from './TabArchiveView'

const SupportModule = dynamic(
    () => import('./SupportModule').then(m => ({ default: m.SupportModule })),
    { loading: () => <Skeleton className="h-64 rounded-xl" /> }
)
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'

import { CSS } from '@dnd-kit/utilities'
import { enrichMetaRow, enrichTikTokRow, parseTabFilter, tabFilterLabel, applyCompoundFilter } from '@/lib/campaign-filter'
import { enrichOfflineRow } from '@/lib/offline-filter'
import type { CampaignFilterSpec, TabCampaignFilter } from '@/lib/layout-types'

/**
 * Añade a cada fila del rango las claves de Report-UTM: `utm_leads` (contactos
 * del día) y una por respuesta de cada pregunta configurada.
 *
 * Se hace AQUÍ y no en el servidor porque el recorte por campaña lo decide la
 * pestaña activa, que el servidor no conoce. Es el mismo sitio y el mismo patrón
 * que los campos `funnel_*`.
 *
 * A partir de aquí, el motor de fórmulas las trata como cualquier otra métrica:
 * sirven en tarjetas, gráficas, columnas de tabla y tablas de ranking, y se
 * pueden dividir por el gasto —que está recortado por la MISMA campaña— para
 * obtener el costo por lead de un segmento.
 */
function inyectarRespuestas(
    filas: any[],
    ds: LeadAnswerDatasetLite | null | undefined,
    keyword: string | TabCampaignFilter,
    campaignGroups: any[] | undefined,
): any[] {
    const ref = refDeCubo(ds, keyword, campaignGroups)
    if (!ref) return filas
    // Además de los escalares, la fila se lleva el cubo POR REFERENCIA: es lo que
    // permite que una tarjeta o una columna con `campaignFilter` propio recalcule
    // estas cifras en vez de arrastrar las de toda la pestaña. Ver lead-answer-row.
    return filas.map((row: any) => ({ ...row, ...clavesYRefDelDia(ref, String(row.fecha ?? '')) }))
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function safeFmt(dateStr: string | null | undefined, fmt: string): string {
    if (!dateStr) return '...'
    try {
        const d = parseISO(dateStr)
        if (!isValid(d)) return '...'
        return format(d, fmt, { locale: es })
    } catch { return '...' }
}

function resolveFilter(
    campaignFilter: CampaignFilterSpec | undefined,
    fallback: string
): CampaignFilterSpec | string {
    if (campaignFilter) return campaignFilter
    return fallback
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, string> = {
    emerald: 'text-emerald-600 dark:text-emerald-400',
    red: 'text-red-600 dark:text-red-400',
    blue: 'text-blue-600 dark:text-blue-400',
    amber: 'text-amber-600 dark:text-amber-400',
    default: 'text-foreground',
}

function highlightClass(value: number | null, col: ColDef): string {
    if (!col.highlight || value === null) return ''
    if (col.suffix === 'x') return value >= 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
    if (col.suffix === '%') return value >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
    return ''
}

// ─── Layout Config Button ─────────────────────────────────────────────────────

function LayoutConfigButton({ onClick, isCustomized }: { onClick: () => void; isCustomized: boolean }) {
    return (
        <Button
            size="sm"
            variant="outline"
            onClick={onClick}
            className="gap-1.5 border-border text-muted-foreground hover:text-indigo-300 hover:border-indigo-500/40 hover:bg-indigo-500/5 text-xs transition"
        >
            <Settings2 className="w-3.5 h-3.5" />
            {isCustomized ? 'Layout personalizado ✦' : 'Configurar Layout'}
        </Button>
    )
}

// ─── Sortable Tab Component ──────────────────────────────────────────────────

function SortableTab({ tab, isActive, onSelect, onEdit, isPublic, hasOverride }: {
    tab: any
    isActive: boolean
    onSelect: () => void
    onEdit: () => void
    isPublic?: boolean
    hasOverride: boolean
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 50 : 'auto' as any,
    }

    return (
        <div ref={setNodeRef} style={style} className="relative group flex items-center">
            {!isPublic && (
                <button
                    {...attributes}
                    {...listeners}
                    className="p-1 text-muted-foreground/70 hover:text-muted-foreground cursor-grab active:cursor-grabbing"
                    title="Arrastrar para reordenar"
                >
                    <GripVertical className="w-3.5 h-3.5" />
                </button>
            )}
            <button
                onClick={onSelect}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${isActive ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-500/10' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'}`}
            >
                {tab.nombre}
                <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono tracking-wider transition ${isActive ? 'bg-blue-500/20 text-blue-500 dark:text-blue-300 border border-blue-500/20' : 'bg-muted/80 text-muted-foreground/50'}`}
                    title={`Filtro de campaña: ${tabFilterLabel(tab.keyword_meta)}`}
                >{tabFilterLabel(tab.keyword_meta)}</span>
                {hasOverride && (
                    <span className="text-[9px] text-indigo-600 dark:text-indigo-400 font-bold" title="Vista personalizada">✦</span>
                )}
            </button>
            {!isPublic && (
                <button
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    className={`absolute right-1 p-1 text-muted-foreground/70 hover:text-foreground rounded bg-card shadow border border-border opacity-0 group-hover:opacity-100 transition ${isActive ? 'opacity-100' : ''}`}
                >
                    <Edit2 className="w-3 h-3" />
                </button>
            )}
        </div>
    )
}

// ─── Extras Panel: productos Hotmart sin funnel asignado ───────────────────
// Aparece en Vista General y agrega los productos "extras" del rango filtrado.
// Se nutre de hotmart_funnel_data.extras[] de cada metricas_diarias del rango.
function ExtrasPanel({ filteredMetrics }: { filteredMetrics: any[] }) {
    const aggregated = useMemo(() => {
        const map = new Map<string, { count: number; gross: number; net: number }>()
        for (const row of filteredMetrics) {
            const extras = (row.hotmart_funnel_data as any)?.extras
            if (!Array.isArray(extras)) continue
            for (const e of extras) {
                const name = e.product_name || '(Sin nombre)'
                const cur = map.get(name) || { count: 0, gross: 0, net: 0 }
                cur.count += Number(e.count) || 0
                cur.gross += Number(e.gross) || 0
                cur.net   += Number(e.net)   || 0
                map.set(name, cur)
            }
        }
        return Array.from(map.entries())
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.net - a.net)
    }, [filteredMetrics])

    if (aggregated.length === 0) return null

    const totalCount = aggregated.reduce((s, r) => s + r.count, 0)
    const totalNet   = aggregated.reduce((s, r) => s + r.net,   0)
    const totalGross = aggregated.reduce((s, r) => s + r.gross, 0)

    return (
        <Card className="bg-card border-border overflow-hidden">
            <CardHeader className="border-b border-border bg-background/30 py-3">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-foreground text-base flex items-center gap-2">
                        <span className="text-orange-600 dark:text-orange-400">⚡</span>
                        Productos Extras
                        <span className="text-xs font-normal text-muted-foreground/70">(no asignados a ningún funnel)</span>
                    </CardTitle>
                    <div className="text-xs text-muted-foreground">
                        {aggregated.length} producto{aggregated.length !== 1 ? 's' : ''} · <span className="text-emerald-600 dark:text-emerald-400 font-mono">${totalNet.toFixed(2)}</span> neto
                    </div>
                </div>
            </CardHeader>
            <CardContent className="p-0 overflow-x-auto custom-scrollbar">
                <Table className="whitespace-nowrap">
                    <TableHeader>
                        <TableRow className="border-border bg-background *:text-foreground/90 *:font-semibold *:text-xs">
                            <TableHead className="pl-4">Producto</TableHead>
                            <TableHead className="text-right">Ventas</TableHead>
                            <TableHead className="text-right">Bruto (USD)</TableHead>
                            <TableHead className="text-right pr-4">Neto (USD)</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {aggregated.map(r => (
                            <TableRow key={r.name} className="border-border hover:bg-background/50">
                                <TableCell className="pl-4 text-foreground">{r.name}</TableCell>
                                <TableCell className="text-right font-mono text-foreground/90">{r.count}</TableCell>
                                <TableCell className="text-right font-mono text-muted-foreground">${r.gross.toFixed(2)}</TableCell>
                                <TableCell className="text-right pr-4 font-mono text-emerald-600 dark:text-emerald-400">${r.net.toFixed(2)}</TableCell>
                            </TableRow>
                        ))}
                        <TableRow className="border-border bg-background/60 font-semibold">
                            <TableCell className="pl-4 text-foreground">Total</TableCell>
                            <TableCell className="text-right font-mono text-foreground">{totalCount}</TableCell>
                            <TableCell className="text-right font-mono text-foreground">${totalGross.toFixed(2)}</TableCell>
                            <TableCell className="text-right pr-4 font-mono text-emerald-600 dark:text-emerald-400">${totalNet.toFixed(2)}</TableCell>
                        </TableRow>
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    )
}

// ─── Dynamic Dashboard ────────────────────────────────────────────────────────

function DynamicDashboard({ data, initialLayout, isCustomized, isPublic, initialTabId = 'general', initialKeyword = '', userRole = 'viewer' }: {
    data: any
    initialLayout: ReportLayout
    isCustomized: boolean
    isPublic?: boolean
    initialTabId?: string
    initialKeyword?: string
    userRole?: string
}) {
    const { cliente, metrics, prevMetrics = [], weeks, allLayouts, tabTemplates = [], tabs: initialTabs = [], conversionesCatalogo = [], availablePlatforms: availablePlatformsArr = ['meta'] } = data
    const platformSet = useMemo(() => new Set<string>(availablePlatformsArr), [availablePlatformsArr])
    const searchParams = useSearchParams()
    const tabFromUrl = searchParams.get('tab')
    const [activeTabId, setActiveTabId] = useState<string>(tabFromUrl || initialTabId)

    useEffect(() => {
        if (tabFromUrl) setActiveTabId(tabFromUrl)
    }, [tabFromUrl])

    const [isPuzzleMode, setIsPuzzleMode] = useState(false)
    const [isSavingLayout, setIsSavingLayout] = useState(false)
    const [orderedBlocks, setOrderedBlocks] = useState<string[]>([])
    const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set())
    const [tableColWidths, setTableColWidths] = useState<Record<string, number>>({})
    const tableResizingRef = useRef<{ key: string; startX: number; startW: number } | null>(null)

    useEffect(() => {
        function onMove(e: MouseEvent) {
            if (!tableResizingRef.current) return
            const { key, startX, startW } = tableResizingRef.current
            setTableColWidths(prev => ({ ...prev, [key]: Math.max(40, startW + (e.clientX - startX)) }))
        }
        function onUp() {
            if (!tableResizingRef.current) return
            tableResizingRef.current = null
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
        }
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
        return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    }, [])

    function startTableColResize(key: string, e: React.MouseEvent) {
        e.preventDefault()
        e.stopPropagation()
        const th = (e.currentTarget as HTMLElement).closest('th') as HTMLTableCellElement
        tableResizingRef.current = { key, startX: e.clientX, startW: th?.offsetWidth ?? 100 }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
    }

    function toggleCollapse(blockId: string) {
        setCollapsedBlocks(prev => {
            const next = new Set(prev)
            if (next.has(blockId)) next.delete(blockId)
            else next.add(blockId)
            return next
        })
    }

    // Sortable tabs state
    const [sortedTabs, setSortedTabs] = useState<any[]>(initialTabs)
    const [dragActiveId, setDragActiveId] = useState<string | null>(null)

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
        useSensor(KeyboardSensor)
    )

    const handleDragStart = useCallback((event: DragStartEvent) => {
        setDragActiveId(event.active.id as string)
    }, [])

    const handleDragEnd = useCallback(async (event: DragEndEvent) => {
        setDragActiveId(null)
        const { active, over } = event
        if (!over || active.id === over.id) return

        const oldIndex = sortedTabs.findIndex((t: any) => t.id === active.id)
        const newIndex = sortedTabs.findIndex((t: any) => t.id === over.id)
        if (oldIndex === -1 || newIndex === -1) return

        const reordered = arrayMove(sortedTabs, oldIndex, newIndex)
        const withPositions = reordered.map((tab: any, i: number) => ({ ...tab, position: i }))
        setSortedTabs(withPositions)

        // Persist
        try {
            await fetch('/api/layouts/reorder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clienteId: cliente.id,
                    tabOrder: withPositions.map((t: any) => ({ id: t.id, position: t.position })),
                }),
            })
        } catch {
            setSortedTabs(initialTabs) // revert on error
        }
    }, [sortedTabs, cliente.id, initialTabs])

    // Sync if initialTabs change (e.g. after tab creation/deletion)
    useEffect(() => {
        setSortedTabs(initialTabs)
        // If active tab no longer exists, reset to 'general'
        if (activeTabId !== 'general' && activeTabId !== 'soporte') {
            const tabExists = initialTabs.some((t: any) => t.id === activeTabId)
            if (!tabExists) {
                setActiveTabId('general')
            }
        }
    }, [initialTabs, activeTabId])

    // Use sortedTabs as the canonical tabs list
    const tabs = sortedTabs
    const visibleTabs = tabs.filter((t: any) => !t.archived)
    const archivedCount = tabs.filter((t: any) => t.archived).length

    // Tab Modals
    const [showTabModal, setShowTabModal] = useState(false)
    const [tabToEdit, setTabToEdit] = useState<any>(null)

    // Fallback manual filter for general tab
    const [keywordFilter, setKeywordFilter] = useState(initialKeyword)
    const [showModal, setShowModal] = useState(false)
    const [quickEditTarget, setQuickEditTarget] = useState<QuickEditTarget | null>(null)
    const [addMenuOpen, setAddMenuOpen] = useState(false)
    const [showArchive, setShowArchive] = useState(false)
    const isTeam = ['superadmin', 'admin', 'trafficker'].includes(userRole ?? '')

    const handleToggleArchived = useCallback(async (tabId: string, archived: boolean) => {
        setSortedTabs(prev => prev.map((t: any) => t.id === tabId ? { ...t, archived } : t))
        await toggleTabArchived(cliente.id, tabId, archived)
    }, [cliente.id])

    // Global spend for budget cards
    const [globalSpend, setGlobalSpend] = useState<number | null>(null)
    const [fetchingSpend, setFetchingSpend] = useState(false)

    useEffect(() => {
        const fetchSpend = async () => {
             const tab = tabs.find((t: any) => t.id === activeTabId)
             if (tab && tab.presupuesto_objetivo) {
                 setFetchingSpend(true)
                 const spend = await getTabTotalSpend(cliente.id, tab.keyword_meta, tab.fecha_inicio, tab.fecha_finalizacion)
                 setGlobalSpend(spend)
                 setFetchingSpend(false)
             } else {
                 setGlobalSpend(null)
             }
        }
        fetchSpend()
    }, [activeTabId, tabs, cliente.id])

    // Prevent dnd-kit hydration mismatch (aria-describedby IDs differ server/client)
    const [isMounted, setIsMounted] = useState(false)
    useEffect(() => { setIsMounted(true) }, [])

    // Country breakdown toggle
    const [showCountries, setShowCountries] = useState(false)

    // Local layout overrides per tab (so "Personalizar" changes reflect instantly)
    // Key = tabId ('general' or tab.id), Value = ReportLayout
    const [tabLayoutOverrides, setTabLayoutOverrides] = useState<Record<string, ReportLayout>>({})

    const metaKeywords: string[] = cliente.config_api?.meta_keywords
        ? cliente.config_api.meta_keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
        : []

    const tiktokAccounts: { id: string; label: string; advertiser_id: string }[] =
        (cliente.config_api?.tiktok_accounts ?? []).filter((a: any) => a.advertiser_id)

    // 1. Determine active tab object
    const activeTabObj = useMemo(() => tabs.find((t: any) => t.id === activeTabId), [tabs, activeTabId])

    // 2. Determine effective keyword filter
    // If we are on a custom tab, start with its keyword but allow manual overriding/filtering if keywordFilter is set
    // El keyword de una pestaña puede ser un filtro compuesto (Y/O) serializado.
    const effectiveKeyword: string | TabCampaignFilter = keywordFilter || (activeTabObj ? parseTabFilter(activeTabObj.keyword_meta) : '')

    // 3. Determine effective layout — priority (highest to lowest):
    const { activeLayout, layoutIsCustomized } = useMemo(() => {
        let layout: ReportLayout = initialLayout
        let customized = isCustomized

        if (tabLayoutOverrides[activeTabId]) {
            layout = tabLayoutOverrides[activeTabId]
            customized = true
        } else if (activeTabObj) {
            if (activeTabObj.columnas && activeTabObj.tarjetas) {
                layout = {
                    nombre: activeTabObj.nombre,
                    columnas: activeTabObj.columnas,
                    tarjetas: activeTabObj.tarjetas,
                    graficos: activeTabObj.graficos,
                    text_blocks: activeTabObj.text_blocks ?? undefined,
                    blocks_order: activeTabObj.blocks_order ?? undefined,
                    custom_metrics: activeTabObj.custom_metrics ?? undefined,
                    ranking_tables: activeTabObj.ranking_tables ?? undefined,
                    lead_answer_blocks: activeTabObj.lead_answer_blocks ?? undefined,
                }
                customized = true
            } else if (activeTabObj.plantilla_id) {
                const found = allLayouts.find((l: any) => l.id === activeTabObj.plantilla_id)
                if (found) {
                    layout = {
                        ...found,
                        text_blocks: activeTabObj.text_blocks ?? found.text_blocks,
                        blocks_order: activeTabObj.blocks_order ?? found.blocks_order,
                        ranking_tables: activeTabObj.ranking_tables ?? found.ranking_tables,
                        lead_answer_blocks: activeTabObj.lead_answer_blocks ?? found.lead_answer_blocks,
                    }
                    customized = false
                }
            } else {
                // Tab sin columnas propias ni plantilla — usa layout del cliente pero aplica puzzle state del tab
                layout = {
                    ...initialLayout,
                    text_blocks: activeTabObj.text_blocks ?? initialLayout.text_blocks,
                    blocks_order: activeTabObj.blocks_order ?? initialLayout.blocks_order,
                    ranking_tables: activeTabObj.ranking_tables ?? initialLayout.ranking_tables,
                    lead_answer_blocks: activeTabObj.lead_answer_blocks ?? initialLayout.lead_answer_blocks,
                }
            }
        }
        return { activeLayout: layout, layoutIsCustomized: customized }
    }, [initialLayout, isCustomized, tabLayoutOverrides, activeTabId, activeTabObj, allLayouts])

    // ─── Drag & Drop Persistence ──────────────────────────────────────────────────
    useEffect(() => {
        // Collect all possible block IDs from current layout components
        const availableBlockIds: string[] = [
            ...activeLayout.tarjetas.map(t => `card:${t.id}`),
            ...(activeLayout.graficos || []).map(g => `chart:${g.id}`),
            'table',
            ...(activeLayout.text_blocks || []).map(t => `text:${t.id}`),
            ...(activeLayout.ranking_tables || []).map(r => `ranking:${r.id}`),
            ...(activeLayout.lead_answer_blocks || []).map(b => `leadanswer:${b.id}`),
        ]

        // Reconcile with saved order: keep saved order but append new blocks, remove missing ones
        const savedOrder = activeLayout.blocks_order || []
        const validSaved = savedOrder.filter(id => availableBlockIds.includes(id))
        const missingFromSaved = availableBlockIds.filter(id => !savedOrder.includes(id))
        setOrderedBlocks([...validSaved, ...missingFromSaved])
    }, [activeLayout])

    const layoutCustomMetrics = useMemo(() => {
        const result: Record<string, string> = {}
        if (activeLayout.custom_metrics) {
            activeLayout.custom_metrics.forEach((m: MetricDef) => {
                result[m.id] = m.formula
            })
        }
        return result
    }, [activeLayout.custom_metrics])


    const handleDashboardDragEnd = useCallback((event: DragEndEvent) => {
        const { active, over } = event
        if (!over || active.id === over.id) return
        const oldIndex = orderedBlocks.indexOf(active.id as string)
        const newIndex = orderedBlocks.indexOf(over.id as string)
        if (oldIndex === -1 || newIndex === -1) return
        
        const newOrder = arrayMove(orderedBlocks, oldIndex, newIndex)
        setOrderedBlocks(newOrder)

        // Persist order in memory for tab switches
        setTabLayoutOverrides(prev => ({
            ...prev,
            [activeTabId]: {
                ...(prev[activeTabId] || activeLayout),
                blocks_order: newOrder
            }
        }))
    }, [orderedBlocks, activeTabId, activeLayout])

    async function handleTogglePuzzleMode() {
        if (!isPublic) {
            setIsSavingLayout(true)
            await updateLayoutPuzzleState(cliente.id, activeTabId, {
                blocks_order: orderedBlocks,
                text_blocks: activeLayout.text_blocks || [],
                tarjetas: activeLayout.tarjetas,
                graficos: activeLayout.graficos || [],
                ranking_tables: activeLayout.ranking_tables || [],
                lead_answer_blocks: activeLayout.lead_answer_blocks || [],
                // Necesario para crear fila en clientes_layouts si no existe aún
                full_layout: activeTabId === 'general' ? {
                    nombre: activeLayout.nombre,
                    columnas: activeLayout.columnas,
                    tarjetas: activeLayout.tarjetas,
                    graficos: activeLayout.graficos,
                    custom_metrics: activeLayout.custom_metrics,
                    attribution_strategy: activeLayout.attribution_strategy,
                } : undefined,
            })
            setIsSavingLayout(false)
            setIsPuzzleMode(false)
        }
    }

    function handleRemoveBlock(blockId: string) {
        const newOrder = orderedBlocks.filter(id => id !== blockId)
        setOrderedBlocks(newOrder)

        const base = tabLayoutOverrides[activeTabId] || activeLayout
        const updates: Partial<ReportLayout> = { blocks_order: newOrder }
        if (blockId.startsWith('text:')) {
            const textId = blockId.replace('text:', '')
            updates.text_blocks = (base.text_blocks || []).filter((b: TextBlockDef) => b.id !== textId)
        } else if (blockId.startsWith('card:')) {
            const cardId = blockId.replace('card:', '')
            updates.tarjetas = (base.tarjetas || []).filter((b: any) => b.id !== cardId)
        } else if (blockId.startsWith('chart:')) {
            const chartId = blockId.replace('chart:', '')
            updates.graficos = (base.graficos || []).filter((b: any) => b.id !== chartId)
        } else if (blockId.startsWith('ranking:')) {
            const rankingId = blockId.replace('ranking:', '')
            updates.ranking_tables = (base.ranking_tables || []).filter((b: any) => b.id !== rankingId)
        } else if (blockId.startsWith('leadanswer:')) {
            const answerId = blockId.replace('leadanswer:', '')
            updates.lead_answer_blocks = (base.lead_answer_blocks || []).filter((b: any) => b.id !== answerId)
        }
        setTabLayoutOverrides(prev => ({
            ...prev,
            [activeTabId]: { ...(base), ...updates }
        }))
    }

    async function handleDuplicateBlock(blockId: string) {
        const layout = { ...activeLayout, blocks_order: orderedBlocks }
        const currentOrder = [...orderedBlocks]
        const insertAfterIdx = currentOrder.indexOf(blockId)
        let updated: typeof layout | null = null

        if (blockId.startsWith('card:')) {
            const origId = blockId.replace('card:', '')
            const orig = layout.tarjetas.find((c: any) => c.id === origId)
            if (!orig) return
            const copy = { ...orig, id: crypto.randomUUID(), label: `${orig.label} (copia)` }
            const newOrder = [...currentOrder]
            newOrder.splice(insertAfterIdx + 1, 0, `card:${copy.id}`)
            updated = { ...layout, tarjetas: [...layout.tarjetas, copy], blocks_order: newOrder }
        } else if (blockId.startsWith('chart:')) {
            const origId = blockId.replace('chart:', '')
            const orig = (layout.graficos || []).find((g: any) => g.id === origId)
            if (!orig) return
            const copy = { ...orig, id: crypto.randomUUID(), title: `${orig.title} (copia)` }
            const newOrder = [...currentOrder]
            newOrder.splice(insertAfterIdx + 1, 0, `chart:${copy.id}`)
            updated = { ...layout, graficos: [...(layout.graficos || []), copy], blocks_order: newOrder }
        } else if (blockId.startsWith('text:')) {
            const origId = blockId.replace('text:', '')
            const orig = (layout.text_blocks || []).find((t: any) => t.id === origId)
            if (!orig) return
            const copy = { ...orig, id: crypto.randomUUID() }
            const newOrder = [...currentOrder]
            newOrder.splice(insertAfterIdx + 1, 0, `text:${copy.id}`)
            updated = { ...layout, text_blocks: [...(layout.text_blocks || []), copy], blocks_order: newOrder }
        } else if (blockId.startsWith('ranking:')) {
            const origId = blockId.replace('ranking:', '')
            const orig = (layout.ranking_tables || []).find((r: any) => r.id === origId)
            if (!orig) return
            const copy = { ...orig, id: crypto.randomUUID(), title: `${orig.title} (copia)`, columns: orig.columns.map((c: any) => ({ ...c })) }
            const newOrder = [...currentOrder]
            newOrder.splice(insertAfterIdx + 1, 0, `ranking:${copy.id}`)
            updated = { ...layout, ranking_tables: [...(layout.ranking_tables || []), copy], blocks_order: newOrder }
        } else if (blockId.startsWith('leadanswer:')) {
            const origId = blockId.replace('leadanswer:', '')
            const orig = (layout.lead_answer_blocks || []).find((b: any) => b.id === origId)
            if (!orig) return
            const copy = { ...orig, id: crypto.randomUUID(), title: `${orig.title} (copia)`, clavesOrigen: [...(orig.clavesOrigen || [])] }
            const newOrder = [...currentOrder]
            newOrder.splice(insertAfterIdx + 1, 0, `leadanswer:${copy.id}`)
            updated = { ...layout, lead_answer_blocks: [...(layout.lead_answer_blocks || []), copy], blocks_order: newOrder }
        }

        if (!updated) return
        setTabLayoutOverrides(prev => ({ ...prev, [activeTabId]: updated! }))
        const payload = {
            columnas: updated.columnas,
            tarjetas: updated.tarjetas,
            graficos: updated.graficos,
            text_blocks: updated.text_blocks,
            custom_metrics: updated.custom_metrics,
            blocks_order: updated.blocks_order,
            ranking_tables: updated.ranking_tables,
            lead_answer_blocks: updated.lead_answer_blocks,
        }
        if (activeTabId && activeTabId !== 'general') {
            await saveTabOverrides(cliente.id, activeTabId, payload)
        } else {
            await saveClienteLayout(cliente.id, payload)
        }
    }

    function handleAddNewBlock(type: 'card' | 'chart' | 'ranking' | 'text' | 'leadanswer') {
        const newId = crypto.randomUUID()
        const base = { ...(tabLayoutOverrides[activeTabId] || activeLayout), blocks_order: orderedBlocks }

        let updated: typeof base
        let target: QuickEditTarget

        if (type === 'card') {
            const newCard: CardDef = { id: newId, label: 'Nueva tarjeta', formula: 'meta_spend', prefix: '$', suffix: '', decimals: 2, color: 'default' }
            updated = { ...base, tarjetas: [...(base.tarjetas || []), newCard], blocks_order: [...orderedBlocks, `card:${newId}`] }
            target = { type: 'card', id: newId }
        } else if (type === 'chart') {
            const newChart: ChartDef = { id: newId, title: 'Nuevo gráfico', type: 'line', categoryColumns: ['fecha'], valueFormulas: ['meta_spend'], colors: ['blue'], height: 240 }
            updated = { ...base, graficos: [...(base.graficos || []), newChart], blocks_order: [...orderedBlocks, `chart:${newId}`] }
            target = { type: 'chart', id: newId }
        } else if (type === 'ranking') {
            const newRanking: RankingTableDef = { id: newId, title: 'Nueva tabla', dimension: 'campaigns', topN: 10, sortOrder: 'desc', sortColumnIndex: 0, showRank: true, columns: [{ formula: 'meta_spend', label: 'Gasto', prefix: '$', suffix: '', decimals: 2 }] }
            updated = { ...base, ranking_tables: [...(base.ranking_tables || []), newRanking], blocks_order: [...orderedBlocks, `ranking:${newId}`] }
            target = { type: 'ranking', id: newId }
        } else if (type === 'leadanswer') {
            // Nace en 'auto' y sin pregunta: el picker del editor rápido —que se
            // abre justo después— es quien la elige, y ahí es donde se ve si el
            // cliente tiene campos ya configurados o hay que auto-detectarlos.
            const newAnswer: LeadAnswerBlockDef = {
                id: newId, title: 'Respuestas de formulario', origen: 'auto', clavesOrigen: [],
                display: 'bars', topN: 12, agruparResto: true, showDelta: true, showCsv: true,
            }
            updated = { ...base, lead_answer_blocks: [...(base.lead_answer_blocks || []), newAnswer], blocks_order: [...orderedBlocks, `leadanswer:${newId}`] }
            target = { type: 'leadanswer', id: newId }
        } else {
            const newText: TextBlockDef = { id: newId, blockType: 'text', content: 'Nueva sección', style: 'h2', align: 'left', color: 'white', colSpan: 4 }
            updated = { ...base, text_blocks: [...(base.text_blocks || []), newText], blocks_order: [...orderedBlocks, `text:${newId}`] }
            target = { type: 'text', id: newId }
        }

        setTabLayoutOverrides(prev => ({ ...prev, [activeTabId]: updated }))
        setAddMenuOpen(false)
        setQuickEditTarget(target)
    }

    const handleUpdateChart = useCallback((chartId: string, updatedChart: ChartDef) => {
        setTabLayoutOverrides(prev => {
            const currentLayout = prev[activeTabId] || activeLayout
            const newGraficos = (currentLayout.graficos || []).map(g => g.id === chartId ? updatedChart : g)
            return {
                ...prev,
                [activeTabId]: {
                    ...currentLayout,
                    graficos: newGraficos
                }
            }
        })
    }, [activeTabId, activeLayout])

    function handleAddBlock(blockType: 'text' | 'separator') {
        const newId = crypto.randomUUID()
        const newBlock: TextBlockDef = blockType === 'separator'
            ? { id: newId, blockType: 'separator', content: '', style: 'p', colSpan: 4, separatorStyle: 'line', color: 'zinc' }
            : { id: newId, blockType: 'text', content: 'Nueva sección', style: 'h2', align: 'left', color: 'white', colSpan: 4 }
        const newOrder = [...orderedBlocks, `text:${newId}`]
        setTabLayoutOverrides(prev => {
            const base = prev[activeTabId] || activeLayout
            return {
                ...prev,
                [activeTabId]: {
                    ...base,
                    text_blocks: [...(base.text_blocks || []), newBlock],
                    blocks_order: newOrder,
                }
            }
        })
    }

    function handleUpdateTextBlock(blockId: string, updates: Partial<TextBlockDef>) {
        const newTextBlocks = (activeLayout.text_blocks || []).map((b: TextBlockDef) =>
            b.id === blockId.replace('text:', '') ? { ...b, ...updates } : b
        )
        setTabLayoutOverrides(prev => ({
            ...prev,
            [activeTabId]: { ...(prev[activeTabId] || activeLayout), text_blocks: newTextBlocks }
        }))
    }


    // Step 1: date-filter only (no campaign enrichment)
    const baseRows = useMemo(() => {
        let rows = metrics
        if (activeTabObj?.fecha_inicio) {
            rows = rows.filter((m: any) => m.fecha >= activeTabObj.fecha_inicio)
        }
        if (activeTabObj?.fecha_finalizacion) {
            rows = rows.filter((m: any) => m.fecha <= activeTabObj.fecha_finalizacion)
        }
        return rows
    }, [metrics, activeTabObj])

    const allCampaignNames = useMemo(() => {
        const names = new Set<string>()
        for (const row of baseRows) {
            if (Array.isArray((row as any).meta_campaigns)) {
                for (const c of (row as any).meta_campaigns) {
                    if (c.name) names.add(c.name)
                }
            }
        }
        return Array.from(names).sort()
    }, [baseRows])

    // Step 2: campaign-enrich with global tab filter + funnel injection (existing behavior)
    const filteredMetrics = useMemo(() => {
        const enriched = baseRows.map((m: any) =>
            enrichTikTokRow(enrichMetaRow(m, effectiveKeyword, data.campaignGroups), effectiveKeyword, data.campaignGroups)
        )

        // Inyectar campos del funnel desde hotmart_funnel_data.by_tab.
        // Esto permite que las fórmulas usen $funnel.* / funnel_principal_count / funnel_bump_neto, etc.
        //
        // En la VISTA GENERAL (sin pestaña activa) antes no se inyectaba nada, así
        // que TODAS las `funnel_*` salían 0 en silencio y cualquier tarjeta que las
        // usara mostraba un cero perfectamente creíble. Ahora se SUMAN todas las
        // pestañas: es el equivalente honesto de "todos los embudos juntos".
        const tabId = activeTabObj?.id
        const conFunnel = enriched.map((row: any) => {
            const funnelData = (row.hotmart_funnel_data as any) || {}
            const porTab: Record<string, any> = funnelData.by_tab ?? {}

            let fb: any = null
            if (tabId) {
                fb = porTab[tabId] ?? null
            } else {
                const ids = Object.keys(porTab)
                if (ids.length === 0) return row   // sin embudos: nada que inyectar
                const suma = (camino: (b: any) => number) =>
                    ids.reduce((acc, id) => acc + (Number(camino(porTab[id])) || 0), 0)
                fb = {
                    principal: { count: suma(b => b?.principal?.count), net: suma(b => b?.principal?.net), gross: suma(b => b?.principal?.gross) },
                    bump: { count: suma(b => b?.bump?.count), net: suma(b => b?.bump?.net), gross: suma(b => b?.bump?.gross) },
                    upsell: { count: suma(b => b?.upsell?.count), net: suma(b => b?.upsell?.net), gross: suma(b => b?.upsell?.gross), page_visits: suma(b => b?.upsell?.page_visits) },
                    downsell: { count: suma(b => b?.downsell?.count), net: suma(b => b?.downsell?.net), gross: suma(b => b?.downsell?.gross) },
                    pagos_iniciados: suma(b => b?.pagos_iniciados),
                    // NO se suman las sesiones de landing entre pestañas: distintos
                    // embudos pueden compartir landing y se contarían dos veces.
                    landing_sessions: 0,
                }
            }

            const landingSessions = fb?.landing_sessions ?? 0
            return {
                ...row,
                // Si hay landing pages configuradas, reemplazar ga_sessions con las sesiones del funnel
                ...(landingSessions > 0 ? { ga_sessions: landingSessions } : {}),
                funnel_principal_count: fb?.principal?.count ?? 0,
                funnel_principal_neto:  fb?.principal?.net   ?? 0,
                funnel_principal_bruto: fb?.principal?.gross ?? 0,
                // Precio público configurado en el funnel del tab (para calcular bruta = precio × count)
                funnel_principal_price: Number(activeTabObj?.hotmart_funnel?.principal_price_usd ?? 0),
                funnel_bump_count:      fb?.bump?.count      ?? 0,
                funnel_bump_neto:       fb?.bump?.net        ?? 0,
                funnel_bump_bruto:      fb?.bump?.gross      ?? 0,
                funnel_upsell_count:    fb?.upsell?.count    ?? 0,
                funnel_upsell_neto:     fb?.upsell?.net      ?? 0,
                funnel_upsell_bruto:    fb?.upsell?.gross    ?? 0,
                funnel_upsell_visits:   fb?.upsell?.page_visits ?? 0,
                funnel_downsell_count:  fb?.downsell?.count  ?? 0,
                funnel_downsell_neto:   fb?.downsell?.net    ?? 0,
                funnel_downsell_bruto:  fb?.downsell?.gross  ?? 0,
                funnel_pagos_iniciados: fb?.pagos_iniciados  ?? 0,
            }
        })

        return inyectarRespuestas(conFunnel, data.leadAnswers, effectiveKeyword, data.campaignGroups)
    }, [baseRows, effectiveKeyword, activeTabObj, data.campaignGroups, data.leadAnswers])

    // Previous period rows (no tab date filter needed — already a different date range)
    const prevFilteredMetrics = useMemo(() => {
        if (!prevMetrics.length) return []
        const enriched = prevMetrics.map((m: any) =>
            enrichTikTokRow(enrichMetaRow(m, effectiveKeyword, data.campaignGroups), effectiveKeyword, data.campaignGroups)
        )
        // El periodo anterior recibe las MISMAS claves: sin esto, una tarjeta con
        // `utm_leads` mostraría su delta contra cero y siempre diría "+100%".
        return inyectarRespuestas(enriched, data.prevLeadAnswers, effectiveKeyword, data.campaignGroups)
    }, [prevMetrics, effectiveKeyword, data.campaignGroups, data.prevLeadAnswers])

    /**
     * Las mismas filas que `baseRows`, pero con las claves de Report-UTM SIN el
     * filtro de la pestaña.
     *
     * Es lo que consume una gráfica que tiene `campaignFilter` propio: su filtro
     * SUSTITUYE al de la pestaña, no lo encadena (MetricCharts elige `rawMetrics`
     * precisamente por eso). Inyectarlas con `effectiveKeyword` daría un
     * `rawMetrics` que no es raw y volvería a descuadrar en silencio.
     */
    const baseRowsConRespuestas = useMemo(
        () => inyectarRespuestas(baseRows, data.leadAnswers, '', data.campaignGroups),
        [baseRows, data.leadAnswers, data.campaignGroups],
    )

    /** Referencia del cubo con el filtro de la pestaña, para las filas de relleno. */
    const refCuboPestana = useMemo(
        () => refDeCubo(data.leadAnswers, effectiveKeyword, data.campaignGroups),
        [data.leadAnswers, effectiveKeyword, data.campaignGroups],
    )

    /**
     * Preguntas ofrecibles en los selectores de métrica.
     *
     * El cubo manda cuando está cargado —sus buckets salen de los datos y son la
     * lista real—; el catálogo del cliente aporta las que ningún bloque declara,
     * para poder construir una tarjeta sin tener que añadir antes un bloque.
     */
    const leadAnswerCampos = useMemo(() => {
        const delCubo = data.leadAnswers?.campos ?? []
        const vistos = new Set(delCubo.map((c: any) => c.clave))
        return [...delCubo, ...(data.leadAnswerCatalogo ?? []).filter((c: any) => !vistos.has(c.clave))]
    }, [data.leadAnswers, data.leadAnswerCatalogo])

    const visibleCols = useMemo(() => {
        return activeLayout.columnas.filter((c: ColDef) => !c.hidden)
    }, [activeLayout.columnas])

    // Compute varContext for formulas
    const varContext = useMemo(() => {
        const ctx: Record<string, number> = {}
        if (activeTabObj) {
            if (activeTabObj.fecha_inicio && activeTabObj.fecha_finalizacion) {
                try {
                const start = parseISO(activeTabObj.fecha_inicio)
                const end = parseISO(activeTabObj.fecha_finalizacion)
                if (!isValid(start) || !isValid(end)) return ctx
                const totalDays = differenceInDays(end, start) + 1
                const elapsedDays = differenceInDays(new Date(), start) + 1
                
                ctx.dias_totales = totalDays
                ctx.dias_transcurridos = elapsedDays > totalDays ? totalDays : (elapsedDays < 0 ? 0 : elapsedDays)
                ctx.dias_restantes = ctx.dias_totales - ctx.dias_transcurridos
                } catch { /* invalid dates — skip budget context */ }
            }
            if (activeTabObj.presupuesto_objetivo) {
                ctx.presupuesto_objetivo = parseFloat(activeTabObj.presupuesto_objetivo)
                if (ctx.dias_totales && ctx.dias_totales > 0) {
                    ctx.presupuesto_diario_ideal = ctx.presupuesto_objetivo / ctx.dias_totales
                }
            }
            if (globalSpend !== null) {
                ctx.presupuesto_gastado_total = globalSpend
                if (ctx.presupuesto_objetivo) {
                    ctx.presupuesto_restante = ctx.presupuesto_objetivo - globalSpend
                    if (ctx.dias_restantes && ctx.dias_restantes > 0) {
                        ctx.presupuesto_diario_sugerido = ctx.presupuesto_restante / ctx.dias_restantes
                    } else {
                        ctx.presupuesto_diario_sugerido = 0
                    }
                }
            }
        }
        return ctx
    }, [activeTabObj, globalSpend])

    // Extract source mapping for semantic alias resolution
    const sourceMapping = useMemo(() => activeLayout.source_mapping || {}, [activeLayout.source_mapping])

    // Summary cards — keyword global primero, luego filtro por tarjeta encadenado
    const tarjetaValues = useMemo(() => {
        return activeLayout.tarjetas.map((t: CardDef) => {
            // Filtered rows for current period
            let rows = !t.campaignFilter
                ? filteredMetrics
                : filteredMetrics.map((m: any) =>
                    applyCompoundFilter(m, effectiveKeyword, t.campaignFilter, data.campaignGroups)
                )
            if (t.sheetFilter) {
                rows = rows.map((r: any) => enrichOfflineRow(r, t.sheetFilter))
            }
            if (t.account_id) {
                rows = rows.map((r: any) => filterRowByTikTokAccount(r, t.account_id, effectiveKeyword, data.campaignGroups))
            }
            const value = aggregateFormula(t.formula, rows, varContext, sourceMapping, platformSet, layoutCustomMetrics)

            // Delta vs previous period
            let prevValue: number | null = null
            let delta: number | null = null
            if (t.showDelta && prevFilteredMetrics.length > 0) {
                let prevRows = !t.campaignFilter
                    ? prevFilteredMetrics
                    : prevFilteredMetrics.map((m: any) =>
                        applyCompoundFilter(m, effectiveKeyword, t.campaignFilter, data.campaignGroups)
                    )
                if (t.sheetFilter) {
                    prevRows = prevRows.map((r: any) => enrichOfflineRow(r, t.sheetFilter))
                }
                if (t.account_id) {
                    prevRows = prevRows.map((r: any) => filterRowByTikTokAccount(r, t.account_id, effectiveKeyword, data.campaignGroups))
                }
                prevValue = aggregateFormula(t.formula, prevRows, varContext, sourceMapping, platformSet, layoutCustomMetrics)
                if (prevValue !== null && value !== null && prevValue !== 0) {
                    delta = ((value - prevValue) / Math.abs(prevValue)) * 100
                }
            }

            // Daily values for sparkline variant
            const dailyValues: Array<{ v: number | null }> = t.variant === 'sparkline'
                ? rows.map((row: any) => ({ v: evaluateFormula(t.formula, row, varContext, sourceMapping, platformSet, layoutCustomMetrics) }))
                : []

            // Target value for progress variant
            const targetValue: number | null = t.variant === 'progress' && t.targetFormula
                ? aggregateFormula(t.targetFormula, rows, varContext, sourceMapping, platformSet, layoutCustomMetrics)
                : null

            return { ...t, value, prevValue, delta, dailyValues, targetValue }
        })
    }, [activeLayout.tarjetas, filteredMetrics, prevFilteredMetrics, effectiveKeyword, varContext, sourceMapping, platformSet, layoutCustomMetrics, data.campaignGroups])

    // Determine formulas for Gasto and Leads based on visible columns
    const { gastoFormula, leadsFormula } = useMemo(() => {
        const gastoCol = visibleCols.find((c: ColDef) => c.label.toLowerCase().includes('gasto'))
        const leadsCol = visibleCols.find((c: ColDef) => c.label.toLowerCase().includes('lead') || c.label.toLowerCase().includes('registro'))
        return {
            gastoFormula: gastoCol ? gastoCol.formula : 'meta_spend',
            // leadsFormula drives both the fallback chart AND the country breakdown CPL
            leadsFormula: leadsCol ? leadsCol.formula : 'meta_leads'
        }
    }, [visibleCols])

    // Build chart data based on weekly aggregates
    const chartData = useMemo(() => {
        return weeks.map((week: any) => {
            let currentDate = parseISO(week.start)
            const endDate = parseISO(week.end)
            const weekRows: any[] = []

            if (!isValid(currentDate) || !isValid(endDate)) return null

            while (currentDate.getTime() <= endDate.getTime()) {
                const dayStr = format(currentDate, 'yyyy-MM-dd')
                const raw = filteredMetrics.find((m: any) => m.fecha === dayStr) || {
                    fecha: dayStr, meta_spend: 0, meta_impressions: 0, meta_clicks: 0, meta_campaigns: [],
                    hotmart_pagos_iniciados: 0, ventas_principal: 0, ventas_bump: 0, ventas_upsell: 0
                }
                weekRows.push(raw)
                currentDate = addDays(currentDate, 1)
            }

            const totalGasto = aggregateFormula(gastoFormula, weekRows, varContext, sourceMapping, platformSet)
            const totalLeads = aggregateFormula(leadsFormula, weekRows, varContext, sourceMapping, platformSet)

            return {
                date: `Sem ${week.weekNumber}`,
                "Gasto": totalGasto === null || isNaN(totalGasto) ? 0 : totalGasto,
                "Leads": totalLeads === null || isNaN(totalLeads) ? 0 : totalLeads
            }
        }).filter(Boolean)
    }, [weeks, filteredMetrics, varContext, gastoFormula, leadsFormula])

    let budgetCards = null
    if (activeTabObj && (activeTabObj.fecha_inicio || activeTabObj.fecha_finalizacion || activeTabObj.presupuesto_objetivo)) {
        const fechaInicioStr = safeFmt(activeTabObj.fecha_inicio, 'dd MMM yyyy')
        const fechaFinStr = safeFmt(activeTabObj.fecha_finalizacion, 'dd MMM yyyy')
        
        const daysLeft = varContext.dias_restantes ?? null
        const pres = varContext.presupuesto_objetivo || 0
        const rem = varContext.presupuesto_restante ?? 0
        const dailyBudget = varContext.presupuesto_diario_sugerido ?? 0

        budgetCards = (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mt-2 mb-2">
                <Card className="bg-card border-border border-l-4 border-l-blue-500 shadow-lg">
                    <CardContent className="py-3 px-4 flex items-center justify-between">
                        <div>
                            <p className="text-xs text-muted-foreground font-medium mb-1">Rango de Captación</p>
                            <p className="text-sm text-foreground font-semibold">{fechaInicioStr} - {fechaFinStr}</p>
                        </div>
                        <CalendarDays className="w-7 h-7 text-blue-500/50" />
                    </CardContent>
                </Card>
                
                {daysLeft !== null && (
                    <Card className="bg-card border-border border-l-4 border-l-amber-500 shadow-lg">
                        <CardContent className="py-3 px-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-muted-foreground font-medium mb-1">Días Faltantes</p>
                                <p className="text-lg md:text-xl font-bold text-amber-600 dark:text-amber-400 font-mono">{daysLeft} días</p>
                            </div>
                            <Timer className="w-7 h-7 text-amber-500/50" />
                        </CardContent>
                    </Card>
                )}

                {pres > 0 && (
                    <Card className="bg-card border-border border-l-4 border-l-emerald-500 shadow-lg">
                        <CardContent className="py-3 px-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-muted-foreground font-medium mb-1">Presupuesto Restante</p>
                                {fetchingSpend ? (
                                    <p className="text-sm text-muted-foreground/70">Calculando...</p>
                                ) : (
                                    <p className="text-lg md:text-xl font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                                        ${rem.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </p>
                                )}
                            </div>
                            <Wallet className="w-7 h-7 text-emerald-500/50" />
                        </CardContent>
                    </Card>
                )}

                {pres > 0 && daysLeft !== null && (
                    <Card className="bg-card border-border border-l-4 border-l-indigo-500 shadow-lg">
                        <CardContent className="py-3 px-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-muted-foreground font-medium mb-1">Prep. Diario Sugerido</p>
                                {fetchingSpend ? (
                                    <p className="text-sm text-muted-foreground/70">Calculando...</p>
                                ) : (
                                    <p className="text-lg md:text-xl font-bold text-indigo-600 dark:text-indigo-400 font-mono">
                                        ${dailyBudget.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}/día
                                    </p>
                                )}
                            </div>
                            <BadgeDollarSign className="w-7 h-7 text-indigo-500/50" />
                        </CardContent>
                    </Card>
                )}
            </div>
        )
    }

    if (showArchive) {
        return (
            <TabArchiveView
                tabs={tabs}
                metrics={metrics}
                campaignGroups={data.campaignGroups || []}
                allLayouts={allLayouts || []}
                initialLayout={initialLayout}
                clientId={cliente.id}
                onClose={() => setShowArchive(false)}
                onToggleArchived={handleToggleArchived}
                isTeam={isTeam}
            />
        )
    }

    return (
        <div className="space-y-6">
            {/* Public Tabs Bar — simplified, no drag, no edit */}
            {isPublic && visibleTabs.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar border-b border-border">
                    {visibleTabs.map((tab: any) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTabId(tab.id)}
                            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${activeTabId === tab.id ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-500/10' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'}`}
                        >
                            {tab.nombre}
                            {tab.keyword_meta && (
                                <span className="text-[10px] bg-muted/80 px-1.5 py-0.5 rounded text-muted-foreground font-mono tracking-wider">{tabFilterLabel(tab.keyword_meta)}</span>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {/* Tabs Bar with Drag & Drop */}
            {!isPublic && (
                <div className="flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar border-b border-border">
                    {/* Vista General - always first, not draggable */}
                    <button
                        onClick={() => setActiveTabId('general')}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 ${activeTabId === 'general' ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-500/10' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'}`}
                    >
                        Vista General
                    </button>
                    {/* Draggable custom tabs — only rendered client-side to avoid dnd-kit hydration mismatch */}
                    {!isMounted ? (
                        visibleTabs.map((tab: any) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTabId(tab.id)}
                                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 ${activeTabId === tab.id ? 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-500/10' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'}`}
                            >
                                {tab.nombre}
                            </button>
                        ))
                    ) : (
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                        >
                            <SortableContext items={visibleTabs.map((t: any) => t.id)} strategy={horizontalListSortingStrategy}>
                                {visibleTabs.map((tab: any) => (
                                    <SortableTab
                                        key={tab.id}
                                        tab={tab}
                                        isActive={activeTabId === tab.id}
                                        onSelect={() => setActiveTabId(tab.id)}
                                        onEdit={() => { setTabToEdit(tab); setShowTabModal(true); }}
                                        isPublic={isPublic}
                                        hasOverride={!!(tab.columnas || tabLayoutOverrides[tab.id])}
                                    />
                                ))}
                            </SortableContext>
                            <DragOverlay>
                                {dragActiveId ? (
                                    <div className="px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-500/10 shadow-lg">
                                        {tabs.find((t: any) => t.id === dragActiveId)?.nombre}
                                    </div>
                                ) : null}
                            </DragOverlay>
                        </DndContext>
                    )}
                    {!isPublic && (
                        <button
                            onClick={() => { setTabToEdit(null); setShowTabModal(true); }}
                            className="ml-2 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-card border border-border hover:border-muted-foreground/50 rounded flex items-center gap-1 transition"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Nueva Pestaña
                        </button>
                    )}
                    {isTeam && (
                        <button
                            onClick={() => setShowArchive(true)}
                            title="Archivo de pestañas"
                            className="ml-1 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-card border border-border hover:border-muted-foreground/50 rounded flex items-center gap-1.5 transition relative"
                        >
                            <Archive className="w-3.5 h-3.5" />
                            {archivedCount > 0 && (
                                <span className="absolute -top-1.5 -right-1.5 text-[9px] bg-indigo-500 text-white rounded-full w-4 h-4 flex items-center justify-center font-bold">
                                    {archivedCount}
                                </span>
                            )}
                        </button>
                    )}
                    {/* Pestaña fija de Roadmap */}
                    <button
                        onClick={() => setActiveTabId('soporte')}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${activeTabId === 'soporte' ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400 bg-indigo-500/10' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-accent'}`}
                    >
                        🗺️ Roadmap
                    </button>
                </div>
            )}



            {/* Soporte Tab Content */}
            {activeTabId === 'soporte' && (
                <SupportModule clientId={cliente.id} userRole={userRole} clienteNombre={cliente.nombre ?? ''} />
            )}

            {/* Toolbar + Dashboard Content */}
            {activeTabId !== 'soporte' && (<>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-500/5 border border-indigo-500/20 rounded-lg px-3 py-1.5">
                        <LayoutDashboard className="w-3.5 h-3.5" />
                        <span><strong>{activeLayout.nombre}</strong>{layoutIsCustomized ? ' — Personalizada' : ' — Plantilla Base'}</span>
                    </div>

                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/70 pointer-events-none" />
                        <Input
                            placeholder="Buscar campaña..."
                            value={keywordFilter}
                            onChange={(e) => setKeywordFilter(e.target.value)}
                            className="h-8 pl-8 text-xs w-44 md:w-64 bg-card border-border text-foreground placeholder:text-muted-foreground/70"
                        />
                        {keywordFilter && (
                            <button 
                                onClick={() => setKeywordFilter('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/70 hover:text-foreground/90"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>
                </div>
                {!isPublic && (
                    <div className="flex items-center gap-2">
                        {isTeam && (
                            <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
                                <PopoverTrigger asChild>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        className="gap-1.5 text-xs border-border text-muted-foreground hover:text-emerald-300 hover:border-emerald-500/40 hover:bg-emerald-500/5 transition"
                                    >
                                        <Plus className="w-3.5 h-3.5" />
                                        Agregar
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent
                                    className="p-1 bg-card border-border w-48"
                                    style={{ zIndex: 9999 }}
                                    align="start"
                                    side="bottom"
                                    collisionBoundary={[]}
                                    collisionPadding={8}
                                    onOpenAutoFocus={e => e.preventDefault()}
                                >
                                    {([
                                        { type: 'card',    icon: <CreditCard className="w-3.5 h-3.5" />, label: 'Tarjeta' },
                                        { type: 'chart',   icon: <BarChart3  className="w-3.5 h-3.5" />, label: 'Gráfico' },
                                        { type: 'ranking', icon: <Table2     className="w-3.5 h-3.5" />, label: 'Tabla ranking' },
                                        { type: 'leadanswer', icon: <ListChecks className="w-3.5 h-3.5" />, label: 'Respuestas de formulario' },
                                        { type: 'text',    icon: <Type       className="w-3.5 h-3.5" />, label: 'Texto / Sección' },
                                    ] as const).map(({ type, icon, label }) => (
                                        <button
                                            key={type}
                                            type="button"
                                            onClick={() => handleAddNewBlock(type)}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-foreground/90 hover:bg-accent hover:text-foreground rounded transition"
                                        >
                                            <span className="text-muted-foreground/70">{icon}</span>
                                            {label}
                                        </button>
                                    ))}
                                </PopoverContent>
                            </Popover>
                        )}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setIsPuzzleMode(!isPuzzleMode)}
                            className={`gap-1.5 text-xs transition ${isPuzzleMode ? 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20' : 'border-border text-muted-foreground hover:text-indigo-300 hover:bg-indigo-500/5'}`}
                        >
                            <Puzzle className="w-3.5 h-3.5" />
                            {isPuzzleMode ? 'Salir Modo Edición' : 'Modo Rompecabezas'}
                        </Button>
                        
                        {isPuzzleMode && (
                            <>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleAddBlock('text')}
                                    className="gap-1.5 text-xs border-indigo-500/40 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10 animate-in zoom-in-95 duration-200"
                                >
                                    <Type className="w-3.5 h-3.5" />
                                    + Sección
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleAddBlock('separator')}
                                    className="gap-1.5 text-xs border-muted-foreground/40 text-muted-foreground hover:bg-accent animate-in zoom-in-95 duration-200"
                                >
                                    <Minus className="w-3.5 h-3.5" />
                                    + Separador
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={handleTogglePuzzleMode}
                                    disabled={isSavingLayout}
                                    className="gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-700 text-white border-transparent shadow-[0_0_15px_rgba(79,70,229,0.4)] transition-all animate-in zoom-in-95 duration-200"
                                >
                                    {isSavingLayout ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                                    {isSavingLayout ? 'Guardando...' : 'Guardar Visualización'}
                                </Button>
                            </>
                        )}

{activeTabId === 'general' ? (
                            <LayoutConfigButton
                                onClick={() => setShowModal(true)}
                                isCustomized={layoutIsCustomized}
                            />
                        ) : (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setShowModal(true)}
                                className="gap-1.5 border-border text-muted-foreground hover:text-indigo-300 hover:border-indigo-500/40 hover:bg-indigo-500/5 text-xs transition"
                            >
                                <Settings2 className="w-3.5 h-3.5" />
                                Configurar layout
                            </Button>
                        )}
                    </div>
                )}
            </div>

            {/* Budget/Time Cards */}
            {budgetCards}

            {/* Productos Extras: solo en Vista General, agrega productos sin funnel mapeado */}
            {activeTabId === 'general' && (
                <ExtrasPanel filteredMetrics={filteredMetrics} />
            )}

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDashboardDragEnd}>
                <SortableContext items={orderedBlocks} strategy={verticalListSortingStrategy}>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        {orderedBlocks.map(blockId => {
                            if (blockId.startsWith('leadanswer:')) {
                                const answerId = blockId.replace('leadanswer:', '')
                                const answerDef = activeLayout.lead_answer_blocks?.find(b => b.id === answerId)
                                if (!answerDef) return null
                                // No pasa por `filteredMetrics`: el cubo de respuestas tiene su
                                // propio grano (día × campaña × respuesta) y aplica el filtro de
                                // la pestaña por su cuenta. Mezclarlo con las filas de métricas
                                // sería inventar una unión que no existe.
                                return (
                                    <SortableTable key={blockId} id={blockId} isPuzzleMode={isPuzzleMode} title={answerDef.title} onQuickEdit={() => setQuickEditTarget({ type: 'leadanswer', id: answerId })} onDuplicate={() => handleDuplicateBlock(blockId)} onRemove={() => handleRemoveBlock(blockId)} isCollapsed={collapsedBlocks.has(blockId)} onToggleCollapse={() => toggleCollapse(blockId)}>
                                        <LeadAnswerBlock
                                            def={answerDef}
                                            dataset={data.leadAnswers}
                                            prevDataset={data.prevLeadAnswers}
                                            effectiveKeyword={effectiveKeyword}
                                            campaignGroups={data.campaignGroups || []}
                                            fechaInicio={activeTabObj?.fecha_inicio}
                                            fechaFin={activeTabObj?.fecha_finalizacion}
                                            clienteNombre={cliente.nombre ?? ''}
                                            pestanaNombre={activeTabObj?.nombre ?? 'Vista general'}
                                            rangoLabel={`${searchParams.get('from') ?? ''} a ${searchParams.get('to') ?? ''}`.trim()}
                                            filtroLabel={tabFilterLabel(activeTabObj?.keyword_meta)}
                                        />
                                    </SortableTable>
                                )
                            }
                            if (blockId.startsWith('ranking:')) {
                                const rankingId = blockId.replace('ranking:', '')
                                const rankingDef = activeLayout.ranking_tables?.find(r => r.id === rankingId)
                                if (!rankingDef) return null
                                return (
                                    <SortableTable key={blockId} id={blockId} isPuzzleMode={isPuzzleMode} title={rankingDef.title} onQuickEdit={() => setQuickEditTarget({ type: 'ranking', id: rankingId })} onDuplicate={() => handleDuplicateBlock(blockId)} onRemove={() => handleRemoveBlock(blockId)} isCollapsed={collapsedBlocks.has(blockId)} onToggleCollapse={() => toggleCollapse(blockId)}>
                                        <RankingTableBlock
                                            def={rankingDef}
                                            metrics={filteredMetrics}
                                            campaignGroups={data.campaignGroups || []}
                                            sourceMapping={sourceMapping}
                                            customMetrics={layoutCustomMetrics}
                                            clienteId={cliente.id}
                                            accountId={rankingDef.account_id}
                                            effectiveKeyword={effectiveKeyword}
                                        />
                                    </SortableTable>
                                )
                            }
                            if (blockId.startsWith('card:')) {
                                const card = tarjetaValues.find((t: any) => `card:${t.id}` === blockId)
                                if (!card) return null
                                return <SortableCard key={blockId} id={blockId} card={card} isPuzzleMode={isPuzzleMode} onRemove={() => handleRemoveBlock(blockId)} onQuickEdit={() => setQuickEditTarget({ type: 'card', id: card.id })} onDuplicate={() => handleDuplicateBlock(blockId)} isCollapsed={collapsedBlocks.has(blockId)} onToggleCollapse={() => toggleCollapse(blockId)} />
                            }
                            if (blockId.startsWith('chart:')) {
                                const chart = activeLayout.graficos?.find((g: any) => `chart:${g.id}` === blockId)
                                if (!chart) return null
                                const chartMetrics = chart.account_id
                                    ? filteredMetrics.map((r: any) => filterRowByTikTokAccount(r, chart.account_id, effectiveKeyword, data.campaignGroups))
                                    : filteredMetrics
                                return <SortableChart
                                    key={blockId}
                                    id={blockId}
                                    chart={chart}
                                    isPuzzleMode={isPuzzleMode}
                                    metrics={chartMetrics}
                                    weeks={weeks}
                                    varContext={varContext}
                                    sourceMapping={sourceMapping}
                                    platformSet={platformSet}
                                    layoutCustomMetrics={layoutCustomMetrics}
                                    rawMetrics={baseRowsConRespuestas}
                                    campaignGroups={data.campaignGroups}
                                    effectiveKeyword={effectiveKeyword}
                                    onRemove={() => handleRemoveBlock(blockId)}
                                    onUpdateChart={handleUpdateChart}
                                    onQuickEdit={() => setQuickEditTarget({ type: 'chart', id: chart.id })}
                                    onDuplicate={() => handleDuplicateBlock(blockId)}
                                    isCollapsed={collapsedBlocks.has(blockId)}
                                    onToggleCollapse={() => toggleCollapse(blockId)}
                                />
                            }
                            if (blockId.startsWith('text:')) {
                                const txt = (tabLayoutOverrides[activeTabId]?.text_blocks || activeLayout.text_blocks)?.find((t: any) => `text:${t.id}` === blockId)
                                if (!txt) return null
                                return <SortableText
                                    key={blockId}
                                    id={blockId}
                                    block={txt}
                                    isPuzzleMode={isPuzzleMode}
                                    onRemove={() => handleRemoveBlock(blockId)}
                                    onUpdate={(updates: any) => handleUpdateTextBlock(blockId, updates)}
                                    onQuickEdit={() => setQuickEditTarget({ type: 'text', id: txt.id })}
                                    onDuplicate={() => handleDuplicateBlock(blockId)}
                                    isCollapsed={collapsedBlocks.has(blockId)}
                                    onToggleCollapse={() => toggleCollapse(blockId)}
                                />
                            }
                            if (blockId === 'table') {
                                return (
                                    <SortableTable key={blockId} id={blockId} isPuzzleMode={isPuzzleMode} title="Vista de Embudo Diaria" onQuickEdit={() => setQuickEditTarget({ type: 'table' })} isCollapsed={collapsedBlocks.has(blockId)} onToggleCollapse={() => toggleCollapse(blockId)}>
                                        <Card className="bg-card border-border overflow-hidden shadow-2xl">
                                            <CardHeader className="border-b border-border bg-background/30">
                                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                                                    <CardTitle className="text-foreground">Vista de Embudo Diaria — {cliente.nombre} {activeTabObj && <span className="text-blue-600 dark:text-blue-400 opacity-80 border-l border-border pl-2 ml-2">{activeTabObj.nombre}</span>}</CardTitle>
                                                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                                                        {activeTabId === 'general' ? (
                                                            <>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        onClick={() => setKeywordFilter('')}
                                                                        className={`h-7 text-xs ${keywordFilter === '' ? 'bg-blue-600 text-white border-transparent hover:bg-blue-700' : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
                                                                    >Ver Todo</Button>
                                                                    {data.campaignGroups && data.campaignGroups.length > 0 && (
                                                                        <>
                                                                            <div className="h-6 w-px bg-muted-foreground/30" />
                                                                            {data.campaignGroups.map((group: any) => (
                                                                                <Button
                                                                                    key={group.id}
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    onClick={() => setKeywordFilter(group.id)}
                                                                                    className={`h-7 text-xs ${keywordFilter === group.id ? 'bg-emerald-600 text-white border-transparent hover:bg-emerald-700' : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
                                                                                >📊 {group.nombre}</Button>
                                                                            ))}
                                                                        </>
                                                                    )}
                                                                    {metaKeywords.length > 0 && (
                                                                        <>
                                                                            {(data.campaignGroups && data.campaignGroups.length > 0) && <div className="h-6 w-px bg-muted-foreground/30" />}
                                                                            {metaKeywords.map((kw: string) => (
                                                                                <Button
                                                                                    key={kw}
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    onClick={() => setKeywordFilter(kw)}
                                                                                    className={`h-7 text-xs ${keywordFilter.toLowerCase() === kw.toLowerCase() ? 'bg-blue-600 text-white border-transparent hover:bg-blue-700' : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
                                                                                >{kw}</Button>
                                                                            ))}
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </>
                                                        ) : activeTabObj ? (
                                                            <div className="text-xs text-muted-foreground/70 bg-background px-3 py-1.5 rounded-md border border-border">
                                                                Filtro: <span className="font-mono text-foreground/90">"{tabFilterLabel(activeTabObj.keyword_meta)}"</span>
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            </CardHeader>
                                            {/* Period Summary Strip */}
                                            {filteredMetrics.length > 0 && visibleCols.filter((c: ColDef) => c.formula !== 'fecha').length > 0 && (
                                                <div className="px-4 py-2.5 border-b border-border bg-background/40 flex flex-wrap gap-x-6 gap-y-1.5">
                                                    {visibleCols.filter((c: ColDef) => c.formula !== 'fecha').slice(0, 7).map((col: ColDef) => {
                                                        let colRows = filteredMetrics
                                                        if (col.campaignFilter) {
                                                            colRows = colRows.map((r: any) => applyCompoundFilter(r, effectiveKeyword, col.campaignFilter, data.campaignGroups))
                                                        }
                                                        if (col.sheetFilter) {
                                                            colRows = colRows.map((r: any) => enrichOfflineRow(r, col.sheetFilter))
                                                        }
                                                        const val = aggregateFormula(col.formula, colRows, varContext, sourceMapping, platformSet, layoutCustomMetrics)
                                                        const hl = col.highlight ? highlightClass(val, col) : 'text-foreground'
                                                        return (
                                                            <div key={col.id} className="flex flex-col min-w-0">
                                                                <span className="text-[10px] text-muted-foreground/60 leading-none mb-0.5 truncate">{col.label}</span>
                                                                <span className={`text-sm font-semibold leading-none ${hl}`}>
                                                                    {formatValue(val, { prefix: col.prefix, suffix: col.suffix, decimals: col.decimals })}
                                                                </span>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            )}
                                            <CardContent className="p-0 overflow-x-auto custom-scrollbar">
                                                <Table className="whitespace-nowrap select-none">
                                                    <TableHeader>
                                                        {/* Column group header row */}
                                                        {(() => {
                                                            const getGroup = (f: string) => {
                                                                if (f === 'fecha') return ''
                                                                if (f.startsWith('meta_')) return 'Meta Ads'
                                                                if (f.startsWith('ga_')) return 'GA4'
                                                                if (f.startsWith('hotmart_') || f.startsWith('ventas_') || f.startsWith('funnel_')) return 'Conversiones'
                                                                return ''
                                                            }
                                                            const groups: { label: string; span: number }[] = []
                                                            let cur = getGroup(visibleCols[0]?.formula ?? '')
                                                            let span = 0
                                                            for (const col of visibleCols) {
                                                                const g = getGroup(col.formula)
                                                                if (g === cur) { span++ } else { groups.push({ label: cur, span }); cur = g; span = 1 }
                                                            }
                                                            groups.push({ label: cur, span })
                                                            const distinctGroups = new Set(groups.map(g => g.label).filter(l => l !== ''))
                                                            if (distinctGroups.size < 2) return null
                                                            return (
                                                                <TableRow className="border-b border-border/40 bg-background/60 h-6">
                                                                    {groups.map((g, i) => (
                                                                        <TableHead key={i} colSpan={g.span} className={`py-0 text-center text-[10px] font-semibold uppercase tracking-widest ${g.label ? 'text-muted-foreground/60' : ''} ${i > 0 && g.label ? 'border-l border-border/50' : ''}`}>
                                                                            {g.label}
                                                                        </TableHead>
                                                                    ))}
                                                                </TableRow>
                                                            )
                                                        })()}
                                                        <TableRow className="border-border bg-background *:text-foreground/90 *:font-semibold">
                                                            {visibleCols.map((col: ColDef) => (
                                                                <TableHead
                                                                    key={col.id}
                                                                    className={`${col.align === 'right' ? 'text-right' : ''} relative`}
                                                                    style={{
                                                                        width: tableColWidths[col.id] || (col.id === visibleCols[0].id && col.formula === 'fecha' ? 120 : undefined),
                                                                        position: 'relative',
                                                                    }}
                                                                >
                                                                    {col.label}
                                                                    <div
                                                                        onMouseDown={e => startTableColResize(col.id, e)}
                                                                        onClick={e => e.stopPropagation()}
                                                                        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400/30 transition-colors z-10"
                                                                    />
                                                                </TableHead>
                                                            ))}
                                                        </TableRow>
                                                    </TableHeader>
                                                    <TableBody className="text-sm">
                                                        {weeks.map((week: any, wIndex: number) => {
                                                            let currentDate = parseISO(week.start)
                                                            const endDate = parseISO(week.end)
                                                            const daysInWeek: React.ReactNode[] = []
                                                            const weekRows: any[] = []

                                                            if (!isValid(currentDate) || !isValid(endDate)) return null

                                                            while (currentDate.getTime() <= endDate.getTime()) {
                                                                const dayStr = format(currentDate, 'yyyy-MM-dd')
                                                                const raw = filteredMetrics.find((m: any) => m.fecha === dayStr) || {
                                                                    fecha: dayStr, meta_spend: 0, meta_impressions: 0, meta_clicks: 0, meta_campaigns: [],
                                                                    hotmart_pagos_iniciados: 0, ventas_principal: 0, ventas_bump: 0, ventas_upsell: 0,
                                                                    // Un día puede tener formularios y NO tener fila de inversión. Sin
                                                                    // estas claves ese día mostraba `—` en vez de sus contactos, que el
                                                                    // cubo sí conoce.
                                                                    ...clavesYRefDelDia(refCuboPestana, dayStr),
                                                                }
                                                                weekRows.push(raw)

                                                                const isWeekend = getDay(currentDate) === 0 || getDay(currentDate) === 6
                                                                daysInWeek.push(
                                                                    <TableRow key={dayStr} className={`border-border transition-colors hover:bg-accent/60 ${isWeekend ? 'bg-muted/30 text-muted-foreground/60' : 'text-foreground'}`}>
                                                                        {visibleCols.map((col: ColDef) => {
                                                                            if (col.formula === 'fecha') {
                                                                                return (
                                                                                    <TableCell key={col.id} className="font-mono text-xs">
                                                                                        {format(currentDate, 'dd MMM (EEE)', { locale: es })}
                                                                                        {/* El desglose por campaña no cuadra con el gasto
                                                                                            registrado: sin este aviso el día se ve como un
                                                                                            cero legítimo en vez de como un dato faltante. */}
                                                                                        {raw.meta_data_incomplete && (
                                                                                            <span
                                                                                                className="ml-1.5 text-amber-500 cursor-help"
                                                                                                title="Este día tiene gasto registrado pero el detalle por campaña está incompleto, así que las cifras filtradas salen de menos. Se repara en la próxima reconciliación."
                                                                                            >
                                                                                                ⚠
                                                                                            </span>
                                                                                        )}
                                                                                    </TableCell>
                                                                                )
                                                                            }
                                                                            let rowForCol = applyCompoundFilter(raw, effectiveKeyword, col.campaignFilter, data.campaignGroups)
                                                                            if (col.sheetFilter) {
                                                                                rowForCol = enrichOfflineRow(rowForCol, col.sheetFilter)
                                                                            }
                                                                            const val = evaluateFormula(col.formula, rowForCol, varContext, sourceMapping, platformSet, layoutCustomMetrics)
                                                                            const hl = highlightClass(val, col)
                                                                            if (col.isManual) {
                                                                                return (
                                                                                    <TableCell key={col.id} className={`${col.align === 'right' ? 'text-right' : ''} p-1`}>
                                                                                        {isPublic ? (
                                                                                            <span className="text-foreground block mt-1">{val || '0'}</span>
                                                                                        ) : (
                                                                                            <Input
                                                                                                type="number"
                                                                                                defaultValue={val || ''}
                                                                                                className="h-7 w-20 text-xs text-right bg-background border-border mx-auto"
                                                                                                onBlur={async (e) => {
                                                                                                    const newVal = parseFloat(e.target.value) || 0
                                                                                                    if (newVal !== val) {
                                                                                                        await updateManualMetric(cliente.id, dayStr, col.formula, newVal)
                                                                                                    }
                                                                                                }}
                                                                                            />
                                                                                        )}
                                                                                    </TableCell>
                                                                                )
                                                                            }
                                                                            return (
                                                                                <TableCell key={col.id} className={`${col.align === 'right' ? 'text-right' : ''} ${hl} relative overflow-hidden`}>
                                                                                    {formatValue(val, { prefix: col.prefix, suffix: col.suffix, decimals: col.decimals })}
                                                                                    {col.suffix === '%' && col.highlight && val !== null && val > 0 && (
                                                                                        <div className="absolute bottom-0 left-0 h-0.5 rounded-r-full opacity-40" style={{ width: `${Math.min(100, val)}%`, background: '#34d399' }} />
                                                                                    )}
                                                                                </TableCell>
                                                                            )
                                                                        })}
                                                                    </TableRow>
                                                                )
                                                                currentDate = addDays(currentDate, 1)
                                                            }

                                                            return (
                                                                <React.Fragment key={`week-${wIndex}`}>
                                                                    {daysInWeek}
                                                                    <TableRow className="border-t-2 border-indigo-500/30 bg-indigo-500/5 dark:bg-indigo-500/10 font-semibold *:text-foreground">
                                                                        {visibleCols.map((col: ColDef) => {
                                                                            if (col.formula === 'fecha') {
                                                                                return <TableCell key={col.id} className="text-indigo-600 dark:text-indigo-300 font-bold tracking-tight">Sem {week.weekNumber}</TableCell>
                                                                            }
                                                                            let colWeekRows = weekRows
                                                                            if (col.campaignFilter) {
                                                                                colWeekRows = colWeekRows.map((r: any) => applyCompoundFilter(r, effectiveKeyword, col.campaignFilter, data.campaignGroups))
                                                                            }
                                                                            if (col.sheetFilter) {
                                                                                colWeekRows = colWeekRows.map((r: any) => enrichOfflineRow(r, col.sheetFilter))
                                                                            }
                                                                            const val = aggregateFormula(col.formula, colWeekRows, varContext, sourceMapping, platformSet, layoutCustomMetrics)
                                                                            const hl = col.highlight ? highlightClass(val, col) : ''
                                                                            return (
                                                                                <TableCell key={col.id} className={`${col.align === 'right' ? 'text-right' : ''} ${hl} relative overflow-hidden`}>
                                                                                    {formatValue(val, { prefix: col.prefix, suffix: col.suffix, decimals: col.decimals })}
                                                                                    {col.suffix === '%' && col.highlight && val !== null && val > 0 && (
                                                                                        <div className="absolute bottom-0 left-0 h-0.5 rounded-r-full opacity-40" style={{ width: `${Math.min(100, val)}%`, background: '#34d399' }} />
                                                                                    )}
                                                                                </TableCell>
                                                                            )
                                                                        })}
                                                                    </TableRow>
                                                                </React.Fragment>
                                                            )
                                                        })}
                                                        {weeks.length === 0 && (
                                                            <TableRow>
                                                                <TableCell colSpan={visibleCols.length} className="text-center p-8 text-muted-foreground/70">
                                                                    No hay datos reportados para este rango.
                                                                </TableCell>
                                                            </TableRow>
                                                        )}
                                                    </TableBody>
                                                </Table>
                                            </CardContent>
                                        </Card>
                                    </SortableTable>
                                )
                            }
                            return null
                        })}

                        {/* Fallback chart if no graficos defined */}
                        {(!activeLayout.graficos || activeLayout.graficos.length === 0) && chartData.length > 0 && (
                            <div className="col-span-1 md:col-span-4">
                                <MetricCharts
                                    charts={[{ id: 'default', title: 'Rendimiento (Gasto vs. Leads)', type: 'area', valueFormulas: [gastoFormula, leadsFormula], categoryColumns: ['fecha'], colors: ['amber', 'cyan'] }]}
                                    metrics={filteredMetrics}
                                    weeks={weeks}
                                    varContext={varContext}
                                    rawMetrics={baseRowsConRespuestas}
                                    campaignGroups={data.campaignGroups}
                                    effectiveKeyword={effectiveKeyword}
                                    sourceMapping={sourceMapping}
                                    platformSet={platformSet}
                                    layoutCustomMetrics={layoutCustomMetrics}
                                />
                            </div>
                        )}
                    </div>
                </SortableContext>
            </DndContext>

            {/* Country Breakdown Toggle */}
            <div>
                <button
                    onClick={() => setShowCountries(v => !v)}
                    className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground bg-card border border-border hover:border-muted-foreground/40 rounded-lg px-3 py-2 transition"
                >
                    <span>{showCountries ? '▲' : '▼'}</span>
                    {showCountries ? 'Ocultar desglose por país' : 'Ver desglose por país'}
                </button>
                {showCountries && (
                    <div className="mt-3">
                        <CountryBreakdown metrics={filteredMetrics} keywordFilter={effectiveKeyword} leadsFormula={leadsFormula} />
                    </div>
                )}
            </div>
            </>)} {/* end activeTabId !== 'soporte' */}

            {/* Modals */}
            {showTabModal && (
                <TabConfigModal
                    isOpen={showTabModal}
                    onClose={() => setShowTabModal(false)}
                    clienteId={cliente.id}
                    allLayouts={allLayouts}
                    tabTemplates={tabTemplates}
                    tabToEdit={tabToEdit}
                    clienteHasHotmart={platformSet.has('hotmart')}
                />
            )}

            {showModal && (
                <LayoutConfigModal
                    clienteId={cliente.id}
                    currentLayout={{ ...activeLayout, blocks_order: orderedBlocks }}
                    allLayouts={allLayouts || []}
                    isCustomized={layoutIsCustomized}
                    conversionesCatalogo={conversionesCatalogo}
                    googleSheetsConversiones={cliente.config_api?.google_sheets_conversiones}
                    conversionesOfflineRaw={data.conversionesOfflineRaw || []}
                    sheetCampos={data.sheetCampos || []}
                    sheetVistas={data.sheetVistas || []}
                    leadAnswerCampos={leadAnswerCampos}
                    campaignGroups={data.campaignGroups || []}
                    campaignNames={allCampaignNames}
                    onClose={() => setShowModal(false)}
                    onLayoutApplied={(newLayout) => {
                        if (newLayout) {
                            setTabLayoutOverrides(prev => ({ ...prev, [activeTabId]: newLayout }))
                        } else {
                            setTabLayoutOverrides(prev => {
                                const copy = { ...prev }
                                delete copy[activeTabId]
                                return copy
                            })
                        }
                        setShowModal(false)
                    }}
                    tabId={activeTabId}
                    tiktokAccounts={tiktokAccounts}
                />
            )}
            {quickEditTarget && (
                <QuickEditModal
                    target={quickEditTarget}
                    layout={{ ...activeLayout, blocks_order: orderedBlocks }}
                    clienteId={cliente.id}
                    tabId={activeTabId}
                    conversionesCatalogo={conversionesCatalogo}
                    googleSheetsConversiones={cliente.config_api?.google_sheets_conversiones}
                    conversionesOfflineRaw={data.conversionesOfflineRaw || []}
                    sheetCampos={data.sheetCampos || []}
                    sheetVistas={data.sheetVistas || []}
                    leadAnswerCampos={leadAnswerCampos}
                    campaignGroups={data.campaignGroups || []}
                    campaignNames={allCampaignNames}
                    tiktokAccounts={tiktokAccounts}
                    onClose={() => setQuickEditTarget(null)}
                    onLayoutApplied={(newLayout) => {
                        setTabLayoutOverrides(prev => ({ ...prev, [activeTabId]: newLayout }))
                        setTimeout(() => setQuickEditTarget(null), 600)
                    }}
                />
            )}
        </div>
    )
}

// ─── Default Megalayout (32 Metrics) ─────────────────────────────────────────

const DEFAULT_MEGALAYOUT: ReportLayout = {
    nombre: "Dashboard Principal",
    columnas: [
        { id: "c_fecha", label: "Fecha", formula: "fecha", align: "left" },
        { id: "c_gasto_acum", label: "Gasto acumulado", formula: "presupuesto_gastado_total", prefix: "$", decimals: 2, align: "right" },
        { id: "c_importe", label: "Importe gastado", formula: "meta_spend", prefix: "$", decimals: 2, align: "right" },
        { id: "c_cpm", label: "CPM", formula: "meta_cpm", prefix: "$", decimals: 2, align: "right" },
        { id: "c_impresiones", label: "Impresiones", formula: "meta_impressions", align: "right" },
        { id: "c_alcance", label: "Alcance", formula: "meta_reach", align: "right" },
        { id: "c_ctr", label: "CTR", formula: "meta_ctr", suffix: "%", decimals: 2, align: "right" },
        { id: "c_clics", label: "Clics", formula: "meta_link_clicks", align: "right" },
        { id: "c_cpc", label: "CPC", formula: "meta_cpc_link", prefix: "$", decimals: 2, align: "right" },
        { id: "c_visitas", label: "Visitas", formula: "ga_sessions", align: "right" },
        { id: "c_cpv", label: "Costo por visita", formula: "meta_spend / ga_sessions", prefix: "$", decimals: 2, align: "right" },
        { id: "c_p_clics_visitas", label: "% de clics a visitas", formula: "(ga_sessions / meta_link_clicks) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_pagos", label: "Pagos iniciados", formula: "hotmart_pagos_iniciados", align: "right" },
        { id: "c_cpp", label: "Costo por pago", formula: "meta_spend / hotmart_pagos_iniciados", prefix: "$", decimals: 2, align: "right" },
        { id: "c_p_visitas_pagos", label: "% visitas a pagos", formula: "(hotmart_pagos_iniciados / ga_sessions) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_compras", label: "Compras", formula: "meta_purchases", align: "right" },
        { id: "c_cpa", label: "Costo por compra", formula: "meta_spend / meta_purchases", prefix: "$", decimals: 2, align: "right" },
        { id: "c_p_pagos_compras", label: "% de pagos inciados a compras", formula: "(meta_purchases / hotmart_pagos_iniciados) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_p_conv_gen", label: "% de conversión general", formula: "(meta_purchases / ga_sessions) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_bump", label: "Order Bump", formula: "ventas_bump", prefix: "$", decimals: 2, align: "right" },
        { id: "c_fn_bump", label: "Facturación neta Order bump", formula: "ventas_bump", prefix: "$", decimals: 2, align: "right" },
        { id: "c_upsell", label: "UPSell", formula: "meta_custom_upsell", align: "right" },
        { id: "c_fn_upsell", label: "Facturacion neta UPSELL", formula: "ventas_upsell", prefix: "$", decimals: 2, align: "right" },
        { id: "c_fb", label: "Facturación bruta", formula: "total_facturacion_bruta", prefix: "$", decimals: 2, align: "right" },
        { id: "c_fn", label: "Facturación neta", formula: "total_facturacion_neta", prefix: "$", decimals: 2, align: "right" },
        { id: "c_roas", label: "ROAS", formula: "meta_roas", suffix: "x", decimals: 2, align: "right", highlight: true },
        { id: "c_roi", label: "ROI", formula: "(((ventas_principal + ventas_bump + ventas_upsell) - meta_spend) / meta_spend) * 100", suffix: "%", decimals: 1, align: "right", highlight: true },
        { id: "c_dinero", label: "Dinero en la bolsa", formula: "(ventas_principal + ventas_bump + ventas_upsell) - meta_spend", prefix: "$", decimals: 2, align: "right" },
        { id: "c_p_conv_order", label: "% Conversión order", formula: "(meta_custom_order_bump / meta_purchases) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_p_conv_upsell", label: "% Conversión UPSELL", formula: "(meta_custom_upsell / meta_purchases) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_vistas_upsell", label: "Visitas pagina de Upsell", formula: "meta_custom_vistas_upsell", align: "right" },
        { id: "c_p_vistas_pagos_upsell", label: "% de visitas pagina up sell a pagos de upsell", formula: "(meta_custom_pagos_upsell / meta_custom_vistas_upsell) * 100", suffix: "%", decimals: 2, align: "right" }
    ],
    tarjetas: [
        { id: "t_gasto", label: "Gasto Total", formula: "meta_spend", prefix: "$", decimals: 2, color: "default", variant: "stat", showDelta: true },
        { id: "t_fact", label: "Facturación Total", formula: "ventas_principal + ventas_bump + ventas_upsell", prefix: "$", decimals: 2, color: "emerald", variant: "stat", showDelta: true },
        { id: "t_roas", label: "ROAS General", formula: "(ventas_principal + ventas_bump + ventas_upsell) / meta_spend", suffix: "x", decimals: 2, color: "default", variant: "stat", showDelta: true },
        { id: "t_roi", label: "ROI General", formula: "(((ventas_principal + ventas_bump + ventas_upsell) - meta_spend) / meta_spend) * 100", suffix: "%", decimals: 1, color: "default", variant: "stat", showDelta: true }
    ]
}

// ─── Executive Public Dashboard ────────────────────────────────────────────────

function ExecutiveDashboard({ data, layout }: { data: any, layout: { tarjetas: CardDef[], graficos: ChartDef[], show_country_breakdown?: boolean, leads_formula?: string, source_mapping?: Record<string, string> } }) {
    const { metrics, weeks } = data
    const [campaignFilter, setCampaignFilter] = useState('')

    const filteredMetrics = useMemo(() => {
        return metrics.map((m: any) => enrichTikTokRow(enrichMetaRow(m, campaignFilter), campaignFilter))
    }, [metrics, campaignFilter])

    const varContext = useMemo(() => ({}), [])
    const sourceMapping = useMemo(() => layout.source_mapping || {}, [layout.source_mapping])

    const tarjetaValues = useMemo(() => {
        return (layout.tarjetas || []).map((t: CardDef) => ({
            ...t,
            value: aggregateFormula(t.formula, filteredMetrics, varContext, sourceMapping),
        }))
    }, [layout.tarjetas, filteredMetrics, varContext, sourceMapping])

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Campaign Filter */}
            <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/70 pointer-events-none" />
                    <Input
                        placeholder="Filtrar por campaña..."
                        value={campaignFilter}
                        onChange={(e) => setCampaignFilter(e.target.value)}
                        className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground/70 h-9"
                    />
                </div>
                {campaignFilter && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCampaignFilter('')}
                        className="text-muted-foreground hover:text-foreground h-9"
                    >
                        <X className="h-4 w-4 mr-1" />
                        Limpiar
                    </Button>
                )}
            </div>

            {/* Summary Cards */}
            {tarjetaValues.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {tarjetaValues.map((t: CardDef & { value: number | null }) => (
                        <Card key={t.id} className="bg-card border-border hover:border-muted-foreground/30 transition">
                            <CardHeader className="pb-2">
                                <CardDescription className="text-muted-foreground font-medium">
                                    {t.label}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="overflow-hidden">
                                <p
                                    className={`truncate text-2xl lg:text-3xl font-bold font-mono tabular-nums tracking-tight ${COLOR_MAP[t.color || 'default']}`}
                                    title={formatValue(t.value, { prefix: t.prefix, suffix: t.suffix, decimals: t.decimals ?? 2 })}
                                >
                                    {formatValue(t.value, { prefix: t.prefix, suffix: t.suffix, decimals: t.decimals ?? 2 })}
                                </p>
                            </CardContent>
                        </Card>
                    ))}
                </div>
            )}

            {/* Dynamic Charts */}
            {layout.graficos && layout.graficos.length > 0 && (
                <div className="pt-2">
                    <MetricCharts
                        charts={layout.graficos}
                        metrics={filteredMetrics}
                        weeks={weeks}
                        varContext={varContext}
                        rawMetrics={metrics}
                        campaignGroups={data.campaignGroups}
                        effectiveKeyword={campaignFilter}
                        sourceMapping={sourceMapping}
                    />
                </div>
            )}
            
            {/* Country Breakdown — only if enabled in public layout config */}
            {layout.show_country_breakdown && (
                <CountryBreakdown metrics={filteredMetrics} leadsFormula={layout.leads_formula || 'meta_leads'} />
            )}

            {tarjetaValues.length === 0 && !layout.graficos?.length && !layout.show_country_breakdown && (
                <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground/70">
                    <p>No hay tarjetas ni gráficos configurados para este reporte.</p>
                </div>
            )}
        </div>
    )
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export function DashboardClient({
    data,
    isPublic = false,
    initialTabId = 'general',
    initialKeyword = '',
    userRole = 'viewer',
}: { data: any; isPublic?: boolean; initialTabId?: string; initialKeyword?: string; userRole?: string }) {
    const { cliente, layout, clienteLayoutId } = data

    if (!cliente) {
        return (
            <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground">
                <p>No tienes ningún cliente asignado para visualizar métricas.</p>
            </div>
        )
    }

    // Always use DynamicDashboard for MIRROR effect (identical view)
    // DynamicDashboard handles isPublic to hide/show buttons
    return (
        <Suspense fallback={null}>
            <DynamicDashboard
                data={data}
                initialLayout={layout || DEFAULT_MEGALAYOUT}
                isCustomized={!!clienteLayoutId}
                isPublic={isPublic}
                initialTabId={initialTabId}
                initialKeyword={initialKeyword}
                userRole={userRole}
            />
        </Suspense>
    )
}

