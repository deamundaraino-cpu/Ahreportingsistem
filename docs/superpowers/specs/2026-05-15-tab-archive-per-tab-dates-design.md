# Tab Archive Per-Tab Date Ranges — Design Spec

**Date:** 2026-05-15
**Status:** Approved

## Problem

`TabArchiveView` reuses the global metrics already loaded by the dashboard date selector. If a tab's `fecha_inicio`/`fecha_finalizacion` fall outside the global date range (e.g., global is "last 30 days" but a tab ran 3 months ago), `computeCardValue` filters to empty data — metrics show zero or nothing. Additionally, there is no way to override dates per tab inside the archive view for comparison purposes.

## Solution Overview

1. `TabArchiveView` loads its own full historical metrics on mount (independent of global date selector).
2. Each tab in the left panel gets inline editable date inputs (override only — not saved to DB).
3. `computeCardValue` prefers override dates over configured tab dates.

---

## Data Loading

### New server action: `getArchiveMetrics(clientId: string)`

Added to `src/app/(app)/dashboard/_actions.ts`.

Fetches all `metricas_diarias` and `leads_diarios` for the client with no lower date bound (equivalent to `from=all`). Merges leads into metrics by date (same join logic as `getDashboardData`).

Returns: `{ metrics: any[] } | null`

### `TabArchiveView` loading sequence

1. Mounts with `metrics` prop as initial state (`archiveMetrics`).
2. `useEffect` on mount calls `getArchiveMetrics(clientId)`.
3. While loading: shows a subtle loading indicator ("Cargando historial completo…") in the right panel instead of metric cards.
4. On success: replaces `archiveMetrics` state with full historical metrics. Metric cards render with correct data.
5. On error: falls back to `metrics` prop silently (no blocking error UI).

---

## Per-Tab Date Override

### State

```typescript
const [tabDateOverrides, setTabDateOverrides] = useState<
  Record<string, { from: string; to: string }>
>({});
```

Initialized empty. Resets when archive closes (component unmounts).

### UI

In the left panel, each tab currently shows static text "YYYY-MM-DD → YYYY-MM-DD". This becomes two inline `<input type="date">` fields:

- Pre-filled with `tab.fecha_inicio` and `tab.fecha_finalizacion` if configured.
- Empty if the tab has no configured dates (uses full historical data for that tab).
- On change → updates `tabDateOverrides[tab.id]`.
- Styled the same as the existing dark input style (`bg-zinc-800 text-zinc-400`).
- No save button — changes are instant and local only.

### `computeCardValue` update

Signature updated to accept overrides:

```typescript
function computeCardValue(
  card: CardDef,
  tab: any,
  metrics: any[],
  campaignGroups: any[],
  dateOverride?: { from: string; to: string }
): number | null;
```

Priority for date filtering:

1. `dateOverride` (if present)
2. `tab.fecha_inicio` / `tab.fecha_finalizacion` (configured)
3. No filter (use all metrics)

---

## Files Changed

### 1. `src/app/(app)/dashboard/_actions.ts`

- Add `getArchiveMetrics(clientId: string)` — no-filter metrics fetch + leads merge.

### 2. `src/app/(app)/dashboard/components/TabArchiveView.tsx`

- Add `archiveMetrics` state (initialized from `metrics` prop).
- Add `useEffect` to call `getArchiveMetrics` on mount.
- Add `isLoadingArchive` boolean state for loading indicator.
- Add `tabDateOverrides` state.
- Replace static date text with inline date inputs per tab.
- Update `computeCardValue` to accept and prefer `dateOverride`.
- Pass `tabDateOverrides[tab.id]` when calling `computeCardValue`.

---

## Out of Scope

- Persisting per-tab date overrides (not saved to DB).
- Changing the tab's configured `fecha_inicio`/`fecha_finalizacion` from the archive view (that's the pencil modal's job).
- Pagination or lazy loading of archive metrics.
