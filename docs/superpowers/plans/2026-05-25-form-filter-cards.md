# Form Filter in Card Configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a lead-form filter to card/column/chart/ranking config in LayoutConfigModal so each metric block can be scoped to a specific Meta lead form (by form_id or form_name), using the same 8 operators as the campaign filter.

**Architecture:** New `meta_forms` JSONB column in `metricas_diarias` stores per-form metrics collected from Meta's Insights API with `leadgen_form_id` breakdown. A new `form-filter.ts` library mirrors `campaign-filter.ts`. A new `FormFilterPicker` React component mirrors `CampaignFilterPicker` and is wired into every row type in LayoutConfigModal. DashboardClient applies `enrichFormRow` on top of the existing `enrichMetaRow` pipeline.

**Tech Stack:** Next.js 14, TypeScript, Supabase (Postgres JSONB), Meta Graph API v19.0, React/Tailwind.

---

### Task 1: DB Migration — add `meta_forms` column

**Files:**
- Create: `migrations/020_meta_forms.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- migrations/020_meta_forms.sql
ALTER TABLE metricas_diarias
    ADD COLUMN IF NOT EXISTS meta_forms JSONB DEFAULT '[]'::jsonb;
```

- [ ] **Step 2: Run in Supabase SQL editor**

Open the Supabase dashboard → SQL Editor → paste the file contents → Run.
Expected: `ALTER TABLE` success message, no errors.

- [ ] **Step 3: Verify column exists**

In Supabase Table Editor, open `metricas_diarias` and confirm the `meta_forms` column appears with type `jsonb`. Existing rows should show `[]` as the default value.

- [ ] **Step 4: Commit**

```bash
git add migrations/020_meta_forms.sql
git commit -m "feat(db): add meta_forms JSONB column to metricas_diarias"
```

---

### Task 2: Types — FormFilterSpec + extend existing defs

**Files:**
- Modify: `src/lib/layout-types.ts:1-21` (after `CampaignFilterSpec`)

- [ ] **Step 1: Add `FormFilterField` and `FormFilterSpec` types**

Open `src/lib/layout-types.ts`. After the closing `}` of `CampaignFilterSpec` (currently line 20), insert:

```typescript
export type FormFilterField = 'form_id' | 'form_name'

export interface FormFilterSpec {
    field: FormFilterField
    operator?: CampaignFilterOperator
    value: string | string[]
}
```

- [ ] **Step 2: Add `formFilter` to `ColDef`**

In `ColDef` (around line 32), add after `campaignFilter?: CampaignFilterSpec`:

```typescript
    formFilter?: FormFilterSpec
```

- [ ] **Step 3: Add `formFilter` to `CardDef`**

In `CardDef` (around line 46), add after `campaignFilter?: CampaignFilterSpec`:

```typescript
    formFilter?: FormFilterSpec
```

- [ ] **Step 4: Add `formFilter` to `ChartDef`**

In `ChartDef` (around line 70), add after `campaignFilter?: CampaignFilterSpec`:

```typescript
    formFilter?: FormFilterSpec
```

- [ ] **Step 5: Add `formFilter` to `RankingTableDef`**

In `RankingTableDef` (around line 112), add after `campaignFilter?: CampaignFilterSpec`:

```typescript
    formFilter?: FormFilterSpec
```

- [ ] **Step 6: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npx tsc --noEmit
```

Expected: zero errors (new optional fields break nothing).

- [ ] **Step 7: Commit**

```bash
git add src/lib/layout-types.ts
git commit -m "feat(types): add FormFilterSpec and formFilter to layout defs"
```

---

### Task 3: Form filter library

**Files:**
- Create: `src/lib/form-filter.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/lib/form-filter.ts
import type { FormFilterSpec, CampaignFilterOperator } from './layout-types'

