/**
 * Comprobaciones del registro de fuentes del BI (`src/lib/report-utm/bi/`).
 *
 * Todo PURO: no toca la base ni la red.
 *
 * Este script ES la puerta de la Fase 2. El registro no aporta nada si pierde
 * información respecto al catálogo escrito a mano, así que aquí se compara
 * campo por campo: etiqueta, formato, grupo y desglose de las 72 métricas, más
 * los cinco conjuntos que hoy se mantienen sincronizados a mano
 * (ADDITIVE_METRICS, PIVOT_METRICS, FUNNEL_STAGE_METRICS, RECOMMENDED_METRICS,
 * LOWER_IS_BETTER).
 *
 * Si algo de esto falla, el registro NO está listo para que el motor lo use.
 *
 *   npx tsx scripts/verify-bi-registry.ts
 */

import {
    METRIC_META, DIMENSION_META, ADDITIVE_METRICS, PIVOT_METRICS,
    FUNNEL_STAGE_METRICS, RECOMMENDED_METRICS, LOWER_IS_BETTER,
    METRIC_GLOSSARY, AD_JSONB_METRICS, AD_SCALAR_METRICS, AD_RATE_METRICS,
    OFFLINE_METRICS, SUBS_METRICS, MANUAL_JSONB_METRICS,
} from '../src/lib/report-utm/bi-metadata'
import type { BiMetric, BiDimension } from '../src/lib/report-utm/bi-metadata'

import {
    BASE_REGISTRY as REG, STATIC_SOURCES,
    isAdditive, isPivotable, funnelStages, recommendedMeasures,
    isLowerBetterField, legacyBreakdownOfField, directDeps, leafDeps,
    sourcesFor, fieldCrossesDimension, conflictsAmong,
} from '../src/lib/report-utm/bi/registry'
import {
    LEGACY_MEASURE_IDS, LEGACY_DIMENSION_IDS, migrateMeasureId,
    migrateDimensionId, migrateDynamicToken, isCanonicalId,
} from '../src/lib/report-utm/bi/legacy-tokens'
import { parseExpr, isExprError } from '../src/lib/report-utm/bi/expr'

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
/** Compara conjuntos y describe la diferencia en los dos sentidos. */
function difSets(a: Set<string>, b: Set<string>): string {
    const soloA = [...a].filter(x => !b.has(x))
    const soloB = [...b].filter(x => !a.has(x))
    const partes: string[] = []
    if (soloA.length) partes.push(`sobran: ${soloA.join(', ')}`)
    if (soloB.length) partes.push(`faltan: ${soloB.join(', ')}`)
    return partes.join(' | ')
}

// ════════════════════════════════════════════════════════════
seccion('Integridad estructural del registro')
// ════════════════════════════════════════════════════════════

const todosIds = REG.fields().map(f => f.id)
check(`${todosIds.length} campos registrados en ${STATIC_SOURCES.length} fuentes`, todosIds.length > 0)

const noCanonicos = todosIds.filter(id => !isCanonicalId(id))
check('todos los ids tienen la forma <fuente>.<campo>', noCanonicos.length === 0, noCanonicos.join(', '))

const vistos = new Set<string>()
const duplicados = todosIds.filter(id => (vistos.has(id) ? true : (vistos.add(id), false)))
check('sin ids duplicados', duplicados.length === 0, duplicados.join(', '))

// El prefijo del id tiene que coincidir con la fuente que lo declara, o el
// motor buscaría la columna en la tabla equivocada.
const prefijoMal: string[] = []
for (const s of STATIC_SOURCES) {
    for (const f of s.fields) if (!f.id.startsWith(`${s.id}.`)) prefijoMal.push(`${f.id} en ${s.id}`)
}
check('el prefijo del id coincide con su fuente', prefijoMal.length === 0, prefijoMal.join(', '))

const sinHelp = REG.measures().filter(m => !m.help || m.help.trim().length < 10)
check('toda medida tiene texto de ayuda propio', sinHelp.length === 0,
    sinHelp.map(m => m.id).join(', '))

// ════════════════════════════════════════════════════════════
seccion('Fórmulas: parsean y sus referencias existen')
// ════════════════════════════════════════════════════════════

