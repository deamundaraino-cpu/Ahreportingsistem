# Form Filter in Card Configuration — Design Spec

**Date:** 2026-05-25  
**Status:** Approved

## Summary

Add a lead-form filter to the card (and column/chart/ranking) configuration in LayoutConfigModal, parallel to the existing campaign filter. Users can filter a card's metrics to only include data from a specific Meta lead form (by form_id or form_name), using the same 8 operators already available for campaign filtering.

---

## 1. Data Pipeline — Meta API → DB

### New query in `src/app/api/worker/route.ts`

Inside `fetchMetaSingleAccount`, after the existing campaign-level insights query, add a **second query** with the `leadgen_form_id` breakdown:

```
GET /act_{id}/insights
  ?level=campaign
  &breakdowns=leadgen_form_id
  &fields=campaign_id,campaign_name,leadgen_form_id,spend,impressions,clicks,actions
  &time_range={since, until}
  &limit=500
```

This query is independent of the existing campaign query and does not change any existing data. If the account has no Lead Ads, the response will be an empty array — handle gracefully (store `[]`).

### Aggregation

Aggregate the response by `leadgen_form_id`, summing `spend`, `impressions`, `clicks`, and lead action counts across all campaigns for that form and day. Also extract `form_name` from the breakdown response (Meta includes it as a field alongside `leadgen_form_id`). If `form_name` is not returned by the API for a given entry, fall back to `form_id`.

### DB storage

Add a new JSONB column `meta_forms` to the `metricas_diarias` table:

```sql
ALTER TABLE metricas_diarias ADD COLUMN meta_forms JSONB DEFAULT '[]'::jsonb;
```

Shape of each entry in the array:

```typescript
interface MetaFormEntry {
  form_id:     string
  form_name:   string
  leads:       number   // native lead ad form submissions (action_type = 'lead')
  spend:       number
  impressions: number
  clicks:      number
}
```

The upsert payload in the worker adds `meta_forms: metaRecord.forms` alongside `meta_campaigns`.

---

## 2. Types — `src/lib/layout-types.ts`

### New type

```typescript
export type FormFilterField = 'form_id' | 'form_name'

export interface FormFilterSpec {
    field: FormFilterField
    operator?: CampaignFilterOperator   // reuses the same 8 operators
    value: string | string[]
}
```

### Extended definitions

Add `formFilter?: FormFilterSpec` to:
- `ColDef`
- `CardDef`
- `ChartDef`
- `RankingTableDef`

---

## 3. Filter Library — `src/lib/form-filter.ts`

New file, parallel to `src/lib/campaign-filter.ts`.

### `enrichFormRow(row, formFilter)`

```typescript
export function enrichFormRow(
    row: any,
    filter: FormFilterSpec | undefined
): any
```

- If `filter` is undefined or has empty value → return row unchanged.
- Filter `row.meta_forms` (array of `MetaFormEntry`) by comparing `entry[filter.field]` against `filter.value` using `filter.operator` (same operator logic as `campaignMatchesOperator` in campaign-filter.ts).
- Recompute `meta_leads_form` by summing `leads` from matching form entries.
- Recompute `meta_spend`, `meta_impressions`, `meta_clicks` from matching form entries **only when the filter is active** (otherwise leave original campaign-level values intact to avoid conflict with campaign filter).
- Return the enriched row.

The operator matching function is identical to `campaignMatchesOperator` — extract it as a shared utility or duplicate it (no shared abstraction unless the two filters are combined in a single file).

---

## 4. UI — `src/app/(app)/dashboard/components/LayoutConfigModal.tsx`

### `FormFilterPicker` component

New function component, mirrors `CampaignFilterPicker` in structure.

Props:
```typescript
{
  value?: FormFilterSpec
  onChange: (v: FormFilterSpec | undefined) => void
  formNames?: string[]   // for autocomplete
  formIds?: string[]     // for autocomplete
}
```

Layout (same compact row style as CampaignFilterPicker):

```
Form: [Nombre ▼] [Incluye ▼] [Buscar formulario...  ] [×]
```

