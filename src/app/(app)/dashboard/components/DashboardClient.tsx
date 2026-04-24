'use client'

import React, { useState, useEffect, useMemo, useCallback } from 'react'
import { format, parseISO, addDays, getDay, differenceInDays } from 'date-fns'
import { es } from 'date-fns/locale'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { evaluateFormula, aggregateFormula, formatValue } from '@/lib/formula-engine'
import { LayoutConfigModal } from './LayoutConfigModal'
import { TabConfigModal } from './TabConfigModal'
import { MetricCharts } from './MetricCharts'
import { LayoutDashboard, Settings2, Plus, Edit2, CalendarDays, Timer, BadgeDollarSign, Wallet, GripVertical, Search, X, Puzzle, Type, AlignLeft, AlignCenter, AlignRight, Trash2, Save, Loader2, Minus } from 'lucide-react'
import type { ColDef, CardDef, ReportLayout, ChartDef, MetricDef, TextBlockDef } from '@/lib/layout-types'
import { updateManualMetric, getTabTotalSpend, saveClienteLayout, saveTabOverrides, updateLayoutPuzzleState } from '../_actions'
import { SortableCard, SortableChart, SortableTable, SortableText } from './PuzzleComponents'
import { CountryBreakdown } from './CountryBreakdown'
import { MonthlyReportTab } from './MonthlyReportTab'
import { SupportModule } from './SupportModule'
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent, DragStartEvent, DragOverlay, defaultDropAnimationSideEffects } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable'

import { CSS } from '@dnd-kit/utilities'

// Types imported from @/lib/layout-types

// ─── Helpers ─────────────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, string> = {
    emerald: 'text-emerald-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
    amber: 'text-amber-400',
    default: 'text-white',
}

function highlightClass(value: number | null, col: ColDef): string {
    if (!col.highlight || value === null) return ''
    if (col.suffix === 'x') return value >= 1 ? 'text-emerald-400' : 'text-red-400'
    if (col.suffix === '%') return value >= 0 ? 'text-emerald-400' : 'text-red-400'
    return ''
}

// Helper: Verificar si una campaña coincide con el patrón del grupo
function campaignMatchesPattern(
    campaign: any,
    pattern: string
): boolean {
    if (!pattern) return false

    // Convertir patrón SQL LIKE a regex
    // % = .* (cualquier cosa)
    // _ = . (un carácter)
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escapar caracteres especiales regex
        .replace(/%/g, '.*')
        .replace(/_/g, '.')

    const regex = new RegExp(`^${regexPattern}$`, 'i')
    return regex.test(campaign.name || '')
}

// Helper: Verificar si una campaña pertenece a un grupo
function campaignMatchesGroup(
    campaign: any,
    groupMappings: Array<{ campaign_id?: string; campaign_name_pattern?: string }>
): boolean {
    for (const mapping of groupMappings) {
        if (mapping.campaign_id && campaign.campaign_id === mapping.campaign_id) {
            return true
        }
        if (mapping.campaign_name_pattern && campaignMatchesPattern(campaign, mapping.campaign_name_pattern)) {
            return true
        }
    }
    return false
}

