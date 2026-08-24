'use client'

import React from 'react'
import { Card, CardHeader, CardDescription, CardContent } from "@/components/ui/card"
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Trash2, AlignLeft, AlignCenter, AlignRight, ChevronUp, ChevronRight, Pencil, Copy, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import type { CardDef, ChartDef, TextBlockDef, CardThreshold } from '@/lib/layout-types'
import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

// Mismo motivo que en DashboardClient: recharts fuera del bundle inicial.
const MetricCharts = dynamic(
    () => import('./MetricCharts').then(m => ({ default: m.MetricCharts })),
    { ssr: false, loading: () => <Skeleton className="h-64 rounded-xl" /> }
)
import { formatValue } from '@/lib/formula-engine'
// El sparkline vive aparte para que recharts no entre en el bundle inicial.
const Sparkline = dynamic(
    () => import('./Sparkline').then(m => ({ default: m.Sparkline })),
    { ssr: false }
)

const COLOR_MAP: Record<string, string> = {
    emerald: 'text-emerald-600 dark:text-emerald-400',
    red: 'text-red-600 dark:text-red-400',
    blue: 'text-blue-600 dark:text-blue-400',
    amber: 'text-amber-600 dark:text-amber-400',
    default: 'text-foreground',
}

function getThresholdColor(value: number | null, threshold?: CardThreshold): string | null {
    if (!threshold || value === null) return null
    const check = (op: string, v: number) => {
        if (op === '>=') return value >= v
        if (op === '<=') return value <= v
        if (op === '>') return value > v
        if (op === '<') return value < v
        return false
    }
    if (check(threshold.greenOperator, threshold.greenValue)) return 'text-emerald-600 dark:text-emerald-400'
    if (check(threshold.yellowOperator, threshold.yellowValue)) return 'text-amber-500 dark:text-amber-400'
    return 'text-red-600 dark:text-red-400'
}

