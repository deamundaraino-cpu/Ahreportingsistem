'use client'

import { useState, useTransition } from 'react'
import { format, subMonths } from 'date-fns'
import { es } from 'date-fns/locale'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Plus, Loader2, ChevronRight, Trash2, RefreshCw, ExternalLink } from 'lucide-react'
import { createMonthlyReport, deleteMonthlyReport, updateReportStatus } from './_actions'
import { useRouter } from 'next/navigation'

const ESTADO_CONFIG: Record<string, { label: string; color: string }> = {
    borrador:   { label: 'Borrador',  color: 'bg-muted text-muted-foreground' },
    revision:   { label: 'Revisión',  color: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20' },
    aprobado:   { label: 'Aprobado',  color: 'bg-blue-500/10 text-blue-700 dark:text-blue-400 border border-blue-500/20' },
    publicado:  { label: 'Publicado', color: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20' },
}

const NEXT_ACTION: Record<string, string> = {
    borrador:  'Enviar a Revisión',
    revision:  'Aprobar',
    aprobado:  'Publicar',
    publicado: '',
}

interface Props {
    initialReports: any[]
    templates: any[]
    clientes: { id: string; nombre: string }[]
}

export function ReportsClient({ initialReports, templates, clientes }: Props) {
    const router = useRouter()
    const [reports, setReports] = useState(initialReports)
    const [isPending, startTransition] = useTransition()

    // New report form state
    const [creating, setCreating] = useState(false)
    const [selectedCliente, setSelectedCliente] = useState('')
    const [selectedTemplate, setSelectedTemplate] = useState('')
    const [selectedPeriodo, setSelectedPeriodo] = useState(() => format(subMonths(new Date(), 1), 'yyyy-MM'))

    // Filter state
    const [filterCliente, setFilterCliente] = useState('all')

    const filteredReports = filterCliente === 'all'
        ? reports
        : reports.filter(r => r.cliente_id === filterCliente)

    async function handleCreate() {
        if (!selectedCliente || !selectedPeriodo) return
        setCreating(true)
        const res = await createMonthlyReport({
            cliente_id: selectedCliente,
            periodo: selectedPeriodo,
            template_id: selectedTemplate || undefined,
        })
        setCreating(false)
        if (res.success) {
            router.push(`/admin/reports/${res.data.id}`)
        }
    }

    async function handleAdvanceStatus(reportId: string, currentEstado: string) {
        const nextMap: Record<string, string> = {
            borrador: 'revision', revision: 'aprobado', aprobado: 'publicado'
        }
        const next = nextMap[currentEstado]
        if (!next) return
        startTransition(async () => {
            const res = await updateReportStatus(reportId, next)
            if (res.success) {
                setReports(prev => prev.map(r =>
                    r.id === reportId ? { ...r, estado: next } : r
                ))
            }
        })
    }

    async function handleDelete(id: string) {
        if (!confirm('¿Eliminar este reporte?')) return
        startTransition(async () => {
            await deleteMonthlyReport(id)
            setReports(prev => prev.filter(r => r.id !== id))
        })
    }

    // Generate month options (last 12 months)
    const monthOptions = Array.from({ length: 12 }, (_, i) => {
        const d = subMonths(new Date(), i + 1)
        return { value: format(d, 'yyyy-MM'), label: format(d, 'MMMM yyyy', { locale: es }) }
    })

    return (
        <div className="space-y-6">
            {/* Create New Report */}
            <Card className="bg-card border-border">
                <CardHeader>
                    <CardTitle className="text-foreground text-base">Crear Nuevo Reporte</CardTitle>
                    <CardDescription className="text-muted-foreground">
                        Selecciona cliente y mes. Las campañas activas se detectan automáticamente.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-wrap gap-3 items-end">
                        <div className="flex-1 min-w-40">
                            <label className="text-xs text-muted-foreground mb-1 block">Cliente</label>
                            <Select value={selectedCliente} onValueChange={setSelectedCliente}>
                                <SelectTrigger className="bg-background border-input text-foreground">
                                    <SelectValue placeholder="Seleccionar cliente..." />
                                </SelectTrigger>
                                <SelectContent className="bg-card border-border">
                                    {clientes.map(c => (
                                        <SelectItem key={c.id} value={c.id}>{c.nombre}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex-1 min-w-36">
                            <label className="text-xs text-muted-foreground mb-1 block">Período</label>
                            <Select value={selectedPeriodo} onValueChange={setSelectedPeriodo}>
                                <SelectTrigger className="bg-background border-input text-foreground">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-card border-border">
                                    {monthOptions.map(m => (
                                        <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="flex-1 min-w-44">
                            <label className="text-xs text-muted-foreground mb-1 block">Template (opcional)</label>
                            <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                                <SelectTrigger className="bg-background border-input text-foreground">
                                    <SelectValue placeholder="Sin template..." />
                                </SelectTrigger>
                                <SelectContent className="bg-card border-border">
                                    {templates.map(t => (
                                        <SelectItem key={t.id} value={t.id}>{t.nombre}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <Button
                            onClick={handleCreate}
                            disabled={!selectedCliente || !selectedPeriodo || creating}
                            className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white"
                        >
                            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                            Auto-Generar
                        </Button>
                    </div>
                </CardContent>
            </Card>

            {/* Filter + Reports List */}
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-foreground font-medium">Reportes ({filteredReports.length})</h3>
                    <Select value={filterCliente} onValueChange={setFilterCliente}>
                        <SelectTrigger className="w-48 h-8 text-xs bg-card border-input text-foreground/90">
                            <SelectValue placeholder="Filtrar por cliente" />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                            <SelectItem value="all">Todos los clientes</SelectItem>
                            {clientes.map(c => (
                                <SelectItem key={c.id} value={c.id}>{c.nombre}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {filteredReports.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground/70 border border-dashed border-border rounded-xl">
                        <p>No hay reportes creados. Usa el formulario de arriba para generar el primero.</p>
                    </div>
                )}

                <div className="space-y-2">
                    {filteredReports.map(report => {
                        const cfg = ESTADO_CONFIG[report.estado] || ESTADO_CONFIG.borrador
                        const nextAction = NEXT_ACTION[report.estado]
                        const periodo = report.periodo
                        const clienteNombre = report.cliente?.nombre || 'Cliente'
                        const templateNombre = report.template?.nombre || 'Sin template'

                        return (
                            <div
                                key={report.id}
                                className="flex items-center gap-4 p-4 rounded-lg bg-card border border-border hover:border-ring transition"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-foreground font-medium">{clienteNombre}</span>
                                        <span className="text-muted-foreground/70 text-sm">·</span>
                                        <span className="text-muted-foreground text-sm font-mono">{periodo}</span>
                                        <Badge className={`text-[10px] px-2 py-0 ${cfg.color}`}>{cfg.label}</Badge>
                                    </div>
                                    <p className="text-xs text-muted-foreground/70">
                                        {templateNombre} · {(report.campaigns_included || []).length} campañas
                                    </p>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                    {report.estado === 'publicado' && report.public_slug && (
                                        <a
                                            href={`/report/monthly/${report.public_slug}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            className="p-1.5 rounded text-muted-foreground/70 hover:text-emerald-600 dark:hover:text-emerald-400 transition"
                                            title="Ver reporte público"
                                        >
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    )}

                                    {nextAction && (
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            disabled={isPending}
                                            onClick={() => handleAdvanceStatus(report.id, report.estado)}
                                            className="h-7 text-xs border-input text-foreground/90 hover:bg-accent"
                                        >
                                            {isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : nextAction}
                                        </Button>
                                    )}

                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => router.push(`/admin/reports/${report.id}`)}
                                        className="h-7 text-xs text-muted-foreground hover:text-foreground"
                                    >
                                        <ChevronRight className="w-4 h-4" />
                                    </Button>

                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled={isPending}
                                        onClick={() => handleDelete(report.id)}
                                        className="h-7 text-muted-foreground/70 hover:text-red-600 dark:hover:text-red-400"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </Button>
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>
        </div>
    )
}
