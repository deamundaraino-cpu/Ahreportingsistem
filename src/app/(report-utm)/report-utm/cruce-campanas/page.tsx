'use client'

import { useState, useEffect, useCallback } from 'react'
import { Link2, Loader2, Plus, Trash2, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'

interface Cliente { id: string; nombre: string }
interface Campaign { campaign_id: string | null; name: string; platform: 'meta' | 'tiktok'; spend: number }
interface Override { id: string; match_field: string; match_value: string; platform: string; campaign_id: string | null; campaign_name: string | null }
interface Unmatched { field: string; value: string; count: number }

function daysAgo(n: number) { return new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10) }
function today() { return new Date().toISOString().slice(0, 10) }

export default function CruceCampanasPage() {
    const [clientes, setClientes] = useState<Cliente[]>([])
    const [clienteId, setClienteId] = useState('')
    const [dateFrom, setDateFrom] = useState(daysAgo(30))
    const [dateTo, setDateTo] = useState(today())

    const [campaigns, setCampaigns] = useState<Campaign[]>([])
    const [overrides, setOverrides] = useState<Override[]>([])
    const [unmatched, setUnmatched] = useState<Unmatched[]>([])
    const [loading, setLoading] = useState(false)

    // Selección por fila sin cruzar: campaign_id elegido
    const [picks, setPicks] = useState<Record<string, string>>({})

    useEffect(() => {
        fetch('/api/report-utm/clientes').then(r => r.json()).then(j => {
            setClientes(j.data ?? [])
            if (j.data?.[0]) setClienteId(j.data[0].id)
        }).catch(() => {})
    }, [])

    const load = useCallback(() => {
        if (!clienteId) return
        setLoading(true)
        const p = new URLSearchParams({ cliente_id: clienteId, date_from: dateFrom, date_to: dateTo })
        fetch(`/api/report-utm/bi/campaign-map?${p}`)
            .then(r => r.json())
            .then(j => {
                setCampaigns(j.campaigns ?? [])
                setOverrides(j.overrides ?? [])
                setUnmatched(j.unmatched ?? [])
            })
            .catch(() => {})
            .finally(() => setLoading(false))
    }, [clienteId, dateFrom, dateTo])

    useEffect(() => { load() }, [load])

    async function saveOverride(u: Unmatched) {
        const key = `${u.field}||${u.value}`
        const campKey = picks[key]
        if (!campKey) return
        const camp = campaigns.find(c => `${c.platform}:${c.campaign_id ?? c.name}` === campKey)
        if (!camp) return
        await fetch('/api/report-utm/bi/campaign-map', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cliente_id: clienteId,
                match_field: u.field,
                match_value: u.value,
                platform: camp.platform,
                campaign_id: camp.campaign_id,
                campaign_name: camp.name,
            }),
        })
        load()
    }

    async function removeOverride(id: string) {
        await fetch(`/api/report-utm/bi/campaign-map?id=${id}`, { method: 'DELETE' })
        load()
    }

    const matchedPct = unmatched.length === 0 ? 100 : null

    return (
        <div className="space-y-6">
            <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
                    Report-UTM · Datos
                </p>
                <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1 flex items-center gap-2">
                    <Link2 className="h-6 w-6 text-emerald-500" />
                    Cruce Leads × Campañas
                </h1>
                <p className="mt-1 text-sm text-muted-foreground">
                    Conecta los UTMs de tus leads con las campañas reales de Meta/TikTok. Lo que no cruce automáticamente, mapéalo aquí.
                </p>
            </div>

            {/* Filtros */}
            <div className="rounded-2xl border border-border bg-card p-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">Cliente</label>
                    <select value={clienteId} onChange={e => setClienteId(e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground">
                        {clientes.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                    </select>
                </div>
                <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">Desde</label>
                    <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground" />
                </div>
                <div>
                    <label className="block text-[10px] font-medium text-muted-foreground mb-1">Hasta</label>
                    <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                        className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground" />
                </div>
                <div className="flex items-end">
                    <button onClick={load} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald w-full justify-center">
                        <RefreshCw className="h-3.5 w-3.5" /> Actualizar
                    </button>
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : (
                <>
                    {/* Resumen */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <Stat label="Campañas detectadas" value={String(campaigns.length)} icon={CheckCircle2} tone="emerald" />
                        <Stat label="UTMs sin cruzar" value={String(unmatched.length)} icon={AlertTriangle} tone={unmatched.length > 0 ? 'amber' : 'emerald'} />
                        <Stat label="Mapeos manuales" value={String(overrides.length)} icon={Link2} tone="emerald" />
                    </div>

                    {/* UTMs sin cruzar → mapear */}
                    <div className="rounded-2xl border border-border bg-card overflow-hidden">
                        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                            <h2 className="text-sm font-semibold text-foreground">UTMs sin cruzar</h2>
                            <span className="text-[10px] text-muted-foreground font-mono ml-auto">{unmatched.length} valores</span>
                        </div>
                        {matchedPct === 100 ? (
                            <div className="px-6 py-10 text-center">
                                <CheckCircle2 className="h-8 w-8 text-emerald-500 mx-auto mb-2" />
                                <p className="text-sm font-medium text-foreground">¡Todo cruzado!</p>
                                <p className="text-xs text-muted-foreground">Todos los leads del rango se asociaron a una campaña.</p>
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-muted/60">
                                        <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                            <th className="px-6 py-3">Campo</th>
                                            <th className="px-6 py-3">Valor UTM</th>
                                            <th className="px-6 py-3 text-right">Leads</th>
                                            <th className="px-6 py-3">Mapear a campaña</th>
                                            <th className="px-6 py-3"></th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {unmatched.map(u => {
                                            const key = `${u.field}||${u.value}`
                                            return (
                                                <tr key={key} className="hover:bg-accent">
                                                    <td className="px-6 py-3 text-[11px] font-mono text-muted-foreground">{u.field}</td>
                                                    <td className="px-6 py-3 text-xs font-mono text-foreground max-w-[280px] truncate">{u.value}</td>
                                                    <td className="px-6 py-3 text-right text-xs font-mono tabular-nums text-foreground">{u.count}</td>
                                                    <td className="px-6 py-3">
                                                        <select
                                                            value={picks[key] ?? ''}
                                                            onChange={e => setPicks(p => ({ ...p, [key]: e.target.value }))}
                                                            className="w-full max-w-[260px] px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground"
                                                        >
                                                            <option value="">Elegir campaña…</option>
                                                            {campaigns.map(c => {
                                                                const ck = `${c.platform}:${c.campaign_id ?? c.name}`
                                                                return <option key={ck} value={ck}>[{c.platform}] {c.name}</option>
                                                            })}
                                                        </select>
                                                    </td>
                                                    <td className="px-6 py-3">
                                                        <button
                                                            onClick={() => saveOverride(u)}
                                                            disabled={!picks[key]}
                                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white nav-active-emerald disabled:opacity-40"
                                                        >
                                                            <Plus className="h-3 w-3" /> Mapear
                                                        </button>
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Mapeos existentes */}
                    {overrides.length > 0 && (
                        <div className="rounded-2xl border border-border bg-card overflow-hidden">
                            <div className="px-6 py-4 border-b border-border flex items-center gap-2">
                                <Link2 className="h-4 w-4 text-emerald-500" />
                                <h2 className="text-sm font-semibold text-foreground">Mapeos manuales</h2>
                            </div>
                            <table className="w-full">
                                <thead className="bg-muted/60">
                                    <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                        <th className="px-6 py-3">Campo</th>
                                        <th className="px-6 py-3">Valor UTM</th>
                                        <th className="px-6 py-3">Campaña</th>
                                        <th className="px-6 py-3"></th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {overrides.map(o => (
                                        <tr key={o.id} className="hover:bg-accent">
                                            <td className="px-6 py-3 text-[11px] font-mono text-muted-foreground">{o.match_field}</td>
                                            <td className="px-6 py-3 text-xs font-mono text-foreground max-w-[260px] truncate">{o.match_value}</td>
                                            <td className="px-6 py-3 text-xs text-foreground">[{o.platform}] {o.campaign_name}</td>
                                            <td className="px-6 py-3">
                                                <button onClick={() => removeOverride(o.id)} className="p-1 text-muted-foreground hover:text-red-500">
                                                    <Trash2 className="h-3.5 w-3.5" />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                        Tras mapear, usa la dimensión <code className="font-mono px-1 py-0.5 rounded bg-muted">Campaña (cruzada)</code> en cualquier
                        tabla o gráfica del BI para ver gasto, leads, CPL y ROAS por campaña real.
                    </p>
                </>
            )}
        </div>
    )
}

function Stat({ label, value, icon: Icon, tone }: { label: string; value: string; icon: typeof Link2; tone: 'emerald' | 'amber' }) {
    const color = tone === 'amber' ? 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10' : 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10'
    return (
        <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${color}`}>
                    <Icon className="h-4 w-4" />
                </div>
            </div>
            <p className="mt-3 text-2xl font-semibold font-mono tabular-nums text-foreground">{value}</p>
        </div>
    )
}
