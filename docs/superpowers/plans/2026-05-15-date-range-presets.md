# Date Range Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual Desde/Hasta date inputs in `DateRangeSelector` with a button + popover dropdown containing 13 date preset options (radio buttons), applying immediately on selection; "Personalizado" reveals manual inputs inside the popover.

**Architecture:** The component is fully client-side. Preset dates are computed with `date-fns` at click time. Selecting a preset calls `router.push` immediately with `?from=YYYY-MM-DD&to=YYYY-MM-DD` (or `?from=all` for Máximo). The server action `getDashboardData` is updated to skip the lower date filter when `startStr === 'all'`.

**Tech Stack:** Next.js 14 App Router, React, date-fns, Radix UI Popover (`@/components/ui/popover`), Tailwind CSS, Supabase.

---

## Files

- Modify: `src/app/(app)/dashboard/components/DateRangeSelector.tsx`
- Modify: `src/app/(app)/dashboard/_actions.ts` (lines 108–120 and 648–659)

---

## Task 1: Update `_actions.ts` to support `from=all`

**Files:**

- Modify: `src/app/(app)/dashboard/_actions.ts`

### Context

`getDashboardData` (line 61) queries Supabase with `.gte('fecha', startStr)`. When `startStr === 'all'`, this must be skipped. Same applies to `getMirrorDashboardData` (line 593). `getWeeksInRange` would crash with `'all'` so it needs a fallback date.

- [ ] **Step 1: Update `getDashboardData` — replace the `Promise.all` for metrics+leads (lines 108–120) with conditional query building**

Replace this block in `getDashboardData`:

```typescript
// Fetch all metrics + leads for that range
const [metricsRes, leadsRes] = await Promise.all([
  supabase
    .from('metricas_diarias')
    .select('*')
    .eq('cliente_id', cliente.id)
    .gte('fecha', startStr)
    .lte('fecha', endStr)
    .order('fecha', { ascending: true }),
  supabase
    .from('leads_diarios')
    .select('*')
    .eq('client_id', cliente.id)
    .gte('date', startStr)
    .lte('date', endStr),
]);
```

With:

```typescript
// Fetch all metrics + leads for that range
let metricsQuery = supabase.from('metricas_diarias').select('*').eq('cliente_id', cliente.id);
if (startStr !== 'all') metricsQuery = metricsQuery.gte('fecha', startStr);
metricsQuery = metricsQuery.lte('fecha', endStr).order('fecha', { ascending: true });

let leadsQuery = supabase.from('leads_diarios').select('*').eq('client_id', cliente.id);
if (startStr !== 'all') leadsQuery = leadsQuery.gte('date', startStr);
leadsQuery = leadsQuery.lte('date', endStr);

const [metricsRes, leadsRes] = await Promise.all([metricsQuery, leadsQuery]);
```

- [ ] **Step 2: Update the `getWeeksInRange` call in `getDashboardData` (line 141) to handle `'all'`**

Replace:

```typescript
const weeks = getWeeksInRange(startStr, endStr);
```

With:

```typescript
const effectiveStart = startStr === 'all' ? '2020-01-01' : startStr;
const weeks = getWeeksInRange(effectiveStart, endStr);
```

- [ ] **Step 3: Update `getMirrorDashboardData` — same conditional query building for its metrics+leads block (around line 648)**

Replace this block in `getMirrorDashboardData`:

```typescript
    const [metricsRes, leadsRes, conversionesRes, campaignGroupsRes, tabsRes, allLayoutsRes] = await Promise.all([
        supabase.from('metricas_diarias')
            .select('*')
            .eq('cliente_id', cliente.id)
            .gte('fecha', startStr)
            .lte('fecha', endStr)
            .order('fecha', { ascending: true }),
        supabase.from('leads_diarios')
            .select('*')
            .eq('client_id', cliente.id)
            .gte('date', startStr)
            .lte('date', endStr),
```

With:

```typescript
    let mirrorMetricsQuery = supabase.from('metricas_diarias')
        .select('*')
        .eq('cliente_id', cliente.id)
    if (startStr !== 'all') mirrorMetricsQuery = mirrorMetricsQuery.gte('fecha', startStr)
    mirrorMetricsQuery = mirrorMetricsQuery.lte('fecha', endStr).order('fecha', { ascending: true })

    let mirrorLeadsQuery = supabase.from('leads_diarios')
        .select('*')
        .eq('client_id', cliente.id)
    if (startStr !== 'all') mirrorLeadsQuery = mirrorLeadsQuery.gte('date', startStr)
    mirrorLeadsQuery = mirrorLeadsQuery.lte('date', endStr)

    const [metricsRes, leadsRes, conversionesRes, campaignGroupsRes, tabsRes, allLayoutsRes] = await Promise.all([
        mirrorMetricsQuery,
        mirrorLeadsQuery,
```

