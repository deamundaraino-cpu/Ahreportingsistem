# Tab Archive Per-Tab Date Ranges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the tab archive view so metrics use each tab's own date range, and add inline editable date inputs per tab for comparison overrides.

**Architecture:** A new server action `getArchiveMetrics` loads all historical metrics on archive mount. `TabArchiveView` replaces the static date text with inline inputs, stores overrides in local state, and passes them to `computeCardValue`. `DashboardClient` passes `clientId` to `TabArchiveView`.

**Tech Stack:** Next.js 14 App Router, React (useState, useEffect, useMemo), Supabase, Tailwind CSS.

---

## Files

- Modify: `src/app/(app)/dashboard/_actions.ts` — add `getArchiveMetrics`
- Modify: `src/app/(app)/dashboard/components/TabArchiveView.tsx` — full update
- Modify: `src/app/(app)/dashboard/components/DashboardClient.tsx` — pass `clientId` prop

---

## Task 1: Add `getArchiveMetrics` server action

**Files:**
- Modify: `src/app/(app)/dashboard/_actions.ts`

### Context

This file already has `getDashboardData` which fetches metrics with date bounds. We need a slimmer version with no date filter. Add the new function at the end of the file (before the closing of the module, after `getOrCreatePublicToken`). The leads merge logic is identical to `getDashboardData` lines 123-136.

- [ ] **Step 1: Add `getArchiveMetrics` at the end of `_actions.ts`**

Append after the last export in the file:

```typescript
export async function getArchiveMetrics(clientId: string) {
    const supabase = await createAdminClient()

    const [metricsRes, leadsRes] = await Promise.all([
        supabase.from('metricas_diarias')
            .select('*')
            .eq('cliente_id', clientId)
            .order('fecha', { ascending: true }),
        supabase.from('leads_diarios')
            .select('*')
            .eq('client_id', clientId),
    ])

    if (metricsRes.error) return null

    const leadsMap = new Map((leadsRes.data || []).map((l: any) => [l.date, l]))
    const metrics = (metricsRes.data || []).map((m: any) => {
        const leadDay = leadsMap.get(m.fecha)
        if (leadDay) {
            return {
                ...m,
                leads_totales: leadDay.leads_totales,
                leads_calificados: leadDay.leads_calificados,
                leads_no_calificados: leadDay.leads_no_calificados,
                tasa_calificacion: leadDay.tasa_calificacion,
            }
        }
        return m
    })

    return { metrics }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/dashboard/_actions.ts"
git commit -m "feat: add getArchiveMetrics server action for full historical data"
```

---

## Task 2: Update `TabArchiveView.tsx`

**Files:**
- Modify: `src/app/(app)/dashboard/components/TabArchiveView.tsx`

### Context

The full current file is 251 lines. Key changes:
- `computeCardValue` gets a 5th optional param `dateOverride?: { from: string; to: string }` — used instead of `tab.fecha_inicio`/`tab.fecha_finalizacion` when present.
- New state: `archiveMetrics` (initialized from `metrics` prop), `isLoadingArchive`, `tabDateOverrides`.
- `useEffect` on mount calls `getArchiveMetrics(clientId)` and replaces `archiveMetrics`.
- Static date `<p>` at lines 148-152 replaced with two inline `<input type="date">`.
- `computeCardValue` calls in right panel use `archiveMetrics` and `tabDateOverrides[tab.id]`.
- New prop: `clientId: string`.
- New import: `useEffect` from React, `Loader2` from lucide-react, `getArchiveMetrics` from `'../_actions'`.

- [ ] **Step 1: Replace the entire file with the updated version**

```typescript
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
    const [tabDateOverrides, setTabDateOverrides] = useState<Record<string, { from: string; to: string }>>({})

    useEffect(() => {
        setIsLoadingArchive(true)
        getArchiveMetrics(clientId).then(result => {
            if (result?.metrics) setArchiveMetrics(result.metrics)
        }).finally(() => setIsLoadingArchive(false))
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
                            <div className="flex items-center gap-3">
                                <p className="text-xs text-zinc-500 uppercase tracking-wider font-medium">Vista Comparativa</p>
                                {isLoadingArchive && (
                                    <span className="flex items-center gap-1.5 text-xs text-zinc-600">
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        Cargando historial completo…
                                    </span>
                                )}
                            </div>
                            {groupedSelected.map(group => {
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
```

- [ ] **Step 2: Commit (TypeScript check runs in Task 3 after DashboardClient is updated)**

```bash
git add "src/app/(app)/dashboard/components/TabArchiveView.tsx"
git commit -m "feat: add per-tab date overrides and historical metrics loading in TabArchiveView"
```

---

## Task 3: Pass `clientId` to `TabArchiveView` in `DashboardClient.tsx`

**Files:**
- Modify: `src/app/(app)/dashboard/components/DashboardClient.tsx`

### Context

`DashboardClient.tsx` renders `<TabArchiveView>` at around line 731. It has access to `cliente.id`. Just add the `clientId` prop.

- [ ] **Step 1: Add `clientId` prop to the `<TabArchiveView>` invocation**

Find this block (around line 731):
```typescript
        <TabArchiveView
            tabs={tabs}
            metrics={metrics}
            campaignGroups={data.campaignGroups || []}
            allLayouts={allLayouts || []}
            initialLayout={initialLayout}
            onClose={() => setShowArchive(false)}
            onToggleArchived={handleToggleArchived}
            isTeam={isTeam}
        />
```

Replace with:
```typescript
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
```

- [ ] **Step 2: Verify TypeScript compiles with no errors**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npx tsc --noEmit 2>&1 | grep -v node_modules | head -20
```

Expected: no errors.

- [ ] **Step 3: Run dev server and test manually**

```bash
npm run dev
```

Open `http://localhost:3001/dashboard/<client-id>`, click the archive button (🗂), and verify:

1. Archive view opens and shows "Cargando historial completo…" briefly in the right panel.
2. Each tab has two date inputs (pre-filled with `fecha_inicio`/`fecha_finalizacion` if configured, empty if not).
3. Expand a tab, check a metric card. The right panel shows the value calculated from the full historical range filtered to the tab's dates.
4. Change the "from" or "to" date input for a tab — the metric card value updates immediately.
5. Tabs without configured dates show empty inputs and use all historical data.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/dashboard/components/DashboardClient.tsx"
git commit -m "feat: pass clientId to TabArchiveView for historical metrics loading"
```
