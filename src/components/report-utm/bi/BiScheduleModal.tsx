'use client'

import { useEffect, useState } from 'react'
import { X, Clock, Check, Plus, Trash2, MessageCircle, Mail, History, Send, Copy, ExternalLink, Loader2 } from 'lucide-react'
import type { BiSchedule, BiDelivery } from './BiTypes'
import { describeSchedule, DELIVERY_HOUR } from '@/lib/report-utm/report-periods'

interface Props {
    reportId: string
    initial?: BiSchedule
    onSaved: (schedule: BiSchedule) => void
    onClose: () => void
}

const FREQ_LABEL: Record<NonNullable<BiSchedule['frequency']>, string> = {
    weekly: 'Semanal',
    biweekly: 'Quincenal',
    monthly: 'Mensual',
}

const WEEKDAYS = [
    { v: 1, label: 'Lunes' }, { v: 2, label: 'Martes' }, { v: 3, label: 'Miércoles' },
    { v: 4, label: 'Jueves' }, { v: 5, label: 'Viernes' }, { v: 6, label: 'Sábado' },
    { v: 0, label: 'Domingo' },
]

export function BiScheduleModal({ reportId, initial, onSaved, onClose }: Props) {
    const [enabled, setEnabled]     = useState(!!initial?.enabled)
    const [frequency, setFrequency] = useState<NonNullable<BiSchedule['frequency']>>(initial?.frequency ?? 'monthly')
    const [dayOfWeek, setDayOfWeek] = useState<number>(initial?.day_of_week ?? 1)
    const [dayOfMonth, setDayOfMonth] = useState<number>(initial?.day_of_month ?? 1)
    const [whatsapp, setWhatsapp]   = useState(!!initial?.channels?.whatsapp)
    const [email, setEmail]         = useState(!!initial?.channels?.email)
    const [emails, setEmails]       = useState<string[]>(initial?.emails?.length ? initial.emails : [''])
    const [saving, setSaving]       = useState(false)
    const [error, setError]         = useState<string | null>(null)

    // ── Historial de entregas ──
    const [deliveries, setDeliveries] = useState<BiDelivery[] | null>(null)
    const [sendingNow, setSendingNow] = useState(false)
    const [copied, setCopied]         = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        fetch(`/api/report-utm/bi/reports/${reportId}/deliveries`)
            .then(r => r.ok ? r.json() : { data: [] })
            .then(j => { if (!cancelled) setDeliveries(j.data ?? []) })
            .catch(() => { if (!cancelled) setDeliveries([]) })
        return () => { cancelled = true }
    }, [reportId])

    function buildSchedule(): BiSchedule {
        return {
            enabled,
            frequency,
            ...(frequency === 'weekly'  ? { day_of_week: dayOfWeek }   : {}),
            ...(frequency === 'monthly' ? { day_of_month: dayOfMonth } : {}),
            channels: { whatsapp, email },
            emails: emails.map(e => e.trim()).filter(Boolean),
        }
    }

    function validate(s: BiSchedule): string | null {
        if (!s.enabled) return null
        if (s.channels?.email && !s.emails?.length) return 'Agrega al menos un email o desactiva el canal Email.'
        if (!s.channels?.whatsapp && !s.channels?.email) return 'Elige al menos un canal (WhatsApp o Email).'
        return null
    }

    async function handleSave() {
        setError(null)
        const schedule = buildSchedule()
        const problem = validate(schedule)
        if (problem) { setError(problem); return }

        setSaving(true)
        try {
            const res = await fetch(`/api/report-utm/bi/reports/${reportId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ schedule }),
            })
            if (!res.ok) { setError('No se pudo guardar la programación.'); return }
            onSaved(schedule)
            onClose()
        } finally {
            setSaving(false)
        }
    }

    /** Envía ahora el último período completo (sin esperar al cron). */
    async function handleSendNow() {
        setError(null)
        const schedule = buildSchedule()
        const problem = validate({ ...schedule, enabled: true })
        if (problem) { setError(problem); return }

        setSendingNow(true)
        try {
            const res = await fetch(`/api/report-utm/bi/reports/${reportId}/deliveries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    frequency,
                    channels: schedule.channels,
                    emails: schedule.emails,
                }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) { setError(json?.error ?? 'No se pudo enviar el informe.'); return }
            const list = await fetch(`/api/report-utm/bi/reports/${reportId}/deliveries`).then(r => r.json())
            setDeliveries(list.data ?? [])
        } finally {
            setSendingNow(false)
        }
    }

    function copyLink(token: string) {
        navigator.clipboard.writeText(`${window.location.origin}/report/bi/d/${token}`)
        setCopied(token)
        setTimeout(() => setCopied(null), 2000)
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                        <Clock className="h-4 w-4" /> Envío automático
                    </p>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                    {/* Activar */}
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="h-4 w-4 rounded accent-emerald-500" />
                        <span className="text-sm font-medium text-foreground">Activar envío automático</span>
                    </label>

                    <div className={enabled ? '' : 'opacity-50 pointer-events-none'}>
                        {/* Frecuencia */}
                        <div className="mb-4">
                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Frecuencia</label>
                            <div className="flex gap-2">
                                {(['weekly', 'biweekly', 'monthly'] as const).map(f => (
                                    <button
                                        key={f}
                                        onClick={() => setFrequency(f)}
                                        className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-all ${
                                            frequency === f
                                                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : 'border-border bg-muted/30 text-muted-foreground hover:bg-accent'
                                        }`}
                                    >
                                        {FREQ_LABEL[f]}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Día y hora */}
                        <div className="mb-4 grid grid-cols-2 gap-2">
                            <div>
                                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Día de entrega</label>
                                {frequency === 'weekly' && (
                                    <select
                                        value={dayOfWeek}
                                        onChange={e => setDayOfWeek(Number(e.target.value))}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        {WEEKDAYS.map(d => <option key={d.v} value={d.v}>{d.label}</option>)}
                                    </select>
                                )}
                                {frequency === 'monthly' && (
                                    <select
                                        value={dayOfMonth}
                                        onChange={e => setDayOfMonth(Number(e.target.value))}
                                        className="w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                    >
                                        {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>Día {d}</option>)}
                                    </select>
                                )}
                                {frequency === 'biweekly' && (
                                    <p className="px-3 py-2 text-sm rounded-lg bg-muted/50 border border-border text-muted-foreground">Días 1 y 16</p>
                                )}
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Hora (Colombia)</label>
                                <p className="px-3 py-2 text-sm rounded-lg bg-muted/50 border border-border text-muted-foreground">
                                    {String(DELIVERY_HOUR).padStart(2, '0')}:00
                                </p>
                            </div>
                        </div>

                        <p className="-mt-2 mb-4 text-[11px] text-emerald-700 dark:text-emerald-400">
                            {describeSchedule({ frequency, day_of_week: dayOfWeek, day_of_month: dayOfMonth })}.
                            Cada envío reporta el último período completo.
                        </p>

                        {/* Canales */}
                        <div className="mb-4">
                            <label className="block text-xs font-medium text-muted-foreground mb-1.5">Canales</label>
                            <label className="flex items-center gap-2 cursor-pointer mb-2">
                                <input type="checkbox" checked={whatsapp} onChange={e => setWhatsapp(e.target.checked)} className="h-4 w-4 rounded accent-emerald-500" />
                                <MessageCircle className="h-3.5 w-3.5 text-emerald-600" />
                                <span className="text-sm text-foreground">WhatsApp <span className="text-[11px] text-muted-foreground">(al grupo del cliente)</span></span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={email} onChange={e => setEmail(e.target.checked)} className="h-4 w-4 rounded accent-emerald-500" />
                                <Mail className="h-3.5 w-3.5 text-sky-600" />
                                <span className="text-sm text-foreground">Email</span>
                            </label>
                        </div>

                        {/* Emails */}
                        {email && (
                            <div>
                                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Destinatarios (email)</label>
                                <div className="space-y-1.5">
                                    {emails.map((val, i) => (
                                        <div key={i} className="flex items-center gap-1.5">
                                            <input
                                                type="email"
                                                value={val}
                                                onChange={e => setEmails(prev => prev.map((v, idx) => idx === i ? e.target.value : v))}
                                                placeholder="cliente@dominio.com"
                                                className="flex-1 px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                                            />
                                            <button onClick={() => setEmails(prev => prev.filter((_, idx) => idx !== i))} className="p-1.5 text-muted-foreground hover:text-red-500">
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                                <button
                                    onClick={() => setEmails(prev => [...prev, ''])}
                                    className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                                >
                                    <Plus className="h-3 w-3" /> Agregar email
                                </button>
                            </div>
                        )}
                    </div>

                    <p className="text-[11px] text-muted-foreground">
                        Cada entrega genera un <strong>link propio con el período congelado</strong> (ej. &ldquo;Semana 2 de Julio 2026&rdquo;), de modo que el cliente siempre puede volver a consultarla. WhatsApp usa el grupo configurado del cliente; Email requiere <code>GMAIL_USER</code> y <code>GMAIL_APP_PASSWORD</code> en el servidor.
                    </p>
                    {error && <p className="text-xs text-red-500">{error}</p>}

                    {/* ── Historial de entregas ── */}
                    <div className="pt-4 border-t border-border">
                        <div className="flex items-center justify-between mb-2">
                            <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                                <History className="h-3.5 w-3.5" /> Historial de entregas
                            </p>
                            <button
                                onClick={handleSendNow}
                                disabled={sendingNow}
                                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border border-border text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
                            >
                                {sendingNow ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                                Enviar ahora
                            </button>
                        </div>

                        {deliveries === null ? (
                            <p className="text-[11px] text-muted-foreground py-2">Cargando…</p>
                        ) : deliveries.length === 0 ? (
                            <p className="text-[11px] text-muted-foreground py-2 italic">
                                Aún no hay entregas. Usa &ldquo;Enviar ahora&rdquo; o espera al envío programado.
                            </p>
                        ) : (
                            <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                                {deliveries.map(d => (
                                    <div key={d.id} className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-border bg-muted/30">
                                        <div className="min-w-0 flex-1">
                                            <p className="text-xs font-medium text-foreground truncate">{d.period_label}</p>
                                            <p className="text-[10px] text-muted-foreground">
                                                {d.date_from} → {d.date_to} · enviado {new Date(d.sent_at).toLocaleDateString('es-CO')}
                                            </p>
                                        </div>
                                        <button
                                            onClick={() => copyLink(d.delivery_token)}
                                            title="Copiar link"
                                            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                        >
                                            {copied === d.delivery_token ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                                        </button>
                                        <a
                                            href={`/report/bi/d/${d.delivery_token}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            title="Abrir"
                                            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                                        >
                                            <ExternalLink className="h-3.5 w-3.5" />
                                        </a>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
                    <button onClick={onClose} className="px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors">Cancelar</button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-50"
                    >
                        <Check className="h-3.5 w-3.5" />
                        {saving ? 'Guardando…' : 'Guardar'}
                    </button>
                </div>
            </div>
        </div>
    )
}
