'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, Check, AlertCircle } from 'lucide-react'
import { runAggregateNowAction } from '@/app/(report-utm)/report-utm/atribucion/_actions'

export function RunAggregateButton({ clienteId, hours = 24 }: { clienteId?: string; hours?: number }) {
    const router = useRouter()
    const [pending, startTransition] = useTransition()
    const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

    const onClick = () => {
        setResult(null)
        startTransition(async () => {
            const r = await runAggregateNowAction({ clienteId, hours })
            if (r.ok) {
                setResult({ ok: true, msg: `Agregadas ${r.rowsWritten} filas` })
                router.refresh()
            } else {
                setResult({ ok: false, msg: r.error })
            }
            setTimeout(() => setResult(null), 4000)
        })
    }

    return (
        <div className="flex items-center gap-2">
            <button
                onClick={onClick}
                disabled={pending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                           text-foreground/90
                           border border-border
                           hover:bg-accent
                           disabled:opacity-50 transition-colors"
            >
                <Sparkles className="h-3.5 w-3.5" />
                {pending ? 'Agregando…' : `Recalcular ${hours}h`}
            </button>
            {result && (
                <span
                    className={`text-[11px] flex items-center gap-1 ${
                        result.ok
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                    }`}
                >
                    {result.ok ? <Check className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
                    {result.msg}
                </span>
            )}
        </div>
    )
}
