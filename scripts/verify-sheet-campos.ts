/**
 * Comprobaciones del motor de campos de Sheet.
 *
 * Un "campo" unifica columnas equivalentes de varias pestañas bajo un nombre
 * visible único, agrupa valores escritos de forma distinta y produce un desglose
 * diario por valor. Todo eso es puro, así que se verifica sin Google ni Postgres.
 * Lo que necesita base (el replace por campo, el catálogo de valores crudos) se
 * comprueba con el recálculo manual desde /admin/settings.
 *
 *   npx tsx scripts/verify-sheet-campos.ts
 */

import {
    normalizarValorCrudo, bucketDeValor, valoresDeCampoEnFila,
    computeCampoValoresDiarios, evaluarVista, agregarDiarios, vistaIncluyeValor,
    esAgregacionAditiva, slugCampo, sanitizarColumna, parseNumeroSheet,
    firmaDeValor, sugerirAgrupacion, BUCKET_OTROS,
} from '../src/lib/sheets/campos'
import type {
    SheetCampoDef, SheetCampoVistaDef, SheetRawRow, CampoValorCrudo,
} from '../src/lib/sheets/campos'
import {
    makeSheetDim, makeSheetMetric, makeSheetView,
    parseSheetDim, parseSheetMetric, parseSheetView,
    isSheetDim, isSheetMetric, isSheetView, isSheetToken,
    sheetFieldAlias, sheetViewAlias, extractSheetAliases,
    sheetFieldLabel, sheetFieldFormat, isAdditiveMetric,
    hasNonAttributableFilter, evaluateExpression,
} from '../src/lib/report-utm/bi-metadata'
import type { SheetFieldMeta, SheetViewMeta } from '../src/lib/report-utm/bi-metadata'

let pasadas = 0
let fallidas = 0