function enrichMetaRow(row: any, keywordFilter: string, campaignGroups?: any[]): any {
    // Use original logic for campaign filtering
    if (!row.meta_campaigns || !Array.isArray(row.meta_campaigns)) return row

    let matching = row.meta_campaigns

    // Si hay un ID de grupo válido, filtrar por ese grupo
    if (keywordFilter && campaignGroups && campaignGroups.length > 0) {
        const selectedGroup = campaignGroups.find(g => g.id === keywordFilter)
        if (selectedGroup && selectedGroup.campaign_group_mappings) {
            matching = row.meta_campaigns.filter((c: any) =>
                campaignMatchesGroup(c, selectedGroup.campaign_group_mappings)
            )
        } else {
            // Fallback: buscar por nombre si no es un ID de grupo válido
            const kw = keywordFilter.toLowerCase()
            matching = row.meta_campaigns.filter((c: any) =>
                kw === '' || c.name?.toLowerCase().includes(kw)
            )
        }
    } else if (keywordFilter) {
        // Original behavior: búsqueda por keyword en nombre
        const kw = keywordFilter.toLowerCase()
        matching = row.meta_campaigns.filter((c: any) =>
            kw === '' || c.name?.toLowerCase().includes(kw)
        )
    }

    // Reduce helper (inline to avoid breaking patterns)
    const ri = (field: string) => matching.reduce((s: number, c: any) => s + (parseInt(c[field] || '0') || 0), 0)
    const rf = (field: string) => matching.reduce((s: number, c: any) => s + (parseFloat(c[field] || '0') || 0), 0)

    // Base metrics from matched campaigns
    const base = {
        ...row,
        // Entrega
        meta_spend:       rf('spend'),
        meta_impressions: ri('impressions'),
        meta_clicks:      ri('clicks'),
        meta_link_clicks: ri('link_clicks'),
        meta_reach:       ri('reach'),
        meta_frequency:   rf('frequency'),
        // Leads y conversiones estándar
        meta_leads:                  ri('leads'),
        meta_leads_form:             ri('leads_form'),
        meta_purchases:              ri('purchases'),
        meta_adds_to_cart:           ri('adds_to_cart'),
        meta_initiates_checkout:     ri('initiates_checkout'),
        meta_landing_page_views:     ri('landing_page_views'),
        meta_complete_registration:  ri('complete_registration'),
        meta_view_content:           ri('view_content'),
        meta_search:                 ri('search'),
        meta_add_to_wishlist:        ri('add_to_wishlist'),
        meta_customize_product:      ri('customize_product'),
        meta_contact:                ri('contact'),
        meta_schedule:               ri('schedule'),
        meta_start_trial:            ri('start_trial'),
        meta_submit_application:     ri('submit_application'),
        meta_subscribe:              ri('subscribe'),
        meta_find_location:          ri('find_location'),
        meta_donate:                 ri('donate'),
        // Video
        meta_video_views:    ri('video_views'),
        meta_video_thruplay: ri('video_thruplay'),
        meta_video_3s_views: ri('video_3s'),
        // Mensajería
        meta_messaging_conversations_started: ri('messaging_conversations'),
        // Engagement
        meta_page_engagement: ri('page_engagement'),
        meta_post_engagement: ri('post_engagement'),
        meta_post_reactions:  ri('post_reactions'),
        meta_post_shares:     ri('post_shares'),
        meta_post_saves:      ri('post_saves'),
        meta_post_comments:   ri('post_comments'),
        // Resultados
        meta_results: ri('results'),
    }

    // Auto-expand custom pixel conversions: custom_conversions: { leadtcc: 456, lead_neuroemocion: 115 }
    // → exposes meta_custom_leadtcc, meta_custom_lead_neuroemocion, etc. for use in formulas
    const customKeys = new Set<string>()
    matching.forEach((c: any) => {
        if (c.custom_conversions && typeof c.custom_conversions === 'object') {
            Object.keys(c.custom_conversions).forEach(k => customKeys.add(k))
        }
    })
    customKeys.forEach(key => {
        base[`meta_custom_${key}`] = matching.reduce((s: number, c: any) => {
            return s + (c.custom_conversions?.[key] || 0)
        }, 0)
    })

    // Merge manual metrics
    const manuales = row.metricas_manuales || {}
    Object.keys(manuales).forEach(k => {
        base[k] = manuales[k]
    })

    return base
}


// ─── Layout Config Button ─────────────────────────────────────────────────────

function LayoutConfigButton({ onClick, isCustomized }: { onClick: () => void; isCustomized: boolean }) {
    return (
        <Button
            size="sm"
            variant="outline"
            onClick={onClick}
            className="gap-1.5 border-zinc-700 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/40 hover:bg-indigo-500/5 text-xs transition"
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
                    className="p-1 text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing"
                    title="Arrastrar para reordenar"
                >
                    <GripVertical className="w-3.5 h-3.5" />
                </button>
            )}
            <button
                onClick={onSelect}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${isActive ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
            >
                {tab.nombre}
                <span className="text-[10px] bg-zinc-800/80 px-1.5 py-0.5 rounded text-zinc-400 font-mono tracking-wider">{tab.keyword_meta}</span>
                {hasOverride && (
                    <span className="text-[9px] text-indigo-400 font-bold" title="Vista personalizada">✦</span>
                )}
            </button>
            {!isPublic && (
                <button
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    className={`absolute right-1 p-1 text-zinc-500 hover:text-white rounded bg-zinc-900 shadow border border-zinc-700 opacity-0 group-hover:opacity-100 transition ${isActive ? 'opacity-100' : ''}`}
                >
                    <Edit2 className="w-3 h-3" />
                </button>
            )}
        </div>
    )
}

// ─── Dynamic Dashboard ────────────────────────────────────────────────────────

