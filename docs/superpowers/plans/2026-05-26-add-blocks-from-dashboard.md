# Add Blocks from Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "+" button to the dashboard toolbar that opens a dropdown to create cards, charts, ranking tables, and text blocks inline, immediately opening QuickEditModal for configuration.

**Architecture:** Single-file change in `DashboardClient.tsx`. A new `handleAddNewBlock` function creates a block with defaults, appends it to `orderedBlocks` in local state, and sets `quickEditTarget` to open the QuickEditModal. A Radix Popover in the toolbar provides the type-selection dropdown. No backend changes needed.

**Tech Stack:** React, Radix UI Popover (`@/components/ui/popover`), existing `QuickEditModal`, Tailwind CSS.

---

### Task 1: Add imports and `handleAddNewBlock` function

**Files:**
- Modify: `src/app/(app)/dashboard/components/DashboardClient.tsx`

- [ ] **Step 1: Add missing imports**

In `DashboardClient.tsx`, find the existing import lines and add `Popover`, `PopoverContent`, `PopoverTrigger` from the UI lib, `RankingTableDef` to the layout types import, and `BarChart3` + `Table2` to lucide icons.

Find this line (around line 17):
```typescript
import type { ColDef, CardDef, ReportLayout, ChartDef, MetricDef, TextBlockDef } from '@/lib/layout-types'
```
Replace with:
```typescript
import type { ColDef, CardDef, ReportLayout, ChartDef, MetricDef, TextBlockDef, RankingTableDef } from '@/lib/layout-types'
```

Find this line (around line 16):
```typescript
import { LayoutDashboard, Settings2, Plus, Edit2, CalendarDays, Timer, BadgeDollarSign, Wallet, GripVertical, Search, X, Puzzle, Type, AlignLeft, AlignCenter, AlignRight, Trash2, Save, Loader2, Minus, Archive, Copy } from 'lucide-react'
```
Replace with:
```typescript
import { LayoutDashboard, Settings2, Plus, Edit2, CalendarDays, Timer, BadgeDollarSign, Wallet, GripVertical, Search, X, Puzzle, Type, AlignLeft, AlignCenter, AlignRight, Trash2, Save, Loader2, Minus, Archive, Copy, BarChart3, Table2, CreditCard } from 'lucide-react'
```

Add this import after the existing `@/components/ui/button` import:
```typescript
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
```

- [ ] **Step 2: Add `addMenuOpen` state**

In the `DynamicDashboard` component, find the existing state declarations (around line 331 where `quickEditTarget` was added). Add this state after `quickEditTarget`:

```typescript
const [addMenuOpen, setAddMenuOpen] = useState(false)
```

- [ ] **Step 3: Add `handleAddNewBlock` function**

Place this function immediately after `handleDuplicateBlock` (around line 570):

```typescript
function handleAddNewBlock(type: 'card' | 'chart' | 'ranking' | 'text') {
    const newId = crypto.randomUUID()
    const base = { ...(tabLayoutOverrides[activeTabId] || activeLayout), blocks_order: orderedBlocks }

    let updated: typeof base
    let target: QuickEditTarget

    if (type === 'card') {
        const newCard: CardDef = { id: newId, label: 'Nueva tarjeta', formula: 'meta_spend', prefix: '$', suffix: '', decimals: 2, color: 'default' }
        updated = { ...base, tarjetas: [...base.tarjetas, newCard], blocks_order: [...orderedBlocks, `card:${newId}`] }
        target = { type: 'card', id: newId }
    } else if (type === 'chart') {
        const newChart: ChartDef = { id: newId, title: 'Nuevo gráfico', type: 'line', valueFormulas: ['meta_spend'], colors: ['blue'], height: 240 }
        updated = { ...base, graficos: [...(base.graficos || []), newChart], blocks_order: [...orderedBlocks, `chart:${newId}`] }
        target = { type: 'chart', id: newId }
    } else if (type === 'ranking') {
        const newRanking: RankingTableDef = { id: newId, title: 'Nueva tabla', dimension: 'campaigns', topN: 10, sortOrder: 'desc', sortColumnIndex: 0, showRank: true, columns: [{ formula: 'meta_spend', label: 'Gasto', prefix: '$', suffix: '', decimals: 2 }] }
        updated = { ...base, ranking_tables: [...(base.ranking_tables || []), newRanking], blocks_order: [...orderedBlocks, `ranking:${newId}`] }
        target = { type: 'ranking', id: newId }
    } else {
        const newText: TextBlockDef = { id: newId, blockType: 'text', content: 'Nueva sección', style: 'h2', align: 'left', color: 'white', colSpan: 4 }
        updated = { ...base, text_blocks: [...(base.text_blocks || []), newText], blocks_order: [...orderedBlocks, `text:${newId}`] }
        target = { type: 'text', id: newId }
    }

    setTabLayoutOverrides(prev => ({ ...prev, [activeTabId]: updated }))
    setAddMenuOpen(false)
    setQuickEditTarget(target)
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors related to the new function. If `RankingTableDef` or `ChartDef` property errors appear, check `src/lib/layout-types.ts` for exact field names and fix.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/dashboard/components/DashboardClient.tsx
git commit -m "feat(dashboard): add handleAddNewBlock and addMenuOpen state"
```