const formulaMal: string[] = []
const refMal: string[] = []
for (const m of REG.measures()) {
    if (!m.formula) continue
    const p = parseExpr(m.formula)
    if (isExprError(p)) { formulaMal.push(`${m.id}: ${p.error}`); continue }
    for (const r of p.refs) if (!REG.field(r)) refMal.push(`${m.id} → ${r}`)
}
check('todas las fórmulas parsean', formulaMal.length === 0, formulaMal.join(' | '))
check('todas las referencias resuelven en el registro', refMal.length === 0, refMal.join(' | '))

// `weightBy` apunta al denominador de un promedio ponderado: si no existe, el
// promedio se convertiría en un promedio de promedios sin avisar.
const pesoMal = REG.measures()
    .filter(m => m.weightBy && !REG.field(m.weightBy))
    .map(m => `${m.id} → ${m.weightBy}`)
check('todo weightBy resuelve', pesoMal.length === 0, pesoMal.join(', '))

const sinPeso = REG.measures().filter(m => m.agg === 'weighted_avg' && !m.weightBy)
check('todo weighted_avg declara su peso', sinPeso.length === 0, sinPeso.map(m => m.id).join(', '))

// Una fórmula que se referencia a sí misma colgaría el motor.
const ciclos = REG.measures().filter(m => m.formula && leafDeps(REG, m.id).includes(m.id))
check('ninguna fórmula es cíclica', ciclos.length === 0, ciclos.map(m => m.id).join(', '))

const derivadaSinHojas = REG.measures().filter(m => m.formula && leafDeps(REG, m.id).length === 0)
check('toda derivada llega a medidas físicas', derivadaSinHojas.length === 0,
    derivadaSinHojas.map(m => m.id).join(', '))

// ════════════════════════════════════════════════════════════
seccion('Traducción de tokens legados')
// ════════════════════════════════════════════════════════════

const legacyMetrics = Object.keys(METRIC_META) as BiMetric[]
check(`METRIC_META tiene ${legacyMetrics.length} métricas`, legacyMetrics.length === 72,
    String(legacyMetrics.length))

const sinTraducir = legacyMetrics.filter(m => !LEGACY_MEASURE_IDS[m])
check('toda métrica de METRIC_META tiene id canónico', sinTraducir.length === 0, sinTraducir.join(', '))

const traduceANada = legacyMetrics
    .map(m => [m, LEGACY_MEASURE_IDS[m]] as const)
    .filter(([, id]) => id && !REG.measure(id))
check('todo id canónico existe en el registro', traduceANada.length === 0,
    traduceANada.map(([m, id]) => `${m} → ${id}`).join(', '))

const legacyDims = Object.keys(DIMENSION_META) as BiDimension[]
const dimSinTraducir = legacyDims.filter(d => !LEGACY_DIMENSION_IDS[d])
check('toda dimensión de DIMENSION_META tiene id canónico', dimSinTraducir.length === 0,
    dimSinTraducir.join(', '))

const dimTraduceANada = legacyDims
    .map(d => [d, LEGACY_DIMENSION_IDS[d]] as const)
    .filter(([, id]) => id && id !== 'none' && !REG.dimensionField(id))
check('todo id de dimensión existe en el registro', dimTraduceANada.length === 0,
    dimTraduceANada.map(([d, id]) => `${d} → ${id}`).join(', '))

// Idempotencia: reejecutar la migración tiene que ser un no-op.
const noIdempotente = [...legacyMetrics.map(m => LEGACY_MEASURE_IDS[m]!)]
    .filter(id => migrateMeasureId(id) !== id)
check('migrateMeasureId es idempotente', noIdempotente.length === 0, noIdempotente.join(', '))

const dimNoIdempotente = legacyDims
    .map(d => LEGACY_DIMENSION_IDS[d]!)
    .filter(id => migrateDimensionId(id) !== id)
check('migrateDimensionId es idempotente', dimNoIdempotente.length === 0, dimNoIdempotente.join(', '))

check('leads_total (borrada en la mig. 045) sigue resolviendo',
    migrateMeasureId('leads_total') === 'leads.count')
