'use client'

// Campos dinámicos de un cliente: los que no están en el catálogo fijo del BI
// sino que dependen de cómo esté configurado cada cliente (preguntas de sus
// formularios, campos de lead y sus segmentos, columnas de sus Sheets).
//
// Existe porque los consumían DOS editores con dos implementaciones: el editor de
// widgets hacía los cuatro fetch, y el de campos calculados solo uno. Resultado:
// en el modal de campos calculados los alias `sf__`, `sv__` y `off__` no salían
// en ninguna lista y solo funcionaban si te los sabías de memoria. Un hook
// compartido hace imposible que los dos vuelvan a divergir.

import { useEffect, useState } from 'react'
import type {
    FormFieldMeta, OfflineFieldMeta, SheetFieldMeta, SheetViewMeta,
    LeadFieldMeta, LeadSegmentoMeta,
} from '@/lib/report-utm/bi-metadata'

export interface BiClientFields {
    formFields: FormFieldMeta[]
    leadFields: LeadFieldMeta[]
    leadSegments: LeadSegmentoMeta[]
    offlineFields: OfflineFieldMeta[]
    sheetFields: SheetFieldMeta[]
    sheetViews: SheetViewMeta[]
}

/**
 * Cada respuesta se guarda junto al cliente al que pertenece.
 *
 * Es lo que evita el destello de datos ajenos al cambiar de cliente sin tener que
 * vaciar el estado dentro del efecto: al leer se descarta lo que no sea del
 * cliente vigente, así que mientras llega la respuesta nueva se devuelve vacío en
 * vez de la lista del cliente anterior.
 */
interface Cache<T> { de: string; datos: T }

function useCampoRemoto<T>(
    clienteId: string | undefined,
    url: (id: string) => string,
    extraer: (json: any) => T,   // eslint-disable-line @typescript-eslint/no-explicit-any
    vacio: T,
    deps: unknown[] = [],
): T {
    const [cache, setCache] = useState<Cache<T> | null>(null)

    useEffect(() => {
        if (!clienteId) return
        let cancelled = false
        fetch(url(clienteId))
            .then(r => r.json())
            .then(json => { if (!cancelled) setCache({ de: clienteId, datos: extraer(json) }) })
            .catch(() => { if (!cancelled) setCache({ de: clienteId, datos: vacio }) })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clienteId, ...deps])

    return clienteId && cache?.de === clienteId ? cache.datos : vacio
}

const SIN_CAMPOS: never[] = []

/** Query string común: cliente + rango, que es lo que recorta los valores. */
function qs(id: string, dateFrom?: string, dateTo?: string): string {
    const p = new URLSearchParams({ cliente_id: id })
    if (dateFrom) p.set('date_from', dateFrom)
    if (dateTo) p.set('date_to', dateTo)
    return String(p)
}

export function useBiClientFields(
    clienteId?: string,
    dateFrom?: string,
    dateTo?: string
): BiClientFields {
    // Campos de formulario del cliente (claves crudas de raw_fields).
    const formFields = useCampoRemoto<FormFieldMeta[]>(
        clienteId,
        id => `/api/report-utm/bi/form-fields?${qs(id, dateFrom, dateTo)}`,
        json => json.data ?? [],
        SIN_CAMPOS,
        [dateFrom, dateTo],
    )

    // Campos de lead del catálogo y sus segmentos. Unifican las claves
    // equivalentes y las variantes de escritura, así que van por delante de las
    // claves crudas de `form-fields`. Los dos salen del mismo endpoint.
    const lead = useCampoRemoto<{ campos: LeadFieldMeta[]; segmentos: LeadSegmentoMeta[] }>(
        clienteId,
        id => `/api/report-utm/bi/lead-fields?${qs(id, dateFrom, dateTo)}`,
        json => ({ campos: json.data ?? [], segmentos: json.segments ?? [] }),
        { campos: SIN_CAMPOS, segmentos: SIN_CAMPOS },
        [dateFrom, dateTo],
    )

    // Columnas adicionales de los Sheets offline del cliente.
    const offlineFields = useCampoRemoto<OfflineFieldMeta[]>(
        clienteId,
        id => `/api/report-utm/bi/offline-fields?cliente_id=${encodeURIComponent(id)}`,
        json => json.data ?? [],
        SIN_CAMPOS,
    )

    // Campos de Sheet del cliente y sus vistas guardadas.
    const sheet = useCampoRemoto<{ fields: SheetFieldMeta[]; views: SheetViewMeta[] }>(
        clienteId,
        id => `/api/report-utm/bi/sheet-fields?cliente_id=${encodeURIComponent(id)}`,
        json => ({ fields: json.data?.fields ?? [], views: json.data?.views ?? [] }),
        { fields: SIN_CAMPOS, views: SIN_CAMPOS },
    )

    return {
        formFields,
        leadFields: lead.campos,
        leadSegments: lead.segmentos,
        offlineFields,
        sheetFields: sheet.fields,
        sheetViews: sheet.views,
    }
}