function formValueMatchesOperator(
    value: string,
    operator: CampaignFilterOperator,
    filterValue: string | string[]
): boolean {
    const v = value.toLowerCase()
    switch (operator) {
        case 'includes':    return typeof filterValue === 'string' && v.includes(filterValue.toLowerCase())
        case 'excludes':    return typeof filterValue === 'string' && !v.includes(filterValue.toLowerCase())
        case 'exact':       return typeof filterValue === 'string' && v === filterValue.toLowerCase()
        case 'not_exact':   return typeof filterValue === 'string' && v !== filterValue.toLowerCase()
        case 'starts_with': return typeof filterValue === 'string' && v.startsWith(filterValue.toLowerCase())
        case 'ends_with':   return typeof filterValue === 'string' && v.endsWith(filterValue.toLowerCase())
        case 'any_of':      return Array.isArray(filterValue) && filterValue.some(fv => fv.toLowerCase() === v)
        case 'none_of':     return Array.isArray(filterValue) && !filterValue.some(fv => fv.toLowerCase() === v)
        default:            return true
    }
}

export function enrichFormRow(
    row: any,
    filter: FormFilterSpec | undefined
): any {
    if (!filter) return row
    const isEmpty = Array.isArray(filter.value) ? filter.value.length === 0 : filter.value === ''
    if (isEmpty) return row

    const forms: any[] = Array.isArray(row.meta_forms) ? row.meta_forms : []
    const op: CampaignFilterOperator = filter.operator ?? 'includes'

    const matching = forms.filter(f => {
        const fieldValue: string = filter.field === 'form_id'
            ? (f.form_id || '')
            : (f.form_name || '')
        return formValueMatchesOperator(fieldValue, op, filter.value)
    })

    const ri = (field: string) => matching.reduce((s: number, f: any) => s + (parseInt(f[field] || '0') || 0), 0)
    const rf = (field: string) => matching.reduce((s: number, f: any) => s + (parseFloat(f[field] || '0') || 0), 0)

    return {
        ...row,
        meta_leads_form: ri('leads'),
        meta_leads:      ri('leads'),
        meta_spend:      rf('spend'),
        meta_impressions: ri('impressions'),
        meta_clicks:     ri('clicks'),
    }
}
```

- [ ] **Step 2: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/form-filter.ts
git commit -m "feat(lib): add form-filter.ts with enrichFormRow"
```

---

### Task 4: Worker — fetch Meta form data and store in `meta_forms`

**Files:**
- Modify: `src/app/api/worker/route.ts`

- [ ] **Step 1: Extend the `record` object in `fetchMetaSingleAccount`**

Find the line (~226) where `record` is initialized:
```typescript
const record = { spend: 0, impressions: 0, clicks: 0, account_reach: 0, campaigns: [] as any[], meta_ads: [] as any[], meta_adsets: [] as any[] }
```

Add `forms` to the object:
```typescript
const record = { spend: 0, impressions: 0, clicks: 0, account_reach: 0, campaigns: [] as any[], meta_ads: [] as any[], meta_adsets: [] as any[], forms: [] as any[] }
```

- [ ] **Step 2: Add the form breakdown query inside `fetchMetaSingleAccount`**

Find the closing `} catch (err: any) {` of the main campaign try-block (around line 218, after the targeting enrichment). Just before the `return campaigns` at the end of the function body (around line 221), add a new try-block to fetch form data. Place it after the targeting enrichment block and before `return campaigns`.

Actually `fetchMetaSingleAccount` returns the entire `record`. Add the form query right before the final `return record` of the function. Find the line `return record` at the end of `fetchMetaSingleAccount` (search for `return record` inside that function) and insert before it:

