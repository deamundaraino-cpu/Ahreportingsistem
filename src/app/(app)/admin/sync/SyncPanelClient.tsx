'use client'

import React, { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Loader2, RotateCcw, XCircle, Unlock, PlayCircle, ChevronDown, ChevronRight } from 'lucide-react'
import {
    retrySyncJob,
    cancelSyncJob,
    enqueueSyncRange,
    reabrirPeriodo,
    type SyncPanelData,
} from './_actions'

const ESTADO_COLOR: Record<string, string> = {
    pending: 'text-amber-600 dark:text-amber-400',
    running: 'text-blue-600 dark:text-blue-400',
    done: 'text-green-600 dark:text-green-400',
    ok: 'text-green-600 dark:text-green-400',
    partial: 'text-amber-600 dark:text-amber-400',
    error: 'text-red-600 dark:text-red-400',
    cancelled: 'text-muted-foreground',
}

function fmtDuracion(ms: number | null): string {
    if (!ms) return '—'
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

function fmtFecha(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * Las líneas que explican POR QUÉ una corrida no trajo datos.
 *
 * Una corrida larga deja ~100 líneas y casi todas son ruido ("N tx traídas").
 * Al abrir el detalle interesan primero los fallos, así que se muestran arriba
 * y el resto queda debajo.
 */
const PATRON_PROBLEMA = /error|fall|incomplet|omit|sin token|sin credencial|preservan|rechaz|inválid|no disponible|límite/i

function partirLogs(logs: unknown): { problemas: string[]; resto: string[] } {
    if (!Array.isArray(logs)) return { problemas: [], resto: [] }
    const lineas = logs.map(String)
    return {
        problemas: lineas.filter((l) => PATRON_PROBLEMA.test(l)),
        resto: lineas.filter((l) => !PATRON_PROBLEMA.test(l)),
    }
}

export function SyncPanelClient({ data, isAdmin }: { data: SyncPanelData; isAdmin: boolean }) {
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    const [msg, setMsg] = useState<string | null>(null)

    const [clienteId, setClienteId] = useState<string>('')
    const [start, setStart] = useState<string>('')
    const [end, setEnd] = useState<string>('')
    /** Id de la ejecución cuyo detalle de logs está abierto. */
    const [runAbierta, setRunAbierta] = useState<string | null>(null)

    const nombreCliente = (id: string | null) =>
        id ? (data.clientes.find(c => c.id === id)?.nombre ?? id.slice(0, 8)) : 'Todos'

    const run = (fn: () => Promise<{ error?: string; success?: boolean; encolados?: number }>, ok: string) => {
        startTransition(async () => {
            const res = await fn()
            setMsg(res.error ? `❌ ${res.error}` : `✅ ${ok}${res.encolados != null ? ` (${res.encolados} job(s))` : ''}`)
            router.refresh()
            setTimeout(() => setMsg(null), 6000)
        })
    }

    const activos = data.jobs.filter(j => ['pending', 'running', 'error'].includes(j.estado))

    return (
        <div className="space-y-6">
            {msg && (
                <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{msg}</div>
            )}

            {/* ── Resumen de la cola ── */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {(['pending', 'running', 'done', 'error', 'cancelled'] as const).map(estado => (
                    <div key={estado} className="rounded-lg border border-border bg-card p-3">
                        <div className={`text-2xl font-bold ${ESTADO_COLOR[estado]}`}>{data.cola[estado] ?? 0}</div>
                        <div className="text-xs text-muted-foreground capitalize">{estado}</div>
                    </div>
                ))}
            </div>

            {/* ── Encolar un rango ── */}
            {isAdmin && (
                <div className="rounded-lg border border-border bg-card p-4 space-y-3">
                    <h3 className="font-semibold text-sm">Encolar sincronización</h3>
                    <p className="text-xs text-muted-foreground">
                        Los rangos largos se trocean en unidades de 14 días y se procesan en segundo plano.
                        Las fechas de meses congelados se omiten automáticamente.
                    </p>
                    <div className="flex flex-wrap items-end gap-2">
                        <label className="text-xs">
                            <span className="block text-muted-foreground mb-1">Cliente</span>
                            <select
                                value={clienteId}
                                onChange={e => setClienteId(e.target.value)}
                                className="h-8 rounded-md border border-border bg-background px-2 text-sm"
                            >
                                <option value="">Todos</option>
                                {data.clientes.map(c => (
                                    <option key={c.id} value={c.id}>{c.nombre}</option>
                                ))}
                            </select>
                        </label>
                        <label className="text-xs">
                            <span className="block text-muted-foreground mb-1">Desde</span>
                            <input type="date" value={start} onChange={e => setStart(e.target.value)}
                                className="h-8 rounded-md border border-border bg-background px-2 text-sm" />
                        </label>
                        <label className="text-xs">
                            <span className="block text-muted-foreground mb-1">Hasta</span>
                            <input type="date" value={end} onChange={e => setEnd(e.target.value)}
                                className="h-8 rounded-md border border-border bg-background px-2 text-sm" />
                        </label>
                        <Button
                            size="sm"
                            className="h-8 gap-2"
                            disabled={pending || !start || !end}
                            onClick={() => run(() => enqueueSyncRange(clienteId || null, start, end), 'Encolado')}
                        >
                            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                            Encolar
                        </Button>
                    </div>
                </div>
            )}

            {/* ── Cola activa ── */}
            <div className="rounded-lg border border-border bg-card">
                <div className="border-b border-border px-4 py-3">
                    <h3 className="font-semibold text-sm">Cola activa ({activos.length})</h3>
                </div>
                {activos.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-muted-foreground">No hay trabajos pendientes ni fallidos.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="text-xs text-muted-foreground">
                                <tr className="border-b border-border">
                                    <th className="text-left px-4 py-2">Tipo</th>
                                    <th className="text-left px-4 py-2">Cliente</th>
                                    <th className="text-left px-4 py-2">Rango</th>
                                    <th className="text-left px-4 py-2">Estado</th>
                                    <th className="text-left px-4 py-2">Intentos</th>
                                    <th className="text-left px-4 py-2">Origen</th>
                                    <th className="text-left px-4 py-2">Error</th>
                                    <th className="px-4 py-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {activos.map(j => (
                                    <tr key={j.id} className="border-b border-border/50 last:border-0">
                                        <td className="px-4 py-2 font-mono text-xs">{j.tipo}</td>
                                        <td className="px-4 py-2">{nombreCliente(j.cliente_id)}</td>
                                        <td className="px-4 py-2 text-xs text-muted-foreground">
                                            {j.fecha_inicio ?? '—'} → {j.fecha_fin ?? '—'}
                                        </td>
                                        <td className={`px-4 py-2 font-medium ${ESTADO_COLOR[j.estado]}`}>{j.estado}</td>
                                        <td className="px-4 py-2 text-xs">{j.intentos}/{j.max_intentos}</td>
                                        <td className="px-4 py-2 text-xs text-muted-foreground">{j.triggered_by}</td>
                                        <td className="px-4 py-2 text-xs text-red-500/80 max-w-[240px] truncate" title={j.last_error ?? ''}>
                                            {j.last_error ?? '—'}
                                        </td>
                                        <td className="px-4 py-2">
                                            {isAdmin && (
                                                <div className="flex gap-1 justify-end">
                                                    <Button size="sm" variant="ghost" className="h-7 px-2" disabled={pending}
                                                        onClick={() => run(() => retrySyncJob(j.id), 'Reintento encolado')}>
                                                        <RotateCcw className="h-3.5 w-3.5" />
                                                    </Button>
                                                    <Button size="sm" variant="ghost" className="h-7 px-2" disabled={pending}
                                                        onClick={() => run(() => cancelSyncJob(j.id), 'Cancelado')}>
                                                        <XCircle className="h-3.5 w-3.5" />
                                                    </Button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* ── Historial ── */}
            <div className="rounded-lg border border-border bg-card">
                <div className="border-b border-border px-4 py-3">
                    <h3 className="font-semibold text-sm">Últimas ejecuciones</h3>
                </div>
                {data.runs.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-muted-foreground">
                        Aún no hay ejecuciones registradas. Aparecerán aquí en cuanto el worker procese el primer job.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="text-xs text-muted-foreground">
                                <tr className="border-b border-border">
                                    <th className="text-left px-4 py-2 w-8"></th>
                                    <th className="text-left px-4 py-2">Cuándo</th>
                                    <th className="text-left px-4 py-2">Tipo</th>
                                    <th className="text-left px-4 py-2">Cliente</th>
                                    <th className="text-left px-4 py-2">Estado</th>
                                    <th className="text-right px-4 py-2">Duración</th>
                                    <th className="text-right px-4 py-2">Filas</th>
                                    <th className="text-left px-4 py-2">Ejecutor</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.runs.map(r => {
                                    const { problemas, resto } = partirLogs(r.logs)
                                    const hayDetalle = problemas.length + resto.length > 0 || Boolean(r.error)
                                    const abierta = runAbierta === r.id
                                    return (
                                        <React.Fragment key={r.id}>
                                            <tr
                                                className={`border-b border-border/50 ${hayDetalle ? 'cursor-pointer hover:bg-muted/40' : ''}`}
                                                onClick={() => hayDetalle && setRunAbierta(abierta ? null : r.id)}
                                            >
                                                <td className="px-4 py-2 text-muted-foreground">
                                                    {hayDetalle && (abierta
                                                        ? <ChevronDown className="h-3.5 w-3.5" />
                                                        : <ChevronRight className="h-3.5 w-3.5" />)}
                                                </td>
                                                <td className="px-4 py-2 text-xs text-muted-foreground">{fmtFecha(r.started_at)}</td>
                                                <td className="px-4 py-2 font-mono text-xs">{r.tipo}</td>
                                                <td className="px-4 py-2">{nombreCliente(r.cliente_id)}</td>
                                                <td className={`px-4 py-2 font-medium ${ESTADO_COLOR[r.estado]}`}>
                                                    {r.estado}
                                                    {problemas.length > 0 && (
                                                        <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                                                            {problemas.length} aviso{problemas.length > 1 ? 's' : ''}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2 text-right text-xs">{fmtDuracion(r.duracion_ms)}</td>
                                                <td className="px-4 py-2 text-right text-xs">
                                                    {r.filas_escritas}
                                                    {r.filas_saltadas > 0 && (
                                                        <span className="text-muted-foreground"> (+{r.filas_saltadas} sin cambios)</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-2 text-xs text-muted-foreground">{r.ejecutor}</td>
                                            </tr>
                                            {abierta && (
                                                <tr className="border-b border-border/50 bg-muted/30">
                                                    <td colSpan={8} className="px-4 py-3">
                                                        {r.error && (
                                                            <p className="mb-2 font-mono text-xs text-red-600 dark:text-red-400 break-all">
                                                                {r.error}
                                                            </p>
                                                        )}
                                                        {problemas.length > 0 && (
                                                            <div className="mb-3">
                                                                <p className="mb-1 text-xs font-semibold text-muted-foreground">Avisos y errores</p>
                                                                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px] text-amber-700 dark:text-amber-400">
                                                                    {problemas.join('\n')}
                                                                </pre>
                                                            </div>
                                                        )}
                                                        {resto.length > 0 && (
                                                            <details>
                                                                <summary className="cursor-pointer text-xs text-muted-foreground">
                                                                    Traza completa ({resto.length} línea{resto.length > 1 ? 's' : ''})
                                                                </summary>
                                                                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-[11px] text-muted-foreground">
                                                                    {resto.join('\n')}
                                                                </pre>
                                                            </details>
                                                        )}
                                                        {problemas.length === 0 && resto.length === 0 && !r.error && (
                                                            <p className="text-xs text-muted-foreground">Sin logs registrados.</p>
                                                        )}
                                                    </td>
                                                </tr>
                                            )}
                                        </React.Fragment>
                                    )
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* ── Períodos congelados ── */}
            <div className="rounded-lg border border-border bg-card">
                <div className="border-b border-border px-4 py-3">
                    <h3 className="font-semibold text-sm">Períodos congelados</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        El worker omite estas fechas para que los informes ya entregados no cambien.
                        Al reabrir se conserva el snapshot como respaldo.
                    </p>
                </div>
                {data.periodosCerrados.length === 0 ? (
                    <p className="px-4 py-6 text-sm text-muted-foreground">
                        Ningún período congelado todavía. El cierre automático corre el día 7 de cada mes.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="text-xs text-muted-foreground">
                                <tr className="border-b border-border">
                                    <th className="text-left px-4 py-2">Cliente</th>
                                    <th className="text-left px-4 py-2">Período</th>
                                    <th className="text-left px-4 py-2">Congelado</th>
                                    <th className="px-4 py-2"></th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.periodosCerrados.map(p => (
                                    <tr key={`${p.cliente_id}-${p.periodo}`} className="border-b border-border/50 last:border-0">
                                        <td className="px-4 py-2">{nombreCliente(p.cliente_id)}</td>
                                        <td className="px-4 py-2 font-mono text-xs">{String(p.periodo).slice(0, 7)}</td>
                                        <td className="px-4 py-2 text-xs text-muted-foreground">{fmtFecha(p.cerrado_at)}</td>
                                        <td className="px-4 py-2 text-right">
                                            {isAdmin && (
                                                <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs" disabled={pending}
                                                    onClick={() => run(() => reabrirPeriodo(p.cliente_id, p.periodo), 'Período reabierto')}>
                                                    <Unlock className="h-3.5 w-3.5" />
                                                    Reabrir
                                                </Button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    )
}
