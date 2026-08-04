// Planificador de consultas: campos pedidos → qué fuentes leer y por qué eje.
//
// ── Qué sustituye ────────────────────────────────────────────────────────
// Hoy `runBiQuery` decide qué fuentes consultar con SEIS compuertas booleanas
// construidas a partir de listas literales de nombres de métrica, p. ej.:
//
//   const needsAds = !isFieldDimQuery && !isSheetDimQuery && requires([
//       'spend','meta_spend','tiktok_spend','cpl','cpa','roas','clicks',
//       'impressions','cpc','cpm','frequency','ctr',
//       ...AD_JSONB_METRICS, ...AD_SCALAR_METRICS, ...AD_RATE_METRICS, …
//   ])
//
// `cpl` aparece a la vez en `needsLeads` y en `needsAds` porque es un ratio
// entre fuentes: la relación está codificada por REPETICIÓN, no declarada. Y
// añadir una métrica obliga a recordar cuál de las seis listas tocar.
//
// ── Lo que cambia de fondo ───────────────────────────────────────────────
// Cuando una fuente no puede responder, hoy simplemente se cae del plan y sus
// métricas salen 0. Aquí se cae CON UN MOTIVO adjunto (`SkipReason`), que llega
// hasta el widget. Un 0 vuelve a significar "medimos y salió cero"; todo lo
// demás es `null` con explicación.
//
// Client-safe: solo tipos y el registro.

import type {
    DataSource, MeasureField, DimensionField, JoinAxis, SkipReason,
} from './registry-types'
import type { ResolvedRegistry } from './registry'
import { leafDeps, sourceCrossesAxis } from './registry'
import { refsOf } from './expr'

/** Lo que pide un widget, ya en ids canónicos. */
export interface BiFieldRequest {
    /** Medidas y dimensiones pedidas explícitamente. */
    fieldIds: string[]
    /** Dimensión de agrupación, o `null`/`'none'` para el total. */
    dimensionId?: string | null
    /** Dimensión secundaria (tabla dinámica). */
    dimension2Id?: string | null
    /** Campos calculados del informe y fórmulas de widget. */
    calculated?: Array<{ name: string; expression: string }>
}

/**
 * Contexto del cliente y de los filtros. Es lo que permite distinguir
 * "no hay datos" de "no se puede medir".
 */
export interface PlanContext {
    /**
     * ¿El cliente de report_utm está enlazado al cliente público?
     *
     * Si es `false`, TODA fuente con `clientKey.scope === 'public'` es
     * inalcanzable: gasto, GA4, Hotmart, offline y Sheet. Hoy eso devuelve
     * ceros y NADA en el constructor de informes lo dice.
     */
    hasPublicLink: boolean
    /** Fuentes que el cliente no tiene configuradas (sin integración). */
    notConfigured?: ReadonlySet<string>
    /**
     * Campos por los que se está filtrando y que el gasto no puede atribuir
     * (país, formulario, plugin, atribución, campo de formulario, campo de
     * Sheet). Recortan leads y ventas, pero no `metricas_diarias`.
     */
    unattributableFilters?: string[]
}

/** Una fuente a consultar, con el eje por el que debe emitir su clave. */
export interface SourceRequest {
    source: DataSource
    /** Medidas FÍSICAS que esta fuente debe leer (nunca derivadas). */
    measures: MeasureField[]
    /** Eje de la clave de agrupación. `null` = una sola fila "total". */
    keyAxis: JoinAxis | null
    /** La dimensión concreta, cuando la fuente la resuelve ella misma. */
    keyDimension?: DimensionField
}

export interface QueryPlan {
    requests: SourceRequest[]
    /** Derivadas a calcular tras el join, en orden de dependencia. */
    derivedIds: string[]
    /** Fuentes descartadas, con el motivo. */
    skipped: Array<{ sourceId: string; reason: SkipReason }>
    /** Campo → por qué no se puede medir. Alimenta los "—" con tooltip. */
    unavailable: Record<string, SkipReason>
}

/**
 * Expande lo pedido a los ids que hay que resolver: las medidas explícitas, las
 * hojas de sus fórmulas, los pesos de los promedios ponderados y los
 * identificadores de los campos calculados.
 *
 * Los identificadores salen del AST (`refsOf`), filtrados contra el registro.
 * Antes se sacaban con un `match` de regex sobre el texto, así que en
 * `spend / dias` la palabra `dias` se tomaba por métrica y podía disparar la
 * consulta de una fuente entera para nada.
 */