check('el alias histórico dimension:campaign resuelve',
    migrateDimensionId('campaign') === migrateDimensionId('utm_campaign'))
check('un token desconocido se devuelve tal cual (no se descarta)',
    migrateMeasureId('mi_campo_calculado') === 'mi_campo_calculado')

seccion('Tokens dinámicos: las 7 familias')
check('field:<k>', migrateDynamicToken('field:edad') === 'leads.raw__edad')
check('fieldagg:<agg>:<k>', migrateDynamicToken('fieldagg:avg:edad') === 'leads.raw__edad__avg')
check('leadfield:<k>', migrateDynamicToken('leadfield:rango_ingresos') === 'leads.campo__rango_ingresos')
check('offfield:<tipo>:<k>', migrateDynamicToken('offfield:currency:margen') === 'offline.custom__margen')
check('sheetdim:<k>', migrateDynamicToken('sheetdim:rango') === 'sheet.rango')
check('sheetagg:<agg>:<k>', migrateDynamicToken('sheetagg:sum:ticket') === 'sheet.ticket__sum')
check('sheetview:<k>', migrateDynamicToken('sheetview:leads_altos') === 'sheet.vista__leads_altos')
check('un token dinámico traducido es canónico',
    isCanonicalId(migrateDynamicToken('fieldagg:avg:edad')!))

// ════════════════════════════════════════════════════════════
seccion('El catálogo derivado reproduce METRIC_META')
// ════════════════════════════════════════════════════════════

const difLabel: string[] = []
const difFormat: string[] = []
const difGroup: string[] = []
const difBreakdown: string[] = []

for (const legacy of legacyMetrics) {
    const canonical = LEGACY_MEASURE_IDS[legacy]
    const f = canonical ? REG.measure(canonical) : undefined
    if (!f) continue
    const meta = METRIC_META[legacy]
    if (f.label !== meta.label) difLabel.push(`${legacy}: «${f.label}» ≠ «${meta.label}»`)
    if (f.format !== meta.format) difFormat.push(`${legacy}: ${f.format} ≠ ${meta.format}`)
    if (f.group !== meta.group) difGroup.push(`${legacy}: ${f.group} ≠ ${meta.group}`)
    const bd = legacyBreakdownOfField(REG, canonical!)
    if (bd !== meta.breakdown) difBreakdown.push(`${legacy}: ${bd} ≠ ${meta.breakdown}`)
}

check('las 72 etiquetas coinciden', difLabel.length === 0, difLabel.join(' | '))
check('los 72 formatos coinciden', difFormat.length === 0, difFormat.join(' | '))
check('los 72 grupos coinciden', difGroup.length === 0, difGroup.join(' | '))
// La comprobación clave: `breakdown` se escribía a mano 72 veces y ahora se
// deriva de grain ∩ joinAxes. Si esto pasa, la derivación no pierde nada.
check('los 72 desgloses se DERIVAN correctamente', difBreakdown.length === 0, difBreakdown.join(' | '))

// ════════════════════════════════════════════════════════════
seccion('Los conjuntos que hoy se sincronizan a mano')
// ════════════════════════════════════════════════════════════

/** Traduce un conjunto de ids canónicos a nombres legados, para comparar. */
function aLegacy(ids: string[]): Set<string> {
    const inv = new Map<string, string>()
    for (const [legacy, canonical] of Object.entries(LEGACY_MEASURE_IDS)) {
        if (legacy === 'leads_total') continue   // alias, no es una métrica propia
        if (!inv.has(canonical)) inv.set(canonical, legacy)
    }
    return new Set(ids.map(id => inv.get(id) ?? id))
}

const aditivasDerivadas = aLegacy(REG.measures().filter(isAdditive).map(m => m.id))
const aditivasActuales = new Set([...ADDITIVE_METRICS])
check('ADDITIVE_METRICS se deriva igual', aditivasDerivadas.size === aditivasActuales.size &&
    [...aditivasActuales].every(m => aditivasDerivadas.has(m)),
    difSets(aditivasDerivadas, aditivasActuales))