```typescript
            // ─── Lead form breakdown (Meta Lead Ads) ──────────────────────────
            try {
                const formUrl = new URL(`https://graph.facebook.com/v19.0/${actId}/insights`)
                formUrl.searchParams.append('access_token', token)
                formUrl.searchParams.append('time_range', JSON.stringify({ since: targetDate, until: targetDate }))
                formUrl.searchParams.append('fields', 'leadgen_form_id,spend,impressions,clicks,actions')
                formUrl.searchParams.append('breakdowns', 'leadgen_form_id')
                formUrl.searchParams.append('level', 'account')
                formUrl.searchParams.append('limit', '200')

                const formRes = await fetch(formUrl.toString())
                const formData = await formRes.json()

                if (formData.data && Array.isArray(formData.data)) {
                    const formsMap = new Map<string, any>()

                    for (const item of formData.data) {
                        const formId: string = item.leadgen_form_id || ''
                        if (!formId) continue

                        const existing = formsMap.get(formId) || {
                            form_id:     formId,
                            form_name:   formId,  // fallback until name is resolved
                            leads:       0,
                            spend:       0,
                            impressions: 0,
                            clicks:      0,
                        }

                        existing.spend       += parseFloat(item.spend || '0')
                        existing.impressions += parseInt(item.impressions || '0')
                        existing.clicks      += parseInt(item.clicks || '0')

                        if (item.actions) {
                            for (const a of item.actions) {
                                if (a.action_type === 'lead') {
                                    existing.leads += parseInt(a.value || '0')
                                }
                            }
                        }

                        formsMap.set(formId, existing)
                    }

                    record.forms = Array.from(formsMap.values())
                }
            } catch (err: any) {
                log(`[Meta] Form breakdown fetch failed (non-critical): ${err?.message}`)
                // record.forms stays as [] — safe default
            }
```

- [ ] **Step 3: Add `meta_forms` to the upsert payload**

Find the upsert payload block (around line 1295). It currently has:
```typescript
meta_campaigns: metaRecord.campaigns,
meta_ads:      metaRecord.meta_ads,
meta_adsets:   metaRecord.meta_adsets,
```

Add after `meta_adsets`:
```typescript
meta_forms:    metaRecord.forms,
```

- [ ] **Step 4: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/worker/route.ts
git commit -m "feat(worker): fetch Meta leadgen form breakdown and store in meta_forms"
```

---

### Task 5: UI — `FormFilterPicker` component + wiring

**Files:**
- Modify: `src/app/(app)/dashboard/components/LayoutConfigModal.tsx`

- [ ] **Step 1: Update the import at line 13**

The current import is:
```typescript
import type { ColDef, CardDef, ChartDef, ChartType, ReportLayout, CardColor, CampaignFilterSpec, CampaignFilterOperator, RankingTableDef, RankingColumnDef } from '@/lib/layout-types'
```

Replace with:
```typescript
import type { ColDef, CardDef, ChartDef, ChartType, ReportLayout, CardColor, CampaignFilterSpec, CampaignFilterOperator, RankingTableDef, RankingColumnDef, FormFilterSpec, FormFilterField } from '@/lib/layout-types'
```

- [ ] **Step 2: Add `FormFilterPicker` component**

Find the line `// ─── Campaign Filter Picker ───────────────────────────────────────────────────` (around line 832). After the closing `}` of the entire `CampaignFilterPicker` function (look for the last `}` before the next `// ───` section comment), insert the `FormFilterPicker` component:

