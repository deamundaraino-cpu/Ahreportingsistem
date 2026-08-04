// Cálculo de las medidas derivadas. UN solo sitio.
//
// ── El bug que cierra ────────────────────────────────────────────────────
// Hoy cada ratio está implementado DOS veces en `bi-query.ts`, con nulos
// distintos:
//
//   mergeResults  → hotmart_roas = spend > 0 && revenue > 0 ? … : null
//   baseValues    → hotmart_roas = spend > 0 ? round2(revenue / spend) : 0
//
// El segundo bloque es el que alimenta los campos calculados. Resultado: un
// scorecard sobre `hotmart_roas` muestra "—" mientras una fórmula que
// referencia esa misma métrica calcula con 0. Lo mismo pasa con
// cpl/cpa/roas/cpc/cpm/ctr/frequency.
//
// Aquí se calcula una vez, con `nullUnless` como única regla, y los campos
// calculados leen el MISMO valor. Por construcción no pueden divergir.
//
// Client-safe: solo `expr.ts` y el registro.

import type { MeasureField } from './registry-types'
import type { ResolvedRegistry } from './registry'
import { directDeps } from './registry'
import { parseExpr, isExprError, evalExpr } from './expr'
import type { Node } from './expr'

/** Valores de una fila, por id canónico. `null` = medido y desconocido. */
export type RowValues = Record<string, number | null>

/**
 * Ordena las medidas derivadas para que cada una se calcule después de sus
 * dependencias (orden topológico).
 *
 * Hace falta porque las derivadas se apoyan unas en otras:
 * `cuenta.hotmart_roas` depende de `cuenta.hotmart_revenue_calc`, que a su vez
 * es una suma de tres columnas. Calcularlas en el orden de declaración daría
 * null en la primera pasada.
 */
export function orderDerived(reg: ResolvedRegistry, ids: string[]): MeasureField[] {
    const out: MeasureField[] = []
    const done = new Set<string>()
    // Marca de ciclo: sin esto una fórmula que se referencia a sí misma colgaría.
    const visiting = new Set<string>()

    const visit = (id: string) => {
        if (done.has(id) || visiting.has(id)) return
        const f = reg.measure(id)
        if (!f?.formula) return          // medida física: no hay nada que ordenar
        visiting.add(id)
        for (const dep of directDeps(reg, f)) visit(dep)
        visiting.delete(id)
        done.add(id)
        out.push(f)
    }

    for (const id of ids) visit(id)
    return out
}

/** AST ya parseado de una medida derivada, más su guarda de nulos. */
interface Compiled {
    field: MeasureField
    ast: Node
    nullUnless: string[]
}

/**
 * Precompila las fórmulas. Se hace una vez por consulta, no una por fila: en una
 * tabla de 500 filas × 6 ratios eso son 3.000 parseos evitados.
 */
export function compileDerived(reg: ResolvedRegistry, ids: string[]): Compiled[] {
    const out: Compiled[] = []
    for (const f of orderDerived(reg, ids)) {
        const p = parseExpr(f.formula!)
        // Una fórmula mal formada en el catálogo es un bug nuestro, y el script
        // de verificación lo caza antes de llegar aquí. Se omite en vez de
        // reventar la consulta entera del cliente.
        if (isExprError(p)) continue
        out.push({ field: f, ast: p.ast, nullUnless: f.nullUnless ?? [] })
    }
    return out
}

/**
 * Escribe las medidas derivadas en la fila, en su sitio.
 *
 * Reglas, en este orden:
 *
 *  1. `nullUnless` — si algún denominador declarado falta o es 0, el resultado
 *     es `null`. Es lo que evita que un cliente sin Hotmart vea "ROAS 0" y
 *     "ROI −100%", que se lee como "se perdió todo lo invertido".
 *  2. `onMissing: 'null'` — un operando ausente NO cuenta como 0. Es la
 *     doctrina de `lib/fx.ts`: cero ≠ desconocido.
 *  3. División por cero → `null`, nunca Infinity.
 */
export function applyDerived(compiled: Compiled[], row: RowValues): void {
    for (const c of compiled) {
        const bloqueado = c.nullUnless.some(dep => {
            const v = row[dep]
            return v === null || v === undefined || !Number.isFinite(v) || v === 0
        })
        row[c.field.id] = bloqueado
            ? null
            : evalExpr(c.ast, row, { onMissing: 'null', decimals: 2 })
    }
}

/**
 * Calcula los campos calculados del informe y las fórmulas de widget.
 *
 * Se ejecuta DESPUÉS de `applyDerived` y sobre la MISMA fila, así que una
 * fórmula que referencia `roas` recibe exactamente el valor que muestra el
 * scorecard —incluido el null—. Eso es lo que hoy no ocurre.
 *
 * `onMissing` se mantiene en `'zero'` a propósito para los campos calculados del
 * usuario: es el comportamiento con el que se escribieron los informes que ya
 * existen, y cambiarlo movería sus números sin avisar. Los nulos de las
 * derivadas SÍ se propagan, porque un null explícito no es un valor ausente.
 */
export interface CalcSpec {
    name: string
    expression: string
    decimals?: number | null
}

export function applyCalculated(
    specs: CalcSpec[],
    row: RowValues,
    opts: { onMissing?: 'zero' | 'null' } = {}
): void {
    for (const spec of specs) {
        const p = parseExpr(spec.expression)
        if (isExprError(p)) {
            row[spec.name] = null
            continue
        }
        // Un null explícito de una derivada se respeta; un identificador que no
        // existe en la fila sigue contando 0 (compat).
        const hayNullExplicito = p.refs.some(r => row[r] === null)
        row[spec.name] = hayNullExplicito
            ? null
            : evalExpr(p.ast, row, {
                onMissing: opts.onMissing ?? 'zero',
                decimals: spec.decimals === undefined ? 2 : spec.decimals,
            })
    }
}

/** Igual que `applyCalculated` pero precompilando, para muchas filas. */
export function compileCalculated(specs: CalcSpec[]): Array<{ spec: CalcSpec; ast: Node; refs: string[] } | null> {
    return specs.map(spec => {
        const p = parseExpr(spec.expression)
        return isExprError(p) ? null : { spec, ast: p.ast, refs: p.refs }
    })
}

export function applyCompiledCalculated(
    compiled: Array<{ spec: CalcSpec; ast: Node; refs: string[] } | null>,
    row: RowValues,
    opts: { onMissing?: 'zero' | 'null' } = {}
): void {
    for (const c of compiled) {
        if (!c) continue
        const hayNullExplicito = c.refs.some(r => row[r] === null)
        row[c.spec.name] = hayNullExplicito
            ? null
            : evalExpr(c.ast, row, {
                onMissing: opts.onMissing ?? 'zero',
                decimals: c.spec.decimals === undefined ? 2 : c.spec.decimals,
            })
    }
}
