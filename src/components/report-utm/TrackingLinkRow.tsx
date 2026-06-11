'use client'

import { useState, useTransition } from 'react'
import { Copy, Check, Power, Trash2, ExternalLink } from 'lucide-react'
import {
    toggleTrackingLinkAction,
    deleteTrackingLinkAction,
} from '@/app/(report-utm)/report-utm/links/_actions'

type Link = {
    id: string
    cliente_id: string
    slug: string
    nombre: string
    destination_url: string
    utm_source: string | null
    utm_campaign: string | null
    clicks_count: number
    enabled: boolean
    last_click_at: string | null
}

export function TrackingLinkRow({
    link,
    origin,
    clienteName,
}: {
    link: Link
    origin: string
    clienteName: string
}) {
    const [pending, startTransition] = useTransition()
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const shortUrl = `${origin}/t/${link.slug}`

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(shortUrl)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {}
    }

    const onToggle = () => {
        startTransition(async () => {
            const r = await toggleTrackingLinkAction(link.id, !link.enabled)
            if (!r.ok) setError(r.error)
        })
    }

    const onDelete = () => {
        if (!confirm(`¿Eliminar el link "${link.nombre}"? El slug /t/${link.slug} dejará de funcionar.`))
            return
        startTransition(async () => {
            const r = await deleteTrackingLinkAction(link.id)
            if (!r.ok) setError(r.error)
        })
    }

    return (
        <tr className={`hover:bg-accent ${!link.enabled ? 'opacity-60' : ''}`}>
            <td className="px-4 py-3">
                <p className="text-xs font-medium text-foreground">{link.nombre}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{clienteName}</p>
            </td>
            <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                    <code className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                        /t/{link.slug}
                    </code>
                    <button
                        onClick={copy}
                        className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        title="Copiar URL completa"
                    >
                        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                    </button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1 truncate max-w-xs">
                    → {link.destination_url}
                </p>
            </td>
            <td className="px-4 py-3 text-xs">
                <p className="font-mono text-emerald-600 dark:text-emerald-400">
                    {link.utm_source ?? '—'}
                </p>
                {link.utm_campaign && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                        {link.utm_campaign}
                    </p>
                )}
            </td>
            <td className="px-4 py-3 text-right">
                <p className="text-sm font-bold text-foreground">
                    {link.clicks_count.toLocaleString()}
                </p>
                {link.last_click_at && (
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                        {new Date(link.last_click_at).toLocaleDateString()}
                    </p>
                )}
            </td>
            <td className="px-4 py-3">
                <span
                    className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-md ${
                        link.enabled
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
                            : 'bg-muted text-muted-foreground'
                    }`}
                >
                    {link.enabled ? 'activo' : 'pausado'}
                </span>
            </td>
            <td className="px-4 py-3 text-right">
                <div className="flex items-center justify-end gap-1">
                    <a
                        href={shortUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-accent transition-colors"
                        title="Abrir link"
                    >
                        <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <button
                        onClick={onToggle}
                        disabled={pending}
                        className="p-1.5 rounded text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 hover:bg-accent transition-colors disabled:opacity-50"
                        title={link.enabled ? 'Pausar' : 'Activar'}
                    >
                        <Power className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={onDelete}
                        disabled={pending}
                        className="p-1.5 rounded text-muted-foreground hover:text-red-600 dark:hover:text-red-400 hover:bg-accent transition-colors disabled:opacity-50"
                        title="Eliminar"
                    >
                        <Trash2 className="h-3.5 w-3.5" />
                    </button>
                </div>
                {error && <p className="text-[10px] text-red-500 mt-1">{error}</p>}
            </td>
        </tr>
    )
}
