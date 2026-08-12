'use client'

/**
 * Editor de un bloque de respuestas de formulario.
 *
 * Vive en su propio fichero porque lo usan los DOS caminos de configuración —el
 * editor rápido del bloque y el Layout Builder—, y duplicarlo garantizaría que
 * una opción añadida en uno faltara en el otro.
 */

import { PreguntaPicker } from './PreguntaPicker'
import { CampaignFilterPicker } from './LayoutConfigModal'
import type { LeadAnswerBlockDef, CampaignFilterSpec } from '@/lib/layout-types'

interface Props {
    def: LeadAnswerBlockDef
    onChange: (def: LeadAnswerBlockDef) => void
    clienteId: string
    campaignGroups?: { id: string; nombre: string }[]
    campaignNames?: string[]
}

const TOPS = [5, 10, 12, 20, 50]

export function LeadAnswerEditor({ def, onChange, clienteId, campaignGroups = [], campaignNames = [] }: Props) {
    const patch = (p: Partial<LeadAnswerBlockDef>) => onChange({ ...def, ...p })

    return (
        <div className="space-y-5">
            <div>
                <label className="block text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                    Título del bloque
                </label>
                <input
                    value={def.title}
                    onChange={e => patch({ title: e.target.value })}
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-muted-foreground/50"
                    placeholder="Respuestas de formulario"
                />
            </div>

            <div>
                <label className="block text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                    Pregunta a desglosar
                </label>
                <PreguntaPicker clienteId={clienteId} def={def} onChange={patch} />
            </div>

            <div>
                <label className="block text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                    Visualización
                </label>
                <select
                    value={def.display ?? 'bars'}
                    onChange={e => patch({ display: e.target.value as 'bars' | 'daily' })}
                    className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                >
                    <option value="bars">Barras — totales del período</option>
                    <option value="daily">Tabla diaria — cuántos por día y de qué está hecho</option>
                </select>
                <p className="text-[11px] text-muted-foreground/70 mt-1">
                    La tabla diaria muestra el total de contactos de cada día y su reparto por
                    respuesta, incluidos los que no contestaron.
                </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="block text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                        Máximo de respuestas
                    </label>
                    <select
                        value={def.topN ?? 12}
                        onChange={e => patch({ topN: Number(e.target.value) })}
                        className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground"
                    >
                        {TOPS.map(n => <option key={n} value={n}>Top {n}</option>)}
                    </select>
                </div>
                <div className="flex items-end">
                    <label className="flex items-center gap-2 text-xs text-foreground/90 pb-2">
                        <input
                            type="checkbox"
                            checked={def.agruparResto !== false}
                            onChange={e => patch({ agruparResto: e.target.checked })}
                            className="accent-sky-500"
                        />
                        Agrupar el resto
                    </label>
                </div>
            </div>

            <div className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-foreground/90">
                    <input
                        type="checkbox"
                        checked={def.showDelta !== false}
                        onChange={e => patch({ showDelta: e.target.checked })}
                        className="accent-sky-500"
                    />
                    Comparar con el período anterior
                </label>
                <label className="flex items-center gap-2 text-xs text-foreground/90">
                    <input
                        type="checkbox"
                        checked={def.showCsv !== false}
                        onChange={e => patch({ showCsv: e.target.checked })}
                        className="accent-sky-500"
                    />
                    Permitir descargar CSV
                </label>
                <label className="flex items-center gap-2 text-xs text-foreground/90">
                    <input
                        type="checkbox"
                        checked={!!def.ocultarVacios}
                        onChange={e => patch({ ocultarVacios: e.target.checked })}
                        className="accent-sky-500"
                    />
                    Ocultar respuestas sin leads
                </label>
            </div>

            <div>
                <label className="block text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                    Filtro de campañas del bloque
                </label>
                <p className="text-[11px] text-muted-foreground/70 mb-2">
                    Se aplica DESPUÉS del filtro de la pestaña, acotando lo que esta ya deja pasar.
                </p>
                <CampaignFilterPicker
                    value={def.campaignFilter}
                    onChange={(v: CampaignFilterSpec | undefined) => patch({ campaignFilter: v })}
                    campaignGroups={campaignGroups}
                    campaignNames={campaignNames}
                />
            </div>

            <p className="text-[11px] text-muted-foreground/70 border-t border-border pt-3">
                Este bloque mide <span className="text-foreground">solo leads</span>. No ofrece
                gasto ni CPL por respuesta porque la inversión se mide por campaña y no sabe qué
                contestó cada lead; repartirla daría un costo inventado.
            </p>
        </div>
    )
}
