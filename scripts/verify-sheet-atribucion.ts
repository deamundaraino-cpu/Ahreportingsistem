/**
 * Comprobaciones de la atribución publicitaria de las filas de Sheet.
 *
 * Es la puerta de la Fase 2: leer `sheet_filas` en vez del desglose diario solo
 * vale la pena si (a) los ids se limpian bien, (b) la fila entra en la cascada
 * del resolver por la puerta correcta y (c) los totales siguen cuadrando con el
 * camino diario. Si algo de eso falla, el cruce nuevo miente.
 *
 * Todo PURO: no toca la base ni la red. La comprobación contra datos reales vive
 * en `scripts/verify-bi-cruce-sheet.ts`.
 *
 *   npx tsx scripts/verify-sheet-atribucion.ts
 */

import {
    limpiarIdSheet, valorAtribucion, atribucionDeFila,
    filaEsAtribuible, utmDeFilaSheet, correoDeFila, ALIAS_ATRIBUCION,
} from '../src/lib/sheets/atribucion'
import {
    valoresDeCampoEnFila, bucketDeValor, parseNumeroSheet,
    agregarDiarios, computeCampoValoresDiarios,
} from '../src/lib/sheets/campos'
import type { SheetCampoDef, SheetRawRow, CampoValorDiario } from '../src/lib/sheets/campos'
import { BASE_REGISTRY as REG } from '../src/lib/report-utm/bi/registry'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

// ════════════════════════════════════════════════════════════
seccion('Limpieza de ids de Meta')
// ════════════════════════════════════════════════════════════
// Los ids llegan del Sheet con un prefijo de tipo (`c:`, `as:`, `ag:`). En
// `ads_daily.entidad_id` y en `utm_id` viven SIN él. Sin este recorte el cruce
// falla al 100 % y en silencio, que es justo el fallo que no se detecta solo.

check('quita el prefijo de campaña', limpiarIdSheet('c:120235587549050178') === '120235587549050178')
check('quita el prefijo de conjunto', limpiarIdSheet('as:120247665005500178') === '120247665005500178')
check('quita el prefijo de anuncio', limpiarIdSheet('ag:120247737093830178') === '120247737093830178')
check('un id ya limpio no se toca', limpiarIdSheet('120235587549050178') === '120235587549050178')
check('vacío → vacío', limpiarIdSheet('') === '' && limpiarIdSheet(null) === '')
check('recorta espacios', limpiarIdSheet('  c:120235587549050178  ') === '120235587549050178')
// Un valor con `:` que NO es un id prefijado se devuelve intacto: si no, una
// hora («10:30») se convertiría en «30» y contaminaría el cruce.
check('una hora no se confunde con un id prefijado', limpiarIdSheet('10:30') === '10:30')
check('un texto con dos puntos y espacio se respeta', limpiarIdSheet('nota: revisar') === 'nota: revisar')
// El conjunto de prefijos es cerrado: un prefijo desconocido NO se recorta. Esa
// fila cruzará por nombre en vez de por id, que es preferible a estropear una
// columna de texto que casualmente lleva dos puntos.
check('un prefijo desconocido no se recorta', limpiarIdSheet('nota:revisar') === 'nota:revisar')
check('un prefijo conocido sí se recorta aunque el id sea corto', limpiarIdSheet('c:999') === '999')
check('el teléfono conserva su formato tras quitar el prefijo',
    limpiarIdSheet('p:+56956411418') === '+56956411418')

// ════════════════════════════════════════════════════════════
seccion('Detección de columnas')
// ════════════════════════════════════════════════════════════

const filaMeta = {
    id: 'l:1041420008509673',
    ad_id: 'ag:120247737093830178',
    adset_id: 'as:120247665005500178',
    campaign_id: 'c:120235587549050178',
    ad_name: '[AD 10 JUL][Ñuñoa][Matta][IMG][@GOODPROP]',
    adset_name: '[MATTA][ADVANTAGE][HYM][CHILE][25-50]',
    campaign_name: '[ÑUÑOA][CAPTACIÓN LEADS][FORM][ABO][NOV]',
    platform: 'ig',
    email: 'Mariela@Example.com',
    phone: 'p:+56956411418',
    cual_es_tu_rango_de_ingresos: 'entre_$1.300.000_y_$1.600.000',
}

const atr = atribucionDeFila(filaMeta)
check('encuentra los tres ids y los limpia',
    atr.campaign_id === '120235587549050178' &&
    atr.adset_id === '120247665005500178' &&
    atr.ad_id === '120247737093830178')
check('encuentra los tres nombres', Boolean(atr.campaign_name && atr.adset_name && atr.ad_name))
check('encuentra la plataforma', atr.platform === 'ig')

// Variantes en español que los clientes escriben a mano.
const filaEs = { id_campana: 'c:999', nombre_campana: 'Promo Verano', correo: 'X@Y.CL' }
check('acepta los alias en español',
    atribucionDeFila(filaEs).campaign_id === '999' &&
    atribucionDeFila(filaEs).campaign_name === 'Promo Verano')
check('el correo se normaliza a minúsculas', correoDeFila(filaEs) === 'x@y.cl')