const pivotDerivadas = aLegacy(REG.measures().filter(m => isPivotable(REG, m.id)).map(m => m.id))
check('PIVOT_METRICS se deriva igual', pivotDerivadas.size === PIVOT_METRICS.length &&
    PIVOT_METRICS.every(m => pivotDerivadas.has(m)),
    difSets(pivotDerivadas, new Set(PIVOT_METRICS as string[])))

const funnelDerivadas = aLegacy(funnelStages(REG).map(m => m.id))
check('FUNNEL_STAGE_METRICS se deriva igual (mismo conjunto)',
    funnelDerivadas.size === FUNNEL_STAGE_METRICS.length &&
    FUNNEL_STAGE_METRICS.every(m => funnelDerivadas.has(m)),
    difSets(funnelDerivadas, new Set(FUNNEL_STAGE_METRICS as readonly string[] as string[])))

// El orden del embudo importa: las etapas van de más arriba a más abajo.
const ordenDerivado = funnelStages(REG).map(m => [...aLegacy([m.id])][0])
const ordenActual = [...FUNNEL_STAGE_METRICS]
check('FUNNEL_STAGE_METRICS conserva el ORDEN del embudo',
    JSON.stringify(ordenDerivado) === JSON.stringify(ordenActual),
    `derivado: ${ordenDerivado.join(' → ')}`)

const recomendadasDerivadas = aLegacy(recommendedMeasures(REG).map(m => m.id))
check('RECOMMENDED_METRICS se deriva igual',
    recomendadasDerivadas.size === RECOMMENDED_METRICS.length &&
    RECOMMENDED_METRICS.every(m => recomendadasDerivadas.has(m)),
    difSets(recomendadasDerivadas, new Set(RECOMMENDED_METRICS as string[])))

const bajarMejorDerivadas = aLegacy(
    REG.measures().filter(m => isLowerBetterField(REG, m.id)).map(m => m.id))
check('LOWER_IS_BETTER se deriva igual',
    bajarMejorDerivadas.size === LOWER_IS_BETTER.size &&
    [...LOWER_IS_BETTER].every(m => bajarMejorDerivadas.has(m)),
    difSets(bajarMejorDerivadas, new Set([...LOWER_IS_BETTER] as string[])))

// ════════════════════════════════════════════════════════════
seccion('El glosario existente se conserva palabra por palabra')
// ════════════════════════════════════════════════════════════

const glosarioMal: string[] = []
for (const [legacy, texto] of Object.entries(METRIC_GLOSSARY)) {
    const canonical = LEGACY_MEASURE_IDS[legacy]
    const f = canonical ? REG.measure(canonical) : undefined
    if (!f) continue
    if (f.help !== texto) glosarioMal.push(legacy)
}
check(`los ${Object.keys(METRIC_GLOSSARY).length} textos del glosario se conservan`,
    glosarioMal.length === 0, glosarioMal.join(', '))

const conGlosario = Object.keys(METRIC_GLOSSARY).length
check(`el registro amplía el glosario de ${conGlosario} a las 72 métricas`,
    REG.measures().length === 72 && sinHelp.length === 0)

// ════════════════════════════════════════════════════════════
seccion('Las dimensiones reproducen DIMENSION_META')
// ════════════════════════════════════════════════════════════

const difDimLabel: string[] = []
for (const legacy of legacyDims) {
    if (legacy === 'none') continue
    const canonical = LEGACY_DIMENSION_IDS[legacy]
    const d = canonical ? REG.dimensionField(canonical) : undefined
    if (!d) continue
    if (d.label !== DIMENSION_META[legacy].label) {
        difDimLabel.push(`${legacy}: «${d.label}» ≠ «${DIMENSION_META[legacy].label}»`)
    }
}
check('las etiquetas de dimensión coinciden', difDimLabel.length === 0, difDimLabel.join(' | '))

// ════════════════════════════════════════════════════════════
seccion('Las 6 listas físicas quedan cubiertas por las fuentes')
// ════════════════════════════════════════════════════════════

