# Tab Archive & Comparative Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tab archive system that lets the Ads House team hide tabs from the main nav bar, and a comparative view where they can select metric cards from multiple tabs and see them side-by-side.

**Architecture:** A new `archived` boolean column on `cliente_tabs` drives tab visibility. A 🗂 button (team-only) in the tab bar opens `TabArchiveView` — a full-screen replacement component rendered from `DashboardClient` state. Card values in the comparative panel are computed client-side from already-loaded `metrics` data using the existing `enrichMetaRow` + `aggregateFormula` functions.

**Tech Stack:** Next.js 14 App Router, Supabase, React `useState`/`useMemo`, `enrichMetaRow` from `@/lib/campaign-filter`, `aggregateFormula` + `formatValue` from `@/lib/formula-engine`, Tailwind CSS, lucide-react.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `migrations/015_tab_archived.sql` | Create | Add `archived boolean DEFAULT false` to `cliente_tabs` |
| `src/app/(app)/dashboard/_actions.ts` | Modify | Add `toggleTabArchived` server action |
| `src/app/(app)/dashboard/components/TabArchiveView.tsx` | Create | Full archive + comparative UI component |
| `src/app/(app)/dashboard/components/DashboardClient.tsx` | Modify | Filter tab bar, add 🗂 button, wire `showArchive` state |

---

## Task 1: Database Migration

**Files:**
- Create: `migrations/015_tab_archived.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Migration 015: Add archived column to cliente_tabs
-- Archived tabs are hidden from the main tab bar but accessible via the archive view.

ALTER TABLE public.cliente_tabs
ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Run the migration in Supabase**

Go to the Supabase dashboard → SQL Editor → paste the migration → Run.

Verify with:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'cliente_tabs' AND column_name = 'archived';
```
Expected: one row with `data_type = boolean`, `column_default = false`.

- [ ] **Step 3: Commit**

```bash
git add migrations/015_tab_archived.sql
git commit -m "feat(db): add archived column to cliente_tabs"
```

---

## Task 2: Server Action `toggleTabArchived`

**Files:**
- Modify: `src/app/(app)/dashboard/_actions.ts` (add after `deleteClienteTab` around line 298)

- [ ] **Step 1: Add the action**

Open `src/app/(app)/dashboard/_actions.ts`. After the `deleteClienteTab` function (around line 298), insert:

```typescript
export async function toggleTabArchived(clienteId: string, tabId: string, archived: boolean) {
    const supabase = await createAdminClient()
    const { error } = await supabase
        .from('cliente_tabs')
        .update({ archived })
        .eq('id', tabId)
        .eq('cliente_id', clienteId)
    if (error) return { error: error.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}
```

- [ ] **Step 2: Verify types**

```bash
npm run type-check
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/dashboard/_actions.ts
git commit -m "feat: add toggleTabArchived server action"
```

---

## Task 3: `TabArchiveView` Component

**Files:**
- Create: `src/app/(app)/dashboard/components/TabArchiveView.tsx`

This component renders two columns:
- Left (40%): all tabs with eye toggle + expand to select cards
- Right (60%): comparative panel with selected cards and their origin labels

- [ ] **Step 1: Create the file with complete implementation**

