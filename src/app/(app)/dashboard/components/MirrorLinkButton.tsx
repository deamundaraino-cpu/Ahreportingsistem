'use client'

import React, { useState } from 'react'
import { Button } from "@/components/ui/button"
import { Share2, Copy, Check, ExternalLink } from 'lucide-react'
import { getOrCreatePublicToken } from '../_actions'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface MirrorLinkButtonProps {
    id: string
    type: 'client' | 'tab'
    className?: string
}

export function MirrorLinkButton({ id, type, className }: MirrorLinkButtonProps) {
    const [loading, setLoading] = useState(false)
    const [token, setToken] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)

    const handleOpenShare = async () => {
        setLoading(true)
        const res = await getOrCreatePublicToken(id, type)
        if (res.token) {
            setToken(res.token)
        } else {
            alert("Error al generar el link: " + res.error)
        }
        setLoading(false)
    }

    const publicUrl = token ? `${window.location.origin}/p/${token}` : ''

    const copyToClipboard = () => {
        navigator.clipboard.writeText(publicUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <Dialog onOpenChange={(open) => { if (open) handleOpenShare() }}>
            <DialogTrigger asChild>
                <Button
                    size="sm"
                    variant="outline"
                    className={`gap-1.5 text-xs border-zinc-700 text-zinc-400 hover:text-indigo-300 hover:border-indigo-500/40 hover:bg-indigo-500/5 transition ${className}`}
                >
                    <Share2 className="w-3.5 h-3.5" />
                    Link Público Espejo
                </Button>
            </DialogTrigger>
            <DialogContent className="bg-zinc-950 border-zinc-800 text-white sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Link Público Espejo</DialogTitle>
                    <DialogDescription className="text-zinc-400">
                        Comparte este enlace único para que cualquiera pueda ver este reporte en tiempo real sin necesidad de iniciar sesión.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex items-center space-x-2 pt-4">
                    <div className="grid flex-1 gap-2">
                        <Input
                            readOnly
                            value={loading ? 'Generando...' : publicUrl}
                            className="bg-zinc-900 border-zinc-800 text-zinc-300 h-9"
                        />
                    </div>
                    <Button 
                        size="sm" 
                        onClick={copyToClipboard} 
                        className="bg-indigo-600 hover:bg-indigo-700 h-9"
                        disabled={!token}
                    >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </Button>
                </div>
                {token && (
                    <div className="pt-2 text-[10px] text-zinc-500 flex items-center gap-1">
                        <ExternalLink className="w-3 h-3" />
                        Puede abrirse en cualquier navegador
                    </div>
                )}
            </DialogContent>
        </Dialog>
    )
}
