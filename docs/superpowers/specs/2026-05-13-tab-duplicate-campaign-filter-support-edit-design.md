# Design: Tab Duplication, Per-Element Campaign Filter, Support Ticket Editing

**Date:** 2026-05-13  
**Status:** Approved

---

## Overview

Three independent features to improve operational efficiency in the AH Reporting dashboard:

1. **Duplicate Tab** — Clone an existing tab including all config and layout overrides
2. **Per-Element Campaign Filter** — Filter campaign data at the individual card/column/chart level instead of only at the tab level
3. **Support Ticket Editing** — Allow Ads House team (non-viewer roles) to edit tickets and change status

---

## Feature 1: Duplicate Tab

### Scope
Pure persistence operation. No changes to types, data engine, or rendering logic.

### Server Action
New action `duplicateClienteTab(clienteId: string, tabId: string)` in `src/app/(app)/dashboard/_actions.ts`.

Steps:
1. Fetch source tab from `cliente_tabs` by `tabId` + `clienteId`
2. INSERT a new row copying all fields: `nombre` (appended with " (copia)"), `keyword_meta`, `plantilla_id`, `fecha_inicio`, `fecha_finalizacion`, `presupuesto_objetivo`, `hotmart_funnel`, `columnas`, `tarjetas`, `graficos`, `text_blocks`, `blocks_order`
3. Set `orden` to `max(orden) + 1` among existing tabs for that client
4. Call `revalidatePath(`/dashboard/${clienteId}`)`

### UI
File: `src/app/(app)/dashboard/components/TabConfigModal.tsx`

- Only rendered when `tabToEdit !== null` (edit mode, not create mode)
- Add "Duplicar Pestaña" button in the modal footer, positioned between "Eliminar" and "Cancelar"
- On click: call `duplicateClienteTab`, close modal, dashboard reloads showing the new tab

---

## Feature 2: Per-Element Campaign Filter

### Type Extensions
File: `src/lib/layout-types.ts`

Add optional field to `CardDef`, `ColDef`, and `ChartDef`:

```ts
campaignFilter?: { type: 'group' | 'keyword'; value: string }
```

- If absent: element inherits the tab-level `keyword_meta` filter (existing behavior unchanged)
- If present: element uses its own filter, ignoring the tab-level filter

### UI in LayoutConfigModal
File: `src/app/(app)/dashboard/components/LayoutConfigModal.tsx`

Add "Filtro de campaña (opcional)" section to the config panel of each element type (card, table column, chart):
- `<Select>` populated from `campaign_groups` prop — selects a named group
- `<Input>` for free keyword
- Mutually exclusive: selecting one clears the other
- "Limpiar" button to remove filter entirely

`campaign_groups` data is already available in `data.campaignGroups` passed to `DashboardClient`. It must be threaded through to `LayoutConfigModal` as a new prop.

### Data Engine
File: `src/app/(app)/dashboard/components/DashboardClient.tsx`

`enrichMetaRow` already accepts `keywordFilter` + `campaignGroups`. Create a helper `resolveFilter(element, effectiveKeyword)` that returns the correct filter string for a given element:
- If `element.campaignFilter` exists → use it
- Otherwise → fall back to `effectiveKeyword` (tab-level filter)

Apply `resolveFilter` when computing each card value, each column value, and each chart series.

### Database
No migration required. `CardDef`, `ColDef`, `ChartDef` are stored as JSONB columns in Supabase — the new `campaignFilter` field persists automatically.

---

## Feature 3: Support Ticket Editing

### Role Detection
File: `src/app/(app)/dashboard/[clientId]/page.tsx`

The page already reads `profile.role` from Supabase. Pass it as `userRole` prop to `SupportModule`.

Editable roles: `superadmin`, `admin`, `trafficker`  
Read-only role: `viewer` (existing client behavior unchanged)

### UI Changes
File: `src/app/(app)/dashboard/components/SupportModule.tsx`

**Inline status selector** (team only):
- Replace the status `<Badge>` in each table row with a `<Select>` showing the 4 states
- On change: immediately call `updateSoporteTicket({ estado })` — no save button needed
- Loading state on the select while the call is in flight

**Edit button** (team only):
- Add pencil icon button to each table row
- Opens a `<Dialog>` with all editable fields: nombre_solicitante, requerimiento, observaciones, prioridad
- "Guardar" button calls `updateSoporteTicket` with changed fields
- "Cancelar" closes without saving

### Server Action Extension
File: `src/app/(app)/dashboard/_actions.ts`

Extend `updateSoporteTicket` payload to accept:
```ts
nombre_solicitante?: string
requerimiento?: string
```
These map directly to the existing `soporte_tickets` table columns.

### States (unchanged)
`abierto` → `en_progreso` → `completado` → `cancelado`

---

## Files Touched Summary

| File | Change |
|------|--------|
| `src/app/(app)/dashboard/_actions.ts` | Add `duplicateClienteTab`; extend `updateSoporteTicket` |
| `src/lib/layout-types.ts` | Add `campaignFilter` to `CardDef`, `ColDef`, `ChartDef` |
| `src/app/(app)/dashboard/components/TabConfigModal.tsx` | Add "Duplicar Pestaña" button |
| `src/app/(app)/dashboard/components/LayoutConfigModal.tsx` | Add campaign filter UI per element; accept `campaignGroups` prop |
| `src/app/(app)/dashboard/components/DashboardClient.tsx` | Add `resolveFilter` helper; apply per-element filter in rendering |
| `src/app/(app)/dashboard/components/SupportModule.tsx` | Add `userRole` prop; status selector; edit modal |
| `src/app/(app)/dashboard/[clientId]/page.tsx` | Pass `userRole` to `SupportModule` |
