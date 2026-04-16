'use client'

import { useEffect, useState, useTransition } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
    ArrowLeft, Loader2, CheckSquare, Square, ChevronUp, ChevronDown,
    RefreshCw, ExternalLink, Download
} from 'lucide-react'
import {
    getMonthlyReport, getReportTemplates,
    updateMonthlyReport, updateReportStatus, revertReportStatus
} from '../_actions'

const ESTADO_CONFIG: Record<string, { label: string; color: string }> = {
    borrador:   { label: 'Borrador',  color: 'bg-zinc-700 text-zinc-300' },
    revision:   { label: 'Revisión',  color: 'bg-amber-500/20 text-amber-300 border border-amber-500/30' },
    aprobado:   { label: 'Aprobado',  color: 'bg-blue-500/20 text-blue-300 border border-blue-500/30' },
    publicado:  { label: 'Publicado', color: 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' },
}

const NEXT_ACTION: Record<string, string> = {
    borrador:  'Enviar a Revisión',
    revision:  'Aprobar Reporte',
    aprobado:  'Publicar',
    publicado: '',
}

export default function ReportEditorPage() {
    const { id } = useParams<{ id: string }>()
    const router = useRouter()
    const [isPending, startTransition] = useTransition()

    const [report, setReport] = useState<any>(null)
    const [templates, setTemplates] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)

    // Local editing state
    const [includedKeys, setIncludedKeys] = useState<Set<string>>(new Set())
    const [selectedTemplate, setSelectedTemplate] = useState('')

    useEffect(() => {
        async function load() {
            const [r, t] = await Promise.all([
                getMonthlyReport(id),
                getReportTemplates(),
            ])
            setReport(r)
            setTemplates(t)
            if (r) {
                const keys = new Set<string>(
                    (r.campaigns_included || []).map((c: any) => c.campaign_id || c.name)
                )
                setIncludedKeys(keys)
                setSelectedTemplate(r.template_id || 'none')
            }
            setLoading(false)
        }
        load()
    }, [id])

    function toggleCampaign(key: string) {
        setIncludedKeys(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    async function handleSave() {
        if (!report) return
        setSaving(true)
        const allDiscovered = report.campaigns_discovered || []
        const included = allDiscovered.filter((c: any) =>
            includedKeys.has(c.campaign_id || c.name)
        )
        await updateMonthlyReport(id, {
            template_id: (selectedTemplate && selectedTemplate !== 'none') ? selectedTemplate : undefined,
            campaigns_included: included,
        })
        setSaving(false)
    }

    async function handleAdvance() {
        if (!report) return
        startTransition(async () => {
            const nextMap: Record<string, string> = { borrador: 'revision', revision: 'aprobado', aprobado: 'publicado' }
            const res = await updateReportStatus(id, nextMap[report.estado] || '')
            if (res.success) setReport((prev: any) => ({ ...prev, estado: res.newStatus }))
        })
    }

    async function handleRevert() {
        if (!report) return
        startTransition(async () => {
            const res = await revertReportStatus(id)
            if (res.success) {
                const REVERSE: Record<string, string> = {
                    revision: 'borrador', aprobado: 'revision', publicado: 'aprobado'
                }
                setReport((prev: any) => ({ ...prev, estado: REVERSE[prev.estado] || prev.estado }))
            }
        })
    }

    async function handleDownloadPdf() {
        const { default: html2canvas } = await import('html2canvas')
        const { jsPDF } = await import('jspdf')
        const el = document.getElementById('report-preview')
        if (!el) return
        const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#09090b' })
        const imgData = canvas.toDataURL('image/png')
        const pdf = new jsPDF('p', 'mm', 'a4')
        const pdfWidth = pdf.internal.pageSize.getWidth()
        const pdfHeight = (canvas.height * pdfWidth) / canvas.width
        pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight)
        pdf.save(`reporte-${report.cliente?.nombre}-${report.periodo}.pdf`)
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
            </div>
        )
    }

    if (!report) {
        return (
            <div className="text-center py-12 text-zinc-400">
                <p>Reporte no encontrado.</p>
                <Button variant="ghost" onClick={() => router.push('/admin/reports')} className="mt-4">
                    <ArrowLeft className="w-4 h-4 mr-2" /> Volver
                </Button>
            </div>
        )
    }

    const cfg = ESTADO_CONFIG[report.estado] || ESTADO_CONFIG.borrador
    const nextAction = NEXT_ACTION[report.estado]
    const allDiscovered: any[] = report.campaigns_discovered || []
    const isEditable = report.estado === 'borrador'

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
                <Button variant="ghost" onClick={() => router.push('/admin/reports')} className="text-zinc-400">
                    <ArrowLeft className="w-4 h-4" />
                </Button>
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-xl font-bold text-white">
                            {report.cliente?.nombre} · {report.periodo}
                        </h2>
                        <Badge className={`text-xs ${cfg.color}`}>{cfg.label}</Badge>
                    </div>
                    <p className="text-zinc-500 text-sm">{report.template?.nombre || 'Sin template asignado'}</p>
                </div>

                <div className="flex items-center gap-2">
                    {report.estado === 'publicado' && report.public_slug && (
                        <a
                            href={`/report/monthly/${report.public_slug}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 text-sm text-emerald-400 hover:underline"
                        >
                            <ExternalLink className="w-4 h-4" /> Ver Público
                        </a>
                    )}

                    <Button
                        size="sm"
                        variant="outline"
                        onClick={handleDownloadPdf}
                        className="gap-1.5 border-zinc-700 text-zinc-300"
                    >
                        <Download className="w-4 h-4" /> PDF
                    </Button>

                    {report.estado !== 'borrador' && (
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={isPending}
                            onClick={handleRevert}
                            className="border-zinc-700 text-zinc-400"
                        >
                            <ChevronDown className="w-4 h-4 mr-1" /> Revertir
                        </Button>
                    )}

                    {nextAction && (
                        <Button
                            size="sm"
                            disabled={isPending}
                            onClick={handleAdvance}
                            className="gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white"
                        >
                            {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronUp className="w-4 h-4" />}
                            {nextAction}
                        </Button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-12 gap-6">
                {/* Left: Config */}
                <div className="col-span-4 space-y-4">
                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-white text-sm">Configuración</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div>
                                <label className="text-xs text-zinc-400 mb-1.5 block">Template de Reporte</label>
                                <Select
                                    value={selectedTemplate}
                                    onValueChange={setSelectedTemplate}
                                    disabled={!isEditable}
                                >
                                    <SelectTrigger className="bg-zinc-950 border-zinc-700 text-zinc-200">
                                        <SelectValue placeholder="Sin template..." />
                                    </SelectTrigger>
                                    <SelectContent className="bg-zinc-900 border-zinc-700">
                                        <SelectItem value="none">Sin template</SelectItem>
                                        {templates.map(t => (
                                            <SelectItem key={t.id} value={t.id}>{t.nombre}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {isEditable && (
                                <Button
                                    className="w-full bg-zinc-800 hover:bg-zinc-700 text-white"
                                    onClick={handleSave}
                                    disabled={saving}
                                >
                                    {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                    Guardar Cambios
                                </Button>
                            )}
                        </CardContent>
                    </Card>

                    {/* Campaign selector */}
                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-white text-sm">Campañas Descubiertas</CardTitle>
                            <CardDescription className="text-zinc-500 text-xs">
                                {includedKeys.size} de {allDiscovered.length} incluidas
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-1.5 max-h-96 overflow-y-auto">
                            {allDiscovered.map((c: any) => {
                                const key = c.campaign_id || c.name
                                const included = includedKeys.has(key)
                                return (
                                    <button
                                        key={key}
                                        disabled={!isEditable}
                                        onClick={() => toggleCampaign(key)}
                                        className={`w-full flex items-center gap-2 p-2 rounded text-left transition ${
                                            included ? 'bg-indigo-500/10 border border-indigo-500/20' : 'bg-zinc-800/50 border border-transparent'
                                        } ${isEditable ? 'hover:bg-zinc-800 cursor-pointer' : 'cursor-default'}`}
                                    >
                                        {included
                                            ? <CheckSquare className="w-4 h-4 text-indigo-400 shrink-0" />
                                            : <Square className="w-4 h-4 text-zinc-600 shrink-0" />
                                        }
                                        <div className="flex-1 min-w-0">
                                            <p className="text-xs text-zinc-200 truncate">{c.name}</p>
                                            <p className="text-[10px] text-zinc-500">${c.spend?.toFixed(2)} · {c.leads} leads</p>
                                        </div>
                                    </button>
                                )
                            })}
                        </CardContent>
                    </Card>
                </div>

                {/* Right: Preview */}
                <div className="col-span-8">
                    <Card className="bg-zinc-900 border-zinc-800">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-white text-sm">Preview del Reporte</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div id="report-preview" className="bg-zinc-950 rounded-lg p-6 space-y-4">
                                <div className="border-b border-zinc-800 pb-4">
                                    <h1 className="text-xl font-bold text-white">{report.cliente?.nombre}</h1>
                                    <p className="text-zinc-400 text-sm">Reporte de Rendimiento · {report.periodo}</p>
                                    {report.template && (
                                        <p className="text-xs text-indigo-400 mt-1">{report.template.nombre}</p>
                                    )}
                                </div>

                                {/* Campaign summary */}
                                <div>
                                    <h2 className="text-sm font-semibold text-zinc-300 mb-2">Campañas Incluidas</h2>
                                    <div className="space-y-1.5">
                                        {(report.campaigns_included || [])
                                            .filter((c: any) => includedKeys.has(c.campaign_id || c.name))
                                            .map((c: any) => (
                                                <div key={c.campaign_id || c.name} className="flex items-center justify-between text-xs py-1.5 border-b border-zinc-800/50">
                                                    <span className="text-zinc-300">{c.name}</span>
                                                    <div className="flex gap-4 text-zinc-500">
                                                        <span>${c.spend?.toFixed(2)}</span>
                                                        <span>{c.leads} leads</span>
                                                        <span>{c.impressions?.toLocaleString()} impr.</span>
                                                    </div>
                                                </div>
                                            ))
                                        }
                                    </div>
                                </div>

                                {allDiscovered.filter((c: any) => includedKeys.has(c.campaign_id || c.name)).length === 0 && (
                                    <p className="text-zinc-600 text-sm text-center py-8">Selecciona campañas para incluir en el reporte.</p>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    )
}