- [ ] **Step 4: Update `getWeeksInRange` call in `getMirrorDashboardData` (around line 681)**

Replace:

```typescript
const weeks = getWeeksInRange(startStr, endStr);
```

With:

```typescript
const effectiveStart = startStr === 'all' ? '2020-01-01' : startStr;
const weeks = getWeeksInRange(effectiveStart, endStr);
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd "src/app/(app)/dashboard" && npx tsc --noEmit 2>&1 | head -30
```

Expected: no errors in `_actions.ts`.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/dashboard/_actions.ts"
git commit -m "feat: support from=all in getDashboardData and getMirrorDashboardData for Máximo preset"
```

---

## Task 2: Rewrite `DateRangeSelector.tsx` with preset dropdown

**Files:**

- Modify: `src/app/(app)/dashboard/components/DateRangeSelector.tsx`

### Context

The full current file is 124 lines. The render section (lines 64–123) gets replaced entirely. The state and sync logic (lines 12–62) is preserved. A `PRESETS` constant and `getActivePreset` helper are added at the top of the file.

- [ ] **Step 1: Replace the entire file content**

```typescript
'use client'

import React, { useState } from 'react'
import { useRouter, useSearchParams, useParams } from 'next/navigation'
import {
    format, subDays,
    startOfWeek, endOfWeek, subWeeks,
    startOfMonth, endOfMonth, subMonths,
} from 'date-fns'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Loader2, RefreshCcw, CheckCircle2, AlertCircle, ChevronDown, CalendarDays } from 'lucide-react'
import { triggerWorkerSync } from '../_actions'

const fmt = (d: Date) => format(d, 'yyyy-MM-dd')

type Preset = { id: string; label: string; getRange: () => { from: string; to: string } }

const PRESETS: Preset[] = [
    { id: 'today', label: 'Hoy', getRange: () => { const t = new Date(); return { from: fmt(t), to: fmt(t) } } },
    { id: 'yesterday', label: 'Ayer', getRange: () => { const y = subDays(new Date(), 1); return { from: fmt(y), to: fmt(y) } } },
    { id: 'today_yesterday', label: 'Hoy y ayer', getRange: () => ({ from: fmt(subDays(new Date(), 1)), to: fmt(new Date()) }) },
    { id: 'last7', label: 'Últimos 7 días', getRange: () => ({ from: fmt(subDays(new Date(), 6)), to: fmt(new Date()) }) },
    { id: 'last14', label: 'Últimos 14 días', getRange: () => ({ from: fmt(subDays(new Date(), 13)), to: fmt(new Date()) }) },
    { id: 'last28', label: 'Últimos 28 días', getRange: () => ({ from: fmt(subDays(new Date(), 27)), to: fmt(new Date()) }) },
    { id: 'last30', label: 'Últimos 30 días', getRange: () => ({ from: fmt(subDays(new Date(), 29)), to: fmt(new Date()) }) },
    { id: 'this_week', label: 'Esta semana', getRange: () => ({ from: fmt(startOfWeek(new Date(), { weekStartsOn: 1 })), to: fmt(new Date()) }) },
    {
        id: 'last_week', label: 'La semana pasada', getRange: () => {
            const ref = subWeeks(new Date(), 1)
            return { from: fmt(startOfWeek(ref, { weekStartsOn: 1 })), to: fmt(endOfWeek(ref, { weekStartsOn: 1 })) }
        }
    },
    { id: 'this_month', label: 'Este mes', getRange: () => ({ from: fmt(startOfMonth(new Date())), to: fmt(new Date()) }) },
    {
        id: 'last_month', label: 'El mes pasado', getRange: () => {
            const ref = subMonths(new Date(), 1)
            return { from: fmt(startOfMonth(ref)), to: fmt(endOfMonth(ref)) }
        }
    },
    { id: 'all', label: 'Máximo', getRange: () => ({ from: 'all', to: fmt(new Date()) }) },
]

function getActivePreset(from: string, to: string): string {
    for (const preset of PRESETS) {
        const range = preset.getRange()
        if (range.from === from && range.to === to) return preset.id
    }
    return 'personalizado'
}