```typescript
// ─── Form Filter Picker ───────────────────────────────────────────────────────

function FormFilterPicker({
    value,
    onChange,
    formNames = [],
    formIds = [],
}: {
    value?: FormFilterSpec
    onChange: (v: FormFilterSpec | undefined) => void
    formNames?: string[]
    formIds?: string[]
}) {
    const [currentField, setCurrentField] = useState<FormFilterField>(value?.field ?? 'form_name')
    const currentOp: CampaignFilterOperator = value?.operator ?? 'includes'
    const isMulti = FILTER_OPERATORS.find(o => o.value === currentOp)?.multi ?? false
    const suggestions = currentField === 'form_name' ? formNames : formIds

    const [kwSearch, setKwSearch] = useState(
        value && !isMulti && typeof value.value === 'string' ? value.value : ''
    )
    const [showSuggestions, setShowSuggestions] = useState(false)
    const [showMultiPanel, setShowMultiPanel] = useState(false)
    const [multiSearch, setMultiSearch] = useState('')
    const multiRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (isMulti) setKwSearch('')
    }, [value, isMulti])

    useEffect(() => {
        if (!showMultiPanel) return
        const handler = (e: MouseEvent) => {
            if (multiRef.current && !multiRef.current.contains(e.target as Node)) {
                setShowMultiPanel(false)
                setMultiSearch('')
            }
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [showMultiPanel])

    const selectedMulti: string[] = (value && Array.isArray(value.value)) ? value.value : []
    const filteredSuggestions = suggestions.filter(n =>
        kwSearch === '' || n.toLowerCase().includes(kwSearch.toLowerCase())
    )
    const filteredMulti = suggestions.filter(n =>
        multiSearch === '' || n.toLowerCase().includes(multiSearch.toLowerCase())
    )

    function handleFieldChange(field: FormFilterField) {
        setCurrentField(field)
        onChange(undefined)
        setKwSearch('')
    }

    function handleOperatorChange(op: CampaignFilterOperator) {
        const opDef = FILTER_OPERATORS.find(o => o.value === op)!
        if (opDef.multi) {
            onChange({ field: currentField, operator: op, value: selectedMulti })
            setShowMultiPanel(true)
        } else {
            const currentVal = kwSearch || ''
            onChange(currentVal ? { field: currentField, operator: op, value: currentVal } : undefined)
        }
    }

    function toggleMultiItem(name: string) {
        const next = selectedMulti.includes(name)
            ? selectedMulti.filter(n => n !== name)
            : [...selectedMulti, name]
        onChange(next.length > 0 ? { field: currentField, operator: currentOp, value: next } : undefined)
    }

    const hasFilter = value !== undefined

    return (
        <div className="flex items-center gap-1.5 flex-shrink-0" title="Filtro de formulario (opcional)">
            <span className="text-[10px] text-zinc-600 flex-shrink-0">Form:</span>

            {/* Field selector */}
            <select
                value={currentField}
                onChange={e => handleFieldChange(e.target.value as FormFilterField)}
                className="h-6 text-xs bg-zinc-950 border border-zinc-700 text-zinc-300 rounded px-1.5 max-w-[80px]"
            >
                <option value="form_name">Nombre</option>
                <option value="form_id">ID</option>
            </select>

            {/* Operator selector */}
            <select
                value={currentOp}
                onChange={e => handleOperatorChange(e.target.value as CampaignFilterOperator)}
                className="h-6 text-xs bg-zinc-950 border border-zinc-700 text-zinc-300 rounded px-1.5 max-w-[120px]"
            >
                {FILTER_OPERATORS.map(op => (
                    <option key={op.value} value={op.value}>{op.label}</option>
                ))}
            </select>

            {/* Single-value input */}
            {!isMulti && (
                <div className="relative">
                    <Input
                        value={kwSearch}
                        onChange={e => {
                            setKwSearch(e.target.value)
                            if (e.target.value) onChange({ field: currentField, operator: currentOp, value: e.target.value })
                            else if (value) onChange(undefined)
                            setShowSuggestions(true)
                        }}
                        onFocus={() => setShowSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                        placeholder={currentField === 'form_name' ? 'Buscar formulario...' : 'ID del formulario...'}
                        className="h-6 text-xs bg-zinc-950 border-zinc-700 text-zinc-300 w-40"
                    />
                    {showSuggestions && filteredSuggestions.length > 0 && (
                        <div className="absolute top-7 left-0 z-[120] bg-zinc-900 border border-zinc-800 rounded shadow-lg max-h-48 overflow-y-auto w-56 custom-scrollbar">
                            {filteredSuggestions.map(name => (
                                <button
                                    key={name}
                                    onMouseDown={e => e.preventDefault()}
                                    onClick={() => {
                                        setKwSearch(name)
                                        onChange({ field: currentField, operator: currentOp, value: name })
                                        setShowSuggestions(false)
                                    }}
                                    className="w-full text-left px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 transition truncate block"
                                >
                                    {name}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Multi-select panel */}
            {isMulti && (
                <div className="relative" ref={multiRef}>
                    <button
                        onClick={() => setShowMultiPanel(v => !v)}
                        className={`h-6 px-2 text-xs rounded border transition ${selectedMulti.length > 0 ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300' : 'bg-zinc-950 border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
                    >
                        {selectedMulti.length > 0 ? `${selectedMulti.length} form${selectedMulti.length > 1 ? 's' : ''}` : 'Elegir…'}
                    </button>
                    {showMultiPanel && (
                        <div className="absolute top-7 left-0 z-[120] bg-zinc-900 border border-zinc-800 rounded shadow-lg w-56 custom-scrollbar">
                            <div className="p-1 border-b border-zinc-800">
                                <Input
                                    value={multiSearch}
                                    onChange={e => setMultiSearch(e.target.value)}
                                    placeholder="Buscar..."
                                    className="h-6 text-xs bg-zinc-950 border-zinc-700 text-zinc-300"
                                    autoFocus
                                />
                            </div>
                            <div className="max-h-48 overflow-y-auto">
                                {filteredMulti.map(name => (
                                    <label key={name} className="flex items-center gap-2 px-2 py-1.5 hover:bg-zinc-800 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={selectedMulti.includes(name)}
                                            onChange={() => toggleMultiItem(name)}
                                            className="accent-indigo-500"
                                        />
                                        <span className="text-xs text-zinc-300 truncate">{name}</span>
                                    </label>
                                ))}
                                {filteredMulti.length === 0 && (
                                    <p className="text-xs text-zinc-600 px-2 py-2">Sin resultados</p>
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Clear */}
            {hasFilter && (
                <button
                    onClick={() => { onChange(undefined); setKwSearch('') }}
                    className="text-zinc-600 hover:text-red-400 transition flex-shrink-0"
                    title="Quitar filtro de formulario"
                >
                    <X className="w-3 h-3" />
                </button>
            )}
        </div>
    )
}
```

- [ ] **Step 3: Wire `FormFilterPicker` into `DraggableColRow`**

Find `DraggableColRow` (around line 312). Its destructuring currently ends with `campaignNames = []`. Update the props destructuring and type block:

```typescript
function DraggableColRow({
    col, index, onDragStart, onDragOver, onDrop, onUpdate, onRemove, availableMetrics, campaignGroups = [], campaignNames = [], formNames = [], formIds = []
}: {
    col: ColDef
    index: number
    onDragStart: (i: number) => void
    onDragOver: (e: React.DragEvent, i: number) => void
    onDrop: (i: number) => void
    onUpdate: (col: ColDef) => void
    onRemove: () => void
    availableMetrics?: { id: string; label: string }[]
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
    formNames?: string[]
    formIds?: string[]
})
```

Then, immediately after the `<CampaignFilterPicker ... />` usage in the column row (around line 380), add:

```tsx
<FormFilterPicker
    value={col.formFilter}
    onChange={v => onUpdate({ ...col, formFilter: v })}
    formNames={formNames}
    formIds={formIds}
/>
```

- [ ] **Step 4: Wire `FormFilterPicker` into `DraggableCardRow`**

Find `DraggableCardRow` (around line 420). Update exactly as in Step 3, adding `formNames = []` and `formIds = []` to both the destructuring and type block.

Then after the `<CampaignFilterPicker ... />` on the card row (around line 478), add:

```tsx
<FormFilterPicker
    value={card.formFilter}
    onChange={v => onUpdate({ ...card, formFilter: v })}
    formNames={formNames}
    formIds={formIds}
/>
```

- [ ] **Step 5: Wire `FormFilterPicker` into the chart row**

Find the chart row component (around line 520). Add `formNames = []` and `formIds = []` to its props identically. After the `<CampaignFilterPicker ... />` (around line 790), add:

```tsx
<FormFilterPicker
    value={chart.formFilter}
    onChange={v => onUpdate({ ...chart, formFilter: v })}
    formNames={formNames}
    formIds={formIds}
/>
```

- [ ] **Step 6: Wire `FormFilterPicker` into the ranking table row**

Find the ranking table `CampaignFilterPicker` usage (around line 1837). The block currently is:

```tsx
{!table.dimension.startsWith('tiktok_') && (
    <div className="pl-1">
        <CampaignFilterPicker
            value={table.campaignFilter}
            onChange={v => updateRankingTable(ti, { ...table, campaignFilter: v })}
            campaignGroups={campaignGroups}
            campaignNames={campaignNames}
        />
    </div>
)}
```

Add `FormFilterPicker` directly after the closing `)}` of that block:

```tsx
<div className="pl-1">
    <FormFilterPicker
        value={table.formFilter}
        onChange={v => updateRankingTable(ti, { ...table, formFilter: v })}
        formNames={formNames}
        formIds={formIds}
    />
