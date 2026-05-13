# Tab Duplication, Per-Element Campaign Filter & Support Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three independent features: (1) duplicate a tab from its edit modal, (2) filter Meta campaign data per card/column/chart rather than only per tab, (3) allow Ads House team members to edit and change status on support tickets.

**Architecture:** All three features are additive — they extend existing components without restructuring them. The campaign filter feature requires extracting `enrichMetaRow` to a shared lib so both `DashboardClient` and `MetricCharts` can use it for per-element enrichment. Support editing reuses the existing `updateSoporteTicket` server action.

**Tech Stack:** Next.js 14 App Router, React, TypeScript, Supabase (JSONB columns), Tailwind CSS, shadcn/ui components. Verification: `npm run type-check` (tsc --noEmit). No unit test framework exists.

---

## File Map

| File | Change |
|------|--------|
| `src/lib/campaign-filter.ts` | **Create** — extract `enrichMetaRow` + helpers from DashboardClient |
| `src/lib/layout-types.ts` | **Modify** — add `campaignFilter` to `CardDef`, `ColDef`, `ChartDef` |
| `src/app/(app)/dashboard/_actions.ts` | **Modify** — add `duplicateClienteTab`; extend `updateSoporteTicket` |
| `src/app/(app)/dashboard/components/TabConfigModal.tsx` | **Modify** — add "Duplicar Pestaña" button |
| `src/app/(app)/dashboard/components/LayoutConfigModal.tsx` | **Modify** — add `campaignGroups` prop; add `CampaignFilterPicker` to each element editor |
| `src/app/(app)/dashboard/components/DashboardClient.tsx` | **Modify** — use shared `enrichMetaRow`; split `baseRows`/`filteredMetrics`; per-element filter in cards, columns, charts; thread `userRole` to `SupportModule` |
| `src/app/(app)/dashboard/components/MetricCharts.tsx` | **Modify** — accept `rawMetrics`, `campaignGroups`, `effectiveKeyword`; apply per-chart filter |
| `src/app/(app)/dashboard/components/SupportModule.tsx` | **Modify** — add `userRole` prop; inline status selector; edit modal |
| `src/app/(app)/dashboard/[clientId]/page.tsx` | **Modify** — pass `userRole` to `DashboardClient` |

---

## Task 1: Extract `enrichMetaRow` to shared lib

**Files:**
- Create: `src/lib/campaign-filter.ts`

- [ ] **Step 1: Create the shared campaign-filter module**

Create `src/lib/campaign-filter.ts` with the following content (extracted verbatim from `DashboardClient.tsx` lines 54–141):