function DynamicDashboard({ data, initialLayout, isCustomized, isPublic, initialTabId = 'general', initialKeyword = '' }: {
    data: any
    initialLayout: ReportLayout
    isCustomized: boolean
    isPublic?: boolean
    initialTabId?: string
    initialKeyword?: string
}) {
    const { cliente, metrics, weeks, allLayouts, tabs: initialTabs = [], conversionesCatalogo = [], availablePlatforms: availablePlatformsArr = ['meta'] } = data
    const platformSet = useMemo(() => new Set<string>(availablePlatformsArr), [availablePlatformsArr])
    const [activeTabId, setActiveTabId] = useState<string>(initialTabId)

    const [isPuzzleMode, setIsPuzzleMode] = useState(false)
    const [isSavingLayout, setIsSavingLayout] = useState(false)
    const [orderedBlocks, setOrderedBlocks] = useState<string[]>([])

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
        if (activeTabId !== 'general' && activeTabId !== 'monthly-report' && activeTabId !== 'soporte') {
            const tabExists = initialTabs.some((t: any) => t.id === activeTabId)
            if (!tabExists) {
                setActiveTabId('general')
            }
        }
    }, [initialTabs, activeTabId])

    // Use sortedTabs as the canonical tabs list
    const tabs = sortedTabs

    // Tab Modals
    const [showTabModal, setShowTabModal] = useState(false)
    const [tabToEdit, setTabToEdit] = useState<any>(null)

    // Fallback manual filter for general tab
    const [keywordFilter, setKeywordFilter] = useState(initialKeyword)
    const [showModal, setShowModal] = useState(false)

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

    // 1. Determine active tab object
    const activeTabObj = useMemo(() => tabs.find((t: any) => t.id === activeTabId), [tabs, activeTabId])

    // 2. Determine effective keyword filter
    // If we are on a custom tab, start with its keyword but allow manual overriding/filtering if keywordFilter is set
    const effectiveKeyword = keywordFilter || (activeTabObj ? activeTabObj.keyword_meta : '')

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
                }
                customized = true
            } else if (activeTabObj.plantilla_id) {
                const found = allLayouts.find((l: any) => l.id === activeTabObj.plantilla_id)
                if (found) {
                    layout = {
                        ...found,
                        text_blocks: activeTabObj.text_blocks ?? found.text_blocks,
                        blocks_order: activeTabObj.blocks_order ?? found.blocks_order,
                    }
                    customized = false
                }
            } else {
                // Tab sin columnas propias ni plantilla — usa layout del cliente pero aplica puzzle state del tab
                layout = {
                    ...initialLayout,
                    text_blocks: activeTabObj.text_blocks ?? initialLayout.text_blocks,
                    blocks_order: activeTabObj.blocks_order ?? initialLayout.blocks_order,
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
            ...(activeLayout.text_blocks || []).map(t => `text:${t.id}`)
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

        const updates: Partial<ReportLayout> = { blocks_order: newOrder }
        if (blockId.startsWith('text:')) {
            const textId = blockId.replace('text:', '')
            updates.text_blocks = (activeLayout.text_blocks || []).filter((b: TextBlockDef) => b.id !== textId)
        }
        setTabLayoutOverrides(prev => ({
            ...prev,
            [activeTabId]: { ...(prev[activeTabId] || activeLayout), ...updates }
        }))
    }

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


    const filteredMetrics = useMemo(() => {
        let rows = metrics
        if (activeTabObj?.fecha_inicio) {
            rows = rows.filter((m: any) => m.fecha >= activeTabObj.fecha_inicio)
        }
        if (activeTabObj?.fecha_finalizacion) {
            rows = rows.filter((m: any) => m.fecha <= activeTabObj.fecha_finalizacion)
        }
        return rows.map((m: any) => enrichMetaRow(m, effectiveKeyword, data.campaignGroups))
    }, [metrics, effectiveKeyword, activeTabObj, data.campaignGroups])

    const visibleCols = useMemo(() => {
        return activeLayout.columnas.filter((c: ColDef) => !c.hidden)
    }, [activeLayout.columnas])

    // Compute varContext for formulas
    const varContext = useMemo(() => {
        const ctx: Record<string, number> = {}
        if (activeTabObj) {
            if (activeTabObj.fecha_inicio && activeTabObj.fecha_finalizacion) {
                const start = parseISO(activeTabObj.fecha_inicio)
                const end = parseISO(activeTabObj.fecha_finalizacion)
                const totalDays = differenceInDays(end, start) + 1
                const elapsedDays = differenceInDays(new Date(), start) + 1
                
                ctx.dias_totales = totalDays
                ctx.dias_transcurridos = elapsedDays > totalDays ? totalDays : (elapsedDays < 0 ? 0 : elapsedDays)
                ctx.dias_restantes = ctx.dias_totales - ctx.dias_transcurridos
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

    // Summary cards — aggregate formula over all filtered rows
    const tarjetaValues = useMemo(() => {
        return activeLayout.tarjetas.map((t: CardDef) => ({
            ...t,
            value: aggregateFormula(t.formula, filteredMetrics, varContext, sourceMapping, platformSet, layoutCustomMetrics),
        }))
    }, [activeLayout.tarjetas, filteredMetrics, varContext, sourceMapping, platformSet, layoutCustomMetrics])

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
        })
    }, [weeks, filteredMetrics, varContext, gastoFormula, leadsFormula])

    let budgetCards = null
    if (activeTabObj && (activeTabObj.fecha_inicio || activeTabObj.fecha_finalizacion || activeTabObj.presupuesto_objetivo)) {
        const fechaInicioStr = activeTabObj.fecha_inicio ? format(parseISO(activeTabObj.fecha_inicio), 'dd MMM yyyy', { locale: es }) : '...'
        const fechaFinStr = activeTabObj.fecha_finalizacion ? format(parseISO(activeTabObj.fecha_finalizacion), 'dd MMM yyyy', { locale: es }) : '...'
        
        const daysLeft = varContext.dias_restantes ?? null
        const pres = varContext.presupuesto_objetivo || 0
        const rem = varContext.presupuesto_restante ?? 0
        const dailyBudget = varContext.presupuesto_diario_sugerido ?? 0

        budgetCards = (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 mt-2 mb-2">
                <Card className="bg-zinc-900 border-zinc-800 border-l-4 border-l-blue-500 shadow-lg">
                    <CardContent className="py-3 px-4 flex items-center justify-between">
                        <div>
                            <p className="text-xs text-zinc-400 font-medium mb-1">Rango de Captación</p>
                            <p className="text-sm text-zinc-200 font-semibold">{fechaInicioStr} - {fechaFinStr}</p>
                        </div>
                        <CalendarDays className="w-7 h-7 text-blue-500/50" />
                    </CardContent>
                </Card>
                
                {daysLeft !== null && (
                    <Card className="bg-zinc-900 border-zinc-800 border-l-4 border-l-amber-500 shadow-lg">
                        <CardContent className="py-3 px-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-zinc-400 font-medium mb-1">Días Faltantes</p>
                                <p className="text-lg md:text-xl font-bold text-amber-400 font-mono">{daysLeft} días</p>
                            </div>
                            <Timer className="w-7 h-7 text-amber-500/50" />
                        </CardContent>
                    </Card>
                )}

                {pres > 0 && (
                    <Card className="bg-zinc-900 border-zinc-800 border-l-4 border-l-emerald-500 shadow-lg">
                        <CardContent className="py-3 px-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-zinc-400 font-medium mb-1">Presupuesto Restante</p>
                                {fetchingSpend ? (
                                    <p className="text-sm text-zinc-500">Calculando...</p>
                                ) : (
                                    <p className="text-lg md:text-xl font-bold text-emerald-400 font-mono">
                                        ${rem.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                                    </p>
                                )}
                            </div>
                            <Wallet className="w-7 h-7 text-emerald-500/50" />
                        </CardContent>
                    </Card>
                )}

                {pres > 0 && daysLeft !== null && (
                    <Card className="bg-zinc-900 border-zinc-800 border-l-4 border-l-indigo-500 shadow-lg">
                        <CardContent className="py-3 px-4 flex items-center justify-between">
                            <div>
                                <p className="text-xs text-zinc-400 font-medium mb-1">Prep. Diario Sugerido</p>
                                {fetchingSpend ? (
                                    <p className="text-sm text-zinc-500">Calculando...</p>
                                ) : (
                                    <p className="text-lg md:text-xl font-bold text-indigo-400 font-mono">
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

    return (
        <div className="space-y-6">
            {/* Public Tabs Bar — simplified, no drag, no edit */}
            {isPublic && tabs.length > 0 && (
                <div className="flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar border-b border-zinc-800">
                    {tabs.map((tab: any) => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTabId(tab.id)}
                            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${activeTabId === tab.id ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                        >
                            {tab.nombre}
                            {tab.keyword_meta && (
                                <span className="text-[10px] bg-zinc-800/80 px-1.5 py-0.5 rounded text-zinc-400 font-mono tracking-wider">{tab.keyword_meta}</span>
                            )}
                        </button>
                    ))}
                </div>
            )}

            {/* Tabs Bar with Drag & Drop */}
            {!isPublic && (
                <div className="flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar border-b border-zinc-800">
                    {/* Vista General - always first, not draggable */}
                    <button
                        onClick={() => setActiveTabId('general')}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 ${activeTabId === 'general' ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                    >
                        Vista General
                    </button>
                    {/* Draggable custom tabs — only rendered client-side to avoid dnd-kit hydration mismatch */}
                    {!isMounted ? (
                        tabs.map((tab: any) => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTabId(tab.id)}
                                className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 ${activeTabId === tab.id ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
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
                            <SortableContext items={tabs.map((t: any) => t.id)} strategy={horizontalListSortingStrategy}>
                                {tabs.map((tab: any) => (
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
                                    <div className="px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 border-blue-500 text-blue-400 bg-blue-500/10 shadow-lg">
                                        {tabs.find((t: any) => t.id === dragActiveId)?.nombre}
                                    </div>
                                ) : null}
                            </DragOverlay>
                        </DndContext>
                    )}
                    {!isPublic && (
                        <button
                            onClick={() => { setTabToEdit(null); setShowTabModal(true); }}
                            className="ml-2 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 rounded flex items-center gap-1 transition"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Nueva Pestaña
                        </button>
                    )}
                    {/* Pestaña fija de Reporte Mensual */}
                    <button
                        onClick={() => setActiveTabId('monthly-report')}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${activeTabId === 'monthly-report' ? 'border-amber-500 text-amber-400 bg-amber-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                    >
                        📊 Reporte Mensual
                    </button>
                    {/* Pestaña fija de Soporte */}
                    <button
                        onClick={() => setActiveTabId('soporte')}
                        className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${activeTabId === 'soporte' ? 'border-indigo-500 text-indigo-400 bg-indigo-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                    >
                        🎧 Soporte Ads
                    </button>
                </div>
            )}



            {/* Reporte Mensual Tab Content */}
            {activeTabId === 'monthly-report' && (
                <MonthlyReportTab clientId={cliente.id} />
            )}

            {/* Soporte Tab Content */}
            {activeTabId === 'soporte' && (
                <SupportModule clientId={cliente.id} />
            )}

            {/* Toolbar + Dashboard Content */}
            {activeTabId !== 'monthly-report' && activeTabId !== 'soporte' && (<>
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-xs text-indigo-400 bg-indigo-500/5 border border-indigo-500/20 rounded-lg px-3 py-1.5">
                        <LayoutDashboard className="w-3.5 h-3.5" />
                        <span><strong>{activeLayout.nombre}</strong>{layoutIsCustomized ? ' — Personalizada' : ' — Plantilla Base'}</span>
                    </div>

                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
                        <Input
                            placeholder="Buscar campaña..."
                            value={keywordFilter}
                            onChange={(e) => setKeywordFilter(e.target.value)}
                            className="h-8 pl-8 text-xs w-44 md:w-64 bg-zinc-900 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
                        />
                        {keywordFilter && (
                            <button 
                                onClick={() => setKeywordFilter('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                            >
                                <X className="h-3 w-3" />
                            </button>
                        )}
                    </div>
                </div>
                {!isPublic && (
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setIsPuzzleMode(!isPuzzleMode)}
                            className={`gap-1.5 text-xs transition ${isPuzzleMode ? 'border-amber-500/50 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20' : 'border-zinc-700 text-zinc-400 hover:text-indigo-300 hover:bg-indigo-500/5'}`}
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
                                    className="gap-1.5 text-xs border-indigo-500/40 text-indigo-400 hover:bg-indigo-500/10 animate-in zoom-in-95 duration-200"
                                >
                                    <Type className="w-3.5 h-3.5" />
                                    + Sección
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleAddBlock('separator')}
                                    className="gap-1.5 text-xs border-zinc-600 text-zinc-400 hover:bg-zinc-800 animate-in zoom-in-95 duration-200"
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
                                className="gap-1.5 border-zinc-700 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/40 hover:bg-indigo-500/5 text-xs transition"
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

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDashboardDragEnd}>
                <SortableContext items={orderedBlocks} strategy={verticalListSortingStrategy}>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        {orderedBlocks.map(blockId => {
                            if (blockId.startsWith('card:')) {
                                const card = tarjetaValues.find((t: any) => `card:${t.id}` === blockId)
                                if (!card) return null
                                return <SortableCard key={blockId} id={blockId} card={card} isPuzzleMode={isPuzzleMode} onRemove={() => handleRemoveBlock(blockId)} />
                            }
                            if (blockId.startsWith('chart:')) {
                                const chart = activeLayout.graficos?.find((g: any) => `chart:${g.id}` === blockId)
                                if (!chart) return null
                                return <SortableChart key={blockId} id={blockId} chart={chart} isPuzzleMode={isPuzzleMode} metrics={filteredMetrics} weeks={weeks} varContext={varContext} onRemove={() => handleRemoveBlock(blockId)} />
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
                                />
                            }
                            if (blockId === 'table') {
                                return (
                                    <SortableTable key={blockId} id={blockId} isPuzzleMode={isPuzzleMode}>
                                        <Card className="bg-zinc-900 border-zinc-800 overflow-hidden shadow-2xl">
                                            <CardHeader className="border-b border-zinc-800 bg-zinc-950/30">
                                                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                                                    <CardTitle className="text-white">Vista de Embudo Diaria — {cliente.nombre} {activeTabObj && <span className="text-blue-400 opacity-80 border-l border-zinc-700 pl-2 ml-2">{activeTabObj.nombre}</span>}</CardTitle>
                                                    <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                                                        {activeTabId === 'general' ? (
                                                            <>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    <Button
                                                                        size="sm"
                                                                        variant="outline"
                                                                        onClick={() => setKeywordFilter('')}
                                                                        className={`h-7 text-xs ${keywordFilter === '' ? 'bg-blue-600 text-white border-transparent hover:bg-blue-700' : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}
                                                                    >Ver Todo</Button>
                                                                    {data.campaignGroups && data.campaignGroups.length > 0 && (
                                                                        <>
                                                                            <div className="h-6 w-px bg-zinc-700" />
                                                                            {data.campaignGroups.map((group: any) => (
                                                                                <Button
                                                                                    key={group.id}
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    onClick={() => setKeywordFilter(group.id)}
                                                                                    className={`h-7 text-xs ${keywordFilter === group.id ? 'bg-emerald-600 text-white border-transparent hover:bg-emerald-700' : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}
                                                                                >📊 {group.nombre}</Button>
                                                                            ))}
                                                                        </>
                                                                    )}
                                                                    {metaKeywords.length > 0 && (
                                                                        <>
                                                                            {(data.campaignGroups && data.campaignGroups.length > 0) && <div className="h-6 w-px bg-zinc-700" />}
                                                                            {metaKeywords.map((kw: string) => (
                                                                                <Button
                                                                                    key={kw}
                                                                                    size="sm"
                                                                                    variant="outline"
                                                                                    onClick={() => setKeywordFilter(kw)}
                                                                                    className={`h-7 text-xs ${keywordFilter.toLowerCase() === kw.toLowerCase() ? 'bg-blue-600 text-white border-transparent hover:bg-blue-700' : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}
                                                                                >{kw}</Button>
                                                                            ))}
                                                                        </>
                                                                    )}
                                                                </div>
                                                            </>
                                                        ) : activeTabObj ? (
                                                            <div className="text-xs text-zinc-500 bg-zinc-950 px-3 py-1.5 rounded-md border border-zinc-800">
                                                                Filtro: <span className="font-mono text-zinc-300">"{activeTabObj.keyword_meta}"</span>
                                                            </div>
                                                        ) : null}
                                                    </div>
                                                </div>
                                            </CardHeader>
                                            <CardContent className="p-0 overflow-x-auto custom-scrollbar">
                                                <Table className="whitespace-nowrap select-none">
                                                    <TableHeader>
                                                        <TableRow className="border-zinc-800 bg-zinc-950 *:text-zinc-300 *:font-semibold">
                                                            {visibleCols.map((col: ColDef) => (
                                                                <TableHead
                                                                    key={col.id}
                                                                    className={col.align === 'right' ? 'text-right' : ''}
                                                                    style={col.id === visibleCols[0].id && col.formula === 'fecha' ? { width: '120px' } : {}}
                                                                >
                                                                    {col.label}
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

                                                            while (currentDate.getTime() <= endDate.getTime()) {
                                                                const dayStr = format(currentDate, 'yyyy-MM-dd')
                                                                const raw = filteredMetrics.find((m: any) => m.fecha === dayStr) || {
                                                                    fecha: dayStr, meta_spend: 0, meta_impressions: 0, meta_clicks: 0, meta_campaigns: [],
                                                                    hotmart_pagos_iniciados: 0, ventas_principal: 0, ventas_bump: 0, ventas_upsell: 0
                                                                }
                                                                weekRows.push(raw)

                                                                const isWeekend = getDay(currentDate) === 0 || getDay(currentDate) === 6
                                                                daysInWeek.push(
                                                                    <TableRow key={dayStr} className={`border-zinc-800/60 ${isWeekend ? 'bg-zinc-950/60 text-zinc-600' : 'text-zinc-200'} hover:bg-zinc-800/70 transition-colors`}>
                                                                        {visibleCols.map((col: ColDef) => {
                                                                            if (col.formula === 'fecha') {
                                                                                return (
                                                                                    <TableCell key={col.id} className="font-mono text-xs">
                                                                                        {format(currentDate, 'dd MMM (EEE)', { locale: es })}
                                                                                    </TableCell>
                                                                                )
                                                                            }
                                                                            const val = evaluateFormula(col.formula, raw, varContext, sourceMapping, platformSet, layoutCustomMetrics)
                                                                            const hl = highlightClass(val, col)
                                                                            if (col.isManual) {
                                                                                return (
                                                                                    <TableCell key={col.id} className={`${col.align === 'right' ? 'text-right' : ''} p-1`}>
                                                                                        {isPublic ? (
                                                                                            <span className="text-zinc-200 block mt-1">{val || '0'}</span>
                                                                                        ) : (
                                                                                            <Input
                                                                                                type="number"
                                                                                                defaultValue={val || ''}
                                                                                                className="h-7 w-20 text-xs text-right bg-zinc-950 border-zinc-700 mx-auto"
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
                                                                                <TableCell key={col.id} className={`${col.align === 'right' ? 'text-right' : ''} ${hl}`}>
                                                                                    {formatValue(val, { prefix: col.prefix, suffix: col.suffix, decimals: col.decimals })}
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
                                                                    <TableRow className="border-t-2 border-zinc-600 bg-zinc-900/80 font-semibold *:text-white">
                                                                        {visibleCols.map((col: ColDef) => {
                                                                            if (col.formula === 'fecha') {
                                                                                return <TableCell key={col.id} className="text-blue-300">Total Sem {week.weekNumber}</TableCell>
                                                                            }
                                                                            const val = aggregateFormula(col.formula, weekRows, varContext, sourceMapping, platformSet, layoutCustomMetrics)
                                                                            const hl = col.highlight ? highlightClass(val, col) : ''
                                                                            return (
                                                                                <TableCell key={col.id} className={`${col.align === 'right' ? 'text-right' : ''} ${hl}`}>
                                                                                    {formatValue(val, { prefix: col.prefix, suffix: col.suffix, decimals: col.decimals })}
                                                                                </TableCell>
                                                                            )
                                                                        })}
                                                                    </TableRow>
                                                                </React.Fragment>
                                                            )
                                                        })}
                                                        {weeks.length === 0 && (
                                                            <TableRow>
                                                                <TableCell colSpan={visibleCols.length} className="text-center p-8 text-zinc-500">
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
                    className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-800 hover:border-zinc-600 rounded-lg px-3 py-2 transition"
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
            </>)} {/* end activeTabId !== 'monthly-report' */}

            {/* Modals */}
            {showTabModal && (
                <TabConfigModal
                    isOpen={showTabModal}
                    onClose={() => setShowTabModal(false)}
                    clienteId={cliente.id}
                    allLayouts={allLayouts}
                    tabToEdit={tabToEdit}
                />
            )}

            {showModal && (
                <LayoutConfigModal
                    clienteId={cliente.id}
                    currentLayout={{ ...activeLayout, blocks_order: orderedBlocks }}
                    allLayouts={allLayouts || []}
                    isCustomized={layoutIsCustomized}
                    conversionesCatalogo={conversionesCatalogo}
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
        { id: "c_fb", label: "Facturación bruta", formula: "ventas_principal + ventas_bump + ventas_upsell", prefix: "$", decimals: 2, align: "right" },
        { id: "c_fn", label: "Facturación neta", formula: "ventas_principal + ventas_bump + ventas_upsell", prefix: "$", decimals: 2, align: "right" },
        { id: "c_roas", label: "ROAS", formula: "meta_roas", suffix: "x", decimals: 2, align: "right", highlight: true },
        { id: "c_roi", label: "ROI", formula: "(((ventas_principal + ventas_bump + ventas_upsell) - meta_spend) / meta_spend) * 100", suffix: "%", decimals: 1, align: "right", highlight: true },
        { id: "c_dinero", label: "Dinero en la bolsa", formula: "(ventas_principal + ventas_bump + ventas_upsell) - meta_spend", prefix: "$", decimals: 2, align: "right" },
        { id: "c_p_conv_order", label: "% Conversión order", formula: "(meta_custom_order_bump / meta_purchases) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_p_conv_upsell", label: "% Conversión UPSELL", formula: "(meta_custom_upsell / meta_purchases) * 100", suffix: "%", decimals: 2, align: "right" },
        { id: "c_vistas_upsell", label: "Visitas pagina de Upsell", formula: "meta_custom_vistas_upsell", align: "right" },
        { id: "c_p_vistas_pagos_upsell", label: "% de visitas pagina up sell a pagos de upsell", formula: "(meta_custom_pagos_upsell / meta_custom_vistas_upsell) * 100", suffix: "%", decimals: 2, align: "right" }
    ],
    tarjetas: [
        { id: "t_gasto", label: "Gasto Total", formula: "meta_spend", prefix: "$", decimals: 2, color: "default" },
        { id: "t_fact", label: "Facturación Total", formula: "ventas_principal + ventas_bump + ventas_upsell", prefix: "$", decimals: 2, color: "emerald" },
        { id: "t_roas", label: "ROAS General", formula: "(ventas_principal + ventas_bump + ventas_upsell) / meta_spend", suffix: "x", decimals: 2, color: "default" },
        { id: "t_roi", label: "ROI General", formula: "(((ventas_principal + ventas_bump + ventas_upsell) - meta_spend) / meta_spend) * 100", suffix: "%", decimals: 1, color: "default" }
    ]
}

// ─── Executive Public Dashboard ────────────────────────────────────────────────

function ExecutiveDashboard({ data, layout }: { data: any, layout: { tarjetas: CardDef[], graficos: ChartDef[], show_country_breakdown?: boolean, leads_formula?: string, source_mapping?: Record<string, string> } }) {
    const { metrics, weeks } = data
    const [campaignFilter, setCampaignFilter] = useState('')

    const filteredMetrics = useMemo(() => {
        return metrics.map((m: any) => enrichMetaRow(m, campaignFilter))
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
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500 pointer-events-none" />
                    <Input
                        placeholder="Filtrar por campaña..."
                        value={campaignFilter}
                        onChange={(e) => setCampaignFilter(e.target.value)}
                        className="pl-8 bg-zinc-900 border-zinc-700 text-zinc-200 placeholder:text-zinc-500 h-9"
                    />
                </div>
                {campaignFilter && (
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCampaignFilter('')}
                        className="text-zinc-400 hover:text-white h-9"
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
                        <Card key={t.id} className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                            <CardHeader className="pb-2">
                                <CardDescription className="text-zinc-400 font-medium">
                                    {t.label}
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="overflow-hidden">
                                <p
                                    className={`truncate text-2xl lg:text-3xl font-bold font-mono tracking-tight ${COLOR_MAP[t.color || 'default']}`}
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
                    />
                </div>
            )}
            
            {/* Country Breakdown — only if enabled in public layout config */}
            {layout.show_country_breakdown && (
                <CountryBreakdown metrics={filteredMetrics} leadsFormula={layout.leads_formula || 'meta_leads'} />
            )}

            {tarjetaValues.length === 0 && !layout.graficos?.length && !layout.show_country_breakdown && (
                <div className="flex flex-col items-center justify-center p-12 text-center text-zinc-500">
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
    initialKeyword = ''
}: { data: any, isPublic?: boolean, initialTabId?: string, initialKeyword?: string }) {
    const { cliente, layout, clienteLayoutId } = data

    if (!cliente) {
        return (
            <div className="flex flex-col items-center justify-center p-12 text-center text-zinc-400">
                <p>No tienes ningún cliente asignado para visualizar métricas.</p>
            </div>
        )
    }

    // Always use DynamicDashboard for MIRROR effect (identical view)
    // DynamicDashboard handles isPublic to hide/show buttons
    return (
        <DynamicDashboard
            data={data}
            initialLayout={layout || DEFAULT_MEGALAYOUT}
            isCustomized={!!clienteLayoutId}
            isPublic={isPublic}
            initialTabId={initialTabId}
            initialKeyword={initialKeyword}
        />
    )
}

