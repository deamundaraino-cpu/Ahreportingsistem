# Date Range Presets — Design Spec

**Date:** 2026-05-15
**Status:** Approved

## Overview

Replace the current manual date inputs (Desde/Hasta + Filtrar) in `DateRangeSelector` with a button + popover dropdown containing radio button presets, matching the reference UX from ad reporting tools.

## Presets

| Label | `from` | `to` |
|---|---|---|
| Hoy | today | today |
| Ayer | yesterday | yesterday |
| Hoy y ayer | yesterday | today |
| Últimos 7 días | today − 6 | today |
| Últimos 14 días | today − 13 | today |
| Últimos 28 días | today − 27 | today |
| Últimos 30 días | today − 29 | today |
| Esta semana | Monday of current week | today |
| La semana pasada | Monday of last week | Sunday of last week |
| Este mes | 1st of current month | today |
| El mes pasado | 1st of last month | last day of last month |
| Máximo | `all` (no lower bound) | today |
| Personalizado | manual inputs | manual inputs |

Week starts on **Monday** (Spanish convention). All dates computed via `date-fns`.

## URL Pattern

- Standard presets: `?from=YYYY-MM-DD&to=YYYY-MM-DD`
- Máximo: `?from=all&to=YYYY-MM-DD`
- Personalizado: same as standard, from user input

## UI Behavior

### Trigger Button
- Always visible. Shows the active preset name (e.g. "Últimos 30 días").
- If active range matches no preset → shows "Personalizado".
- On click → opens Popover.

### Popover Contents
- Scrollable list of 13 radio buttons, one per preset.
- Selecting any preset except "Personalizado" → immediately closes popover and navigates (no extra confirm step).
- Selecting "Personalizado" → reveals two date inputs (Desde / Hasta) + "Aplicar" button inside the popover.
- Clicking "Aplicar" on Personalizado → closes popover and navigates.

### Active Preset Detection
On render, compute each preset's expected `{from, to}` and compare against URL params. First match wins. If none match → "Personalizado" is active.

## Files Changed

### 1. `src/app/(app)/dashboard/components/DateRangeSelector.tsx`
- Full rewrite of the render section.
- Extract a `PRESETS` constant (array of `{ id, label, getRange }`) at the top of the file.
- Extract `getActivePreset(from, to)` helper that returns the matching preset id.
- Use `Popover` + `PopoverTrigger` + `PopoverContent` from `@/components/ui/popover`.
- Keep all existing sync logic (handleSync, syncStatus, syncLogs) unchanged.

### 2. `src/app/(app)/dashboard/_actions.ts`
- In `getDashboardData(clientId, startStr, endStr)`: make the `.gte('fecha', startStr)` filter conditional — skip it when `startStr === 'all'`.

### 3. Page files (no change required)
- Pages already pass `searchParams.get('from')` → `getDashboardData`. The `'all'` string passes through automatically.

## Out of Scope
- Comparison period / secondary date range.
- Changes to the public report page or MonthSelector component.
- Persisting last-used preset in localStorage.