</div>
```

Note: form filter is NOT gated on `!tiktok_` — it shows for all dimensions since `meta_forms` is platform-agnostic in the type.

- [ ] **Step 7: Update `LayoutConfigModal` main props**

Find the `LayoutConfigModal` function signature (around line 1062). Add `formNames` and `formIds` to the props:

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
    campaignGroups = [],
    campaignNames = [],
    formNames = [],
    formIds = [],
}: {
    clienteId: string
    currentLayout: ReportLayout | null
    allLayouts: any[]
    isCustomized: boolean
    onClose: () => void
    onLayoutApplied: (layout: ReportLayout) => void
    tabId?: string
    conversionesCatalogo?: { conversion_key: string; label: string; field_id: string }[]
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
    formNames?: string[]
    formIds?: string[]
})
```

- [ ] **Step 8: Pass `formNames`/`formIds` to every row call in LayoutConfigModal**

Search inside `LayoutConfigModal`'s JSX for every place that renders a `DraggableColRow`, `DraggableCardRow`, or the chart/ranking row component. For each, add:

```tsx
formNames={formNames}
formIds={formIds}
```

(There are typically ~3-4 call sites: columns list, cards list, charts list, ranking tables list.)

- [ ] **Step 9: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 10: Commit**

```bash
git add src/app/(app)/dashboard/components/LayoutConfigModal.tsx
git commit -m "feat(ui): add FormFilterPicker to card/col/chart/ranking config in LayoutConfigModal"
```