---

### Task 2: Add "+" button with dropdown in toolbar

**Files:**
- Modify: `src/app/(app)/dashboard/components/DashboardClient.tsx`

- [ ] **Step 1: Locate the toolbar area**

Find the section in DashboardClient where the "Modo Rompecabezas" button and "Configurar layout" button are rendered. It looks like this (around line 1018):

```tsx
<Button
    size="sm"
    variant="outline"
    onClick={() => setIsPuzzleMode(!isPuzzleMode)}
    className={`gap-1.5 text-xs transition ${isPuzzleMode ? ...}`}
>
    <Puzzle className="w-3.5 h-3.5" />
    {isPuzzleMode ? 'Salir Modo Edición' : 'Modo Rompecabezas'}
</Button>
```

- [ ] **Step 2: Insert the "+" Popover button**

Add the following block **immediately before** the "Modo Rompecabezas" button (so `+` appears first in the toolbar):

```tsx
{isTeam && (
    <Popover open={addMenuOpen} onOpenChange={setAddMenuOpen}>
        <PopoverTrigger asChild>
            <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 hover:bg-emerald-500/5 transition"
            >
                <Plus className="w-3.5 h-3.5" />
                Agregar
            </Button>
        </PopoverTrigger>
        <PopoverContent
            className="p-1 bg-zinc-900 border-zinc-800 w-48"
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
                { type: 'text',    icon: <Type       className="w-3.5 h-3.5" />, label: 'Texto / Sección' },
            ] as const).map(({ type, icon, label }) => (
                <button
                    key={type}
                    onClick={() => handleAddNewBlock(type)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white rounded transition"
                >
                    <span className="text-zinc-500">{icon}</span>
                    {label}
                </button>
            ))}
        </PopoverContent>
    </Popover>
)}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors.

- [ ] **Step 4: Manual verification**

Start dev server if not running:
```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npm run dev
```

Open a dashboard as admin/trafficker. Verify:
1. "Agregar" button appears in the toolbar
2. Clicking it opens a dropdown with 4 options
3. Clicking "Tarjeta" closes the dropdown and opens QuickEditModal titled "Tarjeta: Nueva tarjeta"
4. Clicking "Gráfico" opens QuickEditModal titled "Gráfico: Nuevo gráfico"
5. Clicking "Tabla ranking" opens QuickEditModal titled "Tabla: Nueva tabla"
6. Clicking "Texto / Sección" opens QuickEditModal titled "Título / Texto"
7. Saving from QuickEditModal persists the block
8. Public/viewer users do NOT see the "Agregar" button

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/dashboard/components/DashboardClient.tsx
git commit -m "feat(dashboard): add '+' dropdown button to create blocks inline from dashboard

Adds Agregar button to toolbar with Popover dropdown for card/chart/ranking/text.
New block is created with defaults and opens QuickEditModal immediately."
git push origin main
```