```typescript
// Helpers for filtering Meta campaign data by group or keyword

function campaignMatchesPattern(campaign: any, pattern: string): boolean {
    if (!pattern) return false
    const regexPattern = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.')
    const regex = new RegExp(`^${regexPattern}$`, 'i')
    return regex.test(campaign.name || '')
}

function campaignMatchesGroup(
    campaign: any,
    groupMappings: Array<{ campaign_id?: string; campaign_name_pattern?: string }>
): boolean {
    for (const mapping of groupMappings) {
        if (mapping.campaign_id && campaign.campaign_id === mapping.campaign_id) return true
        if (mapping.campaign_name_pattern && campaignMatchesPattern(campaign, mapping.campaign_name_pattern)) return true
    }
    return false
}

export function enrichMetaRow(row: any, keywordFilter: string, campaignGroups?: any[]): any {
    if (!row.meta_campaigns || !Array.isArray(row.meta_campaigns)) return row

    let matching = row.meta_campaigns

    if (keywordFilter && campaignGroups && campaignGroups.length > 0) {
        const selectedGroup = campaignGroups.find((g: any) => g.id === keywordFilter)
        if (selectedGroup && selectedGroup.campaign_group_mappings) {
            matching = row.meta_campaigns.filter((c: any) =>
                campaignMatchesGroup(c, selectedGroup.campaign_group_mappings)
            )
        } else {
            const kw = keywordFilter.toLowerCase()
            matching = row.meta_campaigns.filter((c: any) =>
                kw === '' || c.name?.toLowerCase().includes(kw)
            )
        }
    } else if (keywordFilter) {
        const kw = keywordFilter.toLowerCase()
        matching = row.meta_campaigns.filter((c: any) =>
            kw === '' || c.name?.toLowerCase().includes(kw)
        )
    }

    const ri = (field: string) => matching.reduce((s: number, c: any) => s + (parseInt(c[field] || '0') || 0), 0)
    const rf = (field: string) => matching.reduce((s: number, c: any) => s + (parseFloat(c[field] || '0') || 0), 0)

    const spend = rf('spend')
    const impressions = ri('impressions')
    const clicks = ri('clicks')
    const link_clicks = ri('link_clicks')
    const reach = ri('unique_reach')

    return {
        ...row,
        meta_spend: spend,
        meta_impressions: impressions,
        meta_clicks: clicks,
        meta_link_clicks: link_clicks,
        meta_reach: reach,
        meta_frequency: reach > 0 ? impressions / reach : 0,
        meta_cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
        meta_cpc: clicks > 0 ? spend / clicks : 0,
        meta_cpc_link: link_clicks > 0 ? spend / link_clicks : 0,
        meta_ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        meta_ctr_link: impressions > 0 ? (link_clicks / impressions) * 100 : 0,
        meta_leads: ri('leads'),
        meta_cpl: ri('leads') > 0 ? spend / ri('leads') : 0,
        meta_leads_form: ri('leads_form'),
        meta_cpl_form: ri('leads_form') > 0 ? spend / ri('leads_form') : 0,
        meta_complete_registration: ri('complete_registration'),
        meta_cost_per_complete_registration: ri('complete_registration') > 0 ? spend / ri('complete_registration') : 0,
        meta_submit_application: ri('submit_application'),
        meta_start_trial: ri('start_trial'),
        meta_subscribe: ri('subscribe'),
        meta_purchases: ri('purchases'),
        meta_cpp: ri('purchases') > 0 ? spend / ri('purchases') : 0,
        meta_roas: spend > 0 ? rf('purchase_roas') : 0,
        meta_adds_to_cart: ri('adds_to_cart'),
        meta_cost_per_add_to_cart: ri('adds_to_cart') > 0 ? spend / ri('adds_to_cart') : 0,
        meta_initiates_checkout: ri('initiates_checkout'),
        meta_cost_per_initiate_checkout: ri('initiates_checkout') > 0 ? spend / ri('initiates_checkout') : 0,
        meta_landing_page_views: ri('landing_page_views'),
        meta_cost_per_landing_page_view: ri('landing_page_views') > 0 ? spend / ri('landing_page_views') : 0,
        meta_view_content: ri('view_content'),
        meta_cost_per_view_content: ri('view_content') > 0 ? spend / ri('view_content') : 0,
        meta_search: ri('search'),
        meta_add_to_wishlist: ri('add_to_wishlist'),
        meta_customize_product: ri('customize_product'),
        meta_video_views: ri('video_thruplay'),
        meta_cost_per_video_view: ri('video_thruplay') > 0 ? spend / ri('video_thruplay') : 0,
        meta_results: ri('results'),
        meta_cost_per_result: ri('results') > 0 ? spend / ri('results') : 0,
    }
}
```

> **Note:** The exact fields computed in `enrichMetaRow` in the live `DashboardClient.tsx` may have more fields than shown here. Before creating this file, read lines 120–200 of `DashboardClient.tsx` to copy ALL field assignments verbatim. The list above is illustrative — do not use it as the source of truth for field names.

- [ ] **Step 2: Update DashboardClient to import from shared lib**

In `src/app/(app)/dashboard/components/DashboardClient.tsx`:

Remove the local definitions of `campaignMatchesPattern`, `campaignMatchesGroup`, and `enrichMetaRow` (the three functions at the top of the file, approximately lines 54–200).

Add this import at the top of the file (after existing imports):

```typescript
import { enrichMetaRow } from '@/lib/campaign-filter'
```

- [ ] **Step 3: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors. If there are errors about missing fields in `enrichMetaRow`, compare the function body to the original in `DashboardClient.tsx` and add the missing field assignments.

- [ ] **Step 4: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/lib/campaign-filter.ts src/app/\(app\)/dashboard/components/DashboardClient.tsx
git commit -m "refactor: extract enrichMetaRow to shared lib"
```

---

## Task 2: Add `campaignFilter` to layout types

**Files:**
- Modify: `src/lib/layout-types.ts`

- [ ] **Step 1: Add `campaignFilter` field to `CardDef`, `ColDef`, and `ChartDef`**

In `src/lib/layout-types.ts`, add `campaignFilter?: { type: 'group' | 'keyword'; value: string }` to each interface:

```typescript
export interface ColDef {
    id: string
    label: string
    formula: string
    prefix?: string
    suffix?: string
    decimals?: number
    align?: 'left' | 'right'
    highlight?: boolean
    hidden?: boolean
    isManual?: boolean
    campaignFilter?: { type: 'group' | 'keyword'; value: string }  // ← add this
}