export const SortableCard = React.memo(function SortableCard({ id, card, isPuzzleMode, onRemove, onQuickEdit, onDuplicate, isCollapsed, onToggleCollapse }: {
    id: string
    card: CardDef & { value: number | null; prevValue?: number | null; delta?: number | null; dailyValues?: Array<{ v: number | null }>; targetValue?: number | null }
    isPuzzleMode: boolean
    onRemove?: () => void
    onQuickEdit?: () => void
    onDuplicate?: () => void
    isCollapsed?: boolean
    onToggleCollapse?: () => void
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 50 : 'auto' as any }

    if (isCollapsed) {
        return (
            <div ref={setNodeRef} style={style} className="col-span-1 bg-card/50 border border-border rounded-xl px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-accent hover:border-muted-foreground/30 transition" onClick={onToggleCollapse}>
                <ChevronRight className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
                <span className="text-xs text-muted-foreground/70 truncate">{card.label}</span>
            </div>
        )
    }

    const thresholdColor = card.variant === 'threshold' ? getThresholdColor(card.value, card.threshold) : null
    const valueColorClass = thresholdColor ?? COLOR_MAP[card.color || 'default']

    // Progress percentage (clamped 0–100)
    const targetVal = card.targetValue ?? null
    const progressPct = card.variant === 'progress' && targetVal !== null && targetVal > 0 && card.value !== null
        ? Math.min(100, Math.max(0, (card.value / targetVal) * 100))
        : null

    // Delta display
    const hasDelta = card.showDelta && card.delta !== null && card.delta !== undefined
    const deltaPositive = hasDelta && (card.delta ?? 0) >= 0
    const deltaAbs = hasDelta ? Math.abs(card.delta ?? 0) : 0

    return (
        <Card ref={setNodeRef} style={style} className={`col-span-1 bg-card border-border transition relative group ${isPuzzleMode ? 'ring-1 ring-border hover:border-muted-foreground/50 hover:shadow-lg' : 'hover:border-muted-foreground/30'}`}>
            {isPuzzleMode ? (
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    <button {...attributes} {...listeners} className="p-1 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing bg-muted rounded" aria-label="Mover tarjeta">
                        <GripVertical className="w-3.5 h-3.5" />
                    </button>
                    {onRemove && (
                        <button onClick={onRemove} className="p-1 text-muted-foreground hover:text-red-400 bg-muted rounded" aria-label="Eliminar tarjeta">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            ) : (
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    {onDuplicate && (
                        <button onClick={e => { e.stopPropagation(); onDuplicate() }} className="p-1 text-muted-foreground/70 hover:text-emerald-400 bg-card/80 border border-border hover:border-emerald-500/40 rounded transition" title="Duplicar">
                            <Copy className="w-3 h-3" />
                        </button>
                    )}
                    {onQuickEdit && (
                        <button onClick={e => { e.stopPropagation(); onQuickEdit() }} className="p-1 text-muted-foreground/70 hover:text-indigo-400 bg-card/80 border border-border hover:border-indigo-500/40 rounded transition" title="Editar">
                            <Pencil className="w-3 h-3" />
                        </button>
                    )}
                    {onToggleCollapse && (
                        <button onClick={onToggleCollapse} className="p-1 text-muted-foreground/50 hover:text-muted-foreground bg-card/80 border border-border rounded transition" title="Ocultar">
                            <ChevronUp className="w-3 h-3" />
                        </button>
                    )}
                </div>
            )}
            <CardHeader className="pb-2">
                <CardDescription className="text-muted-foreground font-medium pr-8">{card.label}</CardDescription>
            </CardHeader>
            <CardContent className="overflow-hidden">
                {/* Main value */}
                <p className={`truncate text-2xl lg:text-3xl font-bold font-mono tabular-nums tracking-tight ${valueColorClass}`}>
                    {formatValue(card.value, { prefix: card.prefix, suffix: card.suffix, decimals: card.decimals ?? 2 })}
                </p>

                {/* Delta badge */}
                {hasDelta && (
                    <div className={`flex items-center gap-1 mt-1.5 text-xs font-medium ${deltaPositive ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                        {card.delta === 0
                            ? <Minus className="w-3 h-3" />
                            : deltaPositive
                                ? <TrendingUp className="w-3 h-3" />
                                : <TrendingDown className="w-3 h-3" />
                        }
                        <span>{deltaAbs.toFixed(1)}% vs período anterior</span>
                    </div>
                )}

                {/* Sparkline */}
                {card.variant === 'sparkline' && card.dailyValues && card.dailyValues.length > 1 && (
                    <div className="mt-2 h-10">
                        <Sparkline data={card.dailyValues} stroke={thresholdColor ? 'currentColor' : 'hsl(var(--primary))'} />
                    </div>
                )}

                {/* Progress bar */}
                {card.variant === 'progress' && progressPct !== null && (
                    <div className="mt-2 space-y-1">
                        <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{card.targetLabel || 'Objetivo'}</span>
                            <span>{progressPct.toFixed(1)}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all ${progressPct >= 100 ? 'bg-emerald-500' : progressPct >= 70 ? 'bg-blue-500' : progressPct >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                                style={{ width: `${progressPct}%` }}
                            />
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {formatValue(card.value, { prefix: card.prefix, suffix: card.suffix, decimals: card.decimals ?? 0 })}
                            {' / '}
                            {formatValue(targetVal, { prefix: card.prefix, suffix: card.suffix, decimals: card.decimals ?? 0 })}
                        </p>
                    </div>
                )}
            </CardContent>
        </Card>
    )
})

export const SortableChart = React.memo(function SortableChart({ id, chart, isPuzzleMode, metrics, weeks, varContext, sourceMapping, platformSet, layoutCustomMetrics, rawMetrics, campaignGroups, effectiveKeyword, onRemove, onUpdateChart, onQuickEdit, onDuplicate, isCollapsed, onToggleCollapse }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 50 : 'auto' as any }

    if (isCollapsed) {
        return (
            <div ref={setNodeRef} style={style} className="col-span-1 md:col-span-4 bg-card/50 border border-border rounded-xl px-4 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-accent hover:border-muted-foreground/30 transition" onClick={onToggleCollapse}>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" />
                <span className="text-sm text-muted-foreground/70 truncate">{chart.title || 'Gráfica'}</span>
            </div>
        )
    }

    return (
        <div ref={setNodeRef} style={style} className={`col-span-1 md:col-span-4 relative group ${isPuzzleMode ? 'ring-1 ring-border p-1 rounded-xl hover:shadow-lg hover:border-muted-foreground/50' : ''}`}>
            {isPuzzleMode ? (
                <div className="absolute top-4 right-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <button {...attributes} {...listeners} className="p-1.5 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing bg-card border border-border rounded shadow">
                        <GripVertical className="w-4 h-4" />
                    </button>
                    {onRemove && (
                        <button onClick={onRemove} className="p-1.5 text-muted-foreground hover:text-red-400 bg-card border border-border rounded shadow">
                            <Trash2 className="w-4 h-4" />
                        </button>
                    )}
                </div>
            ) : (
                <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    {onDuplicate && (
                        <button onClick={e => { e.stopPropagation(); onDuplicate() }} className="p-1.5 text-muted-foreground/70 hover:text-emerald-400 bg-card/80 border border-border hover:border-emerald-500/40 rounded transition" title="Duplicar">
                            <Copy className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {onQuickEdit && (
                        <button onClick={e => { e.stopPropagation(); onQuickEdit() }} className="p-1.5 text-muted-foreground/70 hover:text-indigo-400 bg-card/80 border border-border hover:border-indigo-500/40 rounded transition" title="Editar">
                            <Pencil className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {onToggleCollapse && (
                        <button onClick={onToggleCollapse} className="p-1.5 text-muted-foreground/50 hover:text-muted-foreground bg-card/80 rounded border border-border transition" title="Ocultar">
                            <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            )}
            <MetricCharts
                charts={[chart]}
                metrics={metrics}
                weeks={weeks}
                varContext={varContext}
                sourceMapping={sourceMapping}
                platformSet={platformSet}
                layoutCustomMetrics={layoutCustomMetrics}
                rawMetrics={rawMetrics}
                campaignGroups={campaignGroups}
                effectiveKeyword={effectiveKeyword}
                onUpdateChart={onUpdateChart}
            />
        </div>
    )
})

// ─── SortableText ─────────────────────────────────────────────────────────────

export const SortableText = React.memo(function SortableText({ id, block, isPuzzleMode, onRemove, onUpdate, onQuickEdit, onDuplicate, isCollapsed, onToggleCollapse }: {
    id: string
    block: TextBlockDef
    isPuzzleMode: boolean
    onRemove?: () => void
    onUpdate?: (updates: Partial<TextBlockDef>) => void
    onQuickEdit?: () => void
    onDuplicate?: () => void
    isCollapsed?: boolean
    onToggleCollapse?: () => void
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        zIndex: isDragging ? 50 : 'auto' as any,
    }

    const isSeparator = block.blockType === 'separator'
    const colSpan = block.colSpan || 4
    const colSpanClass = `col-span-1 md:col-span-${colSpan}`

    // ── Text style class ─────────────────────────────────────────────────────
    const getTextClass = () => {
        const weightMap: Record<string, string> = { h1: 'font-bold tracking-tight', h2: 'font-semibold', h3: 'font-medium', p: 'font-normal' }
        const colorMap: Record<string, string> = { white: 'text-foreground', zinc: 'text-muted-foreground', indigo: 'text-indigo-600 dark:text-indigo-400', emerald: 'text-emerald-600 dark:text-emerald-400', amber: 'text-amber-600 dark:text-amber-400', rose: 'text-rose-600 dark:text-rose-400', cyan: 'text-cyan-600 dark:text-cyan-400', blue: 'text-blue-600 dark:text-blue-400' }
        const fontMap: Record<string, string> = { sans: 'font-sans', serif: 'font-serif', mono: 'font-mono' }
        const sizeMap: Record<string, string> = { sm: 'text-sm', base: 'text-base', lg: 'text-lg', xl: 'text-xl', '2xl': 'text-2xl', '4xl': 'text-4xl', '6xl': 'text-6xl', '8xl': 'text-8xl' }
        const defaultSizes: Record<string, string> = { h1: 'text-3xl lg:text-4xl', h2: 'text-xl', h3: 'text-lg', p: 'text-base' }
        return [
            weightMap[block.style] || 'font-normal',
            colorMap[block.color || 'white'] || 'text-foreground',
            fontMap[block.fontFamily || ''] || '',
            sizeMap[block.fontSize || ''] || defaultSizes[block.style] || 'text-base',
        ].filter(Boolean).join(' ')
    }

    // ── Separator view ───────────────────────────────────────────────────────
    const renderSeparatorView = () => {
        const sepStyle = block.separatorStyle || 'line'
        const sepWidth = block.separatorWidth || 'full'
        const widthClass = { full: 'w-full', half: 'w-1/2 mx-auto', small: 'w-1/4 mx-auto' }[sepWidth] || 'w-full'
        const colorClass: Record<string, string> = { white: 'border-white/30', zinc: 'border-border', indigo: 'border-indigo-500/40', emerald: 'border-emerald-500/40', amber: 'border-amber-500/40', rose: 'border-rose-500/40', cyan: 'border-cyan-500/40', blue: 'border-blue-500/40' }
        const borderColor = colorClass[block.color || 'zinc'] || 'border-border'
        if (sepStyle === 'space') return <div className="py-6" />
        const borderStyle = { line: 'border-solid', dashed: 'border-dashed', dots: 'border-dotted' }[sepStyle] || 'border-solid'
        return (
            <div className="py-4">
                <div className={`${widthClass} border-t ${borderStyle} ${borderColor}`} />
            </div>
        )
    }

    // ── Text view ────────────────────────────────────────────────────────────
    const renderTextView = () => {
        const hasBg = !!block.backgroundColor
        const radiusMap: Record<string, string> = { none: 'rounded-none', sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', xl: 'rounded-xl', '2xl': 'rounded-2xl', full: 'rounded-full' }
        const radiusClass = radiusMap[block.borderRadius || 'xl'] || 'rounded-xl'
        return (
            <div
                className={`py-4 ${hasBg ? `px-6 ${block.backgroundColor} ${radiusClass} border shadow-sm` : 'px-2'}`}
                style={{ textAlign: block.align || 'left' }}
            >
                <div className={getTextClass()}>{block.content || 'Título vacío'}</div>
            </div>
        )
    }

    // ── Shared drag + remove top bar ──────────────────────────────────────────
    const renderPuzzleTopBar = (label: string, accent: string) => (
        <div className={`flex items-center justify-between mb-2 pb-2 border-b ${accent === 'indigo' ? 'border-indigo-500/20' : 'border-border'}`}>
            <span className={`text-[10px] font-bold uppercase tracking-widest ${accent === 'indigo' ? 'text-indigo-600 dark:text-indigo-400/70' : 'text-muted-foreground/70'}`}>{label}</span>
            <div className="flex items-center gap-1">
                <button
                    {...attributes}
                    {...listeners}
                    className="p-1.5 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing bg-muted hover:bg-accent rounded transition"
                    title="Arrastrar para reordenar"
                >
                    <GripVertical className="w-3.5 h-3.5" />
                </button>
                {onRemove && (
                    <button onClick={onRemove} className="p-1.5 text-muted-foreground hover:text-red-400 bg-muted hover:bg-accent rounded transition" title="Eliminar bloque">
                        <Trash2 className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </div>
    )

    // ── Separator puzzle mode ─────────────────────────────────────────────────
    const renderSeparatorPuzzle = () => (
        <div className="p-3 flex flex-col gap-3">
            {renderPuzzleTopBar('Separador', 'zinc')}

            {/* Width */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground/70 shrink-0 w-12">Ancho:</span>
                {(['full', 'half', 'small'] as const).map(w => (
                    <button
                        key={w}
                        onClick={() => onUpdate?.({ separatorWidth: w })}
                        className={`px-2.5 py-1 text-[10px] font-medium rounded border transition ${(block.separatorWidth || 'full') === w ? 'bg-secondary border-ring text-secondary-foreground' : 'bg-muted border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground'}`}
                    >
                        {w === 'full' ? '━ Completo' : w === 'half' ? '── 50%' : '· Pequeño'}
                    </button>
                ))}
            </div>

            {/* Style */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground/70 shrink-0 w-12">Estilo:</span>
                {([['line', '────'], ['dashed', '- - -'], ['dots', '·····'], ['space', 'Espacio']] as [string, string][]).map(([s, label]) => (
                    <button
                        key={s}
                        onClick={() => onUpdate?.({ separatorStyle: s as TextBlockDef['separatorStyle'] })}
                        className={`px-2.5 py-1 text-[10px] font-mono rounded border transition ${(block.separatorStyle || 'line') === s ? 'bg-secondary border-ring text-secondary-foreground' : 'bg-muted border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground'}`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {/* Color */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground/70 shrink-0 w-12">Color:</span>
                {(['zinc', 'white', 'indigo', 'emerald', 'amber', 'rose', 'cyan'] as const).map(c => {
                    const dotColors: Record<string, string> = { zinc: 'bg-muted-foreground', white: 'bg-white', indigo: 'bg-indigo-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500' }
                    return (
                        <button
                            key={c}
                            onClick={() => onUpdate?.({ color: c })}
                            title={c}
                            className={`w-5 h-5 rounded-full border-2 transition ${dotColors[c]} ${(block.color || 'zinc') === c ? 'border-ring scale-125' : 'border-transparent opacity-60 hover:opacity-100 hover:scale-110'}`}
                        />
                    )
                })}
            </div>

            {/* Preview */}
            <div className="rounded-lg bg-background border border-border px-3 py-1">
                {renderSeparatorView()}
            </div>
        </div>
    )

    // ── Text puzzle mode ──────────────────────────────────────────────────────
    const renderTextPuzzle = () => (
        <div className="p-3 flex flex-col gap-3">
            {renderPuzzleTopBar('Bloque de Texto', 'indigo')}

            {/* Controls row */}
            <div className="flex items-center gap-1.5 flex-wrap">
                {/* Style */}
                {(['h1', 'h2', 'h3', 'p'] as const).map(s => (
                    <button
                        key={s}
                        onClick={() => onUpdate?.({ style: s })}
                        className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded border transition ${block.style === s ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-muted border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground'}`}
                    >
                        {s.toUpperCase()}
                    </button>
                ))}

                <div className="h-4 w-px bg-muted-foreground/30 mx-0.5" />

                {/* Alignment */}
                {([['left', <AlignLeft key="l" className="w-3 h-3" />], ['center', <AlignCenter key="c" className="w-3 h-3" />], ['right', <AlignRight key="r" className="w-3 h-3" />]] as [string, React.ReactNode][]).map(([a, icon]) => (
                    <button
                        key={a}
                        onClick={() => onUpdate?.({ align: a as TextBlockDef['align'] })}
                        className={`p-1.5 rounded border transition ${(block.align || 'left') === a ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-muted border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground'}`}
                    >
                        {icon}
                    </button>
                ))}

                <div className="h-4 w-px bg-muted-foreground/30 mx-0.5" />

                {/* Width */}
                {([4, 2, 1] as const).map(w => (
                    <button
                        key={w}
                        onClick={() => onUpdate?.({ colSpan: w })}
                        className={`px-2 py-0.5 text-[10px] rounded border transition ${colSpan === w ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-muted border-border text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground'}`}
                    >
                        {w}/4
                    </button>
                ))}
            </div>

            {/* Color row */}
            <div className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground/70 shrink-0">Color:</span>
                {(['white', 'zinc', 'indigo', 'emerald', 'amber', 'rose', 'cyan', 'blue'] as const).map(c => {
                    const dotColors: Record<string, string> = { white: 'bg-white', zinc: 'bg-muted-foreground/70', indigo: 'bg-indigo-400', emerald: 'bg-emerald-400', amber: 'bg-amber-400', rose: 'bg-rose-400', cyan: 'bg-cyan-400', blue: 'bg-blue-400' }
                    return (
                        <button
                            key={c}
                            onClick={() => onUpdate?.({ color: c })}
                            title={c}
                            className={`w-4 h-4 rounded-full border-2 transition ${dotColors[c]} ${(block.color || 'white') === c ? 'border-ring scale-125' : 'border-transparent opacity-50 hover:opacity-100 hover:scale-110'}`}
                        />
                    )
                })}
            </div>

            {/* Content input */}
            <input
                className={`bg-background border border-border rounded px-2.5 py-1.5 w-full outline-none focus:border-indigo-500 transition shadow-inner ${getTextClass()}`}
                value={block.content || ''}
                onChange={e => onUpdate?.({ content: e.target.value })}
                placeholder="Escribe el título de sección..."
                style={{ textAlign: block.align || 'left' }}
            />
        </div>
    )

    if (isCollapsed && !isSeparator && !isPuzzleMode) {
        return (
            <div ref={setNodeRef} style={style} className={`${colSpanClass} bg-card/40 border border-border rounded-lg px-3 py-2 flex items-center gap-2 cursor-pointer hover:bg-accent hover:border-muted-foreground/30 transition`} onClick={onToggleCollapse}>
                <ChevronRight className="w-3 h-3 text-muted-foreground/70 flex-shrink-0" />
                <span className="text-xs text-muted-foreground/70 truncate">{block.content || 'Sección'}</span>
            </div>
        )
    }

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${colSpanClass} relative group transition-all duration-200 ${
                isPuzzleMode
                    ? isSeparator
                        ? 'ring-1 ring-border border border-dashed border-border bg-card/20 rounded-xl shadow-md'
                        : 'ring-2 ring-indigo-500/30 border-2 border-dashed border-indigo-500/20 bg-indigo-500/5 rounded-xl shadow-xl'
                    : ''
            }`}
        >
            {isPuzzleMode
                ? (isSeparator ? renderSeparatorPuzzle() : renderTextPuzzle())
                : (isSeparator ? renderSeparatorView() : (
                    <>
                        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                            {onDuplicate && (
                                <button onClick={e => { e.stopPropagation(); onDuplicate() }} className="p-1 text-muted-foreground/70 hover:text-emerald-400 bg-card/80 border border-border hover:border-emerald-500/40 rounded transition" title="Duplicar">
                                    <Copy className="w-3 h-3" />
                                </button>
                            )}
                            {onQuickEdit && (
                                <button onClick={e => { e.stopPropagation(); onQuickEdit() }} className="p-1 text-muted-foreground/70 hover:text-indigo-400 bg-card/80 border border-border hover:border-indigo-500/40 rounded transition" title="Editar">
                                    <Pencil className="w-3 h-3" />
                                </button>
                            )}
                            {onToggleCollapse && (
                                <button onClick={onToggleCollapse} className="p-1 text-muted-foreground/50 hover:text-muted-foreground bg-card/80 border border-border rounded transition" title="Ocultar">
                                    <ChevronUp className="w-3 h-3" />
                                </button>
                            )}
                        </div>
                        {renderTextView()}
                    </>
                ))
            }
        </div>
    )
})

export const SortableTable = React.memo(function SortableTable({ id, isPuzzleMode, children, title, onQuickEdit, onDuplicate, onRemove, isCollapsed, onToggleCollapse }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 50 : 'auto' as any }

    if (isCollapsed) {
        return (
            <div ref={setNodeRef} style={style} className="col-span-1 md:col-span-4 bg-card/50 border border-border rounded-xl px-4 py-2.5 flex items-center gap-2 cursor-pointer hover:bg-accent hover:border-muted-foreground/30 transition" onClick={onToggleCollapse}>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/70 flex-shrink-0" />
                <span className="text-sm text-muted-foreground/70 truncate">{title || 'Tabla'}</span>
            </div>
        )
    }

    return (
        <div ref={setNodeRef} style={style} className={`col-span-1 md:col-span-4 relative group ${isPuzzleMode ? 'ring-1 ring-border p-1 rounded-xl hover:shadow-lg hover:border-muted-foreground/50' : ''}`}>
            {isPuzzleMode ? (
                <div className="absolute top-4 right-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    {onRemove && (
                        <button type="button" onClick={e => { e.stopPropagation(); onRemove() }} className="p-1.5 text-muted-foreground hover:text-red-400 bg-card border border-border hover:border-red-500/40 rounded shadow transition" title="Eliminar">
                            <Trash2 className="w-4 h-4" />
                        </button>
                    )}
                    <button {...attributes} {...listeners} className="p-1.5 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing bg-card border border-border rounded shadow">
                        <GripVertical className="w-4 h-4" />
                    </button>
                </div>
            ) : (
                <div className="absolute top-4 right-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    {onDuplicate && (
                        <button onClick={e => { e.stopPropagation(); onDuplicate() }} className="p-1.5 text-muted-foreground/70 hover:text-emerald-400 bg-card/80 border border-border hover:border-emerald-500/40 rounded transition" title="Duplicar">
                            <Copy className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {onQuickEdit && (
                        <button onClick={e => { e.stopPropagation(); onQuickEdit() }} className="p-1.5 text-muted-foreground/70 hover:text-indigo-400 bg-card/80 border border-border hover:border-indigo-500/40 rounded transition" title="Editar">
                            <Pencil className="w-3.5 h-3.5" />
                        </button>
                    )}
                    {onToggleCollapse && (
                        <button onClick={(e) => { e.stopPropagation(); onToggleCollapse() }} className="p-1.5 text-muted-foreground/50 hover:text-muted-foreground bg-card/80 rounded border border-border transition" title="Ocultar">
                            <ChevronUp className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            )}
            {children}
        </div>
    )
})
