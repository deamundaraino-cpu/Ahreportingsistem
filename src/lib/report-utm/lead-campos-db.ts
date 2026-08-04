/**
 * Campos de lead — lectura, escritura y descubrimiento.
 *
 * Capa fina sobre `report_utm.lead_campos`: todo el cálculo (bucket de un valor,
 * orden, sugerencia de agrupación) vive en `./lead-campos.ts`, así que el motor
 * BI, la vista previa del agrupador y esta capa no pueden dar resultados
 * distintos.
 *
 * A diferencia de los campos de Sheet, aquí NO hay dato derivado: los buckets se
 * calculan al consultar `lead_events`, de modo que editar el catálogo se ve
 * reflejado en el informe al instante, sin recálculo ni cron.
 */

import { fetchAllRows } from '@/lib/supabase-paginate'
import {
    normalizarClaveLead, normalizarValorCrudo, esClaveOfrecible,
} from './lead-campos'
import type { LeadCampoDef, ClaveDetectada, CampoValorCrudo } from './lead-campos'
import { colombiaRangeBounds } from '@/lib/colombia-date'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Tope de leads que escanea el descubrimiento de claves. */
const MAX_LEADS_ESCANEO = 30000

/** Tope de valores crudos que se devuelven por clave, para no inflar la UI. */
const MAX_VALORES_POR_CLAVE = 300

/** Mensaje típico de PostgREST cuando falta la migración 060. */
function esTablaAusente(error: any): boolean {
    const msg = String(error?.message ?? '')
    return error?.code === '42P01' || /does not exist|schema cache/i.test(msg)
}

function toCampo(row: any): LeadCampoDef {
    return {
        id: row.id,
        cliente_id: row.cliente_id,
        clave: row.clave,
        nombre: row.nombre,
        descripcion: row.descripcion ?? null,
        claves_origen: Array.isArray(row.claves_origen) ? row.claves_origen : [],
        valores_map: row.valores_map ?? {},
        valores_orden: row.valores_orden ?? [],
        sin_mapear: row.sin_mapear ?? 'crudo',
        max_valores: row.max_valores ?? 200,
        activo: row.activo !== false,
        orden: row.orden ?? 0,
    }
}

/**
 * Catálogo de campos de un cliente. Si la migración 060 todavía no está
 * aplicada devuelve lista vacía en vez de lanzar: el módulo tiene que seguir
 * funcionando exactamente igual que antes de esta feature.
 */
export async function loadLeadCampos(
    db: any,
    clienteId: string,
    opts?: { soloActivos?: boolean }
): Promise<LeadCampoDef[]> {
    if (!clienteId) return []
    let q = db.from('lead_campos').select('*').eq('cliente_id', clienteId)
    if (opts?.soloActivos) q = q.eq('activo', true)

    const { data, error } = await q.order('orden', { ascending: true })
    if (error) {
        if (!esTablaAusente(error)) console.error('[lead-campos] error leyendo campos:', error.message)
        return []
    }
    return (data ?? []).map(toCampo)
}

/** Un solo campo por su clave pública (la del token `leadfield:<clave>`). */
export async function loadLeadCampo(db: any, clienteId: string, clave: string): Promise<LeadCampoDef | null> {
    const campos = await loadLeadCampos(db, clienteId)
    return campos.find(c => c.clave === clave) ?? null
}

// ── Escritura ─────────────────────────────────────────────────────────

export interface LeadCampoInput {
    id?: string
    cliente_id: string
    clave: string
    nombre: string
    descripcion?: string | null
    claves_origen: string[]
    valores_map?: Record<string, string>
    valores_orden?: string[]
    sin_mapear?: 'crudo' | 'otros' | 'ignorar'
    activo?: boolean
    orden?: number
}

/**
 * Alta o edición de un campo. La `clave` se fija en el alta y NO se reescribe
 * después: es lo que quedó guardado dentro de los widgets de `bi_reports`, así
 * que cambiarla dejaría esos widgets apuntando a un campo inexistente.
 */
export async function saveLeadCampo(db: any, input: LeadCampoInput): Promise<{ error?: string; id?: string }> {
    const claves = Array.from(new Set(
        (input.claves_origen ?? []).map(normalizarClaveLead).filter(Boolean)
    ))
    if (!input.nombre?.trim()) return { error: 'El campo necesita un nombre.' }
    if (claves.length === 0) return { error: 'Selecciona al menos una pregunta de formulario.' }

    const payload = {
        cliente_id: input.cliente_id,
        nombre: input.nombre.trim(),
        descripcion: input.descripcion?.trim() || null,
        claves_origen: claves,
        valores_map: input.valores_map ?? {},
        valores_orden: input.valores_orden ?? [],
        sin_mapear: input.sin_mapear ?? 'crudo',
        activo: input.activo !== false,
        orden: input.orden ?? 0,
    }

    if (input.id) {
        const { error } = await db.from('lead_campos').update(payload).eq('id', input.id)
        if (error) return { error: error.message }
        return { id: input.id }
    }

    const { data, error } = await db
        .from('lead_campos')
        .insert({ ...payload, clave: input.clave })
        .select('id')
        .single()
    if (error) {
        if (esTablaAusente(error)) {
            return { error: 'Falta aplicar la migración 060 (report_utm.lead_campos) en Supabase.' }
        }
        if (error.code === '23505') return { error: 'Ya existe un campo con esa clave para este cliente.' }
        return { error: error.message }
    }
    return { id: data?.id }
}

