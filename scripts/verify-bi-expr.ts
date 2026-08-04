/**
 * Comprobaciones del parser de expresiones del BI (`src/lib/report-utm/bi/expr.ts`).
 *
 * Todo PURO: no toca la base ni la red.
 *
 * Lo que se protege aquí es sobre todo la extracción de dependencias. Antes se
 * hacía con un `match` de identificadores por expresión regular, así que:
 *   · `spend / dias` pedía una fuente entera por la palabra `dias`
 *   · `min(a,b)` se convertía en `0(0,0)` y valía 0 en silencio
 *   · una errata nunca se reportaba
 *
 *   npx tsx scripts/verify-bi-expr.ts
 */

import {
    parseExpr, isExprError, evalExpr, refsOf, validateRefs,
    rewriteRefs, serializeExpr,
} from '../src/lib/report-utm/bi/expr'
import type { ParsedExpr } from '../src/lib/report-utm/bi/expr'

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
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`)
}

/** Parsea y falla ruidosamente si no debía fallar. */
function ok(src: string): ParsedExpr {
    const p = parseExpr(src)
    if (isExprError(p)) throw new Error(`«${src}» no debía fallar: ${p.error}`)
    return p
}

// ════════════════════════════════════════════════════════════
seccion('Parseo básico y precedencia')
// ════════════════════════════════════════════════════════════

check('suma', evalExpr(ok('1 + 2').ast, {}) === 3)
check('precedencia * sobre +', evalExpr(ok('2 + 3 * 4').ast, {}) === 14)
check('paréntesis mandan', evalExpr(ok('(2 + 3) * 4').ast, {}) === 20)
check('resta asociativa por la izquierda', evalExpr(ok('10 - 3 - 2').ast, {}) === 5)
check('división asociativa por la izquierda', evalExpr(ok('100 / 5 / 2').ast, {}) === 10)
check('unario negativo', evalExpr(ok('-5 + 2').ast, {}) === -3)
check('unario doble', evalExpr(ok('--5').ast, {}) === 5)
check('unario tras operador', evalExpr(ok('3 * -2').ast, {}) === -6)
check('decimales', evalExpr(ok('1.5 * 2').ast, {}) === 3)
check('decimal sin parte entera', evalExpr(ok('.5 * 4').ast, {}) === 2)

// ════════════════════════════════════════════════════════════
seccion('Extracción de dependencias (el motivo del archivo)')
// ════════════════════════════════════════════════════════════

check('identificadores simples', JSON.stringify(refsOf('revenue / leads_count')) === '["revenue","leads_count"]')
check('ids canónicos con punto', JSON.stringify(refsOf('ads.spend / leads.count')) === '["ads.spend","leads.count"]')
check('campos dinámicos con doble guion bajo',
    JSON.stringify(refsOf('sheet.rango__sum + 1')) === '["sheet.rango__sum"]')
check('sin duplicados, en orden de aparición',
    JSON.stringify(refsOf('a + b + a')) === '["a","b"]')
check('los números NO son dependencias', refsOf('2 * 3.5').length === 0)
check('`dias` se reporta como dependencia real, no se ignora',
    refsOf('spend / dias').includes('dias'))
check('un id no se parte por el punto',
    refsOf('ads.spend').length === 1)

// ════════════════════════════════════════════════════════════
seccion('Errores que antes pasaban en silencio')
// ════════════════════════════════════════════════════════════

const llamadaFuncion = parseExpr('min(a, b)')
check('una llamada a función es ERROR, no 0(0,0)', isExprError(llamadaFuncion))
check('la coma se señala', isExprError(llamadaFuncion) && llamadaFuncion.at > 0)

const parenSinCerrar = parseExpr('(1 + 2')
check('paréntesis sin cerrar es error', isExprError(parenSinCerrar))
check('el error apunta al paréntesis que abre',
    isExprError(parenSinCerrar) && parenSinCerrar.at === 0)

check('expresión vacía es error', isExprError(parseExpr('')))
check('solo espacios es error', isExprError(parseExpr('   ')))
check('operador colgando es error', isExprError(parseExpr('1 +')))
check('carácter no permitido es error', isExprError(parseExpr('a & b')))
check('punto suelto tras id es error', isExprError(parseExpr('ads.')))
check('sobra texto al final es error', isExprError(parseExpr('1 2')))

// ════════════════════════════════════════════════════════════
seccion('Valores, nulos y división por cero')
// ════════════════════════════════════════════════════════════

const div = ok('revenue / spend')
check('calcula con valores', evalExpr(div.ast, { revenue: 100, spend: 40 }) === 2.5)
check('división por cero → null', evalExpr(div.ast, { revenue: 100, spend: 0 }) === null)
check('nunca devuelve Infinity',
    Number.isFinite(evalExpr(div.ast, { revenue: 1, spend: 0 }) ?? 0))

check('política zero: falta un valor → cuenta 0 (compat histórica)',
    evalExpr(ok('a + 5').ast, {}, { onMissing: 'zero' }) === 5)
check('política null: falta un valor → null',
    evalExpr(ok('a + 5').ast, {}, { onMissing: 'null' }) === null)
check('null explícito con política null → null',
    evalExpr(ok('a + 5').ast, { a: null }, { onMissing: 'null' }) === null)
check('null explícito con política zero → 0',
    evalExpr(ok('a + 5').ast, { a: null }, { onMissing: 'zero' }) === 5)
check('el null se propaga por la multiplicación',
    evalExpr(ok('a * 0').ast, { a: null }, { onMissing: 'null' }) === null)
check('NaN se trata como ausente',
    evalExpr(ok('a + 1').ast, { a: NaN }, { onMissing: 'null' }) === null)

check('redondea a 2 decimales por defecto',
    evalExpr(ok('10 / 3').ast, {}) === 3.33)
check('decimals: 4', evalExpr(ok('10 / 3').ast, {}, { decimals: 4 }) === 3.3333)
check('decimals: 0', evalExpr(ok('10 / 3').ast, {}, { decimals: 0 }) === 3)
check('decimals: null no redondea',
    (evalExpr(ok('10 / 3').ast, {}, { decimals: null }) ?? 0) > 3.333333)

// ════════════════════════════════════════════════════════════
seccion('Validación contra un catálogo')
// ════════════════════════════════════════════════════════════

const conocidos = new Set(['ads.spend', 'leads.count'])
const known = (id: string) => conocidos.has(id)

const buena = ok('ads.spend / leads.count')
check('todos los ids conocidos → ok', validateRefs(buena, known).ok)

const conErrata = ok('ads.spen / leads.count')
const v = validateRefs(conErrata, known)
check('id desconocido → no ok', !v.ok)
check('dice EXACTAMENTE qué id está mal',
    !v.ok && JSON.stringify(v.unknown) === '["ads.spen"]')

// ════════════════════════════════════════════════════════════
seccion('Reescritura sobre el AST (migración de informes)')
// ════════════════════════════════════════════════════════════

// El riesgo que corrió la migración 045 con replace(layout::text, ...): un
// `replace` de 'spend' rompe 'meta_spend'. Sobre el AST no puede pasar.
const mapa: Record<string, string> = { spend: 'ads.spend', meta_spend: 'ads.spend_meta' }
const reescrito = rewriteRefs(ok('meta_spend / spend').ast, id => mapa[id] ?? id)
check('reescribe cada id por separado sin solaparse',
    serializeExpr(reescrito) === 'ads.spend_meta / ads.spend',
    serializeExpr(reescrito))

check('un id no mapeado se queda igual',
    serializeExpr(rewriteRefs(ok('otro + 1').ast, id => mapa[id] ?? id)) === 'otro + 1')

// ════════════════════════════════════════════════════════════
seccion('Serialización: ida y vuelta preserva el valor')
// ════════════════════════════════════════════════════════════

const casos = [
    'a + b',
    'a - b - c',
    'a - (b - c)',
    'a / b / c',
    'a / (b * c)',
    '(a + b) * c',
    'a + b * c',
    '-a + b',
    'a * -b',
    '2 * (3 + 4) / 7',
]
const vals = { a: 12, b: 3, c: 2 }
const rotos: string[] = []
for (const src of casos) {
    const p1 = ok(src)
    const txt = serializeExpr(p1.ast)
    const p2 = parseExpr(txt)
    if (isExprError(p2)) {
        rotos.push(`${src} → «${txt}» no parsea`)
        continue
    }
    const v1 = evalExpr(p1.ast, vals, { decimals: null })
    const v2 = evalExpr(p2.ast, vals, { decimals: null })
    if (v1 !== v2) rotos.push(`${src} → «${txt}»: ${v1} ≠ ${v2}`)
}
check('el texto serializado re-parsea al mismo valor', rotos.length === 0, rotos.join(' | '))

// El caso que justifica los paréntesis del lado derecho en `serializeExpr`.
check('a - (b - c) no se serializa como a - b - c',
    serializeExpr(ok('a - (b - c)').ast) === 'a - (b - c)',
    serializeExpr(ok('a - (b - c)').ast))
check('a / (b * c) conserva el paréntesis',
    serializeExpr(ok('a / (b * c)').ast) === 'a / (b * c)',
    serializeExpr(ok('a / (b * c)').ast))

// ════════════════════════════════════════════════════════════
seccion('Paridad con evaluateExpression (comportamiento histórico)')
// ════════════════════════════════════════════════════════════

// La fachada nueva debe dar exactamente lo mismo que el evaluador viejo para
// las expresiones que hoy están guardadas en bi_reports.
function nuevoEvaluate(expr: string, values: Record<string, number>): number | null {
    const p = parseExpr(expr)
    if (isExprError(p)) return null
    return evalExpr(p.ast, values, { onMissing: 'zero', decimals: 2 })
}

const paridad: Array<[string, Record<string, number>, number | null]> = [
    ['revenue / leads_count', { revenue: 1000, leads_count: 40 }, 25],
    ['revenue / leads_count', { revenue: 1000, leads_count: 0 }, null],
    ['spend / (leads_count + sales_count)', { spend: 100, leads_count: 3, sales_count: 1 }, 25],
    ['falta_este + 10', {}, 10],
    ['10 / 3', {}, 3.33],
]
for (const [expr, vals2, esperado] of paridad) {
    check(`«${expr}» → ${esperado}`, nuevoEvaluate(expr, vals2) === esperado,
        String(nuevoEvaluate(expr, vals2)))
}

// ════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
process.exit(fallos === 0 ? 0 : 1)