/** ¿Todas estas métricas legadas caen en la fuente esperada? */
function todasEnFuente(nombre: string, metricas: readonly string[], fuente: string) {
    const mal = metricas.filter(m => {
        const id = LEGACY_MEASURE_IDS[m]
        return !id || REG.sourceOf(id)?.id !== fuente
    })
    check(`${nombre} → fuente «${fuente}»`, mal.length === 0, mal.join(', '))
}
todasEnFuente('AD_JSONB_METRICS', AD_JSONB_METRICS, 'ads')
todasEnFuente('AD_RATE_METRICS', AD_RATE_METRICS, 'cuenta')
todasEnFuente('OFFLINE_METRICS', OFFLINE_METRICS, 'offline')
todasEnFuente('SUBS_METRICS', SUBS_METRICS, 'subs')
todasEnFuente('MANUAL_JSONB_METRICS', MANUAL_JSONB_METRICS.map(m => m.metric), 'cuenta')

// AD_SCALAR_METRICS está repartida a propósito: son columnas escalares de
// metricas_diarias, pero `tiktok_conversions` SÍ se desglosa por campaña (se lee
// del JSONB tiktok_campaigns), así que pertenece a `ads`, no a `cuenta`.
const escalaresMal = AD_SCALAR_METRICS.filter(m => {
    const id = LEGACY_MEASURE_IDS[m]
    const src = id ? REG.sourceOf(id)?.id : undefined
    return m === 'tiktok_conversions' ? src !== 'ads' : src !== 'cuenta'
})
check('AD_SCALAR_METRICS → «cuenta» (y tiktok_conversions → «ads»)',
    escalaresMal.length === 0, escalaresMal.join(', '))

// ════════════════════════════════════════════════════════════
seccion('Selección de fuentes: sustituye a las 6 compuertas booleanas')
// ════════════════════════════════════════════════════════════

const nombresDe = (ids: string[]) => sourcesFor(REG, ids).map(s => s.id).sort()

check('leads.count → solo la fuente leads',
    JSON.stringify(nombresDe(['leads.count'])) === '["leads"]')
check('ads.spend → solo la fuente ads',
    JSON.stringify(nombresDe(['ads.spend'])) === '["ads"]')
// El caso que antes se codificaba REPITIENDO `cpl` en needsLeads y en needsAds.
check('leads.cpl → ads + leads (deducido de la fórmula)',
    JSON.stringify(nombresDe(['leads.cpl'])) === '["ads","leads"]')
check('sales.roas → ads + sales',
    JSON.stringify(nombresDe(['sales.roas'])) === '["ads","sales"]')
check('cuenta.hotmart_roas → ads + cuenta',
    JSON.stringify(nombresDe(['cuenta.hotmart_roas'])) === '["ads","cuenta"]')
check('leads.conversion_rate → leads + sales',
    JSON.stringify(nombresDe(['leads.conversion_rate'])) === '["leads","sales"]')
// Un promedio ponderado necesita traer también su peso.
check('cuenta.ga_bounce_rate arrastra su peso (ga_sessions)',
    sourcesFor(REG, ['cuenta.ga_bounce_rate']).length === 1 &&
    leafDepsIncluyePeso())
function leafDepsIncluyePeso(): boolean {
    const m = REG.measure('cuenta.ga_bounce_rate')
    return m?.weightBy === 'cuenta.ga_sessions' && REG.measure(m.weightBy) !== undefined
}
check('una fórmula NO arrastra fuentes por palabras sueltas',
    // `directDeps` filtra lo que no es un campo del registro.
    directDeps(REG, {
        kind: 'measure', id: 'x.y', label: 'x', help: 'xxxxxxxxxx', group: 'leads',
        agg: 'avg', format: 'ratio', formula: 'ads.spend / dias',
    }).length === 1)

// ════════════════════════════════════════════════════════════
seccion('fieldCrossesDimension reproduce metricCrossesDimension')
// ════════════════════════════════════════════════════════════

// Los casos que el módulo ya documenta como límites reales.
check('gasto × campaña SÍ cruza',
    fieldCrossesDimension(REG, 'ads.spend', 'leads.campaign'))
check('gasto × fecha SÍ cruza',
    fieldCrossesDimension(REG, 'ads.spend', 'leads.date'))
check('gasto × país NO cruza (metricas_diarias no tiene UTM)',
    !fieldCrossesDimension(REG, 'ads.spend', 'leads.ip_country'))
