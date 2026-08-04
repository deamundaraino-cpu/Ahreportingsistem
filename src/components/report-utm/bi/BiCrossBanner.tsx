'use client'

// Banner de cobertura del cruce UTM ↔ campañas.
//
// El cruce es automático (decisión de producto: el usuario no configura claves de
// unión), pero deja de ser opaco. Muestra los DOS porcentajes que importan y que
// cuentan historias distintas:
//
//   · leads cruzados  — ¿están bien etiquetados los contactos?
//   · gasto cruzado   — ¿cuánto de lo invertido tiene contactos atribuidos?
//
// 100% de leads y 40% de gasto no es un error de etiquetado: es que el 60% de la
// inversión no produjo ni un contacto. Al revés sí es un problema de UTM. Con un
// solo número no se distinguen, y hasta ahora no se calculaba ninguno de los dos.

import { useEffect, useState } from 'react'
import { Info, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'

interface UnmatchedTop {
    field: string
    value: string
    leads: number
    suggestion: string | null
    confidence: number | null
}

interface InvalidTop {
    field: string
    value: string
    count: number
    reason: string
}

interface CrossSummary {
    leads: { total: number; matched: number; pct: number | null; methods: Record<string, number> }
    spend: { matched: number; total: number; pct: number | null; orphans: { name: string; platform: string; spend: number }[] } | null
    unmatchedTop: UnmatchedTop[]
    invalidTop: InvalidTop[]
}

interface Props {
    clienteId?: string
    dateFrom?: string
    dateTo?: string
    /** En el enlace público no se muestra: es higiene interna de UTMs. */
    readonly?: boolean
}

/** Por debajo de esto se considera que merece la pena avisar. */
const UMBRAL_AVISO = 95

const money = (n: number) =>
    `$${n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`

export function BiCrossBanner({ clienteId, dateFrom, dateTo, readonly }: Props) {
    const [sum, setSum] = useState<CrossSummary | null>(null)
    const [open, setOpen] = useState(false)

    // El caso "no hay que mostrar nada" se resuelve en el render (abajo), no
    // poniendo el estado a null aquí: `clienteId` y `readonly` son props, así que
    // derivarlo evita un setState en el cuerpo del efecto y el render en cascada
    // que provoca.
    useEffect(() => {
        if (!clienteId || readonly) return
        const params = new URLSearchParams({ cliente_id: clienteId })
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo)   params.set('date_to', dateTo)
        let cancelled = false
        fetch(`/api/report-utm/bi/cross-summary?${params}`)
            .then(r => r.json())
            .then(json => { if (!cancelled) setSum(json?.data ?? null) })
            .catch(() => { if (!cancelled) setSum(null) })
        return () => { cancelled = true }
    }, [clienteId, dateFrom, dateTo, readonly])

    // Guarda de render: cubre el caso de arriba y además evita que un resumen
    // ya cargado se quede visible si se cambia de cliente o se pasa a readonly.
    if (!clienteId || readonly || !sum) return null

    const leadsPct = sum.leads.pct
    const spendPct = sum.spend?.pct ?? null

    // Sin nada que cruzar no se dice «0%»: no aplica.
    if (leadsPct === null && spendPct === null) return null

    // Todo cruzado: se muestra en verde y compacto, sin ocupar espacio.
    const todoBien =
        (leadsPct === null || leadsPct >= UMBRAL_AVISO) &&
        (spendPct === null || spendPct >= UMBRAL_AVISO)

    const color = todoBien
        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
        : (leadsPct !== null && leadsPct < 80) || (spendPct !== null && spendPct < 80)
            ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'

    const qs = new URLSearchParams()
    if (clienteId) qs.set('cliente_id', clienteId)
    if (dateFrom) qs.set('date_from', dateFrom)
    if (dateTo)   qs.set('date_to', dateTo)

    return (
        <div className={`rounded-lg border px-3 py-2 text-[11px] ${color}`}>
            <div className="flex items-start gap-2">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                    <span>
                        <strong>Cruce de campañas:</strong>{' '}
                        {leadsPct !== null && (
                            <>
                                {leadsPct}% de los leads
                                {' '}({sum.leads.matched.toLocaleString('es-AR')} de {sum.leads.total.toLocaleString('es-AR')})
                            </>
                        )}
                        {leadsPct !== null && spendPct !== null && ' · '}
                        {spendPct !== null && sum.spend && (
                            <>
                                {spendPct}% del gasto
                                {' '}({money(sum.spend.matched)} de {money(sum.spend.total)})
                            </>
                        )}
                        {todoBien && ' — todo atribuido.'}
                    </span>

                    {!todoBien && (
                        <button
                            onClick={() => setOpen(o => !o)}
                            className="ml-1 inline-flex items-center gap-0.5 underline font-medium"
                        >
                            {open ? 'ocultar detalle' : 'ver detalle'}
                            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                        </button>
                    )}

                    {open && (
                        <div className="mt-2 space-y-2 border-t border-current/20 pt-2">
                            {sum.unmatchedTop.length > 0 && (
                                <div>
                                    <p className="font-medium mb-0.5">UTMs sin cruzar (mapeables):</p>
                                    <ul className="space-y-0.5">
                                        {sum.unmatchedTop.map((u, i) => (
                                            <li key={i} className="font-mono text-[10px] truncate">
                                                {u.value} · {u.leads} leads
                                                {u.suggestion && ` → ¿${u.suggestion}? (${u.confidence}%)`}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {sum.invalidTop.length > 0 && (
                                <div>
                                    {/* Un macro sin renderizar abarca muchas campañas: no se
                                        puede mapear, hay que arreglarlo en el anuncio. */}
                                    <p className="font-medium mb-0.5">
                                        UTMs que no se pueden mapear (arreglar en el anuncio):
                                    </p>
                                    <ul className="space-y-0.5">
                                        {sum.invalidTop.map((u, i) => (
                                            <li key={i} className="font-mono text-[10px] truncate">
                                                {u.value} · {u.count} leads · {u.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {(sum.spend?.orphans.length ?? 0) > 0 && (
                                <div>
                                    <p className="font-medium mb-0.5">
                                        Campañas con gasto y sin ningún lead:
                                    </p>
                                    <ul className="space-y-0.5">
                                        {sum.spend!.orphans.slice(0, 6).map((o, i) => (
                                            <li key={i} className="font-mono text-[10px] truncate">
                                                {o.name} · {money(o.spend)}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            <a
                                href={`/report-utm/cruce-campanas?${qs}`}
                                className="inline-flex items-center gap-1 underline font-medium"
                            >
                                Corregir el mapeo <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
