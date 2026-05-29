'use client'

import { useState } from 'react'
import { X, Save, Loader2, Pencil, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveClienteLayout, saveTabOverrides } from '../_actions'
import {
    FormulaInput, MetricTypeSelector, CampaignFilterPicker,
    CHART_TYPES, CHART_COLOR_OPTIONS, COLOR_OPTIONS, buildAvailableMetrics,
    TikTokAccountPicker, hasTikTokFormula,
} from './LayoutConfigModal'
import type {
    ReportLayout, CardDef, ChartDef, TextBlockDef, RankingTableDef, ColDef,
} from '@/lib/layout-types'

// ─── Types ─────────────────────────────────────────────────────────────────────

export type QuickEditTarget =
    | { type: 'card'; id: string }
    | { type: 'chart'; id: string }
    | { type: 'text'; id: string }
    | { type: 'ranking'; id: string }
    | { type: 'table' }

// ─── Card Editor ───────────────────────────────────────────────────────────────

function CardEditor({ card, onChange, availableMetrics, campaignGroups, campaignNames, tiktokAccounts = [] }: {
    card: CardDef
    onChange: (card: CardDef) => void
    availableMetrics: { id: string; label: string }[]
    campaignGroups: { id: string; nombre: string }[]
    campaignNames: string[]
    tiktokAccounts?: { id: string; label: string; advertiser_id: string }[]
}) {
    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <div className="flex gap-1 flex-shrink-0">
                    {COLOR_OPTIONS.map(opt => (
                        <button
                            key={opt.val}
                            onClick={() => onChange({ ...card, color: opt.val })}
                            className={`w-4 h-4 rounded-full ${opt.bg} transition ${card.color === opt.val ? 'ring-2 ring-white ring-offset-2 ring-offset-zinc-900 scale-110' : 'opacity-40 hover:opacity-100'}`}
                        />
                    ))}
                </div>
                <Input
                    value={card.label}
                    onChange={e => onChange({ ...card, label: e.target.value })}
                    className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-32 flex-shrink-0"
                    placeholder="Etiqueta"
                />
                <FormulaInput
                    value={card.formula}
                    onChange={val => onChange({ ...card, formula: val.trim() })}
                    availableMetrics={availableMetrics}
                />
            </div>
            <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                    <MetricTypeSelector
                        prefix={card.prefix}
                        suffix={card.suffix}
                        onChange={vals => onChange({ ...card, ...vals })}
                    />
                    <CampaignFilterPicker
                        value={card.campaignFilter}
                        onChange={v => onChange({ ...card, campaignFilter: v })}
                        campaignGroups={campaignGroups}
                        campaignNames={campaignNames}
                    />
                </div>
                {hasTikTokFormula(card.formula) && (
                    <TikTokAccountPicker
                        value={card.account_id}
                        accounts={tiktokAccounts}
                        onChange={v => onChange({ ...card, account_id: v || undefined })}
                    />
                )}
            </div>
        </div>
    )
}

// ─── Chart Editor ──────────────────────────────────────────────────────────────