export function expandRequestedFields(
    reg: ResolvedRegistry, req: BiFieldRequest
): { measures: string[]; derived: string[]; leaves: string[] } {
    const explicit = new Set<string>()

    for (const id of req.fieldIds) {
        if (reg.measure(id)) explicit.add(id)
    }
    for (const calc of req.calculated ?? []) {
        for (const ref of refsOf(calc.expression)) {
            if (reg.measure(ref)) explicit.add(ref)
        }
    }

    const derived: string[] = []
    const leaves = new Set<string>()

    for (const id of explicit) {
        const f = reg.measure(id)!
        if (f.formula) {
            derived.push(id)
            for (const leaf of leafDeps(reg, id)) leaves.add(leaf)
            // Las derivadas intermedias también hay que calcularlas.
            for (const dep of leafDeps(reg, id)) {
                const m = reg.measure(dep)
                if (m?.weightBy) leaves.add(m.weightBy)
            }
        } else {
            leaves.add(id)
            if (f.weightBy) leaves.add(f.weightBy)
        }
    }

    // Derivadas intermedias que no se pidieron pero hacen falta: p. ej.
    // `cuenta.hotmart_revenue_calc` bajo `cuenta.hotmart_roas`.
    for (const id of [...explicit]) {
        const f = reg.measure(id)
        if (!f?.formula) continue
        for (const ref of refsOf(f.formula)) {
            const m = reg.measure(ref)
            if (m?.formula && !derived.includes(ref)) derived.push(ref)
        }
    }

    return { measures: [...explicit], derived, leaves: [...leaves] }
}

/**
 * ¿Por qué esta fuente no puede participar? `null` si sí puede.
 *
 * El orden importa: se reporta la causa más profunda primero. Si falta el
 * enlace de cliente, da igual que además el grano no cruce — lo que hay que
 * arreglar es el enlace.
 */
export function skipReasonFor(
    src: DataSource,
    ctx: PlanContext,
    dim: DimensionField | null
): SkipReason | null {
    if (src.clientKey.scope === 'public' && !ctx.hasPublicLink) {
        return { kind: 'no_public_link' }
    }
    if (ctx.notConfigured?.has(src.id)) {
        return { kind: 'not_configured' }
    }
    // Un filtro no atribuible anula el gasto y sus derivados, pero no los leads.
    // La regla física: solo afecta a las fuentes que NO pueden filtrar por
    // columnas de lead.
    const filtros = ctx.unattributableFilters ?? []
    if (filtros.length && !src.joinAxes.includes('lead_column')) {
        return { kind: 'unattributable_filter', fields: filtros }
    }
    if (dim && !sourceCrossesAxis(src, dim.axis)) {
        return { kind: 'grain_mismatch', axis: dim.axis }
    }
    return null
}

/**
 * Construye el plan.
 *
 * El eje de la clave sale de la dimensión: cada fuente emite su clave por el
 * eje compartido, y el join las une por ahí. Eso es lo que sustituye a
 * `mergeResults` con sus 12 parámetros posicionales.
 */
export function buildPlan(
    reg: ResolvedRegistry, req: BiFieldRequest, ctx: PlanContext
): QueryPlan {
    const dimId = !req.dimensionId || req.dimensionId === 'none' ? null : req.dimensionId
    const dim = dimId ? (reg.dimensionField(dimId) ?? null) : null

    const { derived, leaves } = expandRequestedFields(reg, req)

    // Agrupa las medidas físicas por fuente.
    const porFuente = new Map<string, MeasureField[]>()
    for (const id of leaves) {
        const s = reg.sourceOf(id)
        const m = reg.measure(id)
        if (!s || !m) continue
        const lista = porFuente.get(s.id) ?? []
        lista.push(m)
        porFuente.set(s.id, lista)
    }

    const requests: SourceRequest[] = []
    const skipped: QueryPlan['skipped'] = []
    const unavailable: Record<string, SkipReason> = {}

    for (const [sourceId, measures] of porFuente) {
        const src = reg.source(sourceId)!
        const reason = skipReasonFor(src, ctx, dim)
        if (reason) {
            skipped.push({ sourceId, reason })
            // Cada medida de esa fuente queda marcada con el motivo: es lo que
            // el widget pinta como "—" con su explicación en vez de un 0.
            for (const m of measures) unavailable[m.id] = reason
            continue
        }
        requests.push({
            source: src,
            measures,
            keyAxis: dim ? dim.axis : null,
            keyDimension: dim ?? undefined,
        })
    }

    // Una derivada cuyo operando no se pudo medir hereda el motivo. Así `cpl`
    // explica "falta enlazar el cliente" en vez de mostrar 0.
    for (const id of derived) {
        for (const leaf of leafDeps(reg, id)) {
            if (unavailable[leaf]) {
                unavailable[id] = unavailable[leaf]
                break
            }
        }
    }

    return { requests, derivedIds: derived, skipped, unavailable }
}

/** Las fuentes del plan, por id. Útil para los lectores y los tests. */
export function planSourceIds(plan: QueryPlan): string[] {
    return plan.requests.map(r => r.source.id).sort()
}