check('una fila de CRM sin identidad publicitaria no es atribuible',
    !filaEsAtribuible({ correo: 'a@b.cl', canal: 'AGENDAMIENTO DIRECTO', observaciones: 'reagenda' }))
check('una fila de Meta Lead Ads sí es atribuible', filaEsAtribuible(filaMeta))
check('vacío no es atribuible', !filaEsAtribuible({}) && !filaEsAtribuible(null))

// El primer alias con valor gana, en el orden declarado.
check('gana el primer alias con valor',
    valorAtribucion({ phone: '', phone_number: '+56 9 1234' }, 'phone') === '+56 9 1234')
check('sin alias con valor devuelve vacío', valorAtribucion({ otra: 'x' }, 'ad_id') === '')
check('ningún alias está duplicado entre partes', (() => {
    const vistos = new Set<string>()
    for (const lista of Object.values(ALIAS_ATRIBUCION)) {
        for (const a of lista) {
            if (vistos.has(a)) return false
            vistos.add(a)
        }
    }
    return true
})())

// ════════════════════════════════════════════════════════════
seccion('Forma UtmRecord para el resolver')
// ════════════════════════════════════════════════════════════
// El id MÁS ESPECÍFICO manda: el índice del resolver mapea `ad_id` a los tres
// niveles a la vez (`byAdId` → campaña, `adByAdId` → anuncio, `adsetByAdId` →
// conjunto). Con el id de campaña solo se resolvería el primero, así que elegir
// mal aquí degrada el cruce de anuncio y conjunto sin dar ningún error.

check('utm_id toma el id de anuncio cuando existe',
    utmDeFilaSheet(filaMeta).utm_id === '120247737093830178')
check('sin anuncio, cae al conjunto',
    utmDeFilaSheet({ adset_id: 'as:222', campaign_id: 'c:111' }).utm_id === '222')
check('sin anuncio ni conjunto, cae a la campaña',
    utmDeFilaSheet({ campaign_id: 'c:111' }).utm_id === '111')
check('sin ningún id, utm_id es null',
    utmDeFilaSheet({ campaign_name: 'Promo' }).utm_id === null)

// Cada nombre tiene que ir a la ranura que la cascada consulta para SU nivel, o
// el respaldo por nombre resuelve el nivel equivocado.
const utm = utmDeFilaSheet(filaMeta)
check('el nombre de campaña va a utm_campaign', utm.utm_campaign === filaMeta.campaign_name)
check('el nombre de anuncio va a utm_content', utm.utm_content === filaMeta.ad_name)
check('el nombre de conjunto va a utm_term', utm.utm_term === filaMeta.adset_name)

// ════════════════════════════════════════════════════════════
seccion('Los totales cuadran con el camino diario')
// ════════════════════════════════════════════════════════════
// Es la garantía que hace seguro tener DOS caminos: agrupar por campaña no puede
// cambiar el total del período. Se compara el acumulado por fila (lo que hace
// `querySheetLeadsDirect`) contra el desglose diario ya materializado (lo que
// hace `querySheetFieldsDirect`), campo a campo.

const campoRango: SheetCampoDef = {
    id: 'campo-rango', cliente_id: 'c1', clave: 'rango_de_ingresos', nombre: 'Rango de ingresos',
    rol: 'ambos', formato: 'number', agregacion: 'count',
    origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['cual_es_tu_rango_de_ingresos'] }],
    valores_map: {}, valores_orden: [], sin_mapear: 'crudo', max_valores: 200,
    alta_cardinalidad: false, activo: true, orden: 0,
}
const campoMonto: SheetCampoDef = {
    ...campoRango, id: 'campo-monto', clave: 'monto', nombre: 'Monto',
    agregacion: 'sum', origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['monto_de_inversion'] }],
}

const filas: SheetRawRow[] = [
    { sheet_id: 's1', tab_name: 'Form', fecha: '2026-08-01', fila_num: 2,
      valores: { campaign_id: 'c:111', ad_id: 'ag:aaa', cual_es_tu_rango_de_ingresos: 'entre_1_y_2', monto_de_inversion: '1.000,50' } },
    { sheet_id: 's1', tab_name: 'Form', fecha: '2026-08-01', fila_num: 3,
      valores: { campaign_id: 'c:222', ad_id: 'ag:bbb', cual_es_tu_rango_de_ingresos: 'mas_de_4', monto_de_inversion: '2.000' } },
    { sheet_id: 's1', tab_name: 'Form', fecha: '2026-08-02', fila_num: 4,
      valores: { campaign_id: 'c:111', ad_id: 'ag:aaa', cual_es_tu_rango_de_ingresos: 'entre_1_y_2', monto_de_inversion: '500' } },
    // Fila sin identidad publicitaria: cuenta igual en el total, cae en su propio
    // cubo al agrupar. Es lo que impide que atribuir cambie el número de arriba.
    { sheet_id: 's1', tab_name: 'Form', fecha: '2026-08-02', fila_num: 5,
      valores: { cual_es_tu_rango_de_ingresos: 'entre_1_y_2', monto_de_inversion: '250' } },
]

const campos = [campoRango, campoMonto]