check('gasto × formulario NO cruza',
    !fieldCrossesDimension(REG, 'ads.spend', 'leads.form_name'))
check('leads × país SÍ cruza',
    fieldCrossesDimension(REG, 'leads.count', 'leads.ip_country'))
check('GA4 × campaña NO cruza',
    !fieldCrossesDimension(REG, 'cuenta.ga_sessions', 'leads.campaign'))
check('GA4 × fecha SÍ cruza',
    fieldCrossesDimension(REG, 'cuenta.ga_sessions', 'leads.date'))
check('suscripciones NO cruzan ni por fecha (son una foto)',
    !fieldCrossesDimension(REG, 'subs.active', 'leads.date'))
check('suscripciones SÍ valen en el Total',
    fieldCrossesDimension(REG, 'subs.active', 'none'))
check('CPL hereda el límite del gasto (× país NO cruza)',
    !fieldCrossesDimension(REG, 'leads.cpl', 'leads.ip_country'))
check('CPL × campaña SÍ cruza',
    fieldCrossesDimension(REG, 'leads.cpl', 'leads.campaign'))
check('Conv. Rate × país SÍ cruza (leads y ventas son de grano fila)',
    fieldCrossesDimension(REG, 'leads.conversion_rate', 'leads.ip_country'))
check('un campo de Sheet NO cruza con el gasto',
    !fieldCrossesDimension(REG, 'ads.spend', 'sheet.cualquiera') ||
    REG.dimensionField('sheet.cualquiera') === undefined)

// ════════════════════════════════════════════════════════════
seccion('Métricas que se solapan (aviso legible por máquina)')
// ════════════════════════════════════════════════════════════

const solapes = conflictsAmong(REG, ['leads.count', 'ads.leads_form', 'offline.leads'])
check('las tres métricas de "leads" se declaran incompatibles entre sí',
    solapes.length === 3, JSON.stringify(solapes))
check('métricas no solapadas no generan aviso',
    conflictsAmong(REG, ['leads.count', 'ads.spend']).length === 0)

// ════════════════════════════════════════════════════════════
seccion('Contrato de las fuentes')
// ════════════════════════════════════════════════════════════

const sinGrano = STATIC_SOURCES.filter(s => s.grain.length === 0)
check('toda fuente declara su grano', sinGrano.length === 0, sinGrano.map(s => s.id).join(', '))

// Una fuente con fecha tiene que decir de qué tipo es, o el motor no sabe si
// necesita convertir a día local antes de agrupar.
const sinTipoFecha = STATIC_SOURCES.filter(s => s.dateColumn && !s.dateType)
check('toda fuente con fecha declara su tipo', sinTipoFecha.length === 0,
    sinTipoFecha.map(s => s.id).join(', '))

const snapshotConFecha = STATIC_SOURCES.filter(s => s.grainKind === 'snapshot' && s.dateColumn)
check('un snapshot no declara columna de rango', snapshotConFecha.length === 0,
    snapshotConFecha.map(s => s.id).join(', '))

// El puente public_cliente_id: declararlo es lo que permite REPORTAR que falta
// en vez de devolver ceros. Es el fallo silencioso más caro del módulo.
const porPublic = STATIC_SOURCES.filter(s => s.clientKey.scope === 'public').map(s => s.id)
check('las fuentes que dependen de public_cliente_id están declaradas',
    JSON.stringify(porPublic.sort()) === '["ads","cuenta","offline","sheet","subs"]',
    porPublic.join(', '))
const porReportUtm = STATIC_SOURCES.filter(s => s.clientKey.scope === 'report_utm').map(s => s.id)
check('leads y ventas cuelgan del cliente de report_utm',
    JSON.stringify(porReportUtm.sort()) === '["leads","sales"]', porReportUtm.join(', '))

// Solo el grano de fila puede ser eje de tabla dinámica.
const pivotNoFila = REG.measures()
    .filter(m => isPivotable(REG, m.id) && REG.sourceOf(m.id)?.grainKind !== 'row')
check('solo el grano «row» es pivotable', pivotNoFila.length === 0,
    pivotNoFila.map(m => m.id).join(', '))

// ════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
process.exit(fallos === 0 ? 0 : 1)
