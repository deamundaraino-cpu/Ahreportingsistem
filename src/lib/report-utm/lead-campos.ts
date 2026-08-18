// ── Campos de lead: lógica pura (client-safe) ─────────────────────────
//
// Un "campo de lead" unifica las respuestas equivalentes de los formularios de
// un cliente bajo un nombre y unos valores únicos, para poder cruzarlas en los
// informes. Resuelve dos cosas que el dato crudo de `lead_events.raw_fields` no
// permite (ver migración 060):
//
//   • la misma pregunta llega con claves distintas según el formulario
//     ("cual_es_tu_rango_de_ingresos" en Meta, "¿cuál_es_tu_rango_aproximado_
//     de_ingresos?" en la web) → `claves_origen` las une;
//   • el mismo valor se escribe de dos formas ("Entre $2.000.000 a $3.000.000"
//     y "Entre $2.000.000 – $3.000.000") → `valores_map` las funde en un bucket.
//
// Este archivo NO importa nada de servidor: lo consumen el motor BI, los
// endpoints y los componentes cliente (editor de widgets, filtros, ficha del
// cliente). La normalización de valores y el cálculo del bucket se reutilizan
// de `lib/sheets/campos`, que ya resolvió exactamente este problema para las
// columnas de Google Sheets: si divergieran, la vista previa del agrupador
// dejaría de coincidir con lo que hace el motor.

import { normalizarValorCrudo, bucketDeValor, sanitizarColumna, slugCampo } from '@/lib/sheets/campos'
import type { CampoValoresMap, CampoValorCrudo, CampoSinMapear } from '@/lib/sheets/campos'

export { normalizarValorCrudo, slugCampo, bucketDeValor }
export type { CampoValoresMap, CampoValorCrudo, CampoSinMapear }

/** Definición de un campo de lead (fila de `report_utm.lead_campos`). */
export interface LeadCampoDef {
    id: string
    cliente_id: string
    clave: string
    nombre: string
    descripcion: string | null
    /** Claves de raw_fields que unifica, ya sanitizadas. */
    claves_origen: string[]
    valores_map: CampoValoresMap
    valores_orden: string[]
    sin_mapear: CampoSinMapear
    max_valores: number
    activo: boolean
    orden: number
}

/**
 * Metadata que viaja al navegador (editor de widgets y constructor de filtros).
 * Lleva los valores ya calculados para poder ofrecerlos en un desplegable sin
 * consultar de nuevo.
 */
export interface LeadCampoMeta {
    clave: string
    nombre: string
    descripcion?: string | null
    /** Buckets que produce, en el orden configurado. */
    valores: string[]
    /** Claves crudas que unifica, para el tooltip del editor. */
    claves_origen: string[]
    /** Leads del período que responden este campo. */
    cobertura: number
    alta_cardinalidad: boolean
}

/** Campo cuyo valor no está en el mapa y `sin_mapear` manda agruparlo. */
export const BUCKET_OTROS = '(otros)'

// ── Claves ────────────────────────────────────────────────────────────

/**
 * Clave de `raw_fields` → forma canónica para comparar. Se aplica a las dos
 * partes (lo guardado en `claves_origen` y lo que trae el lead), de modo que
 * "Rango de renta", "rango_de_renta" y "RANGO DE RENTA" son la misma clave.
 *
 * Es la misma función que sanea las columnas de Sheet: los dos catálogos hablan
 * el mismo idioma y un campo no deja de encontrar su origen por un acento.
 */
export function normalizarClaveLead(key: string): string {
    return sanitizarColumna(key)
}

/**
 * Índice clave normalizada → valor, de un `raw_fields` de lead. Se construye una
 * vez por lead y se reutiliza para todos los campos del catálogo: recorrer el
 * JSONB por cada campo multiplicaría el trabajo en consultas de decenas de miles
 * de leads.
 */
export function indexarRawFields(rf: Record<string, unknown> | null | undefined): Map<string, unknown> {
    const idx = new Map<string, unknown>()
    if (!rf || typeof rf !== 'object') return idx
    for (const [k, v] of Object.entries(rf)) {
        if (v === null || v === undefined) continue
        const norm = normalizarClaveLead(k)
        if (!norm) continue
        // La primera clave con dato manda: si un mismo lead trae la pregunta dos
        // veces (formulario duplicado), quedarse con la primera evita que el
        // orden de las claves del JSONB cambie el resultado.
        if (!idx.has(norm) || idx.get(norm) === '') idx.set(norm, v)
    }
    return idx
}

// ── Valor de un campo en un lead ──────────────────────────────────────

/**
 * Bucket que aporta un lead a un campo, o null si no respondió (o el valor está
 * marcado para ignorarse). Se queda con la PRIMERA clave de origen que traiga
 * dato: son claves equivalentes de la misma pregunta, así que la primera no
 * vacía es la respuesta del lead.
 */
export function bucketDeLead(campo: LeadCampoDef, idx: Map<string, unknown>): string | null {
    for (const clave of campo.claves_origen ?? []) {
        const v = idx.get(clave)
        if (v === null || v === undefined) continue
        const s = String(v).trim()
        if (!s) continue
        return bucketDeValor(campo, s)
    }
    return null
}

