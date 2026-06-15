'use client'

import { Copy, Check } from 'lucide-react'

export function CopyField({
    label,
    value,
    onCopy,
    copied,
    mono = true,
}: {
    label?: string
    value: string
    onCopy: () => void
    copied: boolean
    mono?: boolean
}) {
    return (
        <div>
            {label && (
                <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
            )}
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
                <code className={`flex-1 text-xs ${mono ? 'font-mono' : ''} text-foreground/90 truncate`}>
                    {value}
                </code>
                <button
                    type="button"
                    onClick={onCopy}
                    aria-label="Copiar al portapapeles"
                    className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                    {copied ? (
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                    ) : (
                        <Copy className="h-3.5 w-3.5" />
                    )}
                </button>
            </div>
        </div>
    )
}

/** Returns a clipboard copy handler that sets `copied` state for 1.5 s */
export function useCopyHandler(
    setCopied: (v: boolean) => void,
): (value: string) => void {
    return async (value: string) => {
        try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            /* ignore */
        }
    }
}