function ChartEditor({ chart, onChange, availableMetrics, campaignGroups, campaignNames, tiktokAccounts = [] }: {
    chart: ChartDef
    onChange: (chart: ChartDef) => void
    availableMetrics: { id: string; label: string }[]
    campaignGroups: { id: string; nombre: string }[]
    campaignNames: string[]
    tiktokAccounts?: { id: string; label: string; advertiser_id: string }[]
}) {
    function addMetric() {
        onChange({
            ...chart,
            valueFormulas: [...chart.valueFormulas, ''],
            colors: [...(chart.colors || []), 'blue'],
        })
    }

    function removeMetric(i: number) {
        onChange({
            ...chart,
            valueFormulas: chart.valueFormulas.filter((_, idx) => idx !== i),
            colors: (chart.colors || []).filter((_, idx) => idx !== i),
            yAxes: chart.yAxes?.filter((_, idx) => idx !== i),
        })
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <select
                    value={chart.type}
                    onChange={e => onChange({ ...chart, type: e.target.value as any })}
                    className="h-7 text-xs bg-zinc-950 border border-zinc-700 text-zinc-200 rounded px-1.5"
                >
                    {CHART_TYPES.map(t => (
                        <option key={t.val} value={t.val}>{t.icon} {t.label}</option>
                    ))}
                </select>
                <Input
                    value={chart.title}
                    onChange={e => onChange({ ...chart, title: e.target.value })}
                    className="h-7 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 flex-1"
                    placeholder="Título del gráfico"
                />
            </div>

            <div className="space-y-2">
                <p className="text-[10px] text-zinc-500 uppercase font-medium tracking-wider">Métricas</p>
                {chart.valueFormulas.map((formula, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                        <select
                            value={(chart.colors || [])[i] || 'amber'}
                            onChange={e => {
                                const newC = [...(chart.colors || [])]
                                newC[i] = e.target.value
                                onChange({ ...chart, colors: newC })
                            }}
                            className="h-6 w-6 text-[0px] rounded-full border-0 cursor-pointer flex-shrink-0 overflow-hidden"
                            style={{ background: CHART_COLOR_OPTIONS.find(c => c.val === ((chart.colors || [])[i] || 'amber'))?.hex ?? '#f59e0b' }}
                            title="Color de serie"
                        >
                            {CHART_COLOR_OPTIONS.map(c => <option key={c.val} value={c.val}>{c.val}</option>)}
                        </select>
                        <div className="flex-1">
                            <FormulaInput
                                value={formula}
                                onChange={val => {
                                    const newF = [...chart.valueFormulas]
                                    newF[i] = val.trim()
                                    onChange({ ...chart, valueFormulas: newF })
                                }}
                                availableMetrics={availableMetrics}
                            />
                        </div>
                        {chart.valueFormulas.length > 1 && (
                            <button onClick={() => removeMetric(i)} className="text-zinc-700 hover:text-red-400 transition flex-shrink-0">
                                <X className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                ))}
                {chart.valueFormulas.length < 5 && (
                    <button onClick={addMetric} className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-amber-400 transition mt-1">
                        <Plus className="w-3 h-3" /> Añadir métrica
                    </button>
                )}
            </div>

            <div className="flex flex-col gap-1.5 pt-1 border-t border-zinc-800/60">
                {chart.valueFormulas.some(hasTikTokFormula) && (
                    <TikTokAccountPicker
                        value={chart.account_id}
                        accounts={tiktokAccounts}
                        onChange={v => onChange({ ...chart, account_id: v || undefined })}
                    />
                )}
                <div className="flex items-center gap-3">
                <CampaignFilterPicker
                    value={chart.campaignFilter}
                    onChange={v => onChange({ ...chart, campaignFilter: v })}
                    campaignGroups={campaignGroups}
                    campaignNames={campaignNames}
                />
                <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-[10px] text-zinc-500">Alto:</span>
                    <input
                        type="number"
                        value={chart.height || 240}
                        onChange={e => onChange({ ...chart, height: Math.max(100, Number(e.target.value)) })}
                        className="w-14 h-6 text-xs text-center bg-zinc-950 border border-zinc-700 text-zinc-300 rounded outline-none"
                        min={100}
                        max={600}
                    />
                    <span className="text-[9px] text-zinc-700">px</span>
                </div>
                </div>
            </div>
        </div>
    )
}

// ─── Text Editor ───────────────────────────────────────────────────────────────

function TextEditor({ block, onChange }: {
    block: TextBlockDef
    onChange: (b: TextBlockDef) => void
}) {
    return (
        <div className="space-y-3">
            <Input
                value={block.content || ''}
                onChange={e => onChange({ ...block, content: e.target.value })}
                className="h-9 text-sm bg-zinc-950 border-zinc-700 text-white"
                placeholder="Texto del título..."
            />
            <div className="flex flex-wrap gap-2">
                <select
                    value={block.style}
                    onChange={e => onChange({ ...block, style: e.target.value as any })}
                    className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none hover:border-zinc-700 cursor-pointer"
                >
                    <option value="h1">H1 (Bold)</option>
                    <option value="h2">H2 (Semibold)</option>
                    <option value="h3">H3 (Medium)</option>
                    <option value="p">Normal</option>
                </select>
                <select
                    value={block.fontSize || ''}
                    onChange={e => onChange({ ...block, fontSize: e.target.value as any })}
                    className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none hover:border-zinc-700 cursor-pointer"
                >
                    <option value="">Tamaño Default</option>
                    <option value="sm">Pequeño</option>
                    <option value="base">Normal</option>
                    <option value="xl">Extra Grande</option>
                    <option value="2xl">2XL</option>
                    <option value="4xl">4XL</option>
                    <option value="6xl">6XL</option>
                    <option value="8xl">8XL</option>
                </select>
                <select
                    value={block.fontFamily || ''}
                    onChange={e => onChange({ ...block, fontFamily: e.target.value as any })}
                    className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none hover:border-zinc-700 cursor-pointer"
                >
                    <option value="">Sans</option>
                    <option value="serif">Serif</option>
                    <option value="mono">Mono</option>
                </select>
                <select
                    value={block.color || 'white'}
                    onChange={e => onChange({ ...block, color: e.target.value as any })}
                    className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none hover:border-zinc-700 cursor-pointer"
                >
                    <option value="white">Blanco</option>
                    <option value="zinc">Gris</option>
                    <option value="indigo">Índigo</option>
                    <option value="emerald">Verde</option>
                    <option value="amber">Ámbar</option>
                    <option value="rose">Rosa</option>
                    <option value="cyan">Cyan</option>
                    <option value="blue">Azul</option>
                </select>
                <select
                    value={block.align || 'left'}
                    onChange={e => onChange({ ...block, align: e.target.value as any })}
                    className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none hover:border-zinc-700 cursor-pointer"
                >
                    <option value="left">Izquierda</option>
                    <option value="center">Centro</option>
                    <option value="right">Derecha</option>
                </select>
                <select
                    value={block.backgroundColor || ''}
                    onChange={e => onChange({ ...block, backgroundColor: e.target.value })}
                    className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none hover:border-zinc-700 cursor-pointer"
                >
                    <option value="">Sin Fondo</option>
                    <option value="bg-zinc-900/60 border-zinc-800">Gris Suave</option>
                    <option value="bg-zinc-900 border-zinc-700">Gris Sólido</option>
                    <option value="bg-indigo-500/10 border-indigo-500/20">Índigo Sutil</option>
                    <option value="bg-emerald-500/10 border-emerald-500/20">Verde Sutil</option>
                    <option value="bg-amber-500/10 border-amber-500/20">Ámbar Sutil</option>
                    <option value="bg-rose-500/10 border-rose-500/20">Rosa Sutil</option>
                    <option value="bg-indigo-600 border-indigo-500 text-white">Índigo Sólido</option>
                </select>
                <select
                    value={block.borderRadius || 'xl'}
                    onChange={e => onChange({ ...block, borderRadius: e.target.value as any })}
                    className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-xs text-zinc-300 outline-none hover:border-zinc-700 cursor-pointer"
                >
                    <option value="none">Esquinas Rectas</option>
                    <option value="sm">Redondeado SM</option>
                    <option value="md">Redondeado MD</option>
                    <option value="lg">Redondeado LG</option>
                    <option value="xl">Redondeado XL</option>
                    <option value="2xl">Redondeado 2XL</option>
                    <option value="full">Cápsula</option>
                </select>
            </div>
        </div>
    )
}

// ─── Ranking Table Editor ──────────────────────────────────────────────────────

function RankingEditor({ ranking, onChange, availableMetrics, campaignGroups, campaignNames, tiktokAccounts = [] }: {
    ranking: RankingTableDef
    onChange: (r: RankingTableDef) => void
    availableMetrics: { id: string; label: string }[]
    campaignGroups: { id: string; nombre: string }[]
    campaignNames: string[]
    tiktokAccounts?: { id: string; label: string; advertiser_id: string }[]
}) {
    return (
        <div className="space-y-4">
            <Input
                value={ranking.title}
                onChange={e => onChange({ ...ranking, title: e.target.value })}
                className="h-7 text-xs bg-zinc-950 border-zinc-700 text-white"
                placeholder="Título de la tabla"
            />

            <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <div className="flex items-center gap-1">
                    <span className="text-zinc-500">Dimensión:</span>
                    <select
                        value={ranking.dimension}
                        onChange={e => onChange({ ...ranking, dimension: e.target.value as any })}
                        className="h-6 bg-zinc-950 border border-zinc-700 text-zinc-300 rounded px-1.5"
                    >
                        <optgroup label="Meta">
                            <option value="campaigns">Campañas</option>
                            <option value="ads">Anuncios</option>
                            <option value="adsets">Conjuntos</option>
                        </optgroup>
                        <optgroup label="TikTok">
                            <option value="tiktok_campaigns">Campañas</option>
                            <option value="tiktok_ads">Anuncios</option>
                            <option value="tiktok_adgroups">Grupos</option>
                        </optgroup>
                    </select>
                </div>
                <div className="flex items-center gap-1">
                    <span className="text-zinc-500">Top:</span>
                    <select
                        value={ranking.topN}
                        onChange={e => onChange({ ...ranking, topN: Number(e.target.value) })}
                        className="h-6 bg-zinc-950 border border-zinc-700 text-zinc-300 rounded px-1.5"
                    >
                        {[5, 10, 20, 50].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                </div>
                <div className="flex items-center gap-1">
                    <span className="text-zinc-500">Orden:</span>
                    <select
                        value={ranking.sortOrder}
                        onChange={e => onChange({ ...ranking, sortOrder: e.target.value as 'desc' | 'asc' })}
                        className="h-6 bg-zinc-950 border border-zinc-700 text-zinc-300 rounded px-1.5"
                    >
                        <option value="desc">Mayor → Menor</option>
                        <option value="asc">Menor → Mayor</option>
                    </select>
                </div>
                <div className="flex items-center gap-1">
                    <span className="text-zinc-500">Columna ord.:</span>
                    <select
                        value={ranking.sortColumnIndex}
                        onChange={e => onChange({ ...ranking, sortColumnIndex: Number(e.target.value) })}
                        className="h-6 bg-zinc-950 border border-zinc-700 text-zinc-300 rounded px-1.5"
                    >
                        {ranking.columns.map((col, ci) => (
                            <option key={ci} value={ci}>{col.label || `Col ${ci + 1}`}</option>
                        ))}
                    </select>
                </div>
                <label className="flex items-center gap-1 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={ranking.showRank !== false}
                        onChange={e => onChange({ ...ranking, showRank: e.target.checked })}
                        className="w-3 h-3 accent-cyan-500"
                    />
                    <span className="text-zinc-400">Mostrar #</span>
                </label>
            </div>

            {!ranking.dimension.startsWith('tiktok_') && (
                <CampaignFilterPicker
                    value={ranking.campaignFilter}
                    onChange={v => onChange({ ...ranking, campaignFilter: v })}
                    campaignGroups={campaignGroups}
                    campaignNames={campaignNames}
                />
            )}
            {ranking.dimension.startsWith('tiktok_') && (
                <TikTokAccountPicker
                    value={ranking.account_id}
                    accounts={tiktokAccounts}
                    onChange={v => onChange({ ...ranking, account_id: v || undefined })}
                />
            )}

            <div className="space-y-2 pt-2 border-t border-zinc-800">
                <p className="text-[10px] text-zinc-500 font-medium uppercase tracking-wider">Columnas de métricas</p>
                {ranking.columns.map((col, ci) => (
                    <div key={ci} className="flex items-center gap-1.5">
                        <Input
                            value={col.label}
                            onChange={e => {
                                const cols = [...ranking.columns]
                                cols[ci] = { ...col, label: e.target.value }
                                onChange({ ...ranking, columns: cols })
                            }}
                            className="h-6 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-24 flex-shrink-0"
                            placeholder="Etiqueta"
                        />
                        <div className="flex-1">
                            <FormulaInput
                                value={col.formula}
                                onChange={val => {
                                    const cols = [...ranking.columns]
                                    cols[ci] = { ...col, formula: val.trim() }
                                    onChange({ ...ranking, columns: cols })
                                }}
                                availableMetrics={availableMetrics}
                            />
                        </div>
                        <MetricTypeSelector
                            prefix={col.prefix}
                            suffix={col.suffix}
                            onChange={vals => {
                                const cols = [...ranking.columns]
                                cols[ci] = { ...col, ...vals }
                                onChange({ ...ranking, columns: cols })
                            }}
                        />
                        <button
                            onClick={() => {
                                const cols = [...ranking.columns]
                                cols[ci] = { ...col, highlight: !col.highlight }
                                onChange({ ...ranking, columns: cols })
                            }}
                            title="Heatmap"
                            className={`flex-shrink-0 w-6 h-6 rounded border text-xs transition ${col.highlight ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-400' : 'bg-zinc-900 border-zinc-700 text-zinc-600 hover:text-zinc-400'}`}
                        >
                            ✦
                        </button>
                        {ranking.columns.length > 1 && (
                            <button
                                onClick={() => {
                                    const cols = ranking.columns.filter((_, i) => i !== ci)
                                    const newSortIdx = ranking.sortColumnIndex >= cols.length ? cols.length - 1 : ranking.sortColumnIndex
                                    onChange({ ...ranking, columns: cols, sortColumnIndex: newSortIdx })
                                }}
                                className="flex-shrink-0 text-zinc-700 hover:text-red-400 transition"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                ))}
                <button
                    onClick={() => {
                        const cols = [...ranking.columns, { formula: 'meta_spend', label: 'Nueva', prefix: '$', decimals: 2 }]
                        onChange({ ...ranking, columns: cols })
                    }}
                    className="text-[10px] text-cyan-500 hover:text-cyan-400 flex items-center gap-1 mt-1"
                >
                    <Plus className="w-3 h-3" /> Agregar columna
                </button>
            </div>
        </div>
    )
}

// ─── Table Columns Editor ──────────────────────────────────────────────────────

function TableColumnsEditor({ columns, onChange, availableMetrics, campaignGroups, campaignNames }: {
    columns: ColDef[]
    onChange: (cols: ColDef[]) => void
    availableMetrics: { id: string; label: string }[]
    campaignGroups: { id: string; nombre: string }[]
    campaignNames: string[]
}) {
    return (
        <div className="space-y-2">
            <p className="text-[10px] text-zinc-500 uppercase font-medium tracking-wider">Columnas visibles en la tabla</p>
            {columns.map((col, i) => (
                <div key={col.id} className="flex items-center gap-2 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">
                    <Input
                        value={col.label}
                        onChange={e => {
                            const next = [...columns]
                            next[i] = { ...col, label: e.target.value }
                            onChange(next)
                        }}
                        className="h-6 text-xs bg-zinc-950 border-zinc-700 text-zinc-200 w-28 flex-shrink-0"
                        placeholder="Etiqueta"
                    />
                    <div className="flex-1">
                        <FormulaInput
                            value={col.formula}
                            onChange={val => {
                                const next = [...columns]
                                next[i] = { ...col, formula: val.trim() }
                                onChange(next)
                            }}
                            disabled={col.formula === 'fecha'}
                            availableMetrics={availableMetrics}
                        />
                    </div>
                    {col.formula !== 'fecha' && (
                        <>
                            <MetricTypeSelector
                                prefix={col.prefix}
                                suffix={col.suffix}
                                onChange={vals => {
                                    const next = [...columns]
                                    next[i] = { ...col, ...vals }
                                    onChange(next)
                                }}
                            />
                            <CampaignFilterPicker
                                value={col.campaignFilter}
                                onChange={v => {
                                    const next = [...columns]
                                    next[i] = { ...col, campaignFilter: v }
                                    onChange(next)
                                }}
                                campaignGroups={campaignGroups}
                                campaignNames={campaignNames}
                            />
                            <button
                                onClick={() => onChange(columns.filter((_, idx) => idx !== i))}
                                className="flex-shrink-0 text-zinc-700 hover:text-red-400 transition"
                                title="Eliminar columna"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </>
                    )}
                </div>
            ))}
            <button
                onClick={() => onChange([...columns, { id: crypto.randomUUID(), label: 'Nueva', formula: 'meta_spend', prefix: '$', suffix: '', decimals: 2, align: 'right' }])}
                className="text-[10px] text-indigo-400 hover:text-indigo-300 flex items-center gap-1 mt-1"
            >
                <Plus className="w-3 h-3" /> Nueva columna
            </button>
        </div>
    )
}

// ─── Main Modal ────────────────────────────────────────────────────────────────

export function QuickEditModal({
    target,
    layout,
    clienteId,
    tabId,
    campaignGroups = [],
    campaignNames = [],
    conversionesCatalogo = [],
    tiktokAccounts = [],
    onClose,
    onLayoutApplied,
}: {
    target: QuickEditTarget
    layout: ReportLayout
    clienteId: string
    tabId?: string
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
    conversionesCatalogo?: { conversion_key: string; label: string; field_id: string }[]
    tiktokAccounts?: { id: string; label: string; advertiser_id: string }[]
    onClose: () => void
    onLayoutApplied: (layout: ReportLayout) => void
}) {
    const availableMetrics = buildAvailableMetrics(conversionesCatalogo)
    const [loading, setLoading] = useState(false)
    const [saved, setSaved] = useState(false)

    // ── Per-type local state ───────────────────────────────────────────────────

    const [card, setCard] = useState<CardDef>(() =>
        target.type === 'card'
            ? (layout.tarjetas.find(c => c.id === (target as any).id) ?? layout.tarjetas[0])
            : layout.tarjetas[0]
    )
    const [chart, setChart] = useState<ChartDef>(() =>
        target.type === 'chart'
            ? ((layout.graficos ?? []).find(g => g.id === (target as any).id) ?? (layout.graficos ?? [])[0])
            : (layout.graficos ?? [])[0]
    )
    const [textBlock, setTextBlock] = useState<TextBlockDef>(() =>
        target.type === 'text'
            ? ((layout.text_blocks ?? []).find(t => t.id === (target as any).id) ?? (layout.text_blocks ?? [])[0])
            : (layout.text_blocks ?? [])[0]
    )
    const [ranking, setRanking] = useState<RankingTableDef>(() =>
        target.type === 'ranking'
            ? ((layout.ranking_tables ?? []).find(r => r.id === (target as any).id) ?? (layout.ranking_tables ?? [])[0])
            : (layout.ranking_tables ?? [])[0]
    )
    const [columns, setColumns] = useState<ColDef[]>(() => [...layout.columnas])

    // ── Build updated layout ───────────────────────────────────────────────────

    function buildUpdatedLayout(): ReportLayout {
        if (target.type === 'card') {
            return { ...layout, tarjetas: layout.tarjetas.map(c => c.id === card.id ? card : c) }
        }
        if (target.type === 'chart') {
            return { ...layout, graficos: (layout.graficos ?? []).map(g => g.id === chart.id ? chart : g) }
        }
        if (target.type === 'text') {
            return { ...layout, text_blocks: (layout.text_blocks ?? []).map(t => t.id === textBlock.id ? textBlock : t) }
        }
        if (target.type === 'ranking') {
            return { ...layout, ranking_tables: (layout.ranking_tables ?? []).map(r => r.id === ranking.id ? ranking : r) }
        }
        return { ...layout, columnas: columns }
    }

    // ── Save ───────────────────────────────────────────────────────────────────

    async function handleSave() {
        const updated = buildUpdatedLayout()
        setLoading(true)
        const payload = {
            columnas: updated.columnas,
            tarjetas: updated.tarjetas,
            graficos: updated.graficos,
            text_blocks: updated.text_blocks,
            custom_metrics: updated.custom_metrics,
            blocks_order: updated.blocks_order,
            ranking_tables: updated.ranking_tables,
        }
        const res = tabId && tabId !== 'general'
            ? await saveTabOverrides(clienteId, tabId, payload)
            : await saveClienteLayout(clienteId, payload)
        setLoading(false)
        if (res.error) { alert(res.error); return }
        setSaved(true)
        onLayoutApplied(updated)
    }

    // ── Modal title ────────────────────────────────────────────────────────────

    const modalTitle = (() => {
        if (target.type === 'card') return `Tarjeta: ${card?.label ?? ''}`
        if (target.type === 'chart') return `Gráfico: ${chart?.title ?? ''}`
        if (target.type === 'text') return `Título / Texto`
        if (target.type === 'ranking') return `Tabla: ${ranking?.title ?? ''}`
        return 'Columnas de tabla'
    })()

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
            onClick={onClose}
        >
            <div
                className="relative bg-[#0a0a0c] border border-zinc-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 bg-zinc-950/60 flex-shrink-0">
                    <div className="flex items-center gap-2">
                        <Pencil className="w-3.5 h-3.5 text-indigo-400" />
                        <h2 className="text-sm font-semibold text-white truncate">{modalTitle}</h2>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                        <Button
                            size="sm"
                            onClick={handleSave}
                            disabled={loading || saved}
                            className="h-7 gap-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 text-white border-0"
                        >
                            {loading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : saved ? (
                                '✓ Guardado'
                            ) : (
                                <><Save className="w-3.5 h-3.5" /> Guardar</>
                            )}
                        </Button>
                        <button
                            onClick={onClose}
                            className="text-zinc-500 hover:text-white transition p-1 hover:bg-zinc-800 rounded-lg"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
                    {target.type === 'card' && card && (
                        <CardEditor
                            card={card}
                            onChange={setCard}
                            availableMetrics={availableMetrics}
                            campaignGroups={campaignGroups}
                            campaignNames={campaignNames}
                            tiktokAccounts={tiktokAccounts}
                        />
                    )}
                    {target.type === 'chart' && chart && (
                        <ChartEditor
                            chart={chart}
                            onChange={setChart}
                            availableMetrics={availableMetrics}
                            campaignGroups={campaignGroups}
                            campaignNames={campaignNames}
                            tiktokAccounts={tiktokAccounts}
                        />
                    )}
                    {target.type === 'text' && textBlock && (
                        <TextEditor block={textBlock} onChange={setTextBlock} />
                    )}
                    {target.type === 'ranking' && ranking && (
                        <RankingEditor
                            ranking={ranking}
                            onChange={setRanking}
                            availableMetrics={availableMetrics}
                            campaignGroups={campaignGroups}
                            campaignNames={campaignNames}
                            tiktokAccounts={tiktokAccounts}
                        />
                    )}
                    {target.type === 'table' && (
                        <TableColumnsEditor
                            columns={columns}
                            onChange={setColumns}
                            availableMetrics={availableMetrics}
                            campaignGroups={campaignGroups}
                            campaignNames={campaignNames}
                        />
                    )}
                </div>
            </div>
        </div>
    )
}