export function DateRangeSelector({ basePath = '/dashboard', isPublic = false }: { basePath?: string; isPublic?: boolean }) {
    const router = useRouter()
    const searchParams = useSearchParams()
    const params = useParams()
    const clientId = params.clientId as string | undefined
    const token = params.token as string | undefined

    const fromParam = searchParams.get('from') || fmt(subDays(new Date(), 29))
    const toParam = searchParams.get('to') || fmt(new Date())

    const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle')
    const [syncLogs, setSyncLogs] = useState<{ meta?: string; hotmart?: string; ga4?: string }>({})

    const [open, setOpen] = useState(false)
    const [showCustom, setShowCustom] = useState(false)
    const [customFrom, setCustomFrom] = useState(fromParam)
    const [customTo, setCustomTo] = useState(toParam)

    const activePresetId = getActivePreset(fromParam, toParam)
    const activeLabel = PRESETS.find(p => p.id === activePresetId)?.label ?? 'Personalizado'

    const navigate = (from: string, to: string) => {
        const id = isPublic ? token : clientId
        router.push(`${basePath}/${id}?from=${from}&to=${to}`)
    }

    const handleOpenChange = (v: boolean) => {
        setOpen(v)
        if (v) {
            setShowCustom(activePresetId === 'personalizado')
            setCustomFrom(fromParam)
            setCustomTo(toParam)
        }
    }

    const handlePresetSelect = (presetId: string) => {
        if (presetId === 'personalizado') {
            setShowCustom(true)
            return
        }
        const preset = PRESETS.find(p => p.id === presetId)
        if (!preset) return
        const range = preset.getRange()
        setOpen(false)
        navigate(range.from, range.to)
    }

    const handleCustomApply = () => {
        setOpen(false)
        navigate(customFrom, customTo)
    }

    const handleSync = async () => {
        if (!clientId || isPublic) return
        setSyncStatus('syncing')
        setSyncLogs({})
        try {
            const syncFrom = fromParam === 'all' ? fmt(subDays(new Date(), 365)) : fromParam
            const result = await triggerWorkerSync(clientId, syncFrom, toParam)
            if (!result.ok) throw new Error(result.error || 'Failed to sync')
            setSyncLogs(result.platform_status ?? { meta: 'Sincronizado', hotmart: 'Sincronizado', ga4: 'Sincronizado' })
            setSyncStatus('success')
            router.refresh()
            setTimeout(() => setSyncStatus('idle'), 5000)
        } catch (err) {
            console.error('Error sincronizando', err)
            setSyncStatus('error')
            setTimeout(() => setSyncStatus('idle'), 5000)
        }
    }

    const isCustomSelected = activePresetId === 'personalizado' || showCustom

    return (
        <div className="flex flex-col sm:flex-row items-center gap-3 bg-zinc-900 border border-zinc-800 p-2 rounded-lg mt-4 sm:mt-0">
            <Popover open={open} onOpenChange={handleOpenChange}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-2 border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 hover:text-zinc-100"
                    >
                        <CalendarDays className="h-4 w-4 text-zinc-400" />
                        {activeLabel}
                        <ChevronDown className="h-4 w-4 text-zinc-400" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent
                    className="w-52 p-2 bg-zinc-900 border-zinc-700 shadow-xl"
                    align="start"
                    sideOffset={6}
                >
                    <div className="max-h-72 overflow-y-auto space-y-0.5">
                        {PRESETS.map(preset => {
                            const isActive = activePresetId === preset.id && !showCustom
                            return (
                                <button
                                    key={preset.id}
                                    onClick={() => handlePresetSelect(preset.id)}
                                    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm rounded-md text-left transition-colors
                                        ${isActive ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'}`}
                                >
                                    <span className={`h-3.5 w-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center
                                        ${isActive ? 'border-blue-500' : 'border-zinc-600'}`}>
                                        {isActive && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
                                    </span>
                                    {preset.label}
                                </button>
                            )
                        })}
                        <button
                            onClick={() => handlePresetSelect('personalizado')}
                            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm rounded-md text-left transition-colors
                                ${isCustomSelected ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'}`}
                        >
                            <span className={`h-3.5 w-3.5 rounded-full border-2 flex-shrink-0 flex items-center justify-center
                                ${isCustomSelected ? 'border-blue-500' : 'border-zinc-600'}`}>
                                {isCustomSelected && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
                            </span>
                            Personalizado
                        </button>
                    </div>

                    {isCustomSelected && (
                        <div className="mt-2 pt-2 border-t border-zinc-700 space-y-2">
                            <div className="flex flex-col gap-1">
                                <span className="text-xs text-zinc-500 ml-1">Desde</span>
                                <input
                                    type="date"
                                    value={customFrom === 'all' ? '' : customFrom}
                                    onChange={e => setCustomFrom(e.target.value)}
                                    className="bg-zinc-800 text-zinc-100 border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-zinc-500 cursor-pointer w-full"
                                />
                            </div>
                            <div className="flex flex-col gap-1">
                                <span className="text-xs text-zinc-500 ml-1">Hasta</span>
                                <input
                                    type="date"
                                    value={customTo}
                                    onChange={e => setCustomTo(e.target.value)}
                                    className="bg-zinc-800 text-zinc-100 border-none rounded p-1.5 text-sm focus:ring-1 focus:ring-zinc-500 cursor-pointer w-full"
                                />
                            </div>
                            <Button
                                onClick={handleCustomApply}
                                size="sm"
                                className="w-full h-8 bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
                            >
                                Aplicar
                            </Button>
                        </div>
                    )}
                </PopoverContent>
            </Popover>

            <div className="h-8 w-px bg-zinc-700 hidden sm:block mx-1" />

            <div className={`flex flex-col items-end ${isPublic ? 'hidden' : ''}`}>
                <Button
                    onClick={handleSync}
                    variant="outline"
                    size="sm"
                    disabled={syncStatus === 'syncing' || !clientId}
                    className={`mt-4 sm:mt-0 h-8 gap-2 border-zinc-700 bg-zinc-950 text-zinc-300 transition-colors
                        ${syncStatus === 'success' ? 'text-green-400 border-green-500/50 hover:bg-green-500/10 hover:text-green-300' : ''}
                        ${syncStatus === 'error' ? 'text-red-400 border-red-500/50 hover:bg-red-500/10 hover:text-red-300' : 'hover:bg-zinc-800'}
                    `}
                >
                    {syncStatus === 'syncing' && <Loader2 className="h-4 w-4 animate-spin text-blue-400" />}
                    {syncStatus === 'success' && <CheckCircle2 className="h-4 w-4" />}
                    {syncStatus === 'error' && <AlertCircle className="h-4 w-4" />}
                    {syncStatus === 'idle' && <RefreshCcw className="h-4 w-4 text-blue-400" />}
                    {syncStatus === 'syncing' ? 'Sincronizando...' :
                        syncStatus === 'success' ? '¡Actualizado!' :
                            syncStatus === 'error' ? 'Error. Reintentar' : 'Sincronizar Datos'}
                </Button>

                {syncStatus === 'success' && syncLogs && (
                    <div className="flex gap-2 mt-1 text-[10px] font-mono justify-end w-full">
                        {syncLogs.meta && <span className={syncLogs.meta.includes('Saltado') ? 'text-zinc-500' : 'text-green-500/80'}>M:{syncLogs.meta.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                        {syncLogs.hotmart && <span className={syncLogs.hotmart.includes('Saltado') ? 'text-zinc-500' : 'text-green-500/80'}>H:{syncLogs.hotmart.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                        {syncLogs.ga4 && <span className={syncLogs.ga4.includes('Saltado') ? 'text-zinc-500' : 'text-green-500/80'}>G:{syncLogs.ga4.includes('Saltado') ? 'Skip' : 'OK'}</span>}
                    </div>
                )}
            </div>
        </div>
    )
}
```

- [ ] **Step 2: Verify TypeScript compiles with no errors**

```bash
cd "/Users/macbookpro/Documents/Antigravity/Ads house/A/Ahreportingsistem-main" && npx tsc --noEmit 2>&1 | grep -v node_modules | head -30
```

Expected: no errors related to `DateRangeSelector.tsx`.

- [ ] **Step 3: Run the dev server and test manually**

```bash
npm run dev
```

Open `http://localhost:3000/dashboard/<any-client-id>` and verify:

1. A button with the active preset name appears (default: "Últimos 30 días")
2. Clicking it opens a popover with 13 presets + "Personalizado" as radio buttons
3. Clicking any preset closes the popover and updates the URL + dashboard data
4. Clicking "Personalizado" reveals Desde/Hasta inputs + Aplicar button
5. Máximo preset sends `?from=all` in the URL and loads all historical data
6. Sincronizar Datos button still works

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/dashboard/components/DateRangeSelector.tsx"
git commit -m "feat: replace date inputs with preset dropdown in DateRangeSelector"
```