/** Igual que `bucketDeLead` pero partiendo del `raw_fields` sin indexar. */
export function bucketDeLeadRaw(campo: LeadCampoDef, rf: Record<string, unknown> | null | undefined): string | null {
    return bucketDeLead(campo, indexarRawFields(rf))
}

// ── Orden de los buckets ──────────────────────────────────────────────

/**
 * Ordena los buckets según `valores_orden`; lo que no esté en él va detrás, en
 * orden alfabético. Es lo que hace que los rangos de ingresos salgan de menor a
 * mayor: alfabéticamente "Entre $2M" iría antes que "Menos de $2M".
 */
export function ordenarBuckets(campo: Pick<LeadCampoDef, 'valores_orden'>, valores: string[]): string[] {
    const orden = campo.valores_orden ?? []
    const pos = (v: string) => {
        const i = orden.indexOf(v)
        return i === -1 ? orden.length : i
    }
    return [...valores].sort((a, b) => pos(a) - pos(b) || a.localeCompare(b))
}

// ── Sugerencia de agrupación ──────────────────────────────────────────

/**
 * Firma de un valor para proponer agrupaciones automáticas. Extiende la de los
 * Sheets (`firmaDeValor`) con lo que hace falta para respuestas de formulario:
 * los conectores de rango — "a", "y", "-", "–", "to" — se tratan como el mismo
 * separador aunque lleven guiones bajos o símbolo de moneda alrededor.
 *
 * Sin eso, los tres casos reales de producción NO se agrupaban:
 *   "Entre $2.000.000 a $3.000.000" / "Entre $2.000.000 – $3.000.000"
 *   "entre_$2.000.000_y_$4.000.000" / "entre_$2.000.000_a_$4.000.000"
 *
 * Es solo una SUGERENCIA para el botón "Auto-agrupar": lo que manda siempre es
 * el `valores_map` que confirma el analista.
 */
export function firmaDeValorLead(raw: unknown): string {
    return normalizarValorCrudo(raw)
        // Conector de rango entre dos números, con o sin guiones bajos, espacios
        // o símbolo de moneda de por medio.
        .replace(/(\d)[\s_]*(?:a|y|to|and|-)[\s_]*[$€£]?\s*(\d)/g, '$1-$2')
        .replace(/[^a-z0-9]+/g, '')
}

/**
 * Agrupa los valores crudos por su firma y propone un bucket por grupo: el
 * valor más frecuente, que suele ser el mejor escrito. Devuelve un mapa listo
 * para fusionar con `valores_map`.
 */
export function sugerirAgrupacionLead(valores: CampoValorCrudo[]): CampoValoresMap {
    const porFirma = new Map<string, CampoValorCrudo[]>()
    for (const v of valores) {
        const f = firmaDeValorLead(v.valor_crudo)
        if (!f) continue
        const lista = porFirma.get(f)
        if (lista) lista.push(v)
        else porFirma.set(f, [v])
    }

    const out: CampoValoresMap = {}
    for (const grupo of porFirma.values()) {
        if (grupo.length < 2) continue   // sin variantes no hay nada que agrupar
        const bucket = grupo.slice().sort((a, b) => b.filas - a.filas)[0].valor_crudo.trim()
        for (const v of grupo) out[normalizarValorCrudo(v.valor_crudo)] = bucket
    }
    return out
}

// ── Descubrimiento de claves candidatas ───────────────────────────────

/** Una clave de `raw_fields` detectada en los leads del cliente. */
export interface ClaveDetectada {
    /** Clave tal como llegó (la más frecuente si hay variantes de escritura). */
    clave: string
    /** Forma canónica con la que se guarda en `claves_origen`. */
    clave_norm: string
    /** Leads que la traen con valor. */
    leads: number
    /** Valores distintos vistos. */
    distintos: number
    /** ¿Parece una pregunta de opción múltiple (pocos valores repetidos)? */
    es_opcion: boolean
    /** Formularios donde aparece. */
    formularios: string[]
    valores: CampoValorCrudo[]
}

/**
 * Claves que NO se ofrecen como campo: datos de contacto (identificadores, un
 * valor por lead), los UTM — que ya son dimensiones propias del BI y saldrían
 * duplicadas — y el ruido técnico del plugin.
 */
const CLAVES_IGNORADAS = new Set([
    'email', 'correo', 'correo_electronico', 'e_mail', 'mail',
    'nombre', 'name', 'full_name', 'fullname', 'firstname', 'lastname',
    'nombre_y_apellido', 'apellido',
    'phone', 'telefono', 'phone_number', 'numero_de_telefono', 'celular',
    'whatsapp', 'whatsapp_number', 'numero_de_whatsapp', 'movil',
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
    'gclid', 'fbclid', 'ttclid',
    'origen', 'version', 'phone_number_verified', 'page_url', 'referrer',
])