/** Réplica de la acumulación por fila de `querySheetLeadsDirect`. */
function acumularPorFila(rows: SheetRawRow[], dimDe: (f: SheetRawRow) => string) {
    const acc = new Map<string, CampoValorDiario & { dim: string }>()
    for (const fila of rows) {
        if (!fila.fecha) continue
        const dim = dimDe(fila)
        for (const campo of campos) {
            for (const crudo of valoresDeCampoEnFila(campo, fila)) {
                const bucket = bucketDeValor(campo, crudo)
                if (bucket === null) continue
                const key = `${dim} ${campo.id} ${bucket}`
                let e = acc.get(key)
                if (!e) {
                    e = { dim, campo_id: campo.id, fecha: '', valor: bucket, filas: 0, suma: 0, n_num: 0, minimo: null, maximo: null }
                    acc.set(key, e)
                }
                e.filas++
                const n = parseNumeroSheet(crudo)
                if (n !== null) {
                    e.suma += n; e.n_num++
                    e.minimo = e.minimo === null ? n : Math.min(e.minimo, n)
                    e.maximo = e.maximo === null ? n : Math.max(e.maximo, n)
                }
            }
        }
    }
    return acc
}

const { diarios } = computeCampoValoresDiarios(filas, campos)
const porFila = acumularPorFila(filas, () => 'total')

for (const campo of campos) {
    const agg = campo.agregacion
    const totalDiario = agregarDiarios(diarios.filter(d => d.campo_id === campo.id), agg)
    const totalFila = agregarDiarios(
        [...porFila.values()].filter(d => d.campo_id === campo.id), agg)
    check(`«${campo.nombre}» (${agg}): el total por fila coincide con el diario`,
        totalDiario === totalFila, `diario=${totalDiario} fila=${totalFila}`)
}

// Y agrupando por campaña, la suma de las partes tiene que dar el mismo total:
// si no, atribuir estaría creando o perdiendo filas.
const porCampana = acumularPorFila(filas, f => atribucionDeFila(f.valores).campaign_id || '(sin campaña)')
for (const campo of campos) {
    const agg = campo.agregacion
    const total = agregarDiarios([...porFila.values()].filter(d => d.campo_id === campo.id), agg)
    const dims = new Set([...porCampana.values()].map(d => d.dim))
    let suma = 0
    for (const dim of dims) {
        suma += agregarDiarios(
            [...porCampana.values()].filter(d => d.campo_id === campo.id && d.dim === dim), agg)
    }
    check(`«${campo.nombre}» (${agg}): las campañas suman el total`,
        Math.abs(total - suma) < 1e-9, `total=${total} suma=${suma}`)
}

check('la fila sin atribución cae en su propio cubo, no se pierde',
    [...porCampana.values()].some(d => d.dim === '(sin campaña)'))

// Un promedio se reagrega como Σsuma/Σn, no promediando promedios: es la razón
// de guardar `suma` y `n_num` por separado.
const campoAvg: SheetCampoDef = { ...campoMonto, id: 'campo-avg', agregacion: 'avg' }
const accAvg = (() => {
    const rows = [...acumularPorFila(filas, () => 'total').values()].filter(d => d.campo_id === campoMonto.id)
    return rows.map(r => ({ ...r, campo_id: campoAvg.id }))
})()
check('el promedio sale de Σsuma/Σn (no del promedio de promedios)',
    Math.abs(agregarDiarios(accAvg, 'avg') - (1000.5 + 2000 + 500 + 250) / 4) < 1e-9)

// ════════════════════════════════════════════════════════════
seccion('El registro declara el eje nuevo')
// ════════════════════════════════════════════════════════════
// Si la fuente no declara los ejes de publicidad, el editor sigue marcando estos
// campos como incompatibles con el gasto y el usuario nunca llega a pedir el
// cruce, por mucho que el motor sepa resolverlo.

const sheet = REG.source('sheet')
check('la fuente de Sheet existe', sheet !== undefined)
check('declara el eje de campaña', Boolean(sheet?.joinAxes.includes('campaign')))
check('declara los ejes de conjunto y anuncio',
    Boolean(sheet?.joinAxes.includes('adset') && sheet?.joinAxes.includes('ad')))
check('conserva sus ejes propios (fecha y valor)',
    Boolean(sheet?.joinAxes.includes('date') && sheet?.joinAxes.includes('sheet_value')))
// Lo que NO cambia: agrupar POR un campo de Sheet sigue sin repartir el gasto.
// El desglose por valor no tiene forma de asignarse a una campaña.
check('el gasto sigue sin cruzar por el valor de un campo de Sheet',
    !REG.source('ads')?.joinAxes.includes('sheet_value'))
check('el gasto sí cruza por campaña', Boolean(REG.source('ads')?.joinAxes.includes('campaign')))
check('un campo de Sheet no cruza con las columnas de lead',
    !sheet?.joinAxes.includes('lead_column'))

console.log(
    fallos === 0
        ? '\n✓ TODO OK'
        : `\n✗ ${fallos} comprobación(es) fallida(s)`
)
process.exit(fallos === 0 ? 0 : 1)