---

### Task 6: Dashboard integration — extract form data + apply filter

**Files:**
- Modify: `src/app/(app)/dashboard/components/DashboardClient.tsx`

- [ ] **Step 1: Import `enrichFormRow`**

Find the existing import at line 27:
```typescript
import { enrichMetaRow } from '@/lib/campaign-filter'
```

Add after it:
```typescript
import { enrichFormRow } from '@/lib/form-filter'
```

- [ ] **Step 2: Import `FormFilterSpec` type**

Find the import of layout types (around line 13-15). Add `FormFilterSpec` to the existing type import from `@/lib/layout-types`.

- [ ] **Step 3: Compute `allFormNames` and `allFormIds` memos**

Find the `allCampaignNames` memo (around line 567):
```typescript
const allCampaignNames = useMemo(() => {
    const names = new Set<string>()
    for (const row of baseRows) {
        if (Array.isArray((row as any).meta_campaigns)) {
            for (const c of (row as any).meta_campaigns) {
                if (c.name) names.add(c.name)
            }
        }
    }
    return Array.from(names).sort()
}, [baseRows])
```

Add immediately after it:
```typescript
const allFormNames = useMemo(() => {
    const names = new Set<string>()
    for (const row of baseRows) {
        if (Array.isArray((row as any).meta_forms)) {
            for (const f of (row as any).meta_forms) {
                if (f.form_name && f.form_name !== f.form_id) names.add(f.form_name)
            }
        }
    }
    return Array.from(names).sort()
}, [baseRows])

const allFormIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of baseRows) {
        if (Array.isArray((row as any).meta_forms)) {
            for (const f of (row as any).meta_forms) {
                if (f.form_id) ids.add(f.form_id)
            }
        }
    }
    return Array.from(ids).sort()
}, [baseRows])
```

