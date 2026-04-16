'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Globe } from 'lucide-react'
import { PublicLayoutEditor } from './PublicLayoutEditor'
import type { CardDef, ChartDef } from '@/lib/layout-types'

export function PublicLayoutButton({
    clienteId,
    initialLayout,
    conversionesCatalogo = [],
}: {
    clienteId: string
    initialLayout: { tarjetas: CardDef[]; graficos: ChartDef[] } | null
    conversionesCatalogo?: { conversion_key: string; label: string; field_id: string }[]
}) {
    const [showEditor, setShowEditor] = useState(false)

    return (
        <>
            <Button
                variant="outline"
                size="sm"
                onClick={() => setShowEditor(true)}
                className={`gap-2 ${initialLayout ? 'text-emerald-400 border-emerald-500/50 bg-emerald-500/5 hover:bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 bg-zinc-950 hover:bg-zinc-800 hover:text-zinc-200'}`}
            >
                <Globe className="w-4 h-4" />
                {initialLayout ? 'Vista Ejecutiva ✦' : 'Configurar Vista Pública'}
            </Button>

            {showEditor && (
                <PublicLayoutEditor
                    clienteId={clienteId}
                    initialLayout={initialLayout}
                    conversionesCatalogo={conversionesCatalogo}
                    onClose={() => setShowEditor(false)}
                />
            )}
        </>
    )
}
