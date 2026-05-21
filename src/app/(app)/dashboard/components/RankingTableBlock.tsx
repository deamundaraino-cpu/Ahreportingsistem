'use client'

import React, { useMemo, useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { RankingTableDef } from '@/lib/layout-types'
import { evaluateFormula, formatValue } from '@/lib/formula-engine'
import { aggregateRankingRows } from '@/lib/ranking-aggregation'

interface Props {
    def: RankingTableDef
    metrics: any[]
    campaignGroups: any[]
    sourceMapping: Record<string, string>
    customMetrics: Record<string, string>
    clienteId: string
}

export function RankingTableBlock({ def, metrics, campaignGroups, sourceMapping, customMetrics, clienteId }: Props) {
    const [thumbnailMap, setThumbnailMap] = useState<Record<string, string | null>>({})

    const rows = useMemo(() => {
        const aggregated = aggregateRankingRows(metrics, def.dimension, def.campaignFilter)
        const withValues = aggregated.map(row => {
            const colValues = def.columns.map(col =>
                evaluateFormula(col.formula, row, {}, sourceMapping, new Set(['meta']), customMetrics)
            )
            const sortVal = colValues[def.sortColumnIndex] ?? null
            return { row, colValues, sortVal }
        })
        const sorted = withValues.sort((a, b) => {
            if (a.sortVal === null) return 1
            if (b.sortVal === null) return -1
            return def.sortOrder === 'desc' ? b.sortVal - a.sortVal : a.sortVal - b.sortVal
        })
        return sorted.slice(0, def.topN)
    }, [metrics, def, sourceMapping, customMetrics])

    useEffect(() => {
        if (def.dimension !== 'ads') return
        const ids = rows.map(r => r.row._id).filter(Boolean)
        if (ids.length === 0) return
        fetch(`/api/v1/ad-thumbnails?clienteId=${clienteId}&adIds=${ids.join(',')}`)
            .then(r => r.json())
            .then(setThumbnailMap)
            .catch(() => {})
    }, [def.dimension, rows, clienteId])

    const heatmapRanges = useMemo(() => {
        return def.columns.map((col, i) => {
            if (!col.highlight) return null
            const vals = rows.map(r => r.colValues[i]).filter((v): v is number => v !== null && !isNaN(v))
            if (vals.length === 0) return null
            return { min: Math.min(...vals), max: Math.max(...vals) }
        })
    }, [def.columns, rows])

    if (rows.length === 0) {
        const isNewDimension = def.dimension === 'ads' || def.dimension === 'adsets'
        return (
            <div className="col-span-1 md:col-span-4 bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center text-sm text-zinc-500">
                {isNewDimension
                    ? 'Datos disponibles tras el próximo sync'
                    : 'Sin datos para este rango'}
            </div>
        )
    }

    return (
        <div className="col-span-1 md:col-span-4 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-950/40">
                <h3 className="text-sm font-semibold text-white">{def.title}</h3>
            </div>
            <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full text-xs whitespace-nowrap">
                    <thead>
                        <tr className="border-b border-zinc-800 bg-zinc-950">
                            {def.showRank !== false && (
                                <th className="px-3 py-2 text-left text-zinc-500 font-medium w-8">#</th>
                            )}
                            {def.dimension === 'ads' && (
                                <th className="px-3 py-2 text-left text-zinc-500 font-medium w-14"></th>
                            )}
                            <th className="px-3 py-2 text-left text-zinc-500 font-medium">Nombre</th>
                            {def.columns.map(col => (
                                <th key={col.label} className="px-3 py-2 text-right text-zinc-500 font-medium">
                                    {col.label}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(({ row, colValues }, idx) => (
                            <tr key={row._id || idx} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition">
                                {def.showRank !== false && (
                                    <td className="px-3 py-2 text-zinc-600 font-mono text-[10px]">#{idx + 1}</td>
                                )}
                                {def.dimension === 'ads' && (
                                    <td className="px-3 py-1.5">
                                        {thumbnailMap[row._id] ? (
                                            <img
                                                src={thumbnailMap[row._id]!}
                                                alt=""
                                                className="w-10 h-10 rounded object-cover bg-zinc-800"
                                                onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                                            />
                                        ) : (
                                            <div className="w-10 h-10 rounded bg-zinc-800 animate-pulse" />
                                        )}
                                    </td>
                                )}
                                <td className="px-3 py-2 text-zinc-200 max-w-[220px]">
                                    <div className="flex items-center gap-1.5">
                                        <span className="truncate">{row._name}</span>
                                        {def.dimension === 'ads' && row._id && (
                                            <a
                                                href={`https://www.facebook.com/ads/library/?id=${row._id}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex-shrink-0 text-zinc-500 hover:text-blue-400 transition"
                                                title="Ver en Facebook Ad Library"
                                            >
                                                <ExternalLink className="w-3 h-3" />
                                            </a>
                                        )}
                                    </div>
                                </td>
                                {def.columns.map((col, i) => {
                                    const val = colValues[i]
                                    const range = heatmapRanges[i]
                                    let bgStyle: React.CSSProperties = {}
                                    if (col.highlight && range && val !== null && !isNaN(val) && range.max > range.min) {
                                        const intensity = (val - range.min) / (range.max - range.min)
                                        bgStyle = { background: `rgba(99,102,241,${intensity * 0.3})` }
                                    }
                                    return (
                                        <td key={col.label} className="px-3 py-2 text-right font-mono text-zinc-300" style={bgStyle}>
                                            {formatValue(val, { prefix: col.prefix, suffix: col.suffix, decimals: col.decimals })}
                                        </td>
                                    )
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
