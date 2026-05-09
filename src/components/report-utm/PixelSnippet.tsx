'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export function PixelSnippet({ origin, clienteSlug }: { origin: string; clienteSlug: string }) {
    const [copied, setCopied] = useState(false)
    const snippet = `<script>window.RUTM_CONFIG={cliente:'${clienteSlug}'};</script>
<script async src="${origin}/report-utm-pixel.js"></script>`

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(snippet)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {}
    }

    return (
        <div className="rounded-lg border border-zinc-200 dark:border-white/[0.06] bg-zinc-950 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06]">
                <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                    HTML · pegar antes de &lt;/head&gt;
                </span>
                <button
                    onClick={copy}
                    className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                    {copied ? (
                        <>
                            <Check className="h-3 w-3" />
                            Copiado
                        </>
                    ) : (
                        <>
                            <Copy className="h-3 w-3" />
                            Copiar
                        </>
                    )}
                </button>
            </div>
            <pre className="p-4 text-[11px] font-mono text-zinc-100 overflow-x-auto leading-relaxed">
                {snippet}
            </pre>
        </div>
    )
}