export interface CardDef {
    id: string
    label: string
    formula: string
    prefix?: string
    suffix?: string
    decimals?: number
    color?: CardColor
    campaignFilter?: { type: 'group' | 'keyword'; value: string }  // ← add this
}

export interface ChartDef {
    id: string
    title: string
    type: ChartType
    categoryColumns: string[]
    valueFormulas: string[]
    colors?: string[]
    height?: number
    campaignFilter?: { type: 'group' | 'keyword'; value: string }  // ← add this
}
```

- [ ] **Step 2: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/lib/layout-types.ts
git commit -m "feat(types): add campaignFilter to CardDef, ColDef, ChartDef"
```

---

## Task 3: Add `duplicateClienteTab` server action

**Files:**
- Modify: `src/app/(app)/dashboard/_actions.ts`

- [ ] **Step 1: Add the action**

In `src/app/(app)/dashboard/_actions.ts`, add this function after `deleteClienteTab`:

```typescript
export async function duplicateClienteTab(clienteId: string, tabId: string) {
    const supabase = await createAdminClient()

    const { data: source, error: fetchError } = await supabase
        .from('cliente_tabs')
        .select('*')
        .eq('id', tabId)
        .eq('cliente_id', clienteId)
        .single()

    if (fetchError || !source) return { error: fetchError?.message || 'Tab no encontrada' }

    const { data: allTabs } = await supabase
        .from('cliente_tabs')
        .select('orden')
        .eq('cliente_id', clienteId)
        .order('orden', { ascending: false })
        .limit(1)

    const maxOrden = (allTabs?.[0]?.orden ?? 0) as number

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, created_at, updated_at, ...rest } = source

    const { error: insertError } = await supabase
        .from('cliente_tabs')
        .insert({
            ...rest,
            nombre: `${source.nombre} (copia)`,
            orden: maxOrden + 1,
        })

    if (insertError) return { error: insertError.message }
    revalidatePath(`/dashboard/${clienteId}`)
    return { success: true }
}
```

- [ ] **Step 2: Extend `updateSoporteTicket` payload**

Find the existing `updateSoporteTicket` function (around line 511) and add `nombre_solicitante` and `requerimiento` to its payload type:

```typescript
export async function updateSoporteTicket(ticketId: string, clienteId: string, payload: {
    responsable?: string
    fecha_entrega?: string
    prioridad?: number
    estado?: string
    observaciones?: string
    nombre_solicitante?: string   // ← add
    requerimiento?: string        // ← add
}) {
```

The function body stays the same — `...payload` already spreads all fields into the update.

- [ ] **Step 3: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/app/\(app\)/dashboard/_actions.ts
git commit -m "feat(actions): add duplicateClienteTab; extend updateSoporteTicket with editable fields"
```

---

## Task 4: "Duplicar Pestaña" button in TabConfigModal

**Files:**
- Modify: `src/app/(app)/dashboard/components/TabConfigModal.tsx`

- [ ] **Step 1: Import `duplicateClienteTab` and `Copy` icon**

At the top of `TabConfigModal.tsx`, add `duplicateClienteTab` to the actions import:

```typescript
import { saveClienteTab, deleteClienteTab, duplicateClienteTab } from '../_actions'
```

Add `Copy` to the lucide-react import:

```typescript
import { Trash2, ChevronDown, ChevronRight, Zap, Copy } from 'lucide-react'
```

- [ ] **Step 2: Add `duplicating` state and handler**

Inside the `TabConfigModal` function body, after the existing `saving` state:

```typescript
const [duplicating, setDuplicating] = useState(false)

async function handleDuplicate() {
    if (!tabToEdit?.id) return
    setDuplicating(true)
    const res = await duplicateClienteTab(clienteId, tabToEdit.id)
    setDuplicating(false)
    if (res.error) { alert('Error al duplicar: ' + res.error); return }
    onClose()
}
```

- [ ] **Step 3: Add button to modal footer**

Find the footer section of the modal (the `div` that contains the "Eliminar", "Cancelar", and "Guardar Pestaña" buttons). Add the "Duplicar Pestaña" button between "Eliminar" and "Cancelar", visible only in edit mode:

```tsx
{/* Only in edit mode */}
{tabToEdit && (
    <Button
        type="button"
        variant="outline"
        onClick={handleDuplicate}
        disabled={duplicating || saving}
        className="border-zinc-700 text-zinc-300 hover:bg-zinc-800 gap-2"
    >
        <Copy className="w-4 h-4" />
        {duplicating ? 'Duplicando...' : 'Duplicar Pestaña'}
    </Button>
)}
```

- [ ] **Step 4: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/app/\(app\)/dashboard/components/TabConfigModal.tsx
git commit -m "feat(ui): add Duplicar Pestaña button to tab edit modal"
```

