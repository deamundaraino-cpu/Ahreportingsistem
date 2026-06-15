'use client'

import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
    CartesianGrid,
    Legend,
} from 'recharts'

/*
 * Chart chrome uses our design system dark values directly (matching the dark-mode
 * card background for the tooltip) so it reads well on both themes.
 * Tick / grid colors match --muted-foreground dark (#888888) and --chart-grid dark (white/5%).
 */

const PALETTE = ['#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899', '#14B8A6', '#F97316']

const TOOLTIP_STYLE = {
    background: '#222222',            // --card dark
    border: '1px solid oklch(1 0 0 / 10%)', // --border dark
    borderRadius: '8px',
    fontSize: '12px',
    color: '#F5F5F5',                 // --foreground dark
    boxShadow: 'none',
}

const TICK_COLOR = '#888888'          // --muted-foreground dark
const GRID_COLOR = 'oklch(1 0 0 / 5%)' // --chart-grid dark

export function RevenueTrendChart({
    data,
    currency,
}: {
    data: { day: string; revenue: number; sales: number }[]
    currency: string
}) {
    if (data.length === 0) {
        return <EmptyChart label="Sin datos en este rango" />
    }

    const maxRevenue = Math.max(...data.map((d) => d.revenue), 1)
    const tickFormatter = maxRevenue >= 1000
        ? (v: number) => `${(v / 1000).toFixed(1)}k`
        : (v: number) => v.toFixed(0)

    return (
        <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={GRID_COLOR} vertical={false} />
                <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: TICK_COLOR }}
                    tickLine={false}
                    axisLine={false}
                />
                <YAxis
                    tick={{ fontSize: 11, fill: TICK_COLOR }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={tickFormatter}
                />
                <Tooltip
                    cursor={{ fill: 'oklch(0.696 0.150 162 / 0.08)' }}
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value: number, name: string) =>
                        name === 'revenue'
                            ? [`${currency} ${value.toFixed(2)}`, 'Revenue']
                            : [value, 'Ventas']
                    }
                />
                <Bar dataKey="revenue" fill="#10B981" radius={[4, 4, 0, 0]} maxBarSize={48} />
            </BarChart>
        </ResponsiveContainer>
    )
}

export function SourceDistributionChart({
    data,
}: {
    data: { source: string; revenue: number; sales: number }[]
}) {
    if (data.length === 0) {
        return <EmptyChart label="Sin datos" />
    }
    const sliced = data.slice(0, 8)
    return (
        <ResponsiveContainer width="100%" height={260}>
            <PieChart>
                <Pie
                    data={sliced}
                    dataKey="revenue"
                    nameKey="source"
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={95}
                    paddingAngle={2}
                >
                    {sliced.map((_, i) => (
                        <Cell key={i} fill={PALETTE[i % PALETTE.length]} stroke="none" />
                    ))}
                </Pie>
                <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value: number) => value.toFixed(2)}
                />
                <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    wrapperStyle={{ fontSize: '12px', color: TICK_COLOR }}
                />
            </PieChart>
        </ResponsiveContainer>
    )
}

function EmptyChart({ label }: { label: string }) {
    return (
        <div className="h-[260px] flex items-center justify-center text-xs text-muted-foreground/70">
            {label}
        </div>
    )
}