```typescript
'use client'

import React, { useState, useMemo } from 'react'
import { ArrowLeft, Eye, EyeOff, ChevronDown, ChevronRight } from 'lucide-react'
import { enrichMetaRow } from '@/lib/campaign-filter'
import { aggregateFormula, formatValue } from '@/lib/formula-engine'
import type { CardDef } from '@/lib/layout-types'

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
    campaignGroups: any[]
): number | null {
    let rows = metrics
    if (tab.fecha_inicio) rows = rows.filter((m: any) => m.fecha >= tab.fecha_inicio)
    if (tab.fecha_finalizacion) rows = rows.filter((m: any) => m.fecha <= tab.fecha_finalizacion)
    const keyword = card.campaignFilter?.value ?? tab.keyword_meta ?? ''
    rows = rows.map((r: any) => enrichMetaRow(r, keyword, campaignGroups))
    return aggregateFormula(card.formula, rows, {}, {}, new Set(['meta']), [])
}

export function TabArchiveView({
    tabs,
    metrics,
    campaignGroups,
    allLayouts,
    initialLayout,
    onClose,
    onToggleArchived,
    isTeam,
}: {
    tabs: any[]
    metrics: any[]
    campaignGroups: any[]
    allLayouts: any[]
    initialLayout: any
    onClose: () => void
    onToggleArchived: (tabId: string, archived: boolean) => Promise<void>
    isTeam: boolean
}) {
    const [expandedTabIds, setExpandedTabIds] = useState<Set<string>>(new Set())
    const [selectedCards, setSelectedCards] = useState<SelectedCard[]>([])
    const [togglingId, setTogglingId] = useState<string | null>(null)

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

    // Group selected cards by tab for the right panel
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
                        return (
                            <div key={tab.id} className={`rounded-lg border transition ${tab.archived ? 'border-zinc-800 opacity-60' : 'border-zinc-700'} bg-zinc-900`}>
                                {/* Tab header row */}
                                <div className="flex items-center gap-2 px-3 py-2.5">
                                    {/* Expand toggle */}
                                    <button
                                        onClick={() => toggleExpand(tab.id)}
                                        className="text-zinc-500 hover:text-zinc-300 transition flex-shrink-0"
                                    >
                                        {expanded
                                            ? <ChevronDown className="w-4 h-4" />
                                            : <ChevronRight className="w-4 h-4" />}
                                    </button>

                                    {/* Tab info */}
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
                                        {(tab.fecha_inicio || tab.fecha_finalizacion) && (
                                            <p className="text-[10px] text-zinc-600 mt-0.5">
                                                {tab.fecha_inicio ?? '—'} → {tab.fecha_finalizacion ?? '—'}
                                            </p>
                                        )}
                                    </div>

                                    {/* Visibility toggle (team only) */}
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
                                                    {card.prefix || card.suffix ? (
                                                        <span className="text-[10px] text-zinc-600 font-mono">{card.prefix}{card.suffix}</span>
                                                    ) : null}
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
                                                    ? computeCardValue(sel.card, tab, metrics, campaignGroups)
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

- [ ] **Step 2: Verify types**

```bash
npm run type-check
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/dashboard/components/TabArchiveView.tsx
git commit -m "feat: add TabArchiveView component with archive list and comparative panel"
```

---

## Task 4: Wire `TabArchiveView` into `DashboardClient`

**Files:**
- Modify: `src/app/(app)/dashboard/components/DashboardClient.tsx`

Four changes needed:
1. Add imports
2. Add `showArchive` state + `isTeam` + `handleToggleArchived`
3. Filter tab bar to only show non-archived tabs
4. Add 🗂 archive button to tab bar
5. Conditional render of `TabArchiveView`

- [ ] **Step 1: Add imports**

In `src/app/(app)/dashboard/components/DashboardClient.tsx`, find the import line:

```typescript
import { updateManualMetric, getTabTotalSpend, saveClienteLayout, saveTabOverrides, updateLayoutPuzzleState } from '../_actions'
```

Replace with:

```typescript
import { updateManualMetric, getTabTotalSpend, saveClienteLayout, saveTabOverrides, updateLayoutPuzzleState, toggleTabArchived } from '../_actions'
```

Find the lucide-react import line:

```typescript
import { LayoutDashboard, Settings2, Plus, Edit2, CalendarDays, Timer, BadgeDollarSign, Wallet, GripVertical, Search, X, Puzzle, Type, AlignLeft, AlignCenter, AlignRight, Trash2, Save, Loader2, Minus } from 'lucide-react'
```

Replace with:

```typescript
import { LayoutDashboard, Settings2, Plus, Edit2, CalendarDays, Timer, BadgeDollarSign, Wallet, GripVertical, Search, X, Puzzle, Type, AlignLeft, AlignCenter, AlignRight, Trash2, Save, Loader2, Minus, Archive } from 'lucide-react'
```

Add the `TabArchiveView` import after the existing component imports:

```typescript
import { TabArchiveView } from './TabArchiveView'
```

- [ ] **Step 2: Add state and handlers**

Inside `DynamicDashboard`, after the existing state declarations (around the `showModal` / `showTabModal` block, near line 282), add:

```typescript
const [showArchive, setShowArchive] = useState(false)
const isTeam = ['superadmin', 'admin', 'trafficker'].includes(userRole ?? '')

