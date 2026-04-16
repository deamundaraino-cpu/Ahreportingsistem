import React from 'react'
import { Card, CardHeader, CardDescription, CardContent } from "@/components/ui/card"
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Trash2 } from 'lucide-react'
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

export function SortableText({ id, block, isPuzzleMode, onRemove, onUpdate }: any) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
    const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1, zIndex: isDragging ? 50 : 'auto' as any, textAlign: block.align || 'left' }
    
    const getStyleClass = () => {
        let baseWeight = ''
        switch(block.style) {
            case 'h1': baseWeight = 'font-bold tracking-tight'
                break
            case 'h2': baseWeight = 'font-semibold'
                break
            case 'h3': baseWeight = 'font-medium'
                break
            default: baseWeight = 'font-normal'
                break
        }

        const colorMap: any = {
            'white': 'text-white',
            'zinc': 'text-zinc-400',
            'indigo': 'text-indigo-400',
            'emerald': 'text-emerald-400',
            'amber': 'text-amber-400',
            'rose': 'text-rose-400',
            'cyan': 'text-cyan-400',
            'blue': 'text-blue-400',
        }
        
        const fontMap: any = {
            'sans': 'font-sans',
            'serif': 'font-serif',
            'mono': 'font-mono'
        }

        const sizeMap: any = {
            'sm': 'text-sm',
            'base': 'text-base',
            'lg': 'text-lg',
            'xl': 'text-xl',
            '2xl': 'text-2xl',
            '4xl': 'text-4xl',
            '6xl': 'text-6xl',
            '8xl': 'text-8xl'
        }

        const txtColor = colorMap[block.color || 'white'] || 'text-white'
        const txtFont = fontMap[block.fontFamily || ''] || ''
        
        let txtSize = sizeMap[block.fontSize || '']
        if (!txtSize) {
            switch(block.style) {
                case 'h1': txtSize = 'text-3xl lg:text-4xl'; break;
                case 'h2': txtSize = 'text-xl'; break;
                case 'h3': txtSize = 'text-lg'; break;
                default: txtSize = 'text-base'; break;
            }
        }

        return `${baseWeight} ${txtColor} ${txtFont} ${txtSize}`.trim()
    }

    const colSpan = block.colSpan || 4
    const colSpanClass = `col-span-1 md:col-span-${colSpan}`

    const bgClass = block.backgroundColor || ''
    const radiusMap: any = {
        'none': 'rounded-none',
        'sm': 'rounded-sm',
        'md': 'rounded-md',
        'lg': 'rounded-lg',
        'xl': 'rounded-xl',
        '2xl': 'rounded-2xl',
        'full': 'rounded-full'
    }
    const radiusClass = radiusMap[block.borderRadius || 'xl'] || 'rounded-xl'
    const hasBg = !!block.backgroundColor

    return (
        <div ref={setNodeRef} style={style} className={`${colSpanClass} relative group transition-all duration-200 ${isPuzzleMode ? 'ring-2 ring-indigo-500/30 border-2 border-dashed border-indigo-500/20 bg-indigo-500/5 rounded-xl p-4 shadow-xl' : `py-4 ${hasBg ? `px-6 ${bgClass} ${radiusClass} border shadow-sm` : 'px-2'}`}`}>
            {isPuzzleMode && (
                <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10 p-1 bg-zinc-900 border border-zinc-700 rounded shadow">
                    <button {...attributes} {...listeners} className="p-1.5 text-zinc-400 hover:text-white cursor-grab active:cursor-grabbing rounded">
                        <GripVertical className="w-3.5 h-3.5" /> 
                    </button>
                    <button 
                         onClick={() => onUpdate({ colSpan: colSpan === 4 ? 1 : colSpan === 1 ? 2 : 4 })} 
                         className="p-1 text-[10px] font-bold text-zinc-400 hover:text-indigo-400 px-2 border-l border-zinc-700"
                         title="Cambiar Ancho"
                    >
                        Ancho: {colSpan}/4
                    </button>
                    {onRemove && (
                         <button onClick={onRemove} className="p-1 text-zinc-400 hover:text-red-400 rounded bg-zinc-800 ml-1" title="Quitar del Layout">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            )}
            
            {isPuzzleMode ? (
                <div className="flex flex-col gap-2">
                    <span className="text-[10px] font-bold text-indigo-400/70 uppercase tracking-widest leading-none">Bloque de Texto</span>
                    <input 
                        className={`bg-zinc-950 border-zinc-700 border rounded px-2 py-1 w-full outline-none focus:border-indigo-500 transition shadow-inner ${getStyleClass()}`}
                        value={block.content || ''}
                        onChange={(e) => onUpdate({ content: e.target.value })}
                        placeholder="Escribe el título aquí..."
                        style={{ textAlign: block.align || 'left' }}
                    />
                </div>
            ) : (
                <div className={getStyleClass()}>{block.content || 'Título vacío'}</div>
            )}
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
