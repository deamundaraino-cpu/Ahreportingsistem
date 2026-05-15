'use client'

import React, { useState, useMemo, useEffect } from 'react'
import { ArrowLeft, Eye, EyeOff, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import { enrichMetaRow } from '@/lib/campaign-filter'
import { aggregateFormula, formatValue } from '@/lib/formula-engine'
import type { CardDef } from '@/lib/layout-types'
import { getArchiveMetrics } from '../_actions'

type SelectedCard = {
    tabId: string
    tabName: string
    card: CardDef
}

function resolveTabCards(tab: any, allLayouts: any[], initialLayout: any): CardDef[] {
    if (tab.tarjetas && tab.tarjetas.length > 0) return tab.tarjetas
    if (tab.plantilla_id) {
        const found = allLayouts.find((l: any) => l.id === tab.plantilla_id)
        if (found) return found.tarjetas || []
    }
    return initialLayout?.tarjetas || []
}

function computeCardValue(
    card: CardDef,
    tab: any,
    metrics: any[],
    campaignGroups: any[],
    dateOverride?: { from: string; to: string }
): number | null {
    let rows = metrics
    const from = dateOverride?.from || tab.fecha_inicio
    const to = dateOverride?.to || tab.fecha_finalizacion
    if (from) rows = rows.filter((m: any) => m.fecha >= from)
    if (to) rows = rows.filter((m: any) => m.fecha <= to)
    const keyword = card.campaignFilter?.value ?? tab.keyword_meta ?? ''
    rows = rows.map((r: any) => enrichMetaRow(r, keyword, campaignGroups))
    return aggregateFormula(card.formula, rows, {}, {}, new Set(['meta']), {})
}

export function TabArchiveView({
    tabs,
    metrics,
    campaignGroups,
    allLayouts,
    initialLayout,
    clientId,
    onClose,
    onToggleArchived,
    isTeam,
}: {
    tabs: any[]
    metrics: any[]
    campaignGroups: any[]
    allLayouts: any[]
    initialLayout: any
    clientId: string
    onClose: () => void
    onToggleArchived: (tabId: string, archived: boolean) => Promise<void>
    isTeam: boolean
}) {
    const [expandedTabIds, setExpandedTabIds] = useState<Set<string>>(new Set())
    const [selectedCards, setSelectedCards] = useState<SelectedCard[]>([])
    const [togglingId, setTogglingId] = useState<string | null>(null)
    const [archiveMetrics, setArchiveMetrics] = useState<any[]>(metrics)
    const [isLoadingArchive, setIsLoadingArchive] = useState(true)
    const [archiveError, setArchiveError] = useState(false)
    const [tabDateOverrides, setTabDateOverrides] = useState<Record<string, { from: string; to: string }>>({})

    useEffect(() => {
        setIsLoadingArchive(true)
        setArchiveError(false)
        getArchiveMetrics(clientId)
            .then(result => {
                if (result?.metrics) setArchiveMetrics(result.metrics)
                else setArchiveError(true)
            })
            .catch(() => setArchiveError(true))
            .finally(() => setIsLoadingArchive(false))
    }, [clientId])

    function toggleExpand(tabId: string) {
        setExpandedTabIds(prev => {
            const next = new Set(prev)
            if (next.has(tabId)) next.delete(tabId)
            else next.add(tabId)
            return next
        })
    }

    function isCardSelected(tabId: string, cardId: string) {
        return selectedCards.some(s => s.tabId === tabId && s.card.id === cardId)
    }

    function toggleCard(tab: any, card: CardDef) {
        setSelectedCards(prev => {
            if (prev.some(s => s.tabId === tab.id && s.card.id === card.id)) {
                return prev.filter(s => !(s.tabId === tab.id && s.card.id === card.id))
            }
            return [...prev, { tabId: tab.id, tabName: tab.nombre, card }]
        })
    }

    async function handleToggle(tab: any) {
        setTogglingId(tab.id)
        await onToggleArchived(tab.id, !tab.archived)
        setTogglingId(null)
    }

    function setTabOverride(tabId: string, field: 'from' | 'to', value: string, tab: any) {
        setTabDateOverrides(prev => ({
            ...prev,
            [tabId]: {
                from: field === 'from' ? value : (prev[tabId]?.from ?? tab.fecha_inicio ?? ''),
                to: field === 'to' ? value : (prev[tabId]?.to ?? tab.fecha_finalizacion ?? ''),
            }
        }))
    }

    const groupedSelected = useMemo(() => {
        const groups: { tabId: string; tabName: string; cards: SelectedCard[] }[] = []
        for (const sel of selectedCards) {
            const existing = groups.find(g => g.tabId === sel.tabId)
            if (existing) existing.cards.push(sel)
            else groups.push({ tabId: sel.tabId, tabName: sel.tabName, cards: [sel] })
        }
        return groups
    }, [selectedCards])

    const sortedTabs = [...tabs].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))

    return (
        <div className="min-h-screen bg-zinc-950">
            {/* Header */}
            <div className="flex items-center gap-4 px-6 py-4 border-b border-zinc-800 bg-zinc-900/60">
                <button
                    onClick={onClose}
                    className="flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition"
                >
                    <ArrowLeft className="w-4 h-4" />
                    Volver al Dashboard
                </button>
                <div className="h-4 w-px bg-zinc-700" />
                <h1 className="text-sm font-semibold text-white">🗂 Archivo de Pestañas</h1>
                <span className="text-xs text-zinc-500">{tabs.filter(t => t.archived).length} ocultas · {tabs.filter(t => !t.archived).length} visibles</span>
            </div>

            {/* Body */}
            <div className="flex h-[calc(100vh-65px)]">
                {/* Left column — tab list */}
                <div className="w-[40%] border-r border-zinc-800 overflow-y-auto custom-scrollbar p-4 space-y-2">
                    <p className="text-xs text-zinc-500 mb-3 uppercase tracking-wider font-medium">Todas las pestañas</p>
                    {sortedTabs.map(tab => {
                        const cards = resolveTabCards(tab, allLayouts, initialLayout)
                        const expanded = expandedTabIds.has(tab.id)
                        const override = tabDateOverrides[tab.id]
                        return (
                            <div key={tab.id} className={`rounded-lg border transition ${tab.archived ? 'border-zinc-800 opacity-60' : 'border-zinc-700'} bg-zinc-900`}>
                                {/* Tab header row */}
                                <div className="flex items-center gap-2 px-3 py-2.5">
                                    <button
                                        onClick={() => toggleExpand(tab.id)}
                                        className="text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
                                    >
                                        {expanded
                                            ? <ChevronDown className="w-4 h-4" />
                                            : <ChevronRight className="w-4 h-4" />}
                                    </button>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="text-sm font-medium text-zinc-200 truncate">{tab.nombre}</span>
                                            {tab.keyword_meta && (
                                                <span className="text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-400 font-mono">{tab.keyword_meta}</span>
                                            )}
                                            {tab.archived && (
                                                <span className="text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-500">oculta</span>
                                            )}
                                        </div>
                                        {/* Inline date overrides */}
                                        <div className="flex items-center gap-1 mt-1">
                                            <input
                                                type="date"
                                                value={override?.from ?? tab.fecha_inicio ?? ''}
                                                onChange={e => setTabOverride(tab.id, 'from', e.target.value, tab)}
                                                className="text-[10px] bg-zinc-800 text-zinc-400 border-none rounded px-1 py-0.5 w-[100px] cursor-pointer"
                                            />
                                            <span className="text-[10px] text-zinc-600">→</span>
                                            <input
                                                type="date"
                                                value={override?.to ?? tab.fecha_finalizacion ?? ''}
                                                onChange={e => setTabOverride(tab.id, 'to', e.target.value, tab)}
                                                className="text-[10px] bg-zinc-800 text-zinc-400 border-none rounded px-1 py-0.5 w-[100px] cursor-pointer"
                                            />
                                        </div>
                                    </div>

                                    {isTeam && (
                                        <button
                                            onClick={() => handleToggle(tab)}
                                            disabled={togglingId === tab.id}
                                            title={tab.archived ? 'Mostrar en barra' : 'Ocultar de barra'}
                                            className="flex-shrink-0 text-zinc-500 hover:text-zinc-200 transition disabled:opacity-40"
                                        >
                                            {tab.archived
                                                ? <EyeOff className="w-4 h-4" />
                                                : <Eye className="w-4 h-4" />}
                                        </button>
                                    )}
                                </div>

                                {/* Card checkboxes */}
                                {expanded && (
                                    <div className="border-t border-zinc-800 px-3 py-2 space-y-1">
                                        {cards.length === 0 ? (
                                            <p className="text-xs text-zinc-600 py-1">No hay tarjetas configuradas en esta pestaña.</p>
                                        ) : (
                                            cards.map((card: CardDef) => (
                                                <label key={card.id} className="flex items-center gap-2 cursor-pointer group">
                                                    <input
                                                        type="checkbox"
                                                        checked={isCardSelected(tab.id, card.id)}
                                                        onChange={() => toggleCard(tab, card)}
                                                        className="w-3.5 h-3.5 accent-indigo-500 cursor-pointer"
                                                    />
                                                    <span className="text-xs text-zinc-400 group-hover:text-zinc-200 transition">{card.label}</span>
                                                    {(card.prefix || card.suffix) && (
                                                        <span className="text-[10px] text-zinc-600 font-mono">{card.prefix}{card.suffix}</span>
                                                    )}
                                                </label>
                                            ))
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>

                {/* Right column — comparative panel */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
                    {selectedCards.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-center">
                            <div className="text-4xl mb-4">📊</div>
                            <p className="text-sm text-zinc-500 max-w-xs">Expande una pestaña a la izquierda y selecciona las tarjetas que quieres comparar.</p>
                        </div>
                    ) : (
                        <div className="space-y-8">
                            <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Vista Comparativa</p>
                            {isLoadingArchive ? (
                                <div className="flex items-center gap-2 text-sm text-zinc-600">
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                    Cargando historial completo…
                                </div>
                            ) : archiveError ? (
                                <div className="text-xs text-amber-600">No se pudo cargar el historial completo. Mostrando datos del período seleccionado.</div>
                            ) : groupedSelected.map(group => {
                                const tab = tabs.find(t => t.id === group.tabId)
                                return (
                                    <div key={group.tabId}>
                                        <p className="text-xs font-semibold text-indigo-400 mb-3 flex items-center gap-1.5">
                                            📌 {group.tabName}
                                            {tab?.keyword_meta && (
                                                <span className="font-mono text-zinc-500">{tab.keyword_meta}</span>
                                            )}
                                        </p>
                                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                            {group.cards.map(sel => {
                                                const value = tab
                                                    ? computeCardValue(
                                                        sel.card,
                                                        tab,
                                                        archiveMetrics,
                                                        campaignGroups,
                                                        tabDateOverrides[tab.id]
                                                    )
                                                    : null
                                                const formatted = formatValue(value, {
                                                    prefix: sel.card.prefix,
                                                    suffix: sel.card.suffix,
                                                    decimals: sel.card.decimals,
                                                })
                                                return (
                                                    <div key={sel.card.id} className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 relative">
                                                        <button
                                                            onClick={() => toggleCard(tab, sel.card)}
                                                            className="absolute top-2 right-2 text-zinc-700 hover:text-red-400 transition"
                                                            title="Quitar"
                                                        >
                                                            ×
                                                        </button>
                                                        <p className="text-[11px] text-zinc-500 mb-1">{sel.card.label}</p>
                                                        <p className="text-xl font-bold text-white font-mono">{formatted}</p>
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
