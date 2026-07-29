/**
 * Comprobaciones del motor de campos de lead.
 *
 * Un "campo de lead" unifica las respuestas equivalentes de los formularios de
 * un cliente: varias claves de `raw_fields` bajo un nombre, y varias formas de
 * escribir el mismo valor bajo un bucket. Todo eso es puro, así que se verifica
 * sin Postgres, con los valores REALES que hay hoy en producción.
 *
 *   npx tsx scripts/verify-lead-campos.ts
 */

import {
    normalizarClaveLead, indexarRawFields, bucketDeLead, bucketDeLeadRaw,
    ordenarBuckets, firmaDeValorLead, sugerirAgrupacionLead,
    esClaveOfrecible, esValorPlaceholder, normalizarValorCrudo,
} from '../src/lib/report-utm/lead-campos'
import type { LeadCampoDef, CampoValorCrudo } from '../src/lib/report-utm/lead-campos'
import {
    makeLeadFieldDim, isLeadFieldDim, parseLeadFieldDim, leadFieldLabel,
    isFieldDim, hasNonAttributableFilter, appendFieldFilters, fieldFilterSignature,
} from '../src/lib/report-utm/bi-metadata'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) {
        console.log(`  ✓ ${nombre}`)
    } else {
        fallos++
        console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`)
    }
}

function campo(over: Partial<LeadCampoDef> = {}): LeadCampoDef {
    return {
        id: 'x', cliente_id: 'c', clave: 'rango_de_ingresos', nombre: 'Rango de ingresos',
        descripcion: null, claves_origen: [], valores_map: {}, valores_orden: [],
        sin_mapear: 'crudo', max_valores: 200, activo: true, orden: 0,
        ...over,
    }
}

const val = (v: string, filas: number): CampoValorCrudo =>
    ({ valor_crudo: v, valor_norm: normalizarValorCrudo(v), filas, origenes: [], ultima_fecha: null })

// ════════════════════════════════════════════════════════════════
console.log('\n── Tokens del BI ──────────────────────────────────────────')

check('makeLeadFieldDim/parse van y vuelven',
    parseLeadFieldDim(makeLeadFieldDim('rango_de_ingresos')) === 'rango_de_ingresos')
check('un token de campo de lead NO se confunde con uno de clave cruda',
    isLeadFieldDim('leadfield:x') && !isFieldDim('leadfield:x'))
check('un token de clave cruda NO se confunde con uno de catálogo',
    isFieldDim('field:x') && !isLeadFieldDim('field:x'))
check('sin catálogo la etiqueta humaniza la clave',
    leadFieldLabel('leadfield:rango_de_ingresos') === 'Rango de ingresos')
check('con catálogo manda el nombre del analista',
    leadFieldLabel('leadfield:r1', [{ clave: 'r1', nombre: 'Renta mensual', valores: [], claves_origen: [], cobertura: 0, alta_cardinalidad: false }]) === 'Renta mensual')
check('filtrar por un campo de lead anula el gasto (no es atribuible)',
    hasNonAttributableFilter({ 'leadfield:r1': '$2M a $3M' }, undefined))
check('un campo de lead en el filtro avanzado también anula el gasto',
    hasNonAttributableFilter(undefined, { groups: [{ conditions: [{ field: 'leadfield:r1', op: 'eq', value: 'x' }] }] }))

const qs = new URLSearchParams()
appendFieldFilters(qs, { 'leadfield:r1': '$2M a $3M', 'field:otra': 'y', utm_source: 'fb' })
check('el filtro de campo de lead viaja al endpoint',
    qs.get('filters[leadfield:r1]') === '$2M a $3M' && qs.get('filters[field:otra]') === 'y')
check('la firma de filtros incluye los campos de lead',
    fieldFilterSignature({ 'leadfield:r1': 'a' }).includes('leadfield:r1'))

// ════════════════════════════════════════════════════════════════
console.log('\n── Claves: unificar la misma pregunta ─────────────────────')

check('la clave se compara sin acentos, signos ni mayúsculas',
    normalizarClaveLead('¿Cuál es tu rango de ingresos?') === normalizarClaveLead('cual_es_tu_rango_de_ingresos'))
check('"Rango de renta" y "rango_de_renta" son la misma clave',
    normalizarClaveLead('Rango de renta') === normalizarClaveLead('rango_de_renta'))

// Caso real Goodprop: la misma pregunta con dos claves distintas.
const goodprop = campo({
    claves_origen: ['cual_es_tu_rango_de_ingresos', 'cual_es_tu_rango_aproximado_de_ingresos'],
    valores_map: {
        'entre_$2.000.000_y_$4.000.000': '$2M a $4M',
        'entre_$2.000.000_a_$4.000.000': '$2M a $4M',
        'más_de_$4.000.000': 'Más de $4M',
    },
    valores_orden: ['$2M a $4M', 'Más de $4M'],
})

const leadMeta = { 'cual_es_tu_rango_de_ingresos': 'entre_$2.000.000_y_$4.000.000', nombre: 'Ana' }
const leadWeb  = { '¿cuál_es_tu_rango_aproximado_de_ingresos?': 'entre_$2.000.000_a_$4.000.000' }

check('el lead de Meta cae en el bucket',
    bucketDeLeadRaw(goodprop, leadMeta) === '$2M a $4M',
    String(bucketDeLeadRaw(goodprop, leadMeta)))
check('el lead de la web cae en el MISMO bucket',
    bucketDeLeadRaw(goodprop, leadWeb) === '$2M a $4M',
    String(bucketDeLeadRaw(goodprop, leadWeb)))
check('un lead que no respondió no cuenta',
    bucketDeLeadRaw(goodprop, { nombre: 'Ana' }) === null)
check('un lead sin raw_fields no cuenta',
    bucketDeLeadRaw(goodprop, null) === null)

// Caso real Sur Profundo: el mismo valor escrito con "a" y con guion largo.
const surProfundo = campo({
    clave: 'rango_de_renta',
    claves_origen: ['rango_de_renta'],
    valores_map: {
        'entre $2.000.000 a $3.000.000': '$2M a $3M',
        'entre $2.000.000 - $3.000.000': '$2M a $3M',
    },
})
check('"a" y "–" caen en el mismo bucket',
    bucketDeLeadRaw(surProfundo, { 'rango de renta': 'Entre $2.000.000 a $3.000.000' }) === '$2M a $3M' &&
    bucketDeLeadRaw(surProfundo, { 'rango de renta': 'Entre $2.000.000 – $3.000.000' }) === '$2M a $3M')

check('el índice de raw_fields se reutiliza entre campos',
    bucketDeLead(surProfundo, indexarRawFields({ 'Rango de renta': 'Entre $2.000.000 a $3.000.000' })) === '$2M a $3M')

// sin_mapear
check('sin_mapear=crudo deja el valor normalizado',
    bucketDeLeadRaw(campo({ claves_origen: ['x'] }), { x: 'Algo Nuevo' }) === 'algo nuevo')
check('sin_mapear=otros agrupa lo no mapeado',
    bucketDeLeadRaw(campo({ claves_origen: ['x'], sin_mapear: 'otros' }), { x: 'Algo' }) === '(otros)')
check('sin_mapear=ignorar descarta lo no mapeado',
    bucketDeLeadRaw(campo({ claves_origen: ['x'], sin_mapear: 'ignorar' }), { x: 'Algo' }) === null)

// ════════════════════════════════════════════════════════════════
console.log('\n── Auto-agrupación de las variantes reales ────────────────')

// Los tres pares que HOY cuentan doble en producción.
const paresReales: [string, string][] = [
    ['Entre $2.000.000 a $3.000.000', 'Entre $2.000.000 – $3.000.000'],           // Sur Profundo · renta
    ['Entre $12.000.000 a $15.000.000', 'Entre $12.000.000 – $15.000.000'],       // Sur Profundo · pie
    ['entre_$2.000.000_y_$4.000.000', 'entre_$2.000.000_a_$4.000.000'],           // Goodprop · ingresos
]
for (const [a, b] of paresReales) {
    check(`misma firma: "${a}" ≡ "${b}"`,
        firmaDeValorLead(a) === firmaDeValorLead(b),
        `${firmaDeValorLead(a)} vs ${firmaDeValorLead(b)}`)
}
check('rangos DISTINTOS no se funden',
    firmaDeValorLead('Entre $2.000.000 a $3.000.000') !== firmaDeValorLead('Entre $2.000.000 a $4.000.000'))
check('no destroza palabras con "a" ("casa" sigue siendo "casa")',
    firmaDeValorLead('Casa propia') === 'casapropia')

const sugerido = sugerirAgrupacionLead([
    val('Entre $2.000.000 a $3.000.000', 424),
    val('Entre $2.000.000 – $3.000.000', 30),
    val('Más de $3.000.000', 474),
])
check('auto-agrupar propone el valor MÁS FRECUENTE como nombre del grupo',
    sugerido[normalizarValorCrudo('Entre $2.000.000 – $3.000.000')] === 'Entre $2.000.000 a $3.000.000',
    JSON.stringify(sugerido))
check('auto-agrupar no toca los valores sin variantes',
    sugerido[normalizarValorCrudo('Más de $3.000.000')] === undefined)

// ════════════════════════════════════════════════════════════════
console.log('\n── Orden de presentación ──────────────────────────────────')

const conOrden = campo({ valores_orden: ['Menos de $2M', '$2M a $3M', 'Más de $3M'] })
check('los rangos salen de menor a mayor, no alfabéticamente',
    JSON.stringify(ordenarBuckets(conOrden, ['Más de $3M', 'Menos de $2M', '$2M a $3M'])) ===
    JSON.stringify(['Menos de $2M', '$2M a $3M', 'Más de $3M']))
check('un valor nuevo sin orden definido va al final',
    ordenarBuckets(conOrden, ['Más de $3M', 'Sin respuesta', 'Menos de $2M']).at(-1) === 'Sin respuesta')
check('sin orden configurado, alfabético',
    JSON.stringify(ordenarBuckets(campo(), ['b', 'a'])) === JSON.stringify(['a', 'b']))

// ════════════════════════════════════════════════════════════════
console.log('\n── Ruido que no debe ofrecerse ────────────────────────────')

for (const k of ['email', 'phone_number', 'utm_source', 'nombre_y_apellido', 'field_987226f', 'phone_number_verified']) {
    check(`se descarta "${k}"`, !esClaveOfrecible(normalizarClaveLead(k)))
}
for (const k of ['cual_es_tu_rango_de_ingresos', 'rango de renta', '¿cuanto puedes destinar para el pie?']) {
    check(`se ofrece "${k}"`, esClaveOfrecible(normalizarClaveLead(k)))
}
for (const v of ['Seleccione una opción.', 'Select an option', '<test lead: dummy data for x>', '']) {
    check(`es relleno: "${v}"`, esValorPlaceholder(v))
}
check('una respuesta real no es relleno', !esValorPlaceholder('Entre $2.000.000 a $3.000.000'))

// ════════════════════════════════════════════════════════════════
console.log(fallos === 0
    ? '\n✅ Campos de lead: todas las comprobaciones pasan\n'
    : `\n❌ ${fallos} comprobación(es) fallaron\n`)
process.exit(fallos === 0 ? 0 : 1)