const handleToggleArchived = useCallback(async (tabId: string, archived: boolean) => {
    setSortedTabs(prev => prev.map((t: any) => t.id === tabId ? { ...t, archived } : t))
    await toggleTabArchived(cliente.id, tabId, archived)
}, [cliente.id])
```

- [ ] **Step 3: Add `visibleTabs` derived variable**

Right after `const tabs = sortedTabs` (around line 279), add:

```typescript
const visibleTabs = tabs.filter((t: any) => !t.archived)
const archivedCount = tabs.filter((t: any) => t.archived).length
```

- [ ] **Step 4: Replace `tabs` with `visibleTabs` in the tab bar**

In the non-public tab bar section (starting around line 750), find the two places where `tabs` is used to render tab buttons and replace with `visibleTabs`:

**Static render (no dnd, `!isMounted`):**
```typescript
// Before:
{!isMounted ? (
    tabs.map((tab: any) => (

// After:
{!isMounted ? (
    visibleTabs.map((tab: any) => (
```

**DnD render (`SortableContext`):**
```typescript
// Before:
<SortableContext items={tabs.map((t: any) => t.id)} strategy={horizontalListSortingStrategy}>
    {tabs.map((tab: any) => (

// After:
<SortableContext items={visibleTabs.map((t: any) => t.id)} strategy={horizontalListSortingStrategy}>
    {visibleTabs.map((tab: any) => (
```

**Public tab bar** (around line 724):
```typescript
// Before:
{tabs.map((tab: any) => (

// After:
{visibleTabs.map((tab: any) => (
```

- [ ] **Step 5: Add 🗂 archive button to the tab bar**

Find the "Nueva Pestaña" button block (around line 789):

```typescript
{!isPublic && (
    <button
        onClick={() => { setTabToEdit(null); setShowTabModal(true); }}
        className="ml-2 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 rounded flex items-center gap-1 transition"
    >
        <Plus className="w-3.5 h-3.5" />
        Nueva Pestaña
    </button>
)}
```

Add the archive button directly after the closing `)}` of that block, before the Reporte Mensual button:

```typescript
{isTeam && (
    <button
        onClick={() => setShowArchive(true)}
        title="Archivo de pestañas"
        className="ml-1 px-2.5 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-900 border border-zinc-700 hover:border-zinc-500 rounded flex items-center gap-1.5 transition relative"
    >
        <Archive className="w-3.5 h-3.5" />
        {archivedCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 text-[9px] bg-indigo-500 text-white rounded-full w-4 h-4 flex items-center justify-center font-bold">
                {archivedCount}
            </span>
        )}
    </button>
)}
```

- [ ] **Step 6: Add conditional render of `TabArchiveView`**

At the very top of the `return (...)` statement inside `DynamicDashboard`, before the opening `<div className="space-y-6">`, add:

```typescript
if (showArchive) {
    return (
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
    )
}
```

- [ ] **Step 7: Verify types**

```bash
npm run type-check
```
Expected: no errors.

- [ ] **Step 8: Manual test**

1. Open the dashboard as a team user
2. Confirm 🗂 button appears at the end of the tab bar
3. Click 🗂 — entire dashboard is replaced by the archive view
4. Click the eye icon on a tab — it should toggle `archived` (tab disappears from main bar when returning)
5. Click "← Volver" — dashboard returns, hidden tab no longer in bar
6. Click 🗂 again — badge shows correct count
7. Expand a tab → check some cards → values appear in the right panel with origin label
8. Verify as viewer: 🗂 button is not visible

- [ ] **Step 9: Commit**

```bash
git add src/app/\(app\)/dashboard/components/DashboardClient.tsx
git commit -m "feat: wire TabArchiveView into DashboardClient with archive button and tab filter"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `archived boolean DEFAULT false` migration — Task 1
- ✅ `toggleTabArchived` server action — Task 2
- ✅ Tab bar shows only non-archived tabs — Task 4 Step 4
- ✅ 🗂 button at end of tab bar, team-only, with badge — Task 4 Step 5
- ✅ Archive view replaces full content — Task 4 Step 6
- ✅ "← Volver" button closes archive — Task 3 (header button)
- ✅ Eye toggle per tab (team only) — Task 3
- ✅ Expand → show cards as checkboxes — Task 3
- ✅ Right panel with grouped cards + origin label — Task 3
- ✅ Card values computed from tab's own date range + keyword — Task 3 `computeCardValue`
- ✅ Viewers cannot see archive button — Task 4 Step 5 (`isTeam` guard)

**No placeholders found.**

**Type consistency:** `SelectedCard`, `CardDef`, `resolveTabCards`, `computeCardValue` — all defined in Task 3 and referenced consistently.
