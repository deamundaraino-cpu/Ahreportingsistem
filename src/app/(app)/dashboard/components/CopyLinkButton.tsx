'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Link, Check } from 'lucide-react'

export function CopyLinkButton({ clientId }: { clientId: string }) {
    const [copied, setCopied] = useState(false)

    const handleCopy = () => {
        const url = `${window.location.origin}/report/${clientId}`
        navigator.clipboard.writeText(url)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
            className={`gap-2 ${copied ? 'text-emerald-400 border-emerald-500/50 bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-950 hover:bg-zinc-800 hover:text-zinc-200'}`}
        >
            {copied ? <Check className="w-4 h-4" /> : <Link className="w-4 h-4" />}
            {copied ? 'Copiado' : 'Link Público'}
        </Button>
    )
}
