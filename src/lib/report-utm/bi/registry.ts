// Ensamblado del registro y las funciones de derivación.
//
// Todo lo que antes eran conjuntos sincronizados a mano —`ADDITIVE_METRICS`,
// `PIVOT_METRICS`, `FUNNEL_STAGE_METRICS`, `RECOMMENDED_METRICS`,
// `LOWER_IS_BETTER`, `METRIC_GLOSSARY` y los 72 `breakdown:`— se calcula aquí a
// partir de la declaración de cada campo dentro de su fuente.
//
// Client-safe: solo importa tipos y `bi/expr.ts`, que es puro.

import type {
    DataSource, Field, MeasureField, DimensionField, JoinAxis, GrainKind,
} from './registry-types'
import { parseExpr, isExprError } from './expr'

import { LEADS_SOURCE } from './sources/leads'
import { SALES_SOURCE } from './sources/sales'
import { HOTMART_SOURCE } from './sources/hotmart'
import { ADS_SOURCE } from './sources/ads'
import { CUENTA_SOURCE } from './sources/cuenta'
import { OFFLINE_SOURCE } from './sources/offline'
import { SHEET_SOURCE } from './sources/sheet'
import { SUBS_SOURCE } from './sources/subs'

/**
 * Las fuentes fijas, en el orden en que se muestran en el editor.
 *
 * Son SEIS físicas más `sheet`. No son once: `field:`/`fieldagg:` y `leadfield:`
 * leen `lead_events.raw_fields` (así que son campos de `leads`) y `offfield:` lee
 * `conversiones_offline_diarias.custom_fields` (campos de `offline`). Ninguna de
 * esas tres tiene grano propio, y por eso no merece ser fuente.
 */
export const STATIC_SOURCES: readonly DataSource[] = [
    LEADS_SOURCE,
    SALES_SOURCE,
    // Va justo tras `sales` porque es su sucesora natural para Hotmart: misma
    // granularidad (una fila por venta) pero con el dinero ya normalizado a
    // dólares, la clasificación del embudo y los reembolsos.
    HOTMART_SOURCE,
    ADS_SOURCE,
    CUENTA_SOURCE,
    OFFLINE_SOURCE,
    SHEET_SOURCE,
    SUBS_SOURCE,
]

/**
 * Registro resuelto: las fuentes fijas más los campos que un cliente concreto
 * aporta. Se construye por petición; `resolveRegistry` (server) lo cachea.
 */
export interface ResolvedRegistry {
    sources: readonly DataSource[]
    /** Un campo por su id canónico. */
    field(id: string): Field | undefined
    measure(id: string): MeasureField | undefined
    dimensionField(id: string): DimensionField | undefined
    sourceOf(id: string): DataSource | undefined
    source(id: string): DataSource | undefined
    measures(): MeasureField[]
    dimensions(): DimensionField[]
    fields(): Field[]
}

/** Construye un registro resuelto a partir de una lista de fuentes. */
export function makeRegistry(sources: readonly DataSource[]): ResolvedRegistry {
    const byId = new Map<string, Field>()
    const srcOfField = new Map<string, DataSource>()
    const srcById = new Map<string, DataSource>()

    for (const s of sources) {
        srcById.set(s.id, s)
        for (const f of s.fields) {
            byId.set(f.id, f)
            srcOfField.set(f.id, s)
        }
    }

    return {
        sources,
        field: id => byId.get(id),
        measure: id => {
            const f = byId.get(id)
            return f?.kind === 'measure' ? f : undefined
        },
        dimensionField: id => {
            const f = byId.get(id)
            return f?.kind === 'dimension' ? f : undefined
        },
        sourceOf: id => srcOfField.get(id),
        source: id => srcById.get(id),
        measures: () => [...byId.values()].filter((f): f is MeasureField => f.kind === 'measure'),
        dimensions: () => [...byId.values()].filter((f): f is DimensionField => f.kind === 'dimension'),
        fields: () => [...byId.values()],
    }
}

/** El registro sin campos por cliente. Suficiente para el catálogo fijo. */
export const BASE_REGISTRY: ResolvedRegistry = makeRegistry(STATIC_SOURCES)

// ════════════════════════════════════════════════════════════════════════
// Derivación
// ════════════════════════════════════════════════════════════════════════

/**
 * Dependencias directas de una medida derivada, ya validadas contra el registro.
 *
 * Sale del AST (`refs`), no de un regex sobre el texto: en `spend / dias` el
 * regex tomaba `dias` por métrica y podía disparar la consulta de una fuente
 * entera para nada.
 */
