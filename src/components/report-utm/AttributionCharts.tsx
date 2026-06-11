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

const PALETTE = ['#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899', '#14B8A6', '#F97316']

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
    return (
        <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(120,120,120,0.15)" vertical={false} />
                <XAxis
                    dataKey="day"
                    tick={{ fontSize: 11, fill: '#9CA3AF' }}
                    tickLine={false}
                    axisLine={false}
                />
                <YAxis
                    tick={{ fontSize: 11, fill: '#9CA3AF' }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}k`}
                />
                <Tooltip
                    cursor={{ fill: 'rgba(16, 185, 129, 0.08)' }}
                    contentStyle={{
                        background: 'rgba(0,0,0,0.85)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        fontSize: '12px',
                        color: '#fff',
                    }}
                    formatter={(value: number, name: string) =>
                        name === 'revenue' ? [`${currency} ${value.toFixed(2)}`, 'Revenue'] : [value, 'Ventas']
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
                    contentStyle={{
                        background: 'rgba(0,0,0,0.85)',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        fontSize: '12px',
                        color: '#fff',
                    }}
                    formatter={(value: number) => value.toFixed(2)}
                />
                <Legend
                    verticalAlign="bottom"
                    height={36}
                    iconType="circle"
                    wrapperStyle={{ fontSize: '11px' }}
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
