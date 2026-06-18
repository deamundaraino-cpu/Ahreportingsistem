'use client'

import { useState } from 'react'
import { X, Link2, Copy, Check, Loader2, Trash2 } from 'lucide-react'

interface Props {
    reportId: string
    initialToken: string | null
    onClose: () => void
}

export function BiShareModal({ reportId, initialToken, onClose }: Props) {
    const [token, setToken]     = useState<string | null>(initialToken)
    const [loading, setLoading] = useState(false)
    const [copied, setCopied]   = useState(false)

    const publicUrl = token
        ? `${typeof window !== 'undefined' ? window.location.origin : ''}/report/bi/${token}`
        : null

    async function generate() {
        setLoading(true)
        try {
            const res = await fetch(`/api/report-utm/bi/reports/${reportId}/share`, { method: 'POST' })
            const json = await res.json()
            if (json.token) setToken(json.token)
        } finally {
            setLoading(false)
        }
    }

    async function revoke() {
        setLoading(true)
        try {
            await fetch(`/api/report-utm/bi/reports/${reportId}/share`, { method: 'DELETE' })
            setToken(null)
        } finally {
            setLoading(false)
        }
    }

    function copy() {
        if (!publicUrl) return
        navigator.clipboard.writeText(publicUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 1800)
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                    <div className="flex items-center gap-2">
                        <Link2 className="h-4 w-4 text-emerald-500" />
                        <p className="text-sm font-semibold text-foreground">Compartir informe</p>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="p-5 space-y-4">
                    {token ? (
                        <>
                            <p className="text-xs text-muted-foreground">
                                Cualquiera con este link puede ver el informe en modo solo lectura (sin necesidad de iniciar sesión).
                            </p>
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    readOnly
                                    value={publicUrl ?? ''}
                                    className="flex-1 px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground font-mono truncate"
                                />
                                <button
                                    onClick={copy}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald"
                                >
                                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                                    {copied ? 'Copiado' : 'Copiar'}
                                </button>
                            </div>
                            <button
                                onClick={revoke}
                                disabled={loading}
                                className="flex items-center gap-1.5 text-xs font-medium text-red-500 hover:text-red-600 transition-colors"
                            >
                                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                Revocar acceso público
                            </button>
                        </>
                    ) : (
                        <>
                            <p className="text-xs text-muted-foreground">
                                Genera un link público de solo lectura para compartir este informe con clientes o tu equipo.
                            </p>
                            <button
                                onClick={generate}
                                disabled={loading}
                                className="flex items-center gap-2 w-full justify-center px-4 py-2.5 rounded-xl text-sm font-medium text-white nav-active-emerald disabled:opacity-50"
                            >
                                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                                Generar link público
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    )
}
