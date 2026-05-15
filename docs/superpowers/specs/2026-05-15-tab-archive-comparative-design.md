# Design: Tab Archive & Comparative Dashboard

**Date:** 2026-05-15
**Status:** Approved

---

## Overview

Two related features to reduce visual clutter in the tab bar and enable cross-tab metric comparison:

1. **Tab Archive** — Team can hide tabs from the main navigation bar without deleting them. A 🗂 button at the end of the tab bar opens the archive view.
2. **Comparative Dashboard** — Inside the archive view, users can expand any tab, select specific metric cards, and see them all together in a side panel with their origin labeled.

---

## Feature 1: Tab Visibility (Archive Toggle)

### Database

New migration `migrations/015_tab_archived.sql`:

```sql
ALTER TABLE public.cliente_tabs
ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
```

No index needed — filtered client-side after fetching all tabs.

### Server Action

New action `toggleTabArchived(clienteId: string, tabId: string, archived: boolean)` in `src/app/(app)/dashboard/_actions.ts`:

1. Update `cliente_tabs` SET `archived = archived` WHERE `id = tabId AND cliente_id = clienteId`
2. Call `revalidatePath(/dashboard/${clienteId})`

### Tab Bar Changes

File: `src/app/(app)/dashboard/components/DashboardClient.tsx`

- Filter visible tabs: only render tabs where `tab.archived === false` in the main tab bar
- Add 🗂 button at the far right of the tab bar, visible only to `isTeam` users
- If `tabs.filter(t => t.archived).length > 0`, show a numeric badge on the button (e.g. "🗂 3")
- Button `onClick`: set `showArchive(true)` — replaces dashboard content with `TabArchiveView`

### Access Control

Only `isTeam` (superadmin, admin, trafficker) see the 🗂 button and can toggle archived status. Viewers never see archived tabs and never see the archive button.

---

## Feature 2: Tab Archive View

### Entry / Exit

- Triggered by `showArchive` state in `DashboardClient`
- Replaces the **entire** dashboard content area including the tab bar — when archive is open, nothing else is visible
- "← Volver" button in top-left restores the dashboard and sets `showArchive(false)`

### Component

New file: `src/app/(app)/dashboard/components/TabArchiveView.tsx`

Props:
```ts
{
  tabs: any[]                    // all tabs for this client (visible + archived)
  metrics: any[]                 // full raw metrics already loaded
  campaignGroups: any[]          // for enrichMetaRow
  onClose: () => void
  onToggleArchived: (tabId: string, archived: boolean) => void
  isTeam: boolean
}
```

### Layout

Two-column layout:

**Left column (40%):** List of ALL tabs ordered by `orden`. Each tab row shows:
- Tab name + `keyword_meta` badge
- Date range if configured (`fecha_inicio` → `fecha_finalizacion`)
- Eye toggle button (👁 / 👁‍🗨) — only visible to team — calls `onToggleArchived` immediately
- Expand chevron → reveals the tab's cards as checkboxes

**Right column (60%):** Comparative panel
- Empty state: "Selecciona tarjetas del panel izquierdo para comparar"
- Once cards are selected: renders them grouped by origin tab
- Each card shows: label, formatted value, and a footer tag "📌 [Tab name]"

### Card Selection State

Local state in `TabArchiveView`:
```ts
type SelectedCard = {
  tabId: string
  tabName: string
  card: CardDef
}
selectedCards: SelectedCard[]
```

Checking a card adds it; unchecking removes it. No limit on how many can be selected.

---

## Feature 3: Comparative Card Value Computation

### Logic (client-side, no fetch)

For each selected card, compute value using data already in memory:

```ts
function computeCardValue(
  card: CardDef,
  tab: any,
  metrics: any[],
  campaignGroups: any[]
): number | null {
  // 1. Date filter
  let rows = metrics
  if (tab.fecha_inicio) rows = rows.filter(m => m.fecha >= tab.fecha_inicio)
  if (tab.fecha_finalizacion) rows = rows.filter(m => m.fecha <= tab.fecha_finalizacion)

  // 2. Campaign filter
  const keyword = card.campaignFilter?.value ?? tab.keyword_meta ?? ''
  rows = rows.map(r => enrichMetaRow(r, keyword, campaignGroups))

  // 3. Aggregate
  return aggregateFormula(card.formula, rows, {}, {}, new Set(['meta']), [])
}
```

`varContext` is passed as `{}` — formulas depending on `$funnel.*` will resolve to 0 and display `—`. All Meta, GA4, and Ventas metrics work correctly.

### Value Display

Use the existing `formatValue(value, card.prefix, card.suffix, card.decimals)` function from `@/lib/formula-engine` for formatting.

---

## Files Summary

| File | Change |
|------|--------|
| `migrations/015_tab_archived.sql` | Add `archived boolean DEFAULT false` to `cliente_tabs` |
| `src/app/(app)/dashboard/_actions.ts` | Add `toggleTabArchived` action |
| `src/app/(app)/dashboard/components/DashboardClient.tsx` | Filter tab bar; add 🗂 button; conditional render of `TabArchiveView` |
| `src/app/(app)/dashboard/components/TabArchiveView.tsx` | New component: archive list + comparative panel |

---

## Explicit Non-Goals

- No new page route — archive lives inside `DashboardClient` state
- No persistence of selected cards for comparison — selection resets on close
- No comparison for `$funnel.*` formulas — shows `—` with a tooltip explanation
- Viewers cannot see or interact with the archive at all