export function directDeps(reg: ResolvedRegistry, f: MeasureField): string[] {
    if (!f.formula) return []
    const p = parseExpr(f.formula)
    if (isExprError(p)) return []
    return p.refs.filter(id => reg.field(id) !== undefined)
}

/**
 * Todas las medidas de las que depende, transitivamente y sin duplicados.
 * Incluye las intermedias derivadas, porque el motor las necesita calculadas.
 */
export function allDeps(reg: ResolvedRegistry, id: string, seen = new Set<string>()): string[] {
    const f = reg.measure(id)
    if (!f || seen.has(id)) return []
    seen.add(id)
    const out: string[] = []
    for (const dep of directDeps(reg, f)) {
        out.push(dep)
        out.push(...allDeps(reg, dep, seen))
    }
    return [...new Set(out)]
}

/**
 * Las medidas NO derivadas de las que depende: las que una fuente tiene que
 * leer físicamente. Es lo que alimenta el plan de consulta.
 */
export function leafDeps(reg: ResolvedRegistry, id: string): string[] {
    const f = reg.measure(id)
    if (!f) return []
    if (!f.formula) return [id]
    const out: string[] = []
    for (const dep of directDeps(reg, f)) out.push(...leafDeps(reg, dep))
    return [...new Set(out)]
}

/** Las fuentes que hay que consultar para resolver estos campos. */
export function sourcesFor(reg: ResolvedRegistry, fieldIds: string[]): DataSource[] {
    const ids = new Set<string>()
    for (const id of fieldIds) {
        const f = reg.field(id)
        if (!f) continue
        if (f.kind === 'measure' && f.formula) {
            for (const leaf of leafDeps(reg, id)) ids.add(leaf)
            // Un peso (`weightBy`) también hay que traerlo.
        } else {
            ids.add(id)
        }
        if (f.kind === 'measure' && f.weightBy) ids.add(f.weightBy)
    }
    // Los pesos de las hojas también cuentan.
    for (const id of [...ids]) {
        const m = reg.measure(id)
        if (m?.weightBy) ids.add(m.weightBy)
    }
    const out = new Map<string, DataSource>()
    for (const id of ids) {
        const s = reg.sourceOf(id)
        if (s) out.set(s.id, s)
    }
    return [...out.values()]
}

/**
 * ¿Esta fuente puede emitir una clave para este eje? ES la regla de desglose.
 *
 * Sustituye por completo a `MetricBreakdown` ('any'|'campaign'|'total'|'global'),
 * que era una codificación con pérdida de esto mismo escrita a mano 72 veces.
 */
export function sourceCrossesAxis(src: DataSource, axis: JoinAxis | null): boolean {
    // `null` = dimensión "Total": no hay nada que repartir, todo cruza.
    if (axis === null) return true
    return src.joinAxes.includes(axis)
}

/**
 * ¿Este campo se desglosa por esta dimensión, o caería en la fila total?
 *
 * Para una medida derivada, cruza solo si TODAS sus hojas cruzan: es lo que hace
 * que `cpl` (gasto ÷ leads) herede el límite del gasto, y que `hotmart_roas`
 * (cuenta ÷ gasto) herede el de `cuenta`, sin declararlo.
 */
export function fieldCrossesDimension(
    reg: ResolvedRegistry, fieldId: string, dimensionId: string | null
): boolean {
    if (dimensionId === null || dimensionId === 'none') return true
    const dim = reg.dimensionField(dimensionId)
    // Dimensión desconocida: no se bloquea nada (los tokens dinámicos tienen sus
    // propios avisos, más específicos).
    if (!dim) return true

    const f = reg.field(fieldId)
    if (!f) return true
    if (f.kind === 'dimension') return true

    const leaves = f.formula ? leafDeps(reg, fieldId) : [fieldId]
    if (!leaves.length) return true
    return leaves.every(leaf => {
        const s = reg.sourceOf(leaf)
        return s ? sourceCrossesAxis(s, dim.axis) : true
    })
}

/**
 * ¿La fila "Total" de una tabla puede sumar esta medida?
 *
 * Antes: el conjunto `ADDITIVE_METRICS`, construido a mano esparciendo cuatro
 * arrays y excluyendo `reach` a mano.
 */