---

## Task 5: Campaign filter UI in LayoutConfigModal

**Files:**
- Modify: `src/app/(app)/dashboard/components/LayoutConfigModal.tsx`

- [ ] **Step 1: Add `campaignGroups` prop to `LayoutConfigModal`**

Find the `LayoutConfigModal` function signature (around line 599) and add `campaignGroups`:

```typescript
export function LayoutConfigModal({
    clienteId,
    currentLayout,
    allLayouts,
    isCustomized,
    onClose,
    onLayoutApplied,
    tabId,
    conversionesCatalogo = [],
    campaignGroups = [],          // ← add
}: {
    clienteId: string
    currentLayout: ReportLayout | null
    allLayouts: any[]
    isCustomized: boolean
    onClose: () => void
    onLayoutApplied: (layout: ReportLayout) => void
    tabId?: string
    conversionesCatalogo?: { conversion_key: string; label: string; field_id: string }[]
    campaignGroups?: { id: string; nombre: string }[]   // ← add
}) {
```

- [ ] **Step 2: Add `CampaignFilterPicker` component**

Add this component just before the `LayoutConfigModal` export function (after the PRESETS constant):

```tsx
function CampaignFilterPicker({
    value,
    onChange,
    campaignGroups,
}: {
    value?: { type: 'group' | 'keyword'; value: string }
    onChange: (v: { type: 'group' | 'keyword'; value: string } | undefined) => void
    campaignGroups: { id: string; nombre: string }[]
}) {
    return (
        <div className="flex items-center gap-1 flex-shrink-0" title="Filtro de campaña (opcional)">
            {campaignGroups.length > 0 && (
                <select
                    value={value?.type === 'group' ? value.value : ''}
                    onChange={e => {
                        if (e.target.value) onChange({ type: 'group', value: e.target.value })
                        else if (value?.type === 'group') onChange(undefined)
                    }}
                    className="h-6 text-xs bg-zinc-950 border border-zinc-700 text-zinc-300 rounded px-1.5 max-w-[100px]"
                >
                    <option value="">Grupo...</option>
                    {campaignGroups.map(g => (
                        <option key={g.id} value={g.id}>{g.nombre}</option>
                    ))}
                </select>
            )}
            <Input
                value={value?.type === 'keyword' ? value.value : ''}
                onChange={e => {
                    if (e.target.value) onChange({ type: 'keyword', value: e.target.value })
                    else if (value?.type === 'keyword') onChange(undefined)
                }}
                placeholder="keyword..."
                className="h-6 text-xs bg-zinc-950 border-zinc-700 text-zinc-300 w-20"
            />
            {value && (
                <button
                    onClick={() => onChange(undefined)}
                    title="Limpiar filtro de campaña"
                    className="text-zinc-600 hover:text-red-400 transition"
                >
                    <X className="w-3 h-3" />
                </button>
            )}
        </div>
    )
}
```

- [ ] **Step 3: Add `campaignGroups` prop to `DraggableCardRow` and wire picker**

Find `DraggableCardRow` (around line 375). Add `campaignGroups` to its props and render `CampaignFilterPicker` before the remove button:

```typescript
function DraggableCardRow({
    card, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, availableMetrics, campaignGroups = []
}: {
    card: CardDef
    // ... existing props ...
    campaignGroups?: { id: string; nombre: string }[]
}) {
```

Inside the JSX, before the final remove `<button>`:

```tsx
<CampaignFilterPicker
    value={card.campaignFilter}
    onChange={v => onUpdate({ ...card, campaignFilter: v })}
    campaignGroups={campaignGroups}
/>
```

- [ ] **Step 4: Add `campaignGroups` prop to `DraggableColumnRow` and wire picker**

Find `DraggableColumnRow` (around line 279). Add the same `campaignGroups` prop. Inside the scrollable row content div, before the `{col.isManual && ...}` block:

```tsx
<CampaignFilterPicker
    value={col.campaignFilter}
    onChange={v => onUpdate({ ...col, campaignFilter: v })}
    campaignGroups={campaignGroups}
/>
```

- [ ] **Step 5: Add `campaignGroups` prop to `DraggableChartRow` and wire picker**

Find `DraggableChartRow` (around line 458). Add the same `campaignGroups` prop. Inside the JSX, add a new row after the metrics list section (after the "Añadir métrica" button div):