- **Field selector**: dropdown with two options — "Nombre" (`form_name`) and "ID" (`form_id`). Changing field clears the current value.
- **Operator selector**: same 8 operators (`FILTER_OPERATORS` — reuse the existing constant).
- **Text input / multi-panel**: same single-value input with autocomplete dropdown and multi-select panel as `CampaignFilterPicker`, using `formNames` or `formIds` depending on selected field.
- **Clear (×)**: calls `onChange(undefined)`.
- No "group" selector (campaign groups have no form equivalent).

### Placement in `DraggableCardRow`

Row 2 of the card config already shows `MetricTypeSelector` and `CampaignFilterPicker`. Add `FormFilterPicker` after `CampaignFilterPicker` in the same row:

```tsx
<div className="flex items-center gap-2 flex-wrap">
  <MetricTypeSelector ... />
  <CampaignFilterPicker ... />
  <FormFilterPicker ... />
</div>
```

Add `formFilter` / `onUpdate` wiring identical to `campaignFilter`.

### Placement in `DraggableColRow` and chart/ranking rows

Apply the same pattern wherever `CampaignFilterPicker` already appears:
- `DraggableColRow` (column config)
- Chart row (wherever `CampaignFilterPicker` is rendered for charts)
- Ranking table row

### Props threading

`DraggableCardRow`, `DraggableColRow`, and the chart/ranking row components receive two new optional props:
```typescript
formNames?: string[]
formIds?: string[]
```

These flow from the parent modal down to `FormFilterPicker`.

---

## 5. Dashboard Integration

### `src/app/(app)/dashboard/_actions.ts` — `getDashboardData`

After merging metrics and leads, extract unique form names and IDs from the `meta_forms` arrays across all rows:

```typescript
const allFormEntries = (metrics || []).flatMap((m: any) => m.meta_forms || [])
const formNames = [...new Set(allFormEntries.map((f: any) => f.form_name).filter(Boolean))]
const formIds   = [...new Set(allFormEntries.map((f: any) => f.form_id).filter(Boolean))]
```

Add `formNames` and `formIds` to the return value.

### `src/app/(app)/dashboard/components/DashboardClient.tsx`

- Receive `formNames` and `formIds` from `data`.
- Pass them down to `LayoutConfigModal`.
- In `tarjetaValues` (the `useMemo` that computes card values):

```typescript
const tarjetaValues = useMemo(() => {
    return activeLayout.tarjetas.map((t: CardDef) => {
        const campaignFilter = resolveFilter(t.campaignFilter, effectiveKeyword)
        let rows = campaignFilter === effectiveKeyword
            ? filteredMetrics
            : baseRows.map((m: any) => enrichMetaRow(m, campaignFilter, data.campaignGroups))

        // Apply form filter on top of campaign filter
        if (t.formFilter) {
            rows = rows.map((m: any) => enrichFormRow(m, t.formFilter))
        }

        return {
            ...t,
            value: aggregateFormula(t.formula, rows, varContext, sourceMapping, platformSet, layoutCustomMetrics),
        }
    })
}, [...existing deps..., /* add: data.campaignGroups (already there), formFilter deps */])
```

Apply the same pattern for columns (`ColDef.formFilter`) in the table rendering.

---

## 6. Scope Boundaries

- **Meta only (initial):** `meta_forms` data comes from Meta Insights API. TikTok and other platforms can be extended later using the same `FormFilterSpec` type — no type changes needed.
- **No DB migration UI:** The `ALTER TABLE` migration runs once in Supabase. Existing rows get `[]` as default.
- **No campaign groups equivalent:** Form filter has no "form groups" concept. Groups can be added later if needed.
- **Operators:** Exactly the same 8 operators as campaign filter — no new operators.
- **No change to existing campaign filter:** The two filters are independent and additive (both can be set on the same card).

---

## 7. Testing Criteria

- A card with `formFilter = { field: 'form_name', operator: 'includes', value: 'Webinar' }` shows only leads from forms whose name contains "Webinar".
- A card with no `formFilter` behaves identically to current behavior.
- A card with both `campaignFilter` and `formFilter` applies both independently.
- Worker stores `meta_forms: []` for days/accounts with no Lead Ads without error.
- Autocomplete in `FormFilterPicker` shows form names/IDs from actual `meta_forms` data.
- All 8 operators work correctly for both `form_id` and `form_name` fields.