export function isAdditive(f: MeasureField): boolean {
    if (f.dedup) return false                 // reach: personas únicas
    if (f.agg === 'sum' || f.agg === 'count') return true
    // Una derivada aditiva (suma de sumas) sí lo es; un ratio no.
    return false
}

/**
 * ¿Sirve como eje de una tabla dinámica (dimensión secundaria)?
 *
 * Antes: `PIVOT_METRICS = ['leads_count','sales_count','revenue']`. Solo el
 * grano de fila lo permite: el pivot agrupa filas, así que únicamente puede
 * contarlas o sumar una de sus columnas. Con una métrica preagregada devolvería
 * un conteo de filas disfrazado de gasto.
 */
export function isPivotable(reg: ResolvedRegistry, id: string): boolean {
    const f = reg.measure(id)
    if (!f || f.formula) return false
    return reg.sourceOf(id)?.grainKind === 'row'
}

/** Etapas válidas de un embudo, de arriba abajo. Antes: `FUNNEL_STAGE_METRICS`. */
export function funnelStages(reg: ResolvedRegistry): MeasureField[] {
    return reg.measures()
        .filter(f => f.funnelStage !== undefined)
        .sort((a, b) => a.funnelStage! - b.funnelStage!)
}

/** Las que el editor muestra antes de "Ver todas". Antes: `RECOMMENDED_METRICS`. */
export function recommendedMeasures(reg: ResolvedRegistry): MeasureField[] {
    return reg.measures().filter(f => f.recommended)
}

/** ¿Bajar es mejorar? Antes: el conjunto `LOWER_IS_BETTER`. */
export function isLowerBetterField(reg: ResolvedRegistry, id: string): boolean {
    return reg.measure(id)?.direction === 'down'
}

/**
 * Medidas ya elegidas que se solapan con esta: miden lo mismo desde otra fuente,
 * así que sumarlas cuenta doble. Alimenta el aviso del editor.
 */
export function conflictsAmong(reg: ResolvedRegistry, ids: string[]): Array<[string, string]> {
    const set = new Set(ids)
    const out: Array<[string, string]> = []
    for (const id of ids) {
        for (const other of reg.measure(id)?.conflictsWith ?? []) {
            if (set.has(other) && id < other) out.push([id, other])
        }
    }
    return out
}

// ════════════════════════════════════════════════════════════════════════
// Compatibilidad con el enum histórico de desglose
// ════════════════════════════════════════════════════════════════════════

/** El enum que usaba `METRIC_META.breakdown`. Se mantiene para la fachada. */
export type LegacyBreakdown = 'any' | 'campaign' | 'total' | 'global'

/**
 * Traduce los ejes de una fuente al enum histórico.
 *
 * Existe solo para que `scripts/verify-bi-registry.ts` pueda comparar el
 * catálogo derivado contra el escrito a mano, campo por campo. Es la prueba de
 * que la derivación no pierde información.
 */
export function legacyBreakdownOfSource(src: DataSource): LegacyBreakdown {
    if (!src.joinAxes.length) return 'global'
    // Grano de fila: se desglosa por cualquier columna suya.
    if (src.joinAxes.includes('lead_column') || src.joinAxes.includes('sales_column')) return 'any'
    if (src.joinAxes.includes('campaign')) return 'campaign'
    return 'total'
}

const BREAKDOWN_RANK: Record<LegacyBreakdown, number> = {
    any: 0, campaign: 1, total: 2, global: 3,
}

/**
 * Desglose de un campo en el enum histórico. Para una derivada, el MÁS
 * restrictivo de sus hojas: es lo que hace que `cpl` salga 'campaign' (gasto) y
 * `conversion_rate` salga 'any' (leads y ventas), tal como está escrito hoy a mano.
 */
export function legacyBreakdownOfField(reg: ResolvedRegistry, id: string): LegacyBreakdown {
    const f = reg.measure(id)
    if (!f) return 'any'
    const leaves = f.formula ? leafDeps(reg, id) : [id]
    let worst: LegacyBreakdown = 'any'
    for (const leaf of leaves) {
        const s = reg.sourceOf(leaf)
        if (!s) continue
        const b = legacyBreakdownOfSource(s)
        if (BREAKDOWN_RANK[b] > BREAKDOWN_RANK[worst]) worst = b
    }
    return worst
}

/** Utilidades de introspección para los scripts de verificación. */
export function grainKindOf(reg: ResolvedRegistry, id: string): GrainKind | undefined {
    return reg.sourceOf(id)?.grainKind
}