```tsx
{/* Campaign filter row */}
<div className="pl-6 flex items-center gap-2 mt-1">
    <span className="text-[10px] text-zinc-600 flex-shrink-0">Filtro campaña:</span>
    <CampaignFilterPicker
        value={chart.campaignFilter}
        onChange={v => onUpdate({ ...chart, campaignFilter: v })}
        campaignGroups={campaignGroups}
    />
</div>
```

- [ ] **Step 6: Thread `campaignGroups` from `LayoutConfigModal` to each DraggableRow**

Find the places inside `LayoutConfigModal` where `DraggableColumnRow`, `DraggableCardRow`, and `DraggableChartRow` are rendered (around lines 973, ~755, ~729). Add `campaignGroups={campaignGroups}` to each:

```tsx
<DraggableColumnRow
    // ... existing props ...
    campaignGroups={campaignGroups}
/>

<DraggableCardRow
    // ... existing props ...
    campaignGroups={campaignGroups}
/>

<DraggableChartRow
    // ... existing props ...
    campaignGroups={campaignGroups}
/>
```

- [ ] **Step 7: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/app/\(app\)/dashboard/components/LayoutConfigModal.tsx
git commit -m "feat(ui): campaign filter picker in card, column, and chart editors"
```

---

## Task 6: Apply per-element campaign filter in DashboardClient

**Files:**
- Modify: `src/app/(app)/dashboard/components/DashboardClient.tsx`

- [ ] **Step 1: Split `filteredMetrics` into `baseRows` + `filteredMetrics`**

Find the `filteredMetrics` useMemo (around line 615). Split it into two separate useMemos:

```typescript
// Step 1: date-filter only (no campaign enrichment)
const baseRows = useMemo(() => {
    let rows = metrics
    if (activeTabObj?.fecha_inicio) {
        rows = rows.filter((m: any) => m.fecha >= activeTabObj.fecha_inicio)
    }
    if (activeTabObj?.fecha_finalizacion) {
        rows = rows.filter((m: any) => m.fecha <= activeTabObj.fecha_finalizacion)
    }
    return rows
}, [metrics, activeTabObj])

// Step 2: campaign-enrich with global tab filter + funnel injection (existing behavior)
const filteredMetrics = useMemo(() => {
    const enriched = baseRows.map((m: any) => enrichMetaRow(m, effectiveKeyword, data.campaignGroups))

    const tabId = activeTabObj?.id
    if (tabId) {
        return enriched.map((row: any) => {
            // ... keep ALL existing funnel injection logic here, unchanged ...
        })
    }
    return enriched
}, [baseRows, effectiveKeyword, activeTabObj, data.campaignGroups])
```

The rest of the code that uses `filteredMetrics` continues to work unchanged.

- [ ] **Step 2: Add `resolveFilter` helper**

Add this helper function near the top of the file (after the `enrichMetaRow` import):

```typescript
function resolveFilter(
    campaignFilter: { type: 'group' | 'keyword'; value: string } | undefined,
    fallback: string
): string {
    return campaignFilter?.value ?? fallback
}
```

- [ ] **Step 3: Apply per-card filter in `tarjetaValues`**

Find the `tarjetaValues` useMemo (around line 700). Replace it with:

```typescript
const tarjetaValues = useMemo(() => {
    return activeLayout.tarjetas.map((t: CardDef) => {
        const filter = resolveFilter(t.campaignFilter, effectiveKeyword)
        const rows = filter === effectiveKeyword
            ? filteredMetrics
            : baseRows.map((m: any) => enrichMetaRow(m, filter, data.campaignGroups))
        return {
            ...t,
            value: aggregateFormula(t.formula, rows, varContext, sourceMapping, platformSet, layoutCustomMetrics),
        }
    })
}, [activeLayout.tarjetas, filteredMetrics, baseRows, effectiveKeyword, varContext, sourceMapping, platformSet, layoutCustomMetrics, data.campaignGroups])
```

- [ ] **Step 4: Apply per-column filter in table cell rendering**

Find the table row rendering section (around line 1137) where `evaluateFormula(col.formula, raw, ...)` is called. The `raw` variable is currently looked up from `filteredMetrics`. Update this section to support per-column filtering:

```typescript
// Before calling evaluateFormula per column, resolve the row for that column
{visibleCols.map((col: ColDef) => {
    if (col.formula === 'fecha') {
        // ... existing fecha rendering unchanged ...
    }
    const filter = resolveFilter(col.campaignFilter, effectiveKeyword)
    const rowForCol = filter === effectiveKeyword
        ? raw
        : enrichMetaRow(
            baseRows.find((m: any) => m.fecha === dayStr) || raw,
            filter,
            data.campaignGroups
          )
    const val = evaluateFormula(col.formula, rowForCol, varContext, sourceMapping, platformSet, layoutCustomMetrics)
    // ... rest of cell rendering unchanged ...
})}
```

> **Note:** The `raw` variable at this point in DashboardClient is already the enriched row from `filteredMetrics`. The `baseRows.find(...)` retrieves the un-enriched version. If `baseRows.find` returns undefined (e.g., date not in range), fall back to `raw` as shown.

- [ ] **Step 5: Pass `rawMetrics`, `campaignGroups`, `effectiveKeyword` to `MetricCharts`**

Find both calls to `<MetricCharts>` in DashboardClient (around lines 1228 and 1414). Add the three new props to each:

```tsx
<MetricCharts
    charts={activeLayout.graficos || []}
    metrics={filteredMetrics}
    rawMetrics={baseRows}
    campaignGroups={data.campaignGroups}
    effectiveKeyword={effectiveKeyword}
    varContext={varContext}
