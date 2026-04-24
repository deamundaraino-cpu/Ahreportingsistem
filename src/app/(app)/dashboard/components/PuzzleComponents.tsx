import React from 'react'
import { Card, CardHeader, CardDescription, CardContent } from "@/components/ui/card"
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Trash2, AlignLeft, AlignCenter, AlignRight } from 'lucide-react'
import type { CardDef, ChartDef, TextBlockDef } from '@/lib/layout-types'
import { MetricCharts } from './MetricCharts'
import { formatValue } from '@/lib/formula-engine'

const COLOR_MAP: Record<string, string> = {
    emerald: 'text-emerald-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
    amber: 'text-amber-400',
    default: 'text-white',
}

export function SortableCard({ id, card, isPuzzleMode, onRemove }: { id: string, card: CardDef & { value: number | null }, isPuzzleMode: boolean, onRemove?: () => void }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 50 : 'auto' as any }

    return (
        <Card ref={setNodeRef} style={style} className={`col-span-1 bg-zinc-900 border-zinc-800 transition relative group ${isPuzzleMode ? 'ring-1 ring-zinc-700/50 hover:border-zinc-500 hover:shadow-lg' : 'hover:border-zinc-700'}`}>
            {isPuzzleMode && (
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
                    <button {...attributes} {...listeners} className="p-1 text-zinc-400 hover:text-white cursor-grab active:cursor-grabbing bg-zinc-800 rounded">
                        <GripVertical className="w-3.5 h-3.5" />
                    </button>
                    {onRemove && (
                        <button onClick={onRemove} className="p-1 text-zinc-400 hover:text-red-400 bg-zinc-800 rounded">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            )}
            <CardHeader className="pb-2">
                <CardDescription className="text-zinc-400 font-medium pr-8">{card.label}</CardDescription>
            </CardHeader>
            <CardContent className="overflow-hidden">
                <p className={`truncate text-2xl lg:text-3xl font-bold font-mono tracking-tight ${COLOR_MAP[card.color || 'default']}`}>
                    {formatValue(card.value, { prefix: card.prefix, suffix: card.suffix, decimals: card.decimals ?? 2 })}
                </p>
            </CardContent>
        </Card>
    )
}

export function SortableChart({ id, chart, isPuzzleMode, metrics, weeks, varContext, onRemove }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 50 : 'auto' as any }

    return (
        <div ref={setNodeRef} style={style} className={`col-span-1 md:col-span-4 relative group ${isPuzzleMode ? 'ring-1 ring-zinc-700/50 p-1 rounded-xl hover:shadow-lg hover:border-zinc-500' : ''}`}>
            {isPuzzleMode && (
                <div className="absolute top-4 right-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <button {...attributes} {...listeners} className="p-1.5 text-zinc-400 hover:text-white cursor-grab active:cursor-grabbing bg-zinc-900 border border-zinc-700 rounded shadow">
                        <GripVertical className="w-4 h-4" />
                    </button>
                    {onRemove && (
                         <button onClick={onRemove} className="p-1.5 text-zinc-400 hover:text-red-400 bg-zinc-900 border border-zinc-700 rounded shadow">
                            <Trash2 className="w-4 h-4" />
                        </button>
                    )}
                </div>
            )}
            <MetricCharts charts={[chart]} metrics={metrics} weeks={weeks} varContext={varContext} />
        </div>
    )
}

// ─── SortableText ─────────────────────────────────────────────────────────────

