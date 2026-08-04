/**
 * Comprobaciones del planificador, el join y las derivadas del BI
 * (`src/lib/report-utm/bi/{plan,join,derive}.ts`).
 *
 * Todo PURO: no toca la base ni la red.
 *
 * Lo que se protege:
 *
 *   1. La selección de fuentes se DEDUCE de los campos pedidos, no de seis
 *      listas literales de nombres de métrica.
 *   2. Cuando una fuente no puede responder, se cae del plan CON MOTIVO y sus
 *      campos quedan en `null`, no en 0. El caso más caro es
 *      `no_public_link`: hoy pone a 0 media plataforma sin que nada lo diga.
 *   3. Una métrica derivada vale lo MISMO en un scorecard que dentro de un
 *      campo calculado. Hoy no: `mergeResults` da null y `baseValues` da 0.
 *
 *   npx tsx scripts/verify-bi-engine.ts
 */

import { BASE_REGISTRY as REG } from '../src/lib/report-utm/bi/registry'
import {
    buildPlan, expandRequestedFields, skipReasonFor, planSourceIds,
} from '../src/lib/report-utm/bi/plan'
import type { PlanContext } from '../src/lib/report-utm/bi/plan'
import {
    compileDerived, applyDerived, applyCalculated, orderDerived,
} from '../src/lib/report-utm/bi/derive'
import type { RowValues } from '../src/lib/report-utm/bi/derive'
import { joinResults, totalsRow, TOTAL_KEY } from '../src/lib/report-utm/bi/join'
import type { SourceResult } from '../src/lib/report-utm/bi/join'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) {
        console.log(`  ✓ ${nombre}`)
    } else {
        fallos++
        console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`)
    }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

/** Contexto "todo bien": cliente enlazado, sin filtros problemáticos. */
const OK_CTX: PlanContext = { hasPublicLink: true }

// ════════════════════════════════════════════════════════════
seccion('Expansión de lo pedido')
// ════════════════════════════════════════════════════════════

const e1 = expandRequestedFields(REG, { fieldIds: ['leads.count'] })
check('una medida física no tiene derivadas', e1.derived.length === 0)
check('su hoja es ella misma', JSON.stringify(e1.leaves) === '["leads.count"]')

const e2 = expandRequestedFields(REG, { fieldIds: ['leads.cpl'] })
check('CPL se marca como derivada', JSON.stringify(e2.derived) === '["leads.cpl"]')
check('CPL expande a gasto + leads',
    JSON.stringify([...e2.leaves].sort()) === '["ads.spend","leads.count"]',
    JSON.stringify(e2.leaves))

// Derivada de derivada: hotmart_roas → hotmart_revenue_calc → 3 columnas.
const e3 = expandRequestedFields(REG, { fieldIds: ['cuenta.hotmart_roas'] })
check('una derivada anidada arrastra la intermedia',
    e3.derived.includes('cuenta.hotmart_revenue_calc'), JSON.stringify(e3.derived))
check('y llega a las columnas físicas',
    e3.leaves.includes('cuenta.ventas_principal') && e3.leaves.includes('ads.spend'),
    JSON.stringify(e3.leaves))

// Un promedio ponderado necesita su peso o se convierte en promedio de promedios.
const e4 = expandRequestedFields(REG, { fieldIds: ['cuenta.ga_bounce_rate'] })
check('un promedio ponderado arrastra su peso',
    e4.leaves.includes('cuenta.ga_sessions'), JSON.stringify(e4.leaves))

// Los identificadores de un campo calculado también cuentan como pedidos.
const e5 = expandRequestedFields(REG, {
    fieldIds: [],
    calculated: [{ name: 'ticket', expression: 'sales.revenue / sales.count' }],
})
check('un campo calculado arrastra sus operandos',
    JSON.stringify([...e5.leaves].sort()) === '["sales.count","sales.revenue"]',
    JSON.stringify(e5.leaves))

// El caso que motivó el parser: una palabra suelta no es una métrica.
const e6 = expandRequestedFields(REG, {
    fieldIds: [],
    calculated: [{ name: 'x', expression: 'ads.spend / dias' }],
})
check('«dias» NO arrastra ninguna fuente',
    JSON.stringify(e6.leaves) === '["ads.spend"]', JSON.stringify(e6.leaves))

// ════════════════════════════════════════════════════════════
seccion('Selección de fuentes (mata las 6 compuertas booleanas)')
// ════════════════════════════════════════════════════════════

const p = (fieldIds: string[], dimensionId?: string | null, ctx: PlanContext = OK_CTX) =>
    buildPlan(REG, { fieldIds, dimensionId }, ctx)

check('leads.count → [leads]',
    JSON.stringify(planSourceIds(p(['leads.count']))) === '["leads"]')
check('ads.spend → [ads]',
    JSON.stringify(planSourceIds(p(['ads.spend']))) === '["ads"]')
// Antes: `cpl` estaba repetido en needsLeads Y en needsAds.
check('leads.cpl → [ads, leads] deducido de la fórmula',
    JSON.stringify(planSourceIds(p(['leads.cpl']))) === '["ads","leads"]')
check('una tabla con 5 métricas de 3 fuentes → esas 3',
    JSON.stringify(planSourceIds(p(
        ['ads.spend', 'leads.count', 'leads.cpl', 'sales.count', 'sales.roas']
    ))) === '["ads","leads","sales"]')
check('subs.active → [subs]',
    JSON.stringify(planSourceIds(p(['subs.active']))) === '["subs"]')

// ════════════════════════════════════════════════════════════
seccion('El fallo silencioso más caro: falta public_cliente_id')
// ════════════════════════════════════════════════════════════

const SIN_ENLACE: PlanContext = { hasPublicLink: false }
const planSinEnlace = p(['ads.spend', 'leads.count', 'leads.cpl'], null, SIN_ENLACE)

check('la fuente de gasto se cae del plan',
    JSON.stringify(planSourceIds(planSinEnlace)) === '["leads"]')
check('los leads siguen consultándose',
    planSinEnlace.requests.some(r => r.source.id === 'leads'))
check('se reporta el motivo, no se calla',
    planSinEnlace.skipped.some(s => s.sourceId === 'ads' && s.reason.kind === 'no_public_link'))
check('el gasto queda como NO DISPONIBLE (→ «—», no 0)',
    planSinEnlace.unavailable['ads.spend']?.kind === 'no_public_link')
// Esto es lo que hoy hace que un informe entero se lea como "todo a cero".
check('CPL hereda el motivo de su operando',
    planSinEnlace.unavailable['leads.cpl']?.kind === 'no_public_link')
check('leads.count NO queda marcado (sí se puede medir)',
    planSinEnlace.unavailable['leads.count'] === undefined)

const todasPublicas = p(
    ['ads.spend', 'cuenta.ga_sessions', 'offline.leads', 'subs.active'], null, SIN_ENLACE)
check('las 4 fuentes públicas se caen juntas',
    planSourceIds(todasPublicas).length === 0 && todasPublicas.skipped.length === 4,
    JSON.stringify(todasPublicas.skipped.map(s => s.sourceId)))

// ════════════════════════════════════════════════════════════
seccion('Grano: la fuente no cruza con la dimensión')
// ════════════════════════════════════════════════════════════

const porPais = p(['ads.spend', 'leads.count'], 'leads.ip_country')
check('agrupando por país, el gasto se cae',
    JSON.stringify(planSourceIds(porPais)) === '["leads"]')
check('con motivo grain_mismatch',
    porPais.skipped[0]?.reason.kind === 'grain_mismatch')
check('y el eje que falla se nombra',
    porPais.skipped[0]?.reason.kind === 'grain_mismatch' &&
    porPais.skipped[0].reason.axis === 'lead_column')

const porCampana = p(['ads.spend', 'leads.count'], 'leads.campaign')
check('agrupando por campaña, el gasto SÍ participa',
    JSON.stringify(planSourceIds(porCampana)) === '["ads","leads"]')

const ga4PorCampana = p(['cuenta.ga_sessions'], 'leads.campaign')
check('GA4 no cruza por campaña (preagregada por día)',
    ga4PorCampana.skipped[0]?.reason.kind === 'grain_mismatch')

const subsPorFecha = p(['subs.active'], 'leads.date')
check('las suscripciones no cruzan ni por fecha (son una foto)',
    subsPorFecha.skipped[0]?.reason.kind === 'grain_mismatch')
check('pero sí valen en el total',
    JSON.stringify(planSourceIds(p(['subs.active'], null))) === '["subs"]')

// ════════════════════════════════════════════════════════════
seccion('Filtro no atribuible al gasto')
// ════════════════════════════════════════════════════════════

const CTX_FILTRO: PlanContext = {
    hasPublicLink: true,
    unattributableFilters: ['leads.ip_country'],
}
const conFiltro = p(['ads.spend', 'leads.count'], null, CTX_FILTRO)
check('el gasto se cae con un filtro no atribuible',
    JSON.stringify(planSourceIds(conFiltro)) === '["leads"]')
check('con motivo unattributable_filter y los campos nombrados',
    conFiltro.skipped[0]?.reason.kind === 'unattributable_filter' &&
    conFiltro.skipped[0].reason.fields[0] === 'leads.ip_country')
check('los leads sí quedan filtrados (siguen en el plan)',
    conFiltro.requests.some(r => r.source.id === 'leads'))

seccion('Integración sin configurar')
const CTX_NO_CFG: PlanContext = { hasPublicLink: true, notConfigured: new Set(['sales']) }
const sinVentas = p(['sales.count', 'leads.count'], null, CTX_NO_CFG)
check('una fuente sin configurar se reporta como not_configured',
    sinVentas.skipped[0]?.reason.kind === 'not_configured')
check('ventas queda como desconocido, no como 0',
    sinVentas.unavailable['sales.count']?.kind === 'not_configured')

seccion('Prioridad de los motivos')
// Si falta el enlace, eso es lo que hay que arreglar: no importa que además el
// grano no cruce.
const dobleProblema = skipReasonFor(
    REG.source('cuenta')!, { hasPublicLink: false }, REG.dimensionField('leads.campaign')!)
check('falta de enlace manda sobre el desajuste de grano',
    dobleProblema?.kind === 'no_public_link')

// ════════════════════════════════════════════════════════════
seccion('Derivadas: orden topológico')
// ════════════════════════════════════════════════════════════

const orden = orderDerived(REG, ['cuenta.hotmart_roas']).map(f => f.id)
check('la intermedia se calcula ANTES de la que la usa',
    orden.indexOf('cuenta.hotmart_revenue_calc') < orden.indexOf('cuenta.hotmart_roas'),
    JSON.stringify(orden))
check('una física no entra en el orden de derivadas',
    orderDerived(REG, ['ads.spend']).length === 0)

// ════════════════════════════════════════════════════════════
seccion('Derivadas: UN solo valor (el bug del null divergente)')
// ════════════════════════════════════════════════════════════

function calcular(ids: string[], base: RowValues): RowValues {
    const row: RowValues = { ...base }
    applyDerived(compileDerived(REG, ids), row)
    return row
}

const cpl = calcular(['leads.cpl'], { 'ads.spend': 1000, 'leads.count': 40 })
check('CPL = gasto / leads', cpl['leads.cpl'] === 25)

check('CPL con 0 leads → null (no Infinity, no 0)',
    calcular(['leads.cpl'], { 'ads.spend': 1000, 'leads.count': 0 })['leads.cpl'] === null)

// El caso concreto que se leía como "se perdió todo lo invertido".
const roasSinHotmart = calcular(['cuenta.hotmart_roas', 'cuenta.hotmart_roi'], {
    'ads.spend': 5000,
    'cuenta.ventas_principal': 0, 'cuenta.ventas_bump': 0, 'cuenta.ventas_upsell': 0,
})
check('ROAS Hotmart sin facturación → null, NO 0',
    roasSinHotmart['cuenta.hotmart_roas'] === null)
check('ROI Hotmart sin facturación → null, NO −100%',
    roasSinHotmart['cuenta.hotmart_roi'] === null)

const roasConHotmart = calcular(['cuenta.hotmart_roas'], {
    'ads.spend': 1000,
    'cuenta.ventas_principal': 800, 'cuenta.ventas_bump': 300, 'cuenta.ventas_upsell': 200,
})
check('ROAS Hotmart con datos = 1.3', roasConHotmart['cuenta.hotmart_roas'] === 1.3,
    String(roasConHotmart['cuenta.hotmart_roas']))
check('la intermedia también queda en la fila',
    roasConHotmart['cuenta.hotmart_revenue_calc'] === 1300)

// LA comprobación clave de la fase: el scorecard y el campo calculado leen el
// MISMO valor. Hoy uno da null y el otro 0.
const fila = calcular(['cuenta.hotmart_roas'], {
    'ads.spend': 5000,
    'cuenta.ventas_principal': 0, 'cuenta.ventas_bump': 0, 'cuenta.ventas_upsell': 0,
})
const antes = fila['cuenta.hotmart_roas']
applyCalculated([{ name: 'mi_campo', expression: 'cuenta.hotmart_roas * 2' }], fila)
check('un campo calculado sobre una derivada nula da null, no 0',
    antes === null && fila['mi_campo'] === null,
    `derivada=${antes} calculado=${fila['mi_campo']}`)

// Y al revés: un identificador simplemente ausente sigue contando 0, para no
// mover los números de los informes que ya existen.
const filaCompat: RowValues = { 'ads.spend': 100 }
applyCalculated([{ name: 'c', expression: 'ads.spend + no_existe' }], filaCompat)
check('un identificador ausente sigue contando 0 (compat)', filaCompat['c'] === 100)

seccion('Ratios de rendimiento')
check('CTR = clics / impresiones',
    calcular(['ads.ctr'], { 'ads.clicks': 50, 'ads.impressions': 1000 })['ads.ctr'] === 0.05)
check('CPM = gasto / impresiones × 1000',
    calcular(['ads.cpm'], { 'ads.spend': 100, 'ads.impressions': 10000 })['ads.cpm'] === 10)
check('Frecuencia = impresiones / alcance',
    calcular(['ads.frequency'], { 'ads.impressions': 300, 'ads.reach': 100 })['ads.frequency'] === 3)
check('ROAS = revenue / gasto',
    calcular(['sales.roas'], { 'sales.revenue': 3000, 'ads.spend': 1000 })['sales.roas'] === 3)
check('ROAS con gasto 0 → null',
    calcular(['sales.roas'], { 'sales.revenue': 3000, 'ads.spend': 0 })['sales.roas'] === null)
check('Conv. Rate = ventas / leads',
    calcular(['leads.conversion_rate'], { 'sales.count': 5, 'leads.count': 100 })['leads.conversion_rate'] === 0.05)

// ════════════════════════════════════════════════════════════
seccion('Join: outer join con HUECO, no con cero')
// ════════════════════════════════════════════════════════════

function res(sourceId: string, filas: Record<string, Record<string, number>>): SourceResult {
    return {
        sourceId,
        byKey: new Map(Object.entries(filas)),
        stats: { rowsRead: Object.keys(filas).length, truncated: false, ms: 1 },
    }
}

const planTabla = p(['ads.spend', 'leads.count'], 'leads.campaign')
const unidas = joinResults(REG, planTabla, [
    res('ads', { 'Promo A': { 'ads.spend': 500 }, 'Promo B': { 'ads.spend': 300 } }),
    res('leads', { 'Promo A': { 'leads.count': 20 }, 'Promo C': { 'leads.count': 7 } }),
])

check('outer join: la unión de todas las claves', unidas.length === 3,
    unidas.map(r => r.key).join(', '))
check('la clave presente en las dos fuentes tiene ambos valores',
    unidas[0].values['ads.spend'] === 500 && unidas[0].values['leads.count'] === 20)
// Promo B tiene gasto pero ningún lead.
check('gasto sin leads → leads en null, NO en 0',
    unidas.find(r => r.key === 'Promo B')!.values['leads.count'] === null)
// Promo C tiene leads pero ningún gasto.
check('leads sin gasto → gasto en null, NO en 0',
    unidas.find(r => r.key === 'Promo C')!.values['ads.spend'] === null)

// Y por tanto el CPL de una campaña sin gasto es desconocido, no 0.
const compiladas = compileDerived(REG, ['leads.cpl'])
for (const r of unidas) applyDerived(compiladas, r.values)
check('CPL de una campaña sin gasto → null',
    unidas.find(r => r.key === 'Promo C')!.values['leads.cpl'] === null)
check('CPL de una campaña completa se calcula',
    unidas.find(r => r.key === 'Promo A')!.values['leads.cpl'] === 25)

seccion('Join: las fuentes caídas quedan en null')
const planCaido = p(['ads.spend', 'leads.count'], null, SIN_ENLACE)
const unidasCaido = joinResults(REG, planCaido, [
    res('leads', { [TOTAL_KEY]: { 'leads.count': 42 } }),
])
check('los leads se leen', unidasCaido[0].values['leads.count'] === 42)
check('el gasto de la fuente caída es null, no 0',
    unidasCaido[0].values['ads.spend'] === null)

seccion('Join: no cruzadas')
const conNoCruzada: SourceResult = {
    ...res('leads', { 'utm-rara': { 'leads.count': 3 } }),
    unmatchedKeys: new Set(['utm-rara']),
}
const marcadas = joinResults(REG, p(['leads.count'], 'leads.campaign'), [conNoCruzada])
check('una clave sin cruzar se marca', marcadas[0].unmatched === true)

seccion('Promedio ponderado en el join')
const conPeso: SourceResult = {
    ...res('cuenta', {}),
    weighted: new Map([
        // 3 días: (0.5×100 + 0.3×200 + 0.4×100) / 400 = 150/400 = 0.375
        [TOTAL_KEY, { 'cuenta.ga_bounce_rate': { sum: 150, weight: 400 } }],
    ]),
}
const conPesoUnida = joinResults(REG, p(['cuenta.ga_bounce_rate']), [conPeso])
check('se pondera por el peso, no se promedia el promedio',
    conPesoUnida[0].values['cuenta.ga_bounce_rate'] === 0.375,
    String(conPesoUnida[0].values['cuenta.ga_bounce_rate']))
check('peso 0 → null, no división por cero',
    joinResults(REG, p(['cuenta.ga_bounce_rate']), [{
        ...res('cuenta', {}),
        weighted: new Map([[TOTAL_KEY, { 'cuenta.ga_bounce_rate': { sum: 0, weight: 0 } }]]),
    }])[0].values['cuenta.ga_bounce_rate'] === null)

// ════════════════════════════════════════════════════════════
seccion('Fila de totales')
// ════════════════════════════════════════════════════════════

const totales = totalsRow(REG, unidas, ['ads.spend', 'leads.count', 'ads.reach', 'leads.cpl'])
check('suma las aditivas', totales['ads.spend'] === 800 && totales['leads.count'] === 27,
    JSON.stringify(totales))
// `reach` cuenta personas únicas: sumarlo entre campañas cuenta doble a quien
// vio las dos.
check('NO suma el alcance (personas únicas)', totales['ads.reach'] === null)
check('NO suma un ratio: lo recalcula después', totales['leads.cpl'] === null)

// El total del ratio se obtiene aplicando la derivada sobre los totales.
applyDerived(compileDerived(REG, ['leads.cpl']), totales)
check('el CPL total se recalcula sobre los totales (800/27)',
    totales['leads.cpl'] === 29.63, String(totales['leads.cpl']))

const sinNada = totalsRow(REG, [
    { key: 'a', values: { 'ads.spend': null } },
], ['ads.spend'])
check('si ninguna fila tiene valor, el total es hueco (no 0)', sinNada['ads.spend'] === null)

// ════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
process.exit(fallos === 0 ? 0 : 1)
