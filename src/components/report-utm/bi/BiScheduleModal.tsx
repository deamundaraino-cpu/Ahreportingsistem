'use client'

import { useState } from 'react'
import { X, Clock, Check, Plus, Trash2, MessageCircle, Mail } from 'lucide-react'
import type { BiSchedule } from './BiTypes'

interface Props {
    reportId: string
    initial?: BiSchedule
    onSaved: (schedule: BiSchedule) => void
    onClose: () => void
}

export function BiScheduleModal({ reportId, initial, onSaved, onClose }: Props) {
    const [enabled, setEnabled]     = useState(!!initial?.enabled)
    const [frequency, setFrequency] = useState<'weekly' | 'monthly'>(initial?.frequency ?? 'monthly')
    const [whatsapp, setWhatsapp]   = useState(!!initial?.channels?.whatsapp)
    const [email, setEmail]         = useState(!!initial?.channels?.email)
    const [emails, setEmails]       = useState<string[]>(initial?.emails?.length ? initial.emails : [''])
    const [saving, setSaving]       = useState(false)
    const [error, setError]         = useState<string | null>(null)

    async function handleSave() {
        setError(null)
        const cleanEmails = emails.map(e => e.trim()).filter(Boolean)
        if (enabled && email && cleanEmails.length === 0) {
            setError('Agrega al menos un email o desactiva el canal Email.')
            return
        }
        if (enabled && !whatsapp && !email) {
            setError('Elige al menos un canal (WhatsApp o Email).')
            return
        }
        const schedule: BiSchedule = {
            enabled,
            frequency,
            channels: { whatsapp, email },
            emails: cleanEmails,
        }
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

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
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
                                {(['weekly', 'monthly'] as const).map(f => (
                                    <button
                                        key={f}
                                        onClick={() => setFrequency(f)}
                                        className={`flex-1 py-2 rounded-lg text-xs font-medium border transition-all ${
                                            frequency === f
                                                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                                : 'border-border bg-muted/30 text-muted-foreground hover:bg-accent'
                                        }`}
                                    >
                                        {f === 'weekly' ? 'Semanal' : 'Mensual'}
                                    </button>
                                ))}
                            </div>
                        </div>

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
                        El informe se envía como un <strong>link de solo lectura</strong> siempre actualizado. WhatsApp usa el grupo configurado del cliente; Email requiere la clave de Resend en el servidor.
                    </p>
                    {error && <p className="text-xs text-red-500">{error}</p>}
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