export async function deleteLeadCampo(db: any, id: string): Promise<{ error?: string }> {
    const { error } = await db.from('lead_campos').delete().eq('id', id)
    return error ? { error: error.message } : {}
}

// ── Descubrimiento ────────────────────────────────────────────────────

/**
 * Escanea los leads del cliente y devuelve las preguntas de formulario
 * detectadas, con sus valores y cuántos leads tiene cada uno. Es lo que alimenta
 * el alta de un campo y el agrupador de valores.
 *
 * `incluirIgnoradas` trae también las claves que se filtran por defecto (correo,
 * teléfono, UTM…): el analista puede necesitarlas si su formulario llama
 * "origen" a una pregunta real.
 */
export async function detectarCamposDeLeads(
    db: any,
    clienteId: string,
    opts: { dateFrom: string; dateTo: string; incluirIgnoradas?: boolean }
): Promise<{ claves: ClaveDetectada[]; leads: number }> {
    if (!clienteId) return { claves: [], leads: 0 }

    const rows = await fetchAllRows(
        () =>
            db
                .from('lead_events')
                .select('id,raw_fields,form_name')
                .eq('cliente_id', clienteId)
                .gte('created_at', colombiaRangeBounds(opts.dateFrom, opts.dateTo).gte)
                .lt('created_at', colombiaRangeBounds(opts.dateFrom, opts.dateTo).lt)
                // Sin `order` propio: fetchAllRows pagina por keyset sobre `id` y
                // añadir otro criterio rompería el cursor.
                .not('raw_fields', 'is', null),
        1000,
        MAX_LEADS_ESCANEO
    )

    interface Acc {
        etiquetas: Map<string, number>      // clave cruda → veces vista (para elegir la más común)
        leads: number
        valores: Map<string, number>
        formularios: Set<string>
    }
    const porClave = new Map<string, Acc>()

    for (const r of rows as any[]) {
        const rf = r.raw_fields as Record<string, unknown> | null
        if (!rf || typeof rf !== 'object') continue
        for (const [k, v] of Object.entries(rf)) {
            if (v === null || v === undefined) continue
            const s = String(v).trim()
            if (!s) continue
            const norm = normalizarClaveLead(k)
            if (!norm) continue
            if (!opts.incluirIgnoradas && !esClaveOfrecible(norm)) continue

            let acc = porClave.get(norm)
            if (!acc) {
                acc = { etiquetas: new Map(), leads: 0, valores: new Map(), formularios: new Set() }
                porClave.set(norm, acc)
            }
            acc.etiquetas.set(k, (acc.etiquetas.get(k) ?? 0) + 1)
            acc.leads++
            acc.valores.set(s, (acc.valores.get(s) ?? 0) + 1)
            if (r.form_name) acc.formularios.add(String(r.form_name))
        }
    }

    const claves: ClaveDetectada[] = Array.from(porClave.entries())
        .map(([norm, acc]) => {
            const valores: CampoValorCrudo[] = Array.from(acc.valores.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, MAX_VALORES_POR_CLAVE)
                .map(([valor_crudo, filas]) => ({
                    valor_crudo,
                    valor_norm: normalizarValorCrudo(valor_crudo),
                    filas,
                    // `origenes` (pestañas) y `ultima_fecha` son del catálogo de
                    // Sheets; aquí el origen es el propio formulario y ya viaja en
                    // `formularios`, a nivel de la clave.
                    origenes: [],
                    ultima_fecha: null,
                }))
            const distintos = acc.valores.size
            // Pregunta de opción = pocos valores distintos y muy repetidos. Es la
            // heurística que ordena la lista: lo cruzable primero, los campos de
            // texto libre (comentarios, direcciones) al final.
            const es_opcion = distintos <= 30 && distintos < Math.max(2, acc.leads * 0.5)
            const etiqueta = Array.from(acc.etiquetas.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? norm
            return {
                clave: etiqueta,
                clave_norm: norm,
                leads: acc.leads,
                distintos,
                es_opcion,
                formularios: Array.from(acc.formularios).sort(),
                valores,
            }
        })
        .sort((a, b) => Number(b.es_opcion) - Number(a.es_opcion) || b.leads - a.leads)

    return { claves, leads: rows.length }
}