/** ¿Esta clave cruda merece ofrecerse como campo de lead? */
export function esClaveOfrecible(claveNorm: string): boolean {
    if (!claveNorm) return false
    if (CLAVES_IGNORADAS.has(claveNorm)) return false
    // Los campos sin etiqueta de Elementor llegan como "field_9f2a1b3": un id
    // opaco que no significa nada en un informe de cliente.
    if (/^(field|campo)_[a-z0-9]{4,}$/.test(claveNorm)) return false
    return true
}

/**
 * Valor de relleno de un desplegable sin responder. Cuentan como respuesta en
 * el dato crudo y ensucian el eje de la gráfica, así que se proponen para
 * ignorar en el agrupador.
 */
export function esValorPlaceholder(valor: string): boolean {
    const v = normalizarValorCrudo(valor)
    return (
        v === '' ||
        /^selecc?ion[ae]/.test(v) ||          // "Seleccione una opción."
        /^select an option/.test(v) ||
        /^elige/.test(v) ||
        v.startsWith('<test lead')            // leads de prueba de Meta
    )
}

// ── Segmentos: una respuesta (o un grupo de respuestas) como MÉTRICA ──
//
// Un campo de lead es una DIMENSIÓN: agrupa los leads por lo que contestaron.
// Un "segmento" es un subconjunto con nombre de sus buckets —«Desde 2M» = estos
// tres— que se ofrece como MEDIDA: un número que se puede poner en una tarjeta,
// en una columna o dentro de una fórmula.
//
// Existe porque los acumuladores («todos los que ganan ≥ 2M») no son un bucket:
// son varios. Sin esto, la única salida era crear un campo de lead por umbral,
// que es exactamente lo que hay hoy en producción (ver migración 073).
//
// Un segmento SOLAPA buckets a propósito, así que nunca entra en la suma
// «respuestas + sin_respuesta = utm_leads» del dashboard.

/** Definición de un segmento (fila de `report_utm.lead_campo_segmentos`). */
export interface LeadSegmentoDef {
    id: string
    cliente_id: string
    campo_id: string
    /** Clave del campo padre, desnormalizada para no volver a la base por cada fila. */
    campo_clave: string
    clave: string
    nombre: string
    descripcion: string | null
    operador: 'in' | 'not_in'
    /** Buckets del campo padre que incluye (o excluye, con `not_in`). */
    valores: string[]
    activo: boolean
    orden: number
}

/**
 * Lo mínimo que hace falta de un segmento para contarlo: su clave y a qué
 * buckets pertenece. Es lo que viaja dentro del cubo del dashboard, donde el
 * payload se paga por byte.
 */
export interface LeadSegmentoLite {
    clave: string
    nombre: string
    operador: 'in' | 'not_in'
    valores: string[]
}

/** Metadata de un segmento que viaja al navegador (editor de widgets y fórmulas). */
export interface LeadSegmentoMeta {
    clave: string
    nombre: string
    /** Clave del campo padre, para etiquetar «<Campo>: <Segmento>». */
    campo_clave: string
    campo_nombre?: string
    operador: 'in' | 'not_in'
    valores: string[]
    /** Leads del período que caen dentro del segmento. */
    cobertura: number
}

/**
 * ¿El bucket entra en el segmento? Gemelo de `vistaIncluyeValor` de los campos
 * de Sheet: si los dos divergieran, el mismo subconjunto contaría distinto según
 * de dónde saliera el dato.
 */
export function segmentoIncluyeBucket(
    seg: Pick<LeadSegmentoDef, 'valores' | 'operador'>,
    bucket: string
): boolean {
    const dentro = (seg.valores ?? []).includes(bucket)
    return seg.operador === 'not_in' ? !dentro : dentro
}

/**
 * ¿Este lead cuenta para el segmento?
 *
 * Un lead que NO respondió la pregunta no entra en ningún segmento, tampoco en
 * uno `not_in`. Es deliberado: «no respondió» no es «no es de este grupo», y
 * contarlo inflaría el complemento con gente de la que no se sabe nada.
 */
export function cuentaEnSegmento(
    seg: Pick<LeadSegmentoDef, 'valores' | 'operador'>,
    campo: LeadCampoDef,
    idx: Map<string, unknown>
): boolean {
    const bucket = bucketDeLead(campo, idx)
    if (bucket === null) return false
    return segmentoIncluyeBucket(seg, bucket)
}

/**
 * Buckets desde `desde` hasta el final de `valores_orden`: el «≥ X» de un solo
 * clic. Es literalmente lo que Goodprop construyó a mano cuatro veces.
 *
 * Devuelve lista vacía si el bucket no está en el orden configurado: sin orden
 * no hay «hacia arriba» que valga, y adivinarlo alfabéticamente pondría
 * «Menos de $2M» en medio de los demás.
 */
export function bucketsAcumulados(
    campo: Pick<LeadCampoDef, 'valores_orden'>,
    desde: string
): string[] {
    const orden = campo.valores_orden ?? []
    const i = orden.indexOf(desde)
    return i === -1 ? [] : orden.slice(i)
}