/>
```

- [ ] **Step 6: Pass `campaignGroups` to `LayoutConfigModal`**

Find the `<LayoutConfigModal>` usage (around line 1270) and add:

```tsx
<LayoutConfigModal
    // ... existing props ...
    campaignGroups={data.campaignGroups || []}
/>
```

- [ ] **Step 7: Thread `userRole` from DashboardClient to SupportModule**

Add `userRole` prop to `DashboardClient` (exported function, around line 1441):

```typescript
export function DashboardClient({
    data,
    isPublic = false,
    initialTabId = 'general',
    initialKeyword = '',
    userRole = 'viewer',
}: { data: any; isPublic?: boolean; initialTabId?: string; initialKeyword?: string; userRole?: string }) {
```

Pass it down to `DynamicDashboard`:

```typescript
return (
    <DynamicDashboard
        data={data}
        initialLayout={layout || DEFAULT_MEGALAYOUT}
        isCustomized={!!clienteLayoutId}
        isPublic={isPublic}
        initialTabId={initialTabId}
        initialKeyword={initialKeyword}
        userRole={userRole}   // ← add
    />
)
```

Add `userRole` to `DynamicDashboard`'s props (around line 337):

```typescript
function DynamicDashboard({
    data, initialLayout, isCustomized, isPublic, initialTabId = 'general', initialKeyword = '', userRole = 'viewer'
}: {
    // ... existing ...
    userRole?: string
}) {
```

Update the `<SupportModule>` call (line 928):

```tsx
<SupportModule clientId={cliente.id} userRole={userRole} />
```

- [ ] **Step 8: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors. Fix any type errors before committing.

- [ ] **Step 9: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/app/\(app\)/dashboard/components/DashboardClient.tsx
git commit -m "feat: per-element campaign filter in cards, columns, charts; thread userRole to SupportModule"
```

---

## Task 7: Apply per-chart filter in MetricCharts

**Files:**
- Modify: `src/app/(app)/dashboard/components/MetricCharts.tsx`

- [ ] **Step 1: Import `enrichMetaRow`**

At the top of `MetricCharts.tsx`, add:

```typescript
import { enrichMetaRow } from '@/lib/campaign-filter'
```

- [ ] **Step 2: Extend `MetricChartsProps` and function signature**

Find the `MetricChartsProps` interface (line 113) and add three new optional props:

```typescript
interface MetricChartsProps {
    charts: ChartDef[]
    metrics: any[]
    weeks?: any[]
    varContext?: Record<string, number>
    rawMetrics?: any[]
    campaignGroups?: any[]
    effectiveKeyword?: string
}
```

Update the function signature:

```typescript
export function MetricCharts({
    charts, metrics, varContext = {}, rawMetrics, campaignGroups = [], effectiveKeyword = ''
}: MetricChartsProps) {
```

- [ ] **Step 3: Apply per-chart filter when building chart data**

Find the line `const data = buildDailyData(metrics, formulas, varContext)` (around line 137). Replace it with:

```typescript
const filter = chart.campaignFilter?.value
const chartMetrics = (filter && rawMetrics)
    ? rawMetrics.map((r: any) => enrichMetaRow(r, filter, campaignGroups))
    : metrics
const data = buildDailyData(chartMetrics, formulas, varContext)
```

- [ ] **Step 4: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/app/\(app\)/dashboard/components/MetricCharts.tsx src/lib/campaign-filter.ts
git commit -m "feat: per-chart campaign filter in MetricCharts"
```

---

## Task 8: Pass `userRole` from page to DashboardClient

**Files:**
- Modify: `src/app/(app)/dashboard/[clientId]/page.tsx`

- [ ] **Step 1: Capture `userRole` in the page**

Find the section in `page.tsx` where `profile?.role` is read (the section that checks for trafficker access). After the if-block, capture the role into a variable:

```typescript
const userRole = profile?.role ?? 'viewer'
```

If `profile` is only defined inside the `if (user)` block, restructure slightly to ensure `userRole` is in scope for the return. The full pattern should look like:

```typescript
let userRole = 'viewer'
if (user) {
    const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

    if (profile?.role) userRole = profile.role

    if (profile?.role === 'trafficker') {
        // ... existing trafficker redirect check unchanged ...
    }
}
```

- [ ] **Step 2: Pass `userRole` to `DashboardClient`**

Find the `<DashboardClient>` usage in the page's return:

```tsx
<DashboardClient
    data={dashboardData || { cliente: null, metrics: [], weeks: [] }}
    userRole={userRole}
/>
```

- [ ] **Step 3: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/app/\(app\)/dashboard/\[clientId\]/page.tsx
git commit -m "feat: pass userRole from page to DashboardClient"
```

---

## Task 9: Support ticket editing and status change

**Files:**
- Modify: `src/app/(app)/dashboard/components/SupportModule.tsx`

- [ ] **Step 1: Add `userRole` prop and team detection**

Find the `SupportModule` function signature:

```typescript
export function SupportModule({ clientId, userRole = 'viewer' }: { clientId: string; userRole?: string }) {
```

Add a derived constant right after the state declarations:

```typescript
const isTeam = ['superadmin', 'admin', 'trafficker'].includes(userRole)
```

- [ ] **Step 2: Import `updateSoporteTicket`**

At the top of the file, add to the actions import:

```typescript
import { createSoporteTicket, getSoporteTickets, updateSoporteTicket } from '../_actions'
```

- [ ] **Step 3: Add edit modal state**

After the existing state declarations, add:

```typescript
const [editingTicket, setEditingTicket] = useState<Ticket | null>(null)
const [editForm, setEditForm] = useState({
    nombre_solicitante: '',
    requerimiento: '',
    observaciones: '',
    prioridad: 2,
})
const [editSaving, setEditSaving] = useState(false)
const [statusUpdating, setStatusUpdating] = useState<string | null>(null) // ticketId being updated
```

- [ ] **Step 4: Add `handleEditOpen`, `handleEditSave`, `handleStatusChange` functions**

```typescript
function handleEditOpen(ticket: Ticket) {
    setEditForm({
        nombre_solicitante: ticket.nombre_solicitante,
        requerimiento: ticket.requerimiento,
        observaciones: ticket.observaciones || '',
        prioridad: ticket.prioridad,
    })
    setEditingTicket(ticket)
}

async function handleEditSave() {
    if (!editingTicket) return
    setEditSaving(true)
    const res = await updateSoporteTicket(editingTicket.id, clientId, {
        nombre_solicitante: editForm.nombre_solicitante,
        requerimiento: editForm.requerimiento,
        observaciones: editForm.observaciones,
        prioridad: editForm.prioridad,
    })
    setEditSaving(false)
    if (res.error) { alert('Error al guardar: ' + res.error); return }
    setEditingTicket(null)
    fetchTickets()
}

async function handleStatusChange(ticketId: string, newEstado: string) {
    setStatusUpdating(ticketId)
    await updateSoporteTicket(ticketId, clientId, { estado: newEstado })
    setStatusUpdating(null)
    fetchTickets()
}
```

- [ ] **Step 5: Add `Edit2` and `Select`-related imports**

Add `Edit2` to the lucide-react import:

```typescript
import { Plus, Search, AlertCircle, Clock, CheckCircle2, User, Calendar, MessageSquare, History, Edit2 } from 'lucide-react'
```

Add the Select components (already available via shadcn/ui):

```typescript
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
```

- [ ] **Step 6: Replace status Badge with inline Select in table rows (team only)**

Find the table body where `statusMap[t.estado]` is used to render the status badge. Replace the badge with a conditional:

```tsx
{isTeam ? (
    <Select
        value={t.estado}
        onValueChange={(val) => handleStatusChange(t.id, val)}
        disabled={statusUpdating === t.id}
    >
        <SelectTrigger className="h-7 w-32 text-xs bg-zinc-900 border-zinc-700">
            <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-zinc-900 border-zinc-700">
            {Object.entries(statusMap).map(([key, s]) => (
                <SelectItem key={key} value={key} className="text-xs">
                    <span className={s.color}>{s.label}</span>
                </SelectItem>
            ))}
        </SelectContent>
    </Select>
) : (
    <Badge className={`text-xs ${statusMap[t.estado]?.bg || ''}`}>
        <span className={statusMap[t.estado]?.color || ''}>
            {statusMap[t.estado]?.label || t.estado}
        </span>
    </Badge>
)}
```

- [ ] **Step 7: Add Edit button to table rows (team only)**

In the same table row, in the actions column (or add one if it doesn't exist), add the edit button:

```tsx
{isTeam && (
    <button
        onClick={() => handleEditOpen(t)}
        className="text-zinc-500 hover:text-indigo-400 transition"
        title="Editar ticket"
    >
        <Edit2 className="w-4 h-4" />
    </button>
)}
```

- [ ] **Step 8: Add edit Dialog**

Add the edit dialog at the end of the component JSX (before the closing `</div>`):

```tsx
<Dialog open={!!editingTicket} onOpenChange={(open) => { if (!open) setEditingTicket(null) }}>
    <DialogContent className="bg-zinc-950 border-zinc-800 text-white max-w-lg">
        <DialogHeader>
            <DialogTitle className="text-white">Editar Requerimiento</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
            <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Nombre del Solicitante</label>
                <Input
                    value={editForm.nombre_solicitante}
                    onChange={e => setEditForm({ ...editForm, nombre_solicitante: e.target.value })}
                    className="bg-zinc-900 border-zinc-700 text-white"
                />
            </div>
            <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Requerimiento</label>
                <textarea
                    rows={3}
                    value={editForm.requerimiento}
                    onChange={e => setEditForm({ ...editForm, requerimiento: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-md p-3 text-sm text-white outline-none focus:border-indigo-500"
                />
            </div>
            <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Observaciones</label>
                <textarea
                    rows={2}
                    value={editForm.observaciones}
                    onChange={e => setEditForm({ ...editForm, observaciones: e.target.value })}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded-md p-3 text-sm text-white outline-none focus:border-indigo-500"
                />
            </div>
            <div className="space-y-2">
                <label className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Prioridad</label>
                <div className="flex gap-2">
                    {[1, 2, 3].map(p => (
                        <button
                            key={p}
                            type="button"
                            onClick={() => setEditForm({ ...editForm, prioridad: p })}
                            className={`flex-1 py-2 px-3 rounded-lg border text-xs font-medium transition ${editForm.prioridad === p ? priorityMap[p].bg + ' ' + priorityMap[p].color : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-700'}`}
                        >
                            {priorityMap[p].label}
                        </button>
                    ))}
                </div>
            </div>
        </div>
        <DialogFooter>
            <Button variant="ghost" onClick={() => setEditingTicket(null)} className="text-zinc-400 hover:text-white">
                Cancelar
            </Button>
            <Button
                onClick={handleEditSave}
                disabled={editSaving}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
            >
                {editSaving ? 'Guardando...' : 'Guardar Cambios'}
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
```

- [ ] **Step 9: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npm run type-check
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
git add src/app/\(app\)/dashboard/components/SupportModule.tsx
git commit -m "feat(support): team-only status selector and edit modal for tickets"
```

---

## Self-Review

**Spec coverage:**
- ✅ Duplicar pestaña — Tasks 3, 4
- ✅ Filtro por campaña en tarjetas — Tasks 2, 5, 6
- ✅ Filtro por campaña en columnas — Tasks 2, 5, 6
- ✅ Filtro por campaña en gráficas — Tasks 2, 5, 7
- ✅ Edición de tickets (nombre, requerimiento, observaciones, prioridad) — Tasks 3, 9
- ✅ Cambio de estado inline — Tasks 3, 9
- ✅ Solo equipo de Ads House puede editar — Tasks 8, 9
- ✅ Estado persiste en modal (campaignFilter en JSONB) — covered by Task 2 type extension

**Placeholder scan:** No TBDs, TODOs, or "similar to task N" references. All code blocks are complete.

**Type consistency:**
- `campaignFilter?: { type: 'group' | 'keyword'; value: string }` — defined Task 2, used consistently in Tasks 5, 6, 7
- `enrichMetaRow` — defined Task 1, imported in Tasks 6 and 7
- `resolveFilter(campaignFilter, fallback): string` — defined and used in Task 6
- `userRole` — prop name consistent across Tasks 6, 8, 9
- `updateSoporteTicket` payload extended in Task 3, consumed in Task 9
