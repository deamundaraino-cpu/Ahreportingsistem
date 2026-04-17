'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Globe, Copy, Check, ExternalLink, Loader2 } from 'lucide-react'
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { getOrCreatePublicToken, savePublicTabConfig } from '../_actions'

interface Tab {
    id: string
    nombre: string
    keyword_meta: string
}

export function PublicLinkButton({
    clienteId,
    tabs,
    initialTabIds = [],
}: {
    clienteId: string
    tabs: Tab[]
    initialTabIds?: string[]
}) {
    const [open, setOpen] = useState(false)
    const [loading, setLoading] = useState(false)
    const [token, setToken] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [selectedTabIds, setSelectedTabIds] = useState<string[]>(initialTabIds)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)

    const handleOpen = async () => {
        setOpen(true)
        if (!token) {
            setLoading(true)
            const res = await getOrCreatePublicToken(clienteId, 'client')
            if (res.token) setToken(res.token)
            setLoading(false)
        }
    }

    const publicUrl = token ? `${window.location.origin}/p/${token}` : ''

    const copyToClipboard = () => {
        navigator.clipboard.writeText(publicUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    const toggleTab = (id: string) => {
        setSelectedTabIds(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        )
        setSaved(false)
    }

    const handleSave = async () => {
        setSaving(true)
        await savePublicTabConfig(clienteId, selectedTabIds)
        setSaving(false)
        setSaved(true)
    }

    const isConfigured = initialTabIds.length > 0

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                onClick={handleOpen}
                className={`gap-2 ${isConfigured ? 'text-emerald-400 border-emerald-500/50 bg-emerald-500/5 hover:bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-950 hover:bg-zinc-800 hover:text-zinc-200'}`}
            >
                <Globe className="w-4 h-4" />
                {isConfigured ? 'Link Público ✦' : 'Link Público'}
            </Button>

            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="bg-zinc-950 border-zinc-800 text-white sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Link Público</DialogTitle>
                        <DialogDescription className="text-zinc-400">
                            Elige qué pestañas se mostrarán en el link público. La vista es un espejo del dashboard interno.
                        </DialogDescription>
                    </DialogHeader>

                    {/* Link URL */}
                    <div className="flex items-center gap-2 pt-2">
                        <Input
                            readOnly
                            value={loading ? 'Generando link...' : publicUrl}
                            className="bg-zinc-900 border-zinc-800 text-zinc-300 h-9 text-xs"
                        />
                        <Button
                            size="sm"
                            onClick={copyToClipboard}
                            className="bg-indigo-600 hover:bg-indigo-700 h-9 shrink-0"
                            disabled={!token}
                        >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                        </Button>
                    </div>
                    {token && (
                        <p className="text-[10px] text-zinc-500 flex items-center gap-1 -mt-1">
                            <ExternalLink className="w-3 h-3" />
                            Accesible sin iniciar sesión
                        </p>
                    )}

                    {/* Tab selector */}
                    <div className="border-t border-zinc-800 pt-4 mt-2">
                        <p className="text-xs text-zinc-400 mb-3 font-medium">Pestañas visibles en el link público:</p>
                        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                            {tabs.length === 0 ? (
                                <p className="text-xs text-zinc-500 italic py-2">No hay pestañas configuradas aún.</p>
                            ) : (
                                tabs.map(tab => {
                                    const isSelected = selectedTabIds.includes(tab.id)
                                    return (
                                        <button
                                            key={tab.id}
                                            onClick={() => toggleTab(tab.id)}
                                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-all ${
                                                isSelected
                                                    ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-300'
                                                    : 'border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                                            }`}
                                        >
                                            <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all ${
                                                isSelected
                                                    ? 'bg-indigo-600 border-indigo-600'
                                                    : 'border-zinc-600 bg-transparent'
                                            }`}>
                                                {isSelected && (
                                                    <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                    </svg>
                                                )}
                                            </div>
                                            <span className="text-sm font-medium">{tab.nombre}</span>
                                            {tab.keyword_meta && (
                                                <span className="ml-auto text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-500 font-mono shrink-0">
                                                    {tab.keyword_meta}
                                                </span>
                                            )}
                                        </button>
                                    )
                                })
                            )}
                        </div>
                        {tabs.length > 0 && (
                            <p className="text-[10px] text-zinc-600 mt-2">
                                {selectedTabIds.length === 0
                                    ? 'Sin pestañas seleccionadas — el link mostrará todas las pestañas.'
                                    : `${selectedTabIds.length} pestaña${selectedTabIds.length > 1 ? 's' : ''} seleccionada${selectedTabIds.length > 1 ? 's' : ''}`}
                            </p>
                        )}
                    </div>

                    <div className="flex justify-end gap-2 pt-2 border-t border-zinc-800">
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setOpen(false)}
                            className="text-zinc-400 hover:text-zinc-200"
                        >
                            Cerrar
                        </Button>
                        <Button
                            size="sm"
                            onClick={handleSave}
                            disabled={saving}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white"
                        >
                            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                            {saved ? '¡Guardado! ✓' : 'Guardar selección'}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    )
}