- [ ] **Step 4: Apply `enrichFormRow` in `tarjetaValues`**

Find the `tarjetaValues` memo (around line 660):
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

Replace with:
```typescript
const tarjetaValues = useMemo(() => {
    return activeLayout.tarjetas.map((t: CardDef) => {
        const filter = resolveFilter(t.campaignFilter, effectiveKeyword)
        let rows = filter === effectiveKeyword
            ? filteredMetrics
            : baseRows.map((m: any) => enrichMetaRow(m, filter, data.campaignGroups))
        if (t.formFilter) {
            rows = rows.map((m: any) => enrichFormRow(m, t.formFilter))
        }
        return {
            ...t,
            value: aggregateFormula(t.formula, rows, varContext, sourceMapping, platformSet, layoutCustomMetrics),
        }
    })
}, [activeLayout.tarjetas, filteredMetrics, baseRows, effectiveKeyword, varContext, sourceMapping, platformSet, layoutCustomMetrics, data.campaignGroups])
```

- [ ] **Step 5: Apply `enrichFormRow` in column cell rendering**

Find the column cell rendering block (around line 1190):
```typescript
const filter = resolveFilter(col.campaignFilter, effectiveKeyword)
const rowForCol = filter === effectiveKeyword
    ? raw
    : (() => {
        const base = baseRows.find((m: any) => m.fecha === dayStr)
        return base ? enrichMetaRow(base, filter, data.campaignGroups) : raw
    })()
```

Replace with:
```typescript
const filter = resolveFilter(col.campaignFilter, effectiveKeyword)
let rowForCol = filter === effectiveKeyword
    ? raw
    : (() => {
        const base = baseRows.find((m: any) => m.fecha === dayStr)
        return base ? enrichMetaRow(base, filter, data.campaignGroups) : raw
    })()
if (col.formFilter) {
    rowForCol = enrichFormRow(rowForCol, col.formFilter)
}
```

- [ ] **Step 6: Pass `formNames` and `formIds` to `LayoutConfigModal`**

Find the `LayoutConfigModal` render (around line 1320):
```tsx
campaignGroups={data.campaignGroups || []}
campaignNames={allCampaignNames}
```

Add after `campaignNames`:
```tsx
formNames={allFormNames}
formIds={allFormIds}
```

- [ ] **Step 7: Type-check**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/(app)/dashboard/components/DashboardClient.tsx
git commit -m "feat(dashboard): apply form filter in tarjetaValues and column rendering"
```

---

### Task 7: Manual verification

- [ ] **Step 1: Start dev server**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main"
npm run dev
```

- [ ] **Step 2: Verify FormFilterPicker appears in card config**

1. Open the dashboard for a client.
2. Click the config button (⚙️) to open `LayoutConfigModal`.
3. Go to the **Tarjetas** section.
4. Expand any card row.
5. Confirm a `Form:` picker appears next to the existing `Campaña:` picker with "Nombre"/"ID" selector, operator dropdown, and search input.

- [ ] **Step 3: Verify filter saves and persists**

1. Set a form filter on a card: field=Nombre, operator=Incluye, value="test".
2. Click Save.
3. Close and reopen the modal.
4. Confirm the filter is still set with the saved values.

- [ ] **Step 4: Verify filter works when `meta_forms` has data**

After the next worker sync runs (or trigger it manually via the dashboard sync button), `meta_forms` should be populated for accounts that run Lead Ads. Verify:
- A card with `formFilter` active shows a different (lower) value than the same card without the filter.
- A card with no `formFilter` is unchanged from before.

- [ ] **Step 5: Verify graceful no-data state**

For a client that has no Lead Ads, `meta_forms` will be `[]`. Confirm:
- Cards with `formFilter` set show `0` or `null` (not an error).
- Cards with no `formFilter` are completely unaffected.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: form filter for cards/cols/charts/ranking tables — full integration"
```
