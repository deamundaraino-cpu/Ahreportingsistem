'use client'

import { useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Globe, ChevronDown, ChevronUp, TrendingUp, DollarSign } from 'lucide-react'
import { aggregateByCountry, type CountryMetrics } from '@/lib/country-parser'
import type { TabCampaignFilter } from '@/lib/layout-types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number, prefix = '', suffix = '', decimals = 2): string {
    if (!isFinite(n)) return '-'
    const s = n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    return `${prefix}${s}${suffix}`
}


const BAR_COLORS = ['bg-blue-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-cyan-500']

// ─── Country Row ──────────────────────────────────────────────────────────────

function CountryRow({ cm, totalSpend, rank }: { cm: CountryMetrics; totalSpend: number; rank: number }) {
    const [expanded, setExpanded] = useState(false)
    const barColor = BAR_COLORS[rank % BAR_COLORS.length]
    const spendPct = totalSpend > 0 ? (cm.spend / totalSpend) * 100 : 0

    return (
        <div className="border border-border rounded-lg overflow-hidden">
            {/* Summary row */}
            <button
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-accent transition text-left"
                onClick={() => setExpanded(v => !v)}
            >
                {/* Rank badge */}
                <span className="text-xs font-bold text-muted-foreground/70 w-5 shrink-0">#{rank + 1}</span>

                {/* Country name */}
                <span className="font-medium text-foreground w-28 shrink-0 truncate">{cm.country}</span>

                {/* Spend bar */}
                <div className="flex-1 flex items-center gap-2 min-w-0">
                    <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className={`h-full ${barColor} rounded-full`} style={{ width: `${spendPct}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground w-10 text-right shrink-0">{spendPct.toFixed(0)}%</span>
                </div>

                {/* Key metrics */}
                <div className="hidden md:flex items-center gap-6 shrink-0">
                    <div className="text-right">
                        <p className="text-xs text-muted-foreground/70">Gasto</p>
                        <p className="text-sm font-semibold text-foreground">{fmt(cm.spend, '$', '', 2)}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs text-muted-foreground/70">Leads</p>
                        <p className="text-sm font-semibold text-foreground">{cm.leads.toLocaleString()}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs text-muted-foreground/70">CPL</p>
                        <p className="text-sm font-semibold text-foreground">
                            {cm.cpl !== null ? fmt(cm.cpl, '$', '', 2) : '-'}
                        </p>
                    </div>
                    <div className="text-right">
                        <p className="text-xs text-muted-foreground/70">Resultados</p>
                        <p className="text-sm font-semibold text-foreground">{cm.results.toLocaleString()}</p>
                    </div>
                </div>

                <span className="text-muted-foreground/70 shrink-0 ml-2">
                    {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </span>
            </button>

            {/* Expanded detail */}
            {expanded && (
                <div className="border-t border-border px-4 py-4 grid grid-cols-1 md:grid-cols-2 gap-4 bg-card/40">
                    {/* Top ads by results */}
                    <div>
                        <div className="flex items-center gap-1.5 mb-2">
                            <TrendingUp className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Top por Resultados</span>
                        </div>
                        {cm.topAdsByResults.length === 0 ? (
                            <p className="text-xs text-muted-foreground/70">Sin datos</p>
                        ) : (
                            <div className="space-y-1.5">
                                {cm.topAdsByResults.map((ad, i) => (
                                    <div key={i} className="flex items-start justify-between gap-2 text-xs">
                                        <span className="text-muted-foreground truncate max-w-[65%]" title={ad.name}>{ad.name}</span>
                                        <div className="shrink-0 text-right space-x-2">
                                            <span className="text-emerald-600 dark:text-emerald-400 font-medium">{ad.results} res.</span>
                                            <span className="text-muted-foreground/70">{fmt(ad.spend, '$', '', 0)}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Top ads by spend */}
                    <div>
                        <div className="flex items-center gap-1.5 mb-2">
                            <DollarSign className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Top por Gasto</span>
                        </div>
                        {cm.topAdsByCost.length === 0 ? (
                            <p className="text-xs text-muted-foreground/70">Sin datos</p>
                        ) : (
                            <div className="space-y-1.5">
                                {cm.topAdsByCost.map((ad, i) => (
                                    <div key={i} className="flex items-start justify-between gap-2 text-xs">
                                        <span className="text-muted-foreground truncate max-w-[65%]" title={ad.name}>{ad.name}</span>
                                        <div className="shrink-0 text-right space-x-2">
                                            <span className="text-amber-600 dark:text-amber-400 font-medium">{fmt(ad.spend, '$', '', 0)}</span>
                                            <span className="text-muted-foreground/70">{ad.results} res.</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Mobile fallback for key metrics */}
                    <div className="md:hidden col-span-1 flex gap-4 flex-wrap text-xs">
                        <span className="text-muted-foreground/70">Gasto: <strong className="text-foreground">{fmt(cm.spend, '$', '', 2)}</strong></span>
                        <span className="text-muted-foreground/70">Leads: <strong className="text-foreground">{cm.leads}</strong></span>
                        <span className="text-muted-foreground/70">CPL: <strong className="text-foreground">{cm.cpl !== null ? fmt(cm.cpl, '$', '', 2) : '-'}</strong></span>
                    </div>
                </div>
            )}
        </div>
    )
}

// ─── Main Component ───────────────────────────────────────────────────────────

interface CountryBreakdownProps {
    metrics: any[]           // enriched metric rows (already filtered by tab keyword)
    keywordFilter?: string | TabCampaignFilter
    leadsFormula?: string    // e.g. "meta_custom_leadduaypiar" or "meta_leads"
}

export function CountryBreakdown({ metrics, keywordFilter = '', leadsFormula = 'meta_leads' }: CountryBreakdownProps) {
    const countries = useMemo(
        () => aggregateByCountry(metrics, keywordFilter, leadsFormula),
        [metrics, keywordFilter, leadsFormula]
    )

    const totalSpend = useMemo(() => countries.reduce((s, c) => s + c.spend, 0), [countries])

    if (countries.length === 0) {
        return (
            <Card className="bg-card/60 border-border">
                <CardContent className="flex flex-col items-center justify-center py-10 text-muted-foreground/70 gap-2">
                    <Globe className="w-8 h-8" />
                    <p className="text-sm">No hay datos de países detectados.</p>
                    <p className="text-xs">Asegúrate de que los nombres de campaña incluyan el país separado por guión: <code className="bg-muted px-1 rounded">Nombre-País</code></p>
                </CardContent>
            </Card>
        )
    }

    return (
        <Card className="bg-card/60 border-border">
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-foreground text-base">
                    <Globe className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    Desglose por País
                    <span className="ml-auto text-xs font-normal text-muted-foreground/70">{countries.length} países · ${totalSpend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total</span>
                </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
                {countries.map((cm, i) => (
                    <CountryRow key={cm.country} cm={cm} totalSpend={totalSpend} rank={i} />
                ))}
            </CardContent>
        </Card>
    )
}