export function SortableText({ id, block, isPuzzleMode, onRemove, onUpdate }: {
    id: string
    block: TextBlockDef
    isPuzzleMode: boolean
    onRemove?: () => void
    onUpdate?: (updates: Partial<TextBlockDef>) => void
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
        const colorMap: Record<string, string> = { white: 'text-white', zinc: 'text-zinc-400', indigo: 'text-indigo-400', emerald: 'text-emerald-400', amber: 'text-amber-400', rose: 'text-rose-400', cyan: 'text-cyan-400', blue: 'text-blue-400' }
        const fontMap: Record<string, string> = { sans: 'font-sans', serif: 'font-serif', mono: 'font-mono' }
        const sizeMap: Record<string, string> = { sm: 'text-sm', base: 'text-base', lg: 'text-lg', xl: 'text-xl', '2xl': 'text-2xl', '4xl': 'text-4xl', '6xl': 'text-6xl', '8xl': 'text-8xl' }
        const defaultSizes: Record<string, string> = { h1: 'text-3xl lg:text-4xl', h2: 'text-xl', h3: 'text-lg', p: 'text-base' }
        return [
            weightMap[block.style] || 'font-normal',
            colorMap[block.color || 'white'] || 'text-white',
            fontMap[block.fontFamily || ''] || '',
            sizeMap[block.fontSize || ''] || defaultSizes[block.style] || 'text-base',
        ].filter(Boolean).join(' ')
    }

    // ── Separator view ───────────────────────────────────────────────────────
    const renderSeparatorView = () => {
        const sepStyle = block.separatorStyle || 'line'
        const sepWidth = block.separatorWidth || 'full'
        const widthClass = { full: 'w-full', half: 'w-1/2 mx-auto', small: 'w-1/4 mx-auto' }[sepWidth] || 'w-full'
        const colorClass: Record<string, string> = { white: 'border-white/30', zinc: 'border-zinc-700', indigo: 'border-indigo-500/40', emerald: 'border-emerald-500/40', amber: 'border-amber-500/40', rose: 'border-rose-500/40', cyan: 'border-cyan-500/40', blue: 'border-blue-500/40' }
        const borderColor = colorClass[block.color || 'zinc'] || 'border-zinc-700'
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
        <div className={`flex items-center justify-between mb-2 pb-2 border-b ${accent === 'indigo' ? 'border-indigo-500/20' : 'border-zinc-700/50'}`}>
            <span className={`text-[10px] font-bold uppercase tracking-widest ${accent === 'indigo' ? 'text-indigo-400/70' : 'text-zinc-500'}`}>{label}</span>
            <div className="flex items-center gap-1">
                <button
                    {...attributes}
                    {...listeners}
                    className="p-1.5 text-zinc-400 hover:text-white cursor-grab active:cursor-grabbing bg-zinc-800 hover:bg-zinc-700 rounded transition"
                    title="Arrastrar para reordenar"
                >
                    <GripVertical className="w-3.5 h-3.5" />
                </button>
                {onRemove && (
                    <button onClick={onRemove} className="p-1.5 text-zinc-400 hover:text-red-400 bg-zinc-800 hover:bg-zinc-700 rounded transition" title="Eliminar bloque">
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
                <span className="text-[10px] text-zinc-500 shrink-0 w-12">Ancho:</span>
                {(['full', 'half', 'small'] as const).map(w => (
                    <button
                        key={w}
                        onClick={() => onUpdate?.({ separatorWidth: w })}
                        className={`px-2.5 py-1 text-[10px] font-medium rounded border transition ${(block.separatorWidth || 'full') === w ? 'bg-zinc-600 border-zinc-500 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                    >
                        {w === 'full' ? '━ Completo' : w === 'half' ? '── 50%' : '· Pequeño'}
                    </button>
                ))}
            </div>

            {/* Style */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-zinc-500 shrink-0 w-12">Estilo:</span>
                {([['line', '────'], ['dashed', '- - -'], ['dots', '·····'], ['space', 'Espacio']] as [string, string][]).map(([s, label]) => (
                    <button
                        key={s}
                        onClick={() => onUpdate?.({ separatorStyle: s as TextBlockDef['separatorStyle'] })}
                        className={`px-2.5 py-1 text-[10px] font-mono rounded border transition ${(block.separatorStyle || 'line') === s ? 'bg-zinc-600 border-zinc-500 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {/* Color */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-zinc-500 shrink-0 w-12">Color:</span>
                {(['zinc', 'white', 'indigo', 'emerald', 'amber', 'rose', 'cyan'] as const).map(c => {
                    const dotColors: Record<string, string> = { zinc: 'bg-zinc-500', white: 'bg-white', indigo: 'bg-indigo-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500', rose: 'bg-rose-500', cyan: 'bg-cyan-500' }
                    return (
                        <button
                            key={c}
                            onClick={() => onUpdate?.({ color: c })}
                            title={c}
                            className={`w-5 h-5 rounded-full border-2 transition ${dotColors[c]} ${(block.color || 'zinc') === c ? 'border-white scale-125' : 'border-transparent opacity-60 hover:opacity-100 hover:scale-110'}`}
                        />
                    )
                })}
            </div>

            {/* Preview */}
            <div className="rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-1">
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
                        className={`px-2 py-0.5 text-[10px] font-bold uppercase rounded border transition ${block.style === s ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                    >
                        {s.toUpperCase()}
                    </button>
                ))}

                <div className="h-4 w-px bg-zinc-700 mx-0.5" />

                {/* Alignment */}
                {([['left', <AlignLeft key="l" className="w-3 h-3" />], ['center', <AlignCenter key="c" className="w-3 h-3" />], ['right', <AlignRight key="r" className="w-3 h-3" />]] as [string, React.ReactNode][]).map(([a, icon]) => (
                    <button
                        key={a}
                        onClick={() => onUpdate?.({ align: a as TextBlockDef['align'] })}
                        className={`p-1.5 rounded border transition ${(block.align || 'left') === a ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                    >
                        {icon}
                    </button>
                ))}

                <div className="h-4 w-px bg-zinc-700 mx-0.5" />

                {/* Width */}
                {([4, 2, 1] as const).map(w => (
                    <button
                        key={w}
                        onClick={() => onUpdate?.({ colSpan: w })}
                        className={`px-2 py-0.5 text-[10px] rounded border transition ${colSpan === w ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'}`}
                    >
                        {w}/4
                    </button>
                ))}
            </div>

            {/* Color row */}
            <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500 shrink-0">Color:</span>
                {(['white', 'zinc', 'indigo', 'emerald', 'amber', 'rose', 'cyan', 'blue'] as const).map(c => {
                    const dotColors: Record<string, string> = { white: 'bg-white', zinc: 'bg-zinc-400', indigo: 'bg-indigo-400', emerald: 'bg-emerald-400', amber: 'bg-amber-400', rose: 'bg-rose-400', cyan: 'bg-cyan-400', blue: 'bg-blue-400' }
                    return (
                        <button
                            key={c}
                            onClick={() => onUpdate?.({ color: c })}
                            title={c}
                            className={`w-4 h-4 rounded-full border-2 transition ${dotColors[c]} ${(block.color || 'white') === c ? 'border-white scale-125' : 'border-transparent opacity-50 hover:opacity-100 hover:scale-110'}`}
                        />
                    )
                })}
            </div>

            {/* Content input */}
            <input
                className={`bg-zinc-950 border border-zinc-700 rounded px-2.5 py-1.5 w-full outline-none focus:border-indigo-500 transition shadow-inner ${getTextClass()}`}
                value={block.content || ''}
                onChange={e => onUpdate?.({ content: e.target.value })}
                placeholder="Escribe el título de sección..."
                style={{ textAlign: block.align || 'left' }}
            />
        </div>
    )

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={`${colSpanClass} relative group transition-all duration-200 ${
                isPuzzleMode
                    ? isSeparator
                        ? 'ring-1 ring-zinc-600/40 border border-dashed border-zinc-600/30 bg-zinc-900/20 rounded-xl shadow-md'
                        : 'ring-2 ring-indigo-500/30 border-2 border-dashed border-indigo-500/20 bg-indigo-500/5 rounded-xl shadow-xl'
                    : ''
            }`}
        >
            {isPuzzleMode
                ? (isSeparator ? renderSeparatorPuzzle() : renderTextPuzzle())
                : (isSeparator ? renderSeparatorView() : renderTextView())
            }
        </div>
    )
}

export function SortableTable({ id, isPuzzleMode, children }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 50 : 'auto' as any }

    return (
        <div ref={setNodeRef} style={style} className={`col-span-1 md:col-span-4 relative group ${isPuzzleMode ? 'ring-1 ring-zinc-700/50 p-1 rounded-xl hover:shadow-lg hover:border-zinc-500' : ''}`}>
            {isPuzzleMode && (
                <div className="absolute top-4 right-4 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <button {...attributes} {...listeners} className="p-1.5 text-zinc-400 hover:text-white cursor-grab active:cursor-grabbing bg-zinc-900 border border-zinc-700 rounded shadow">
                        <GripVertical className="w-4 h-4" />
                    </button>
                </div>
            )}
            {children}
        </div>
    )
}