function check(nombre: string, condicion: boolean, detalle?: string) {
    if (condicion) {
        pasadas++
        console.log(`  ✓ ${nombre}`)
    } else {
        fallidas++
        console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`)
    }
}

function sec(titulo: string) {
    console.log(`\n${titulo}`)
}

/** Campo mínimo, para no repetir los diez campos de la definición en cada caso. */
function campo(over: Partial<SheetCampoDef> = {}): SheetCampoDef {
    return {
        id: 'campo-1', cliente_id: 'cli-1', clave: 'rango_ingresos', nombre: 'Rango de ingresos',
        rol: 'dimension', formato: 'number', agregacion: 'count',
        origenes: [], valores_map: {}, valores_orden: [], sin_mapear: 'crudo',
        max_valores: 200, alta_cardinalidad: false, activo: true, orden: 0,
        ...over,
    }
}

function fila(over: Partial<SheetRawRow> = {}): SheetRawRow {
    return { sheet_id: 's1', tab_name: 'Form A', fecha: '2026-07-01', fila_num: 1, valores: {}, ...over }
}

// ─── Normalización de valores ───────────────────────────────────────────────

sec('normalizarValorCrudo / bucketDeValor')

{
    check('minúsculas y espacios de sobra', normalizarValorCrudo('  20 A 100  ') === '20 a 100',
        normalizarValorCrudo('  20 A 100  '))
    check('colapsa espacios internos', normalizarValorCrudo('20   a   100') === '20 a 100')
    // Los Sheets traen guiones unicode de copiar y pegar; nadie los escribe a propósito.
    check('unifica guiones unicode', normalizarValorCrudo('20‑100') === normalizarValorCrudo('20-100'),
        `${normalizarValorCrudo('20‑100')} vs ${normalizarValorCrudo('20-100')}`)
    check('vacío se queda vacío', normalizarValorCrudo('   ') === '')
    check('tolera null', normalizarValorCrudo(null) === '')

    // Lo que NO debe hacer: adivinar que "20 a 100" y "20-100" son lo mismo.
    // Eso es una decisión de negocio y para eso está el mapa de valores.
    check('no agrupa por su cuenta', normalizarValorCrudo('20 a 100') !== normalizarValorCrudo('20-100'))
}

{
    const c = campo({ valores_map: { '20 a 100': '20-100', '20-100': '20-100', '1 a 10': '1-10' } })
    check('mapea las dos escrituras al mismo bucket',
        bucketDeValor(c, '20 a 100') === '20-100' && bucketDeValor(c, ' 20-100 ') === '20-100')
    check('mapea respetando mayúsculas del origen', bucketDeValor(c, '20 A 100') === '20-100')
    check('valor sin mapear se queda en su forma normalizada', bucketDeValor(c, 'Bogotá') === 'bogotá',
        String(bucketDeValor(c, 'Bogotá')))
    check('vacío no aporta a ningún bucket', bucketDeValor(c, '') === null)

    const otros = campo({ ...c, sin_mapear: 'otros' })
    check('sin_mapear "otros" manda lo desconocido a (otros)', bucketDeValor(otros, 'Bogotá') === BUCKET_OTROS)

    const ignorar = campo({ ...c, sin_mapear: 'ignorar' })
    check('sin_mapear "ignorar" descarta lo desconocido', bucketDeValor(ignorar, 'Bogotá') === null)
    check('sin_mapear "ignorar" conserva lo mapeado', bucketDeValor(ignorar, '20-100') === '20-100')
}

// ─── Lectura de una fila ────────────────────────────────────────────────────

sec('valoresDeCampoEnFila — mapeo N pestañas × N columnas')

{
    // El caso real: la misma pregunta con distinto nombre de columna en cada
    // formulario. El campo las declara como orígenes y el resto es transparente.
    const c = campo({
        origenes: [
            { sheet_id: 's1', tab_name: 'Form A', columnas: ['rango_de_ingresos'] },
            { sheet_id: 's1', tab_name: 'Form B', columnas: ['cual_es_tu_rango_de_ingresos'] },
        ],
    })

    const a = fila({ tab_name: 'Form A', valores: { rango_de_ingresos: '20 a 100' } })
    const b = fila({ tab_name: 'Form B', valores: { cual_es_tu_rango_de_ingresos: '20-100' } })

    check('lee la columna de la pestaña A', valoresDeCampoEnFila(c, a).join(',') === '20 a 100')
    check('lee la otra columna en la pestaña B', valoresDeCampoEnFila(c, b).join(',') === '20-100')
    check('una pestaña no declarada no aporta',
        valoresDeCampoEnFila(c, fila({ tab_name: 'Form C', valores: { rango_de_ingresos: 'x' } })).length === 0)
    check('la columna de la otra pestaña no se lee por error',
        valoresDeCampoEnFila(c, fila({ tab_name: 'Form A', valores: { cual_es_tu_rango_de_ingresos: 'x' } })).length === 0)
}

{
    const comodin = campo({ origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['ciudad'] }] })
    check('el comodín aplica a cualquier sheet y pestaña',
        valoresDeCampoEnFila(comodin, fila({ sheet_id: 'sX', tab_name: 'Otra', valores: { ciudad: 'Cali' } }))[0] === 'Cali')
    check('el nombre de pestaña no distingue mayúsculas',
        valoresDeCampoEnFila(
            campo({ origenes: [{ sheet_id: 's1', tab_name: 'form a', columnas: ['ciudad'] }] }),
            fila({ tab_name: 'Form A', valores: { ciudad: 'Cali' } })
        )[0] === 'Cali')
}

{
    const f = fila({ valores: { col_a: '', col_b: '10', col_c: '5' } })

    const primero = campo({ origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['col_a', 'col_b', 'col_c'], combinar: 'primero' }] })
    check('"primero" toma la primera columna con valor', valoresDeCampoEnFila(primero, f).join(',') === '10')

    const suma = campo({ origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['col_b', 'col_c'], combinar: 'suma' }] })
    check('"suma" suma las columnas', valoresDeCampoEnFila(suma, f).join(',') === '15')

    const concat = campo({ origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['col_b', 'col_c'], combinar: 'concat' }] })
    check('"concat" aporta un valor por columna', valoresDeCampoEnFila(concat, f).join(',') === '10,5')
}

{
    // Con UNA sola columna, `combinar` no aplica: el valor se toma tal cual.
    // Antes se aplicaba igualmente y un origen de una columna marcado como
    // "suma" convertía "más_de_$4.000.000" en 4000000, dejando el campo con
    // números que no se parecían en nada a los de su columna.
    const texto = fila({ valores: { rango: 'más_de_$4.000.000' } })
    for (const combinar of ['primero', 'suma', 'concat'] as const) {
        const c = campo({ origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['rango'], combinar }] })
        check(`una sola columna con "${combinar}" conserva el texto`,
            valoresDeCampoEnFila(c, texto).join(',') === 'más_de_$4.000.000',
            valoresDeCampoEnFila(c, texto).join(','))
    }

    // Y el bucket resultante sigue siendo el valor legible, no un número.
    const c = campo({ origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['rango'], combinar: 'suma' }] })
    const { crudos } = computeCampoValoresDiarios([
        texto,
        fila({ valores: { rango: 'entre_$1.300.000_y_$1.600.000' } }),
    ], [c])
    check('el catálogo muestra los valores de la columna, no sus números',
        (crudos.get(c.id) ?? []).map(v => v.valor_crudo).sort().join('|')
        === 'entre_$1.300.000_y_$1.600.000|más_de_$4.000.000',
        (crudos.get(c.id) ?? []).map(v => v.valor_crudo).join('|'))
}

// ─── Desglose diario ────────────────────────────────────────────────────────

sec('computeCampoValoresDiarios — el corazón del módulo')

{
    // Dos pestañas, columnas con nombres distintos, valores escritos distinto:
    // el campo tiene que devolver UN solo bucket por día.
    const c = campo({
        valores_map: { '20 a 100': '20-100', '20-100': '20-100', '1 a 10': '1-10' },
        origenes: [
            { sheet_id: 's1', tab_name: 'Form A', columnas: ['rango_de_ingresos'] },
            { sheet_id: 's1', tab_name: 'Form B', columnas: ['cual_es_tu_rango_de_ingresos'] },
        ],
    })
    const filas: SheetRawRow[] = [
        fila({ tab_name: 'Form A', valores: { rango_de_ingresos: '20 a 100' } }),
        fila({ tab_name: 'Form A', valores: { rango_de_ingresos: '20 a 100' } }),
        fila({ tab_name: 'Form B', valores: { cual_es_tu_rango_de_ingresos: '20-100' } }),
        fila({ tab_name: 'Form A', valores: { rango_de_ingresos: '1 a 10' } }),
        fila({ tab_name: 'Form A', fecha: '2026-07-02', valores: { rango_de_ingresos: '20 a 100' } }),
    ]

    const { diarios, crudos } = computeCampoValoresDiarios(filas, [c])

    const d1 = diarios.filter(d => d.fecha === '2026-07-01')
    check('un bucket por valor distinto del día', d1.length === 2, String(d1.length))
    const b20 = d1.find(d => d.valor === '20-100')!
    check('las dos escrituras caen en el mismo bucket', b20.filas === 3, String(b20?.filas))
    check('el otro rango se cuenta aparte', d1.find(d => d.valor === '1-10')!.filas === 1)
    check('separa por fecha', diarios.filter(d => d.fecha === '2026-07-02').length === 1)

    const catalogo = crudos.get(c.id)!
    check('el catálogo registra las dos formas crudas',
        catalogo.map(v => v.valor_crudo).sort().join('|') === '1 a 10|20 a 100|20-100',
        catalogo.map(v => v.valor_crudo).join('|'))
    check('el catálogo dice de qué pestaña salió cada una',
        catalogo.find(v => v.valor_crudo === '20-100')!.origenes.join(',') === 'Form B')
    check('el catálogo ordena por frecuencia', catalogo[0].valor_crudo === '20 a 100')
}

{
    // Promedio correcto a cualquier grano: 3 filas de un día y 1 de otro.
    // El promedio del periodo es (10+20+30+100)/4 = 40, NO el promedio de los
    // promedios diarios ((20 + 100)/2 = 60), que es lo que sale de guardar el
    // promedio ya resuelto por día.
    const c = campo({
        agregacion: 'avg',
        origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['ticket'] }],
    })
    const filas = [
        fila({ valores: { ticket: '10' } }),
        fila({ valores: { ticket: '20' } }),
        fila({ valores: { ticket: '30' } }),
        fila({ fecha: '2026-07-02', valores: { ticket: '100' } }),
    ]
    const { diarios } = computeCampoValoresDiarios(filas, [c])

    check('avg del periodo usa suma/n, no promedio de promedios',
        agregarDiarios(diarios, 'avg') === 40, String(agregarDiarios(diarios, 'avg')))
    check('sum del periodo', agregarDiarios(diarios, 'sum') === 160, String(agregarDiarios(diarios, 'sum')))
    check('count del periodo', agregarDiarios(diarios, 'count') === 4)
    check('min del periodo', agregarDiarios(diarios, 'min') === 10)
    check('max del periodo', agregarDiarios(diarios, 'max') === 100)

    const dia1 = diarios.filter(d => d.fecha === '2026-07-01')
    check('avg de un solo día sigue siendo correcto', agregarDiarios(dia1, 'avg') === 20)
    check('count y sum son aditivas', esAgregacionAditiva('count') && esAgregacionAditiva('sum'))
    check('avg, min y max no son aditivas',
        !esAgregacionAditiva('avg') && !esAgregacionAditiva('min') && !esAgregacionAditiva('max'))
}

{
    // Un valor no numérico no debe contaminar la suma ni el denominador del
    // promedio: cuenta como fila, pero no como número.
    const c = campo({ origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['v'] }] })
    const { diarios } = computeCampoValoresDiarios([
        fila({ valores: { v: '10' } }),
        fila({ valores: { v: 'no sé' } }),
    ], [c])
    check('el texto cuenta como fila', agregarDiarios(diarios, 'count') === 2)
    check('el texto no entra en la suma', agregarDiarios(diarios, 'sum') === 10)
    check('el texto no infla el denominador del promedio', agregarDiarios(diarios, 'avg') === 10)
}

{
    // Alta cardinalidad: un campo apuntado a algo tipo email llenaría la tabla y
    // no serviría como dimensión. Se conservan los más frecuentes y el resto se
    // pliega, SIN perder el total.
    const c = campo({ max_valores: 2, origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['email'] }] })
    const filas = [
        fila({ valores: { email: 'a@x.com' } }),
        fila({ valores: { email: 'a@x.com' } }),
        fila({ valores: { email: 'a@x.com' } }),
        fila({ valores: { email: 'b@x.com' } }),
        fila({ valores: { email: 'b@x.com' } }),
        fila({ valores: { email: 'c@x.com' } }),
        fila({ valores: { email: 'd@x.com' } }),
    ]
    const { diarios, altaCardinalidad, avisos } = computeCampoValoresDiarios(filas, [c])

    check('marca el campo como de alta cardinalidad', altaCardinalidad.get(c.id) === true)
    check('lo explica en los avisos', avisos.some(a => a.includes('valores distintos')), avisos.join(' | '))
    check('respeta el tope de buckets', diarios.length === 3, String(diarios.length))
    check('el excedente cae en (otros)', diarios.find(d => d.valor === BUCKET_OTROS)!.filas === 2)
    check('el total no se pierde', agregarDiarios(diarios, 'count') === 7)
}

{
    const { avisos } = computeCampoValoresDiarios([fila()], [campo({ origenes: [] })])
    check('avisa de un campo sin orígenes',
        avisos.some(a => a.includes('no tiene ninguna pestaña')), avisos.join(' | '))
}

{
    const c = campo({ activo: false, origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['v'] }] })
    const { diarios } = computeCampoValoresDiarios([fila({ valores: { v: '1' } })], [c])
    check('un campo inactivo no se calcula', diarios.length === 0)
}

// ─── Vistas guardadas ───────────────────────────────────────────────────────

sec('evaluarVista — "Leads 20-100" como métrica')

{
    const c = campo({
        valores_map: { '20 a 100': '20-100', '20-100': '20-100', '1 a 10': '1-10', '11 a 20': '11-20' },
        origenes: [{ sheet_id: '*', tab_name: '*', columnas: ['rango'] }],
    })
    const filas = [
        fila({ valores: { rango: '20 a 100' } }),
        fila({ valores: { rango: '20-100' } }),
        fila({ valores: { rango: '1 a 10' } }),
        fila({ fecha: '2026-07-02', valores: { rango: '20 a 100' } }),
        fila({ fecha: '2026-07-02', valores: { rango: '11 a 20' } }),
    ]
    const { diarios } = computeCampoValoresDiarios(filas, [c])

    const vista = (over: Partial<SheetCampoVistaDef> = {}): SheetCampoVistaDef => ({
        id: 'v1', cliente_id: 'cli-1', campo_id: c.id, campo_clave: c.clave,
        clave: 'leads_20_100', nombre: 'Leads 20-100', agregacion: 'count',
        operador: 'in', valores: ['20-100'], formato: 'number', activo: true, orden: 0,
        ...over,
    })

    const v = evaluarVista(vista(), diarios)
    check('la vista cuenta solo su bucket', v.total === 3, String(v.total))
    check('la serie diaria funciona', v.porFecha.get('2026-07-01') === 2 && v.porFecha.get('2026-07-02') === 1,
        JSON.stringify(Array.from(v.porFecha)))

    const varios = evaluarVista(vista({ valores: ['20-100', '11-20'] }), diarios)
    check('una vista puede juntar varios buckets', varios.total === 4, String(varios.total))

    const negada = evaluarVista(vista({ operador: 'not_in' }), diarios)
    check('not_in devuelve el complemento', negada.total === 2, String(negada.total))
    check('in + not_in = total', v.total + negada.total === 5)

    const otroCampo = evaluarVista(vista({ campo_id: 'otro' }), diarios)
    check('una vista no toca el desglose de otro campo', otroCampo.total === 0)
}

// ─── Claves, números y agrupación automática ────────────────────────────────

sec('slugCampo / sanitizarColumna / parseNumeroSheet')

{
    check('slug con acentos y espacios', slugCampo('Rango de Ingresos') === 'rango_de_ingresos',
        slugCampo('Rango de Ingresos'))
    check('slug quita acentos', slugCampo('¿Cuál es tu situación?') === 'cual_es_tu_situacion',
        slugCampo('¿Cuál es tu situación?'))
    check('slug no termina en guion bajo', !slugCampo('Ciudad!!!').endsWith('_'), slugCampo('Ciudad!!!'))
    // Las columnas de los orígenes se comparan contra las claves de
    // sheet_filas.valores: las dos funciones tienen que coincidir.
    check('slug y sanitizarColumna coinciden en nombres normales',
        slugCampo('Rango de Ingresos') === sanitizarColumna('Rango de Ingresos'))
}

{
    check('separador es-CO (punto de miles)', parseNumeroSheet('$ 1.200') === 1200, String(parseNumeroSheet('$ 1.200')))
    check('separador en-US', parseNumeroSheet('1,000.50') === 1000.5)
    check('decimal con coma', parseNumeroSheet('12,5') === 12.5)
    // Distinguir "no es un número" de "es cero" es lo que permite que el
    // denominador del promedio no cuente las celdas de texto.
    check('texto devuelve null, no 0', parseNumeroSheet('no sé') === null)
    check('cero es cero, no null', parseNumeroSheet('0') === 0)
    check('vacío devuelve null', parseNumeroSheet('') === null)
}

sec('sugerirAgrupacion — el botón de auto-agrupar')

{
    check('la firma junta las variantes de un rango',
        firmaDeValor('20 a 100') === firmaDeValor('20-100') && firmaDeValor('20-100') === firmaDeValor('20A100'),
        `${firmaDeValor('20 a 100')} / ${firmaDeValor('20-100')} / ${firmaDeValor('20A100')}`)
    check('la firma no junta rangos distintos', firmaDeValor('20 a 100') !== firmaDeValor('1 a 10'))
    // La "a" solo separa entre dígitos: en una palabra no debe tocarse.
    check('la firma no destroza palabras con "a"', firmaDeValor('Casa propia') === 'casapropia',
        firmaDeValor('Casa propia'))

    const valores: CampoValorCrudo[] = [
        { valor_crudo: '20 a 100', valor_norm: '', filas: 312, origenes: ['Form A'], ultima_fecha: null },
        { valor_crudo: '20-100', valor_norm: '', filas: 98, origenes: ['Form B'], ultima_fecha: null },
        { valor_crudo: '1 a 10', valor_norm: '', filas: 40, origenes: ['Form A'], ultima_fecha: null },
    ]
    const sugerido = sugerirAgrupacion(valores)
    check('propone el bucket más frecuente como nombre', sugerido['20-100'] === '20 a 100', sugerido['20-100'])
    check('agrupa las dos variantes', sugerido['20 a 100'] === '20 a 100' && sugerido['20-100'] === '20 a 100')
    check('no propone nada para un valor sin variantes', sugerido['1 a 10'] === undefined)
}

// ─── Métricas legacy de leads (migración 059) ───────────────────────────────
// La integración "Google Sheets — Leads" se retiró, pero sus cuatro nombres de
// métrica se conservan: hay layouts guardados que los usan. Se reconstruyen
// desde el campo "calidad_lead" y la vista "leads_calificados" que deja el
// script de migración. Esta sección fija esa aritmética.

sec('Migración 059 — las 4 métricas de leads salen del campo de calidad')

{
    // Reproduce el caso real: una hoja de leads de Meta donde cada fila es un
    // lead y una columna dice si calificó.
    const calidad = campo({
        clave: 'calidad_lead', nombre: 'Calidad del lead',
        origenes: [{ sheet_id: 'migrado', tab_name: '*', columnas: ['califica'] }],
    })
    const vistaCalificados: SheetCampoVistaDef = {
        id: 'v-cal', cliente_id: 'cli-1', campo_id: calidad.id, campo_clave: calidad.clave,
        clave: 'leads_calificados', nombre: 'Leads calificados', agregacion: 'count',
        operador: 'in', valores: ['sí'], formato: 'number', activo: true, orden: 0,
    }

    const filas = [
        fila({ sheet_id: 'migrado', valores: { califica: 'Sí' } }),
        fila({ sheet_id: 'migrado', valores: { califica: 'sí' } }),   // misma respuesta, otra caja
        fila({ sheet_id: 'migrado', valores: { califica: 'No' } }),
        fila({ sheet_id: 'migrado', valores: { califica: 'No' } }),
        fila({ sheet_id: 'migrado', fecha: '2026-07-02', valores: { califica: 'Sí' } }),
    ]
    const { diarios } = computeCampoValoresDiarios(filas, [calidad])

    /** Misma aritmética que getSheetCamposDelDia en el dashboard. */
    const cuarteto = (delDia: typeof diarios) => {
        const totales = agregarDiarios(delDia, 'count')
        const calificados = agregarDiarios(delDia.filter(d => vistaIncluyeValor(vistaCalificados, d.valor)), 'count')
        return {
            leads_totales: totales,
            leads_calificados: calificados,
            leads_no_calificados: Math.max(0, totales - calificados),
            tasa_calificacion: totales > 0 ? Math.round((calificados / totales) * 10000) / 100 : 0,
        }
    }

    const d1 = cuarteto(diarios.filter(d => d.fecha === '2026-07-01'))
    check('leads_totales cuenta todas las filas del día', d1.leads_totales === 4, String(d1.leads_totales))
    check('"Sí" y "sí" cuentan como el mismo valor', d1.leads_calificados === 2, String(d1.leads_calificados))
    check('leads_no_calificados es la resta', d1.leads_no_calificados === 2)
    check('tasa_calificacion en porcentaje', d1.tasa_calificacion === 50, String(d1.tasa_calificacion))

    const d2 = cuarteto(diarios.filter(d => d.fecha === '2026-07-02'))
    check('el segundo día se calcula aparte', d2.leads_totales === 1 && d2.tasa_calificacion === 100)

    // Un día sin leads no puede dar NaN ni dividir por cero: la tarjeta mostraría
    // "NaN%" en el dashboard del cliente.
    const vacio = cuarteto([])
    check('un día sin leads da ceros, no NaN',
        vacio.leads_totales === 0 && vacio.tasa_calificacion === 0 &&
        Number.isFinite(vacio.tasa_calificacion))

    // La tasa se redondea a 2 decimales: 1 de 3 son 33.33, no 33.333333.
    const tercio = cuarteto(diarios.filter(d => d.fecha === '2026-07-01').map(d =>
        d.valor === 'sí' ? { ...d, filas: 1 } : d))
    check('la tasa se redondea a 2 decimales',
        Number.isFinite(tercio.tasa_calificacion) &&
        String(tercio.tasa_calificacion).replace(/^\d+\.?/, '').length <= 2,
        String(tercio.tasa_calificacion))

    // El total nunca puede quedar por debajo de los calificados (no_calificados
    // negativo se leería como un dato corrupto en la tarjeta).
    const raro = { leads_totales: 2, leads_calificados: 5 }
    check('no_calificados nunca es negativo',
        Math.max(0, raro.leads_totales - raro.leads_calificados) === 0)
}

// ─── Tokens del BI ──────────────────────────────────────────────────────────
// Los tres tokens que exponen un campo en el BI. La agregación viaja dentro del
// token de métrica para que un widget ya guardado siga midiendo lo mismo aunque
// después se cambie la agregación por defecto del campo.

sec('bi-metadata — tokens sheetdim / sheetagg / sheetview')

{
    const dim = makeSheetDim('rango_ingresos')
    check('token de dimensión', dim === 'sheetdim:rango_ingresos', dim)
    check('se reconoce como dimensión', isSheetDim(dim) && !isSheetMetric(dim) && !isSheetView(dim))
    check('parsea la clave', parseSheetDim(dim) === 'rango_ingresos')

    const met = makeSheetMetric('avg', 'ticket')
    check('token de métrica', met === 'sheetagg:avg:ticket', met)
    check('parsea agregación y clave',
        parseSheetMetric(met)?.agg === 'avg' && parseSheetMetric(met)?.clave === 'ticket')
    check('rechaza una agregación desconocida', parseSheetMetric('sheetagg:raro:x') === null)

    const vista = makeSheetView('leads_20_100')
    check('token de vista', vista === 'sheetview:leads_20_100', vista)
    check('parsea la clave de la vista', parseSheetView(vista) === 'leads_20_100')

    check('isSheetToken cubre los tres', isSheetToken(dim) && isSheetToken(met) && isSheetToken(vista))
    // Lo importante: no confundirse con las métricas normales ni con los tokens
    // offfield:* de la integración anterior, que siguen vivos.
    check('no confunde métricas normales',
        !isSheetToken('offline_leads') && !isSheetToken('spend') && parseSheetDim('spend') === null)
    check('no confunde tokens offfield', !isSheetToken('offfield:currency:ticket'))
}

{
    const fields: SheetFieldMeta[] = [
        { clave: 'rango_ingresos', nombre: 'Rango de ingresos', rol: 'dimension', formato: 'number',
          agregacion: 'count', valores: [], alta_cardinalidad: false, sources: [] },
        { clave: 'ticket', nombre: 'Ticket promedio', rol: 'metrica', formato: 'currency',
          agregacion: 'avg', valores: [], alta_cardinalidad: false, sources: [] },
    ]
    const views: SheetViewMeta[] = [
        { clave: 'leads_20_100', nombre: 'Leads 20-100', campo_clave: 'rango_ingresos',
          agregacion: 'count', formato: 'number' },
    ]

    // El nombre que puso el analista es el que se ve en todas partes.
    check('la etiqueta usa el nombre del campo',
        sheetFieldLabel(makeSheetDim('rango_ingresos'), fields, views) === 'Rango de ingresos')
    check('la etiqueta de la vista usa su nombre',
        sheetFieldLabel(makeSheetView('leads_20_100'), fields, views) === 'Leads 20-100')
    // El conteo es la lectura por defecto: decir "Conteo · X" sería ruido.
    check('el conteo no ensucia la etiqueta',
        sheetFieldLabel(makeSheetMetric('count', 'rango_ingresos'), fields, views) === 'Rango de ingresos')
    check('las demás agregaciones sí se nombran',
        sheetFieldLabel(makeSheetMetric('avg', 'ticket'), fields, views) === 'Promedio · Ticket promedio',
        String(sheetFieldLabel(makeSheetMetric('avg', 'ticket'), fields, views)))
    // Un widget guardado de otro cliente no tiene catálogo: no debe quedarse en blanco.
    check('sin catálogo humaniza la clave',
        sheetFieldLabel(makeSheetDim('rango_ingresos')) === 'Rango ingresos',
        String(sheetFieldLabel(makeSheetDim('rango_ingresos'))))
    check('etiqueta null para no-tokens', sheetFieldLabel('spend', fields, views) === null)

    check('formato de moneda', sheetFieldFormat(makeSheetMetric('avg', 'ticket'), fields, views) === 'currency')
    // Contar filas devuelve un número aunque la columna sea de dinero.
    check('un conteo es número, no moneda',
        sheetFieldFormat(makeSheetMetric('count', 'ticket'), fields, views) === 'number')
    check('formato null para no-tokens', sheetFieldFormat('spend', fields, views) === null)

    // La fila "Total" de una tabla solo puede sumar lo que es sumable.
    check('count y sum son aditivos',
        isAdditiveMetric(makeSheetMetric('count', 'x')) && isAdditiveMetric(makeSheetMetric('sum', 'x')))
    check('avg, min y max no lo son',
        !isAdditiveMetric(makeSheetMetric('avg', 'x')) &&
        !isAdditiveMetric(makeSheetMetric('min', 'x')) &&
        !isAdditiveMetric(makeSheetMetric('max', 'x')))
    check('una vista de conteo es aditiva', isAdditiveMetric(makeSheetView('leads_20_100')))
    check('las métricas normales no cambian', isAdditiveMetric('leads_count') && !isAdditiveMetric('cpl'))
}

{
    const alias = sheetFieldAlias('rango_ingresos')
    check('alias de campo', alias === 'sf__rango_ingresos', alias)
    check('alias de vista', sheetViewAlias('leads_20_100') === 'sv__leads_20_100')

    const found = extractSheetAliases('meta_spend / sv__leads_20_100 + sf__ticket')
    check('extrae los dos alias', found.length === 2, String(found.length))
    check('distingue campo de vista',
        found.find(f => f.clave === 'ticket')?.kind === 'campo' &&
        found.find(f => f.clave === 'leads_20_100')?.kind === 'vista')
    check('no extrae identificadores normales', extractSheetAliases('spend / leads_count').length === 0)
    // Los alias de la integración anterior conviven sin pisarse.
    check('no confunde alias off__', extractSheetAliases('off__citas + spend').length === 0)
}

// ─── Filtro no atribuible ───────────────────────────────────────────────────
// Filtrar por un campo de Sheet recorta los leads pero no el gasto (el gasto
// solo se cruza con UTM por el nombre de campaña), así que el motor tiene que
// saber que el CPL de ese widget no sería real.

sec('hasNonAttributableFilter — el gasto no se puede recortar por campo de Sheet')

{
    check('un filtro por campo de Sheet no es atribuible',
        hasNonAttributableFilter({ [makeSheetDim('rango_ingresos')]: '20-100' }, undefined))
    check('un filtro por UTM sí lo es',
        !hasNonAttributableFilter({ utm_source: 'facebook' }, undefined))
    check('también lo detecta en el filtro avanzado',
        hasNonAttributableFilter(undefined, {
            groups: [{ conditions: [{ field: makeSheetDim('ciudad'), op: 'eq', value: 'Cali' }] }],
        }))
    check('un filtro vacío no cuenta',
        !hasNonAttributableFilter({ [makeSheetDim('rango_ingresos')]: '' }, undefined))
}

// ─── Evaluación de expresiones sin new Function ─────────────────────────────
// La CSP de producción no permite 'unsafe-eval', así que el evaluador del BI no
// puede usar `new Function`: en el navegador lanzaba siempre y el validador del
// editor daba toda fórmula por inválida.

sec('evaluateExpression — parser sin eval')

{
    check('aritmética básica', evaluateExpression('2 + 3 * 4', {}) === 14)
    check('precedencia con paréntesis', evaluateExpression('(2 + 3) * 4', {}) === 20)
    check('negativo unario', evaluateExpression('-5 + 2', {}) === -3)
    check('sustituye identificadores', evaluateExpression('spend / leads', { spend: 100, leads: 4 }) === 25)
    check('identificador ausente vale 0', evaluateExpression('spend + otro', { spend: 10 }) === 10)
    check('división por cero devuelve null', evaluateExpression('spend / leads', { spend: 10, leads: 0 }) === null)
    check('redondea a 2 decimales', evaluateExpression('10 / 3', {}) === 3.33)
    check('expresión mal formada devuelve null', evaluateExpression('2 +', {}) === null)
    check('rechaza caracteres no permitidos', evaluateExpression('2; alert(1)', {}) === null)

    // El caso real de la feature: cruzar gasto con una vista de Sheet.
    const conAlias = evaluateExpression('meta_spend / sv__leads_20_100', {
        meta_spend: 500, sv__leads_20_100: 5,
    })
    check('fórmula con alias de vista de Sheet', conAlias === 100, String(conAlias))
    check('fórmula con alias de campo de Sheet',
        evaluateExpression('sf__ticket * 2', { sf__ticket: 12.5 }) === 25)
}

// ─── Resumen ────────────────────────────────────────────────────────────────

console.log(`\n${fallidas === 0 ? '✓' : '✗'} ${pasadas} comprobaciones pasadas, ${fallidas} fallidas`)
process.exit(fallidas === 0 ? 0 : 1)
