'use client'

import React, { useState, useEffect, useMemo } from 'react'
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
import { LayoutDashboard, Settings2, Plus, Edit2, CalendarDays, Timer, BadgeDollarSign, Wallet } from 'lucide-react'
import type { ColDef, CardDef, ReportLayout, ChartDef } from '@/lib/layout-types'
import { updateManualMetric, getTabTotalSpend } from '../_actions'

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

function enrichMetaRow(row: any, keywordFilter: string): any {
    if (!row.meta_campaigns || !Array.isArray(row.meta_campaigns)) return row

    const kw = keywordFilter ? keywordFilter.toLowerCase() : ''
    const matching = row.meta_campaigns.filter((c: any) => kw === '' || c.name?.toLowerCase().includes(kw))

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

// ─── Dynamic Dashboard ────────────────────────────────────────────────────────

function DynamicDashboard({ data, initialLayout, isCustomized, isPublic }: {
    data: any
    initialLayout: ReportLayout
    isCustomized: boolean
    isPublic?: boolean
}) {
    const { cliente, metrics, weeks, allLayouts, clienteLayoutId, tabs = [], conversionesCatalogo = [] } = data
    const [activeTabId, setActiveTabId] = useState<string>('general')

    // Tab Modals
    const [showTabModal, setShowTabModal] = useState(false)
    const [tabToEdit, setTabToEdit] = useState<any>(null)

    // Fallback manual filter for general tab
    const [keywordFilter, setKeywordFilter] = useState('')
    const [showModal, setShowModal] = useState(false)

    // Global spend for budget cards
    const [globalSpend, setGlobalSpend] = useState<number | null>(null)
    const [fetchingSpend, setFetchingSpend] = useState(false)

    useEffect(() => {
        const fetchSpend = async () => {
             const tab = tabs.find((t: any) => t.id === activeTabId)
             if (tab && tab.presupuesto_objetivo) {
                 setFetchingSpend(true)
                 const spend = await getTabTotalSpend(cliente.id, tab.keyword_meta)
                 setGlobalSpend(spend)
                 setFetchingSpend(false)
             } else {
                 setGlobalSpend(null)
             }
        }
        fetchSpend()
    }, [activeTabId, tabs, cliente.id])

    // Local layout overrides per tab (so "Personalizar" changes reflect instantly)
    // Key = tabId ('general' or tab.id), Value = ReportLayout
    const [tabLayoutOverrides, setTabLayoutOverrides] = useState<Record<string, ReportLayout>>({})

    const metaKeywords: string[] = cliente.config_api?.meta_keywords
        ? cliente.config_api.meta_keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
        : []

    // 1. Determine active tab object
    const activeTabObj = useMemo(() => tabs.find((t: any) => t.id === activeTabId), [tabs, activeTabId])

    // 2. Determine effective keyword filter
    const effectiveKeyword = activeTabObj ? activeTabObj.keyword_meta : keywordFilter

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
                }
                customized = true
            } else if (activeTabObj.plantilla_id) {
                const found = allLayouts.find((l: any) => l.id === activeTabObj.plantilla_id)
                if (found) {
                    layout = found
                    customized = false
                }
            }
        }
        return { activeLayout: layout, layoutIsCustomized: customized }
    }, [initialLayout, isCustomized, tabLayoutOverrides, activeTabId, activeTabObj, allLayouts])

    const filteredMetrics = useMemo(() => {
        return metrics.map((m: any) => enrichMetaRow(m, effectiveKeyword))
    }, [metrics, effectiveKeyword])

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

    // Summary cards — aggregate formula over all filtered rows
    const tarjetaValues = useMemo(() => {
        return activeLayout.tarjetas.map((t: CardDef) => ({
            ...t,
            value: aggregateFormula(t.formula, filteredMetrics, varContext),
        }))
    }, [activeLayout.tarjetas, filteredMetrics, varContext])

    // Determine formulas for Gasto and Leads based on visible columns
    const { gastoFormula, leadsFormula } = useMemo(() => {
        const gastoCol = visibleCols.find((c: ColDef) => c.label.toLowerCase().includes('gasto'))
        const leadsCol = visibleCols.find((c: ColDef) => c.label.toLowerCase().includes('lead') || c.label.toLowerCase().includes('registro'))
        return {
            gastoFormula: gastoCol ? gastoCol.formula : 'meta_spend',
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
                    ga_sessions: 0, hotmart_pagos_iniciados: 0, ventas_principal: 0, ventas_bump: 0, ventas_upsell: 0
                }
                weekRows.push(raw)
                currentDate = addDays(currentDate, 1)
            }

            const totalGasto = aggregateFormula(gastoFormula, weekRows, varContext)
            const totalLeads = aggregateFormula(leadsFormula, weekRows, varContext)

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
                            <p className="text-xs text-zinc-400 font-medium mb-1">Rango del Diplomado</p>
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
            {/* Tabs Bar */}
            <div className="flex items-center gap-2 overflow-x-auto pb-2 custom-scrollbar border-b border-zinc-800">
                <button
                    onClick={() => setActiveTabId('general')}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 ${activeTabId === 'general' ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                >
                    Vista General
                </button>
                {tabs.map((tab: any) => (
                    <div key={tab.id} className="relative group flex items-center">
                        <button
                            onClick={() => setActiveTabId(tab.id)}
                            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition whitespace-nowrap border-b-2 flex items-center gap-1.5 ${activeTabId === tab.id ? 'border-blue-500 text-blue-400 bg-blue-500/10' : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'}`}
                        >
                            {tab.nombre}
                            <span className="text-[10px] bg-zinc-800/80 px-1.5 py-0.5 rounded text-zinc-400 font-mono tracking-wider">{tab.keyword_meta}</span>
                            {(tab.columnas || tabLayoutOverrides[tab.id]) && (
                                <span className="text-[9px] text-indigo-400 font-bold" title="Vista personalizada">✦</span>
                            )}
                        </button>
                        {!isPublic && (
                            <button
                                onClick={(e) => { e.stopPropagation(); setTabToEdit(tab); setShowTabModal(true); }}
                                className={`absolute right-1 p-1 text-zinc-500 hover:text-white rounded bg-zinc-900 shadow border border-zinc-700 opacity-0 group-hover:opacity-100 transition ${activeTabId === tab.id ? 'opacity-100' : ''}`}
                            >
                                <Edit2 className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                ))}
                {!isPublic && (
                    <button
                        onClick={() => { setTabToEdit(null); setShowTabModal(true); }}
                        className="ml-2 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 rounded flex items-center gap-1 transition"
                    >
                        <Plus className="w-3.5 h-3.5" />
                        Nueva Pestaña
                    </button>
                )}
            </div>

            {/* Toolbar */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2 text-xs text-indigo-400 bg-indigo-500/5 border border-indigo-500/20 rounded-lg px-3 py-1.5">
                        <LayoutDashboard className="w-3.5 h-3.5" />
                        <span><strong>{activeLayout.nombre}</strong>{layoutIsCustomized ? ' — Personalizada' : ' — Plantilla Base'}</span>
                    </div>
                </div>
                {!isPublic && (
                    activeTabId === 'general' ? (
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
                            Personalizar esta Vista
                        </Button>
                    )
                )}
            </div>

            {/* Budget/Time Cards */}
            {budgetCards}

            {/* Summary Cards */}
            {tarjetaValues.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                    {tarjetaValues.map((t: CardDef & { value: number | null }) => (
                        <Card key={t.id} className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                            <CardHeader className="pb-2">
                                <CardDescription className="text-zinc-400 font-medium">
                                    {t.label}
                                    {keywordFilter && t.formula.includes('meta_spend') && activeTabId === 'general' && (
                                        <span className="text-blue-400 text-xs ml-1">({keywordFilter})</span>
                                    )}
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

            {/* Dynamic Charts from Layout */}
            {activeLayout.graficos && activeLayout.graficos.length > 0 && (
                <MetricCharts
                    charts={activeLayout.graficos || []}
                    metrics={filteredMetrics}
                    weeks={weeks}
                    varContext={varContext}
                />
            )}

            {/* Fallback chart if no graficos defined */}
            {(!activeLayout.graficos || activeLayout.graficos.length === 0) && chartData.length > 0 && (
                <MetricCharts
                    charts={[{ id: 'default', title: 'Rendimiento (Gasto vs. Leads)', type: 'area', valueFormulas: [gastoFormula, leadsFormula], categoryColumns: ['fecha'], colors: ['amber', 'cyan'] }]}
                    metrics={filteredMetrics}
                    weeks={weeks}
                    varContext={varContext}
                />
            )}

            {/* Data Table */}
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
                                        {metaKeywords.map((kw: string) => (
                                            <Button
                                                key={kw}
                                                size="sm"
                                                variant="outline"
                                                onClick={() => setKeywordFilter(kw)}
                                                className={`h-7 text-xs ${keywordFilter.toLowerCase() === kw.toLowerCase() ? 'bg-blue-600 text-white border-transparent hover:bg-blue-700' : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}
                                            >{kw}</Button>
                                        ))}
                                    </div>
                                    <Input
                                        placeholder="Buscar campaña..."
                                        value={keywordFilter}
                                        onChange={(e) => setKeywordFilter(e.target.value)}
                                        className="h-7 text-xs w-full sm:w-44 bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-500"
                                    />
                                </>
                            ) : (
                                <div className="text-xs text-zinc-500 bg-zinc-950 px-3 py-1.5 rounded-md border border-zinc-800">
                                    Aplicando filtro estricto: <span className="font-mono text-zinc-300">"{activeTabObj.keyword_meta}"</span>
                                </div>
                            )}
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
                                        ga_sessions: 0, hotmart_pagos_iniciados: 0, ventas_principal: 0, ventas_bump: 0, ventas_upsell: 0
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
                                                const val = evaluateFormula(col.formula, raw)
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
                                                const val = aggregateFormula(col.formula, weekRows, varContext)
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
                    currentLayout={activeLayout}
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

// ─── Classic Dashboard ────────────────────────────────────────────────────────

function ClassicDashboard({ data, isPublic }: { data: any, isPublic?: boolean }) {
    const { cliente, metrics, weeks, allLayouts } = data
    const [keywordFilter, setKeywordFilter] = useState('')
    const [showModal, setShowModal] = useState(false)
    const [appliedLayout, setAppliedLayout] = useState<ReportLayout | null>(null)

    // If user applies a layout from the modal, switch to dynamic mode
    if (appliedLayout) {
        return (
            <DynamicDashboard
                data={data}
                initialLayout={appliedLayout}
                isCustomized={true}
                isPublic={isPublic}
            />
        )
    }

    const hasMeta = !!cliente.config_api?.meta_token
    const hasHotmart = !!(cliente.config_api?.hotmart_token || cliente.config_api?.hotmart_basic)
    const hasGA = !!cliente.config_api?.ga_property_id

    const metaKeywords: string[] = useMemo(() => {
        return cliente.config_api?.meta_keywords
            ? cliente.config_api.meta_keywords.split(',').map((k: string) => k.trim()).filter(Boolean)
            : []
    }, [cliente.config_api?.meta_keywords])

    const { totalGasto, totalFacturacion } = useMemo(() => {
        let gasto = 0
        let facturacion = 0

        metrics.forEach((m: any) => {
            let mSpend = 0
            if (!keywordFilter || !m.meta_campaigns) {
                mSpend = parseFloat(m.meta_spend || '0')
            } else {
                const kw = keywordFilter.toLowerCase()
                const camps = Array.isArray(m.meta_campaigns) ? m.meta_campaigns : []
                camps.forEach((c: any) => { if (c.name?.toLowerCase().includes(kw)) mSpend += parseFloat(c.spend || '0') })
            }
            gasto += mSpend
            facturacion += parseFloat(m.ventas_principal || '0') + parseFloat(m.ventas_bump || '0') + parseFloat(m.ventas_upsell || '0')
        })

        return { totalGasto: gasto, totalFacturacion: facturacion }
    }, [metrics, keywordFilter])

    const generalRoas = useMemo(() => totalGasto > 0 ? (totalFacturacion / totalGasto).toFixed(2) : '0.00', [totalGasto, totalFacturacion])
    const totalColumns = 1 + (hasMeta ? 5 : 0) + (hasGA ? 1 : 0) + (hasHotmart ? 4 : 0) + (hasMeta && hasHotmart ? 2 : 0)

    return (
        <div className="space-y-6">
            {/* Classic mode toolbar */}
            {!isPublic && (
                <div className="flex justify-end">
                    <LayoutConfigButton onClick={() => setShowModal(true)} isCustomized={false} />
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                {hasMeta && (
                    <Card className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                        <CardHeader className="pb-2">
                            <CardDescription className="text-zinc-400 font-medium">
                                Gasto Total (Meta) {keywordFilter && <span className="text-blue-400 text-xs ml-1">({keywordFilter})</span>}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="overflow-hidden">
                            <p
                                className="truncate text-2xl lg:text-3xl font-bold font-mono tracking-tight text-white"
                                title={`$${totalGasto.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                            >
                                ${totalGasto.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </p>
                        </CardContent>
                    </Card>
                )}
                {hasHotmart && (
                    <Card className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                        <CardHeader className="pb-2">
                            <CardDescription className="text-zinc-400 font-medium">Facturación (Hotmart)</CardDescription>
                        </CardHeader>
                        <CardContent className="overflow-hidden">
                            <p
                                className="truncate text-2xl lg:text-3xl font-bold font-mono tracking-tight text-emerald-400"
                                title={`$${totalFacturacion.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                            >
                                ${totalFacturacion.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </p>
                        </CardContent>
                    </Card>
                )}
                {hasMeta && hasHotmart && (
                    <>
                        <Card className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                            <CardHeader className="pb-2">
                                <CardDescription className="text-zinc-400 font-medium">ROAS Mensual</CardDescription>
                            </CardHeader>
                            <CardContent className="overflow-hidden">
                                <p
                                    className="truncate text-2xl lg:text-3xl font-bold font-mono tracking-tight text-white"
                                    title={`${generalRoas}x`}
                                >
                                    {generalRoas}x
                                </p>
                            </CardContent>
                        </Card>
                        <Card className="bg-zinc-900 border-zinc-800 hover:border-zinc-700 transition">
                            <CardHeader className="pb-2">
                                <CardDescription className="text-zinc-400 font-medium">ROI Mensual</CardDescription>
                            </CardHeader>
                            <CardContent className="overflow-hidden">
                                <p
                                    className="truncate text-2xl lg:text-3xl font-bold font-mono tracking-tight text-white"
                                    title={`${totalGasto > 0 ? (((totalFacturacion - totalGasto) / totalGasto) * 100).toFixed(1) : '0.0'}%`}
                                >
                                    {totalGasto > 0 ? (((totalFacturacion - totalGasto) / totalGasto) * 100).toFixed(1) : '0.0'}%
                                </p>
                            </CardContent>
                        </Card>
                    </>
                )}
            </div>

            <Card className="bg-zinc-900 border-zinc-800 overflow-hidden shadow-2xl">
                <CardHeader className="border-b border-zinc-800 bg-zinc-950/30">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                        <CardTitle className="text-white">Vista de Embudo Diaria — {cliente.nombre}</CardTitle>
                        {hasMeta && (
                            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                                <div className="flex flex-wrap gap-1.5">
                                    <Button size="sm" variant="outline" onClick={() => setKeywordFilter('')} className={`h-7 text-xs ${keywordFilter === '' ? 'bg-blue-600 text-white border-transparent hover:bg-blue-700' : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}>Ver Todo</Button>
                                    {metaKeywords.map((kw: string) => (
                                        <Button key={kw} size="sm" variant="outline" onClick={() => setKeywordFilter(kw)} className={`h-7 text-xs ${keywordFilter.toLowerCase() === kw.toLowerCase() ? 'bg-blue-600 text-white border-transparent hover:bg-blue-700' : 'border-zinc-700 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}>{kw}</Button>
                                    ))}
                                </div>
                                <Input placeholder="Buscar campaña..." value={keywordFilter} onChange={(e) => setKeywordFilter(e.target.value)} className="h-7 text-xs w-full sm:w-44 bg-zinc-950 border-zinc-700 text-zinc-100 placeholder:text-zinc-500" />
                            </div>
                        )}
                    </div>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto custom-scrollbar">
                    <Table className="whitespace-nowrap select-none">
                        <TableHeader>
                            <TableRow className="border-zinc-800 bg-zinc-950 *:text-zinc-300 *:font-semibold">
                                <TableHead className="w-[120px]">Fecha</TableHead>
                                {hasMeta && (<><TableHead className="text-right">Gasto</TableHead><TableHead className="text-right">Impresiones</TableHead><TableHead className="text-right">Clics</TableHead><TableHead className="text-right">CTR</TableHead><TableHead className="text-right">CPC</TableHead></>)}
                                {hasGA && <TableHead className="text-right">Visitas GA4</TableHead>}
                                {hasHotmart && (<><TableHead className="text-right">Checkouts</TableHead><TableHead className="text-right">V. Principal</TableHead><TableHead className="text-right">V. Bump</TableHead><TableHead className="text-right">V. Upsell</TableHead></>)}
                                {hasMeta && hasHotmart && (<><TableHead className="text-right font-bold text-white">ROAS</TableHead><TableHead className="text-right font-bold text-white">ROI</TableHead></>)}
                            </TableRow>
                        </TableHeader>
                        <TableBody className="text-sm">
                            {weeks.map((week: any, wIndex: number) => {
                                let currentDate = parseISO(week.start)
                                const endDate = parseISO(week.end)
                                const daysInWeek: React.ReactNode[] = []
                                let wSpend = 0, wImpr = 0, wClicks = 0, wGa = 0, wCheck = 0, wPrin = 0, wBump = 0, wUp = 0

                                while (currentDate.getTime() <= endDate.getTime()) {
                                    const dayStr = format(currentDate, 'yyyy-MM-dd')
                                    const dm = metrics.find((m: any) => m.fecha === dayStr) || { meta_spend: 0, meta_impressions: 0, meta_clicks: 0, meta_campaigns: [], ga_sessions: 0, hotmart_pagos_iniciados: 0, ventas_principal: 0, ventas_bump: 0, ventas_upsell: 0 }

                                    let spend = 0, impr = 0, clicks = 0
                                    if (!keywordFilter || !dm.meta_campaigns) {
                                        spend = parseFloat(dm.meta_spend || '0')
                                        impr = parseInt(dm.meta_impressions || '0')
                                        clicks = parseInt(dm.meta_clicks || '0')
                                    } else {
                                        const kw = keywordFilter.toLowerCase()
                                            ; (Array.isArray(dm.meta_campaigns) ? dm.meta_campaigns : []).forEach((c: any) => {
                                                if (c.name?.toLowerCase().includes(kw)) {
                                                    spend += parseFloat(c.spend || '0')
                                                    impr += parseInt(c.impressions || '0')
                                                    clicks += parseInt(c.clicks || '0')
                                                }
                                            })
                                    }

                                    const ga = parseInt(dm.ga_sessions || '0')
                                    const check = parseInt(dm.hotmart_pagos_iniciados || '0')
                                    const prin = parseFloat(dm.ventas_principal || '0')
                                    const bump = parseFloat(dm.ventas_bump || '0')
                                    const up = parseFloat(dm.ventas_upsell || '0')
                                    wSpend += spend; wImpr += impr; wClicks += clicks; wGa += ga; wCheck += check; wPrin += prin; wBump += bump; wUp += up

                                    const totalD = prin + bump + up
                                    const roasD = spend > 0 ? (totalD / spend).toFixed(2) : '-'
                                    const roiD = spend > 0 ? (((totalD - spend) / spend) * 100).toFixed(1) + '%' : '-'
                                    const ctrD = impr > 0 ? ((clicks / impr) * 100).toFixed(2) + '%' : '-'
                                    const cpcD = clicks > 0 ? (spend / clicks).toFixed(2) : '-'
                                    const isWeekend = getDay(currentDate) === 0 || getDay(currentDate) === 6

                                    daysInWeek.push(
                                        <TableRow key={dayStr} className={`border-zinc-800/60 ${isWeekend ? 'bg-zinc-950/60 text-zinc-600' : 'text-zinc-200'} hover:bg-zinc-800/70 transition-colors`}>
                                            <TableCell className="font-mono text-xs">{format(currentDate, 'dd MMM (EEE)', { locale: es })}</TableCell>
                                            {hasMeta && (<><TableCell className="text-right">${spend.toLocaleString('en-US', { minimumFractionDigits: 2 })}</TableCell><TableCell className="text-right">{impr.toLocaleString()}</TableCell><TableCell className="text-right">{clicks.toLocaleString()}</TableCell><TableCell className="text-right">{ctrD}</TableCell><TableCell className="text-right">${cpcD}</TableCell></>)}
                                            {hasGA && <TableCell className="text-right">{ga.toLocaleString()}</TableCell>}
                                            {hasHotmart && (<><TableCell className="text-right">{check.toLocaleString()}</TableCell><TableCell className="text-right">${prin.toLocaleString('en-US')}</TableCell><TableCell className="text-right">${bump.toLocaleString('en-US')}</TableCell><TableCell className="text-right">${up.toLocaleString('en-US')}</TableCell></>)}
                                            {hasMeta && hasHotmart && (<><TableCell className={`text-right font-medium ${parseFloat(roasD) > 1 ? 'text-emerald-500' : ''}`}>{roasD}</TableCell><TableCell className="text-right">{roiD}</TableCell></>)}
                                        </TableRow>
                                    )
                                    currentDate = addDays(currentDate, 1)
                                }

                                const totalW = wPrin + wBump + wUp
                                const roasW = wSpend > 0 ? (totalW / wSpend).toFixed(2) : '-'
                                const roiW = wSpend > 0 ? (((totalW - wSpend) / wSpend) * 100).toFixed(1) + '%' : '-'
                                const ctrW = wImpr > 0 ? ((wClicks / wImpr) * 100).toFixed(2) + '%' : '-'
                                const cpcW = wClicks > 0 ? (wSpend / wClicks).toFixed(2) : '-'

                                return (
                                    <React.Fragment key={`week-${wIndex}`}>
                                        {daysInWeek}
                                        <TableRow className="border-t-2 border-zinc-600 bg-zinc-900/80 font-semibold *:text-white">
                                            <TableCell className="text-blue-300">Total Sem {week.weekNumber}</TableCell>
                                            {hasMeta && (<><TableCell className="text-right">${wSpend.toLocaleString('en-US', { minimumFractionDigits: 2 })}</TableCell><TableCell className="text-right">{wImpr.toLocaleString()}</TableCell><TableCell className="text-right">{wClicks.toLocaleString()}</TableCell><TableCell className="text-right">{ctrW}</TableCell><TableCell className="text-right text-zinc-400 font-normal">${cpcW}</TableCell></>)}
                                            {hasGA && <TableCell className="text-right">{wGa.toLocaleString()}</TableCell>}
                                            {hasHotmart && (<><TableCell className="text-right">{wCheck.toLocaleString()}</TableCell><TableCell className="text-right">${wPrin.toLocaleString('en-US')}</TableCell><TableCell className="text-right">${wBump.toLocaleString('en-US')}</TableCell><TableCell className="text-right">${wUp.toLocaleString('en-US')}</TableCell></>)}
                                            {hasMeta && hasHotmart && (<><TableCell className={`text-right ${parseFloat(roasW) >= 1 ? 'text-emerald-400' : 'text-red-400'}`}>{roasW}x</TableCell><TableCell className={`text-right ${roiW.startsWith('-') || roiW === '-' ? 'text-red-400' : 'text-emerald-400'}`}>{roiW}</TableCell></>)}
                                        </TableRow>
                                    </React.Fragment>
                                )
                            })}
                            {weeks.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={totalColumns} className="text-center p-8 text-zinc-500">
                                        No hay datos reportados para este rango.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>

            {showModal && (
                <LayoutConfigModal
                    clienteId={cliente.id}
                    currentLayout={null}
                    allLayouts={allLayouts || []}
                    isCustomized={false}
                    onClose={() => setShowModal(false)}
                    onLayoutApplied={(newLayout) => {
                        if (newLayout) setAppliedLayout(newLayout)
                        setShowModal(false)
                    }}
                />
            )}
        </div>
    )
}

// ─── Executive Public Dashboard ────────────────────────────────────────────────

function ExecutiveDashboard({ data, layout }: { data: any, layout: { tarjetas: CardDef[], graficos: ChartDef[] } }) {
    const { metrics, weeks } = data

    const filteredMetrics = useMemo(() => {
        return metrics.map((m: any) => enrichMetaRow(m, ''))
    }, [metrics])

    const varContext = useMemo(() => ({}), [])

    const tarjetaValues = useMemo(() => {
        return (layout.tarjetas || []).map((t: CardDef) => ({
            ...t,
            value: aggregateFormula(t.formula, filteredMetrics, varContext),
        }))
    }, [layout.tarjetas, filteredMetrics, varContext])

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
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
            
            {tarjetaValues.length === 0 && (!layout.graficos || layout.graficos.length === 0) && (
                <div className="flex flex-col items-center justify-center p-12 text-center text-zinc-500">
                    <p>No hay tarjetas ni gráficos configurados para este reporte.</p>
                </div>
            )}
        </div>
    )
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export function DashboardClient({ data, isPublic = false }: { data: any, isPublic?: boolean }) {
    const { cliente, layout, clienteLayoutId, layoutPublico } = data

    if (!cliente) {
        return (
            <div className="flex flex-col items-center justify-center p-12 text-center text-zinc-400">
                <p>No tienes ningún cliente asignado para visualizar métricas.</p>
            </div>
        )
    }

    if (isPublic) {
        if (!layoutPublico || (!layoutPublico.tarjetas?.length && !layoutPublico.graficos?.length)) {
            return (
                <div className="flex flex-col items-center justify-center p-16 text-center border-2 border-dashed border-zinc-800 rounded-2xl bg-zinc-900/30">
                    <span className="text-4xl mb-4">🚧</span>
                    <h3 className="text-xl font-semibold text-white mb-2">Reporte no configurado</h3>
                    <p className="text-zinc-400 max-w-md">El administrador de la cuenta aún no ha asignado las métricas y gráficos para esta vista pública.</p>
                </div>
            )
        }
        return <ExecutiveDashboard data={data} layout={layoutPublico} />
    }

    // Has a layout (client-specific takes priority, then global assigned)
    if (layout && Array.isArray(layout.columnas) && layout.columnas.length > 0) {
        return (
            <DynamicDashboard
                data={data}
                initialLayout={layout}
                isCustomized={!!clienteLayoutId}
                isPublic={false}
            />
        )
    }

    // Fallback: classic view with Configurar Layout button
    return <ClassicDashboard data={data} isPublic={false} />
}
