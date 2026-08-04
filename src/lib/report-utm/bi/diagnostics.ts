// Diagnóstico de una consulta del BI: qué NO se pudo medir y por qué.
//
// ── Por qué esto es lo más valioso del rebuild ───────────────────────────
// El modo de fallo dominante del módulo es el cero silencioso. La causa más
// cara: `report_utm.clientes.public_cliente_id` es NULL y entonces el gasto,
// GA4, Hotmart, las conversiones offline y los campos de Sheet devuelven 0
// —media plataforma— sin que NADA en el constructor de informes lo diga. Se
// comprobó en producción: el cliente «Peiurba», sin enlace, arroja
// `spend: 0` en todos los casos del arnés de línea base.
//
// Este módulo NO cambia ningún número: solo explica los que ya salen. Por eso
// puede entrar sin mover el golden file, y por eso puede ir delante del
// refactor del motor en vez de detrás.
//
// El invariante que persigue está ya escrito en `lib/fx.ts`, a propósito de las
// tasas de cambio: «quien llama debe CONTAR el importe como no convertido y
// alertar, NUNCA sumarlo como cero».

import type { SkipReason } from './registry-types'
import type { ResolvedRegistry } from './registry'
import { BASE_REGISTRY } from './registry'
import { buildPlan } from './plan'
import type { PlanContext } from './plan'
import { migrateMeasureId, migrateDimensionId } from './legacy-tokens'

/** Estadística de lectura por fuente. Sirve para detectar truncamientos. */
export interface SourceStat {
    rowsRead: number
    /** Se leyeron tantas filas como el tope: puede faltar información. */
    truncated: boolean
}

export interface QueryDiagnostics {
    /**
     * Campo (en su nombre HISTÓRICO, el que el widget conoce) → por qué no se
     * pudo medir. El widget pinta «—» con esta explicación en vez de un 0.
     */
    unavailable: Record<string, SkipReason>
    /** Fuentes que quedaron fuera, con el motivo. */
    skipped: Array<{ sourceId: string; sourceLabel: string; reason: SkipReason }>
    /**
     * `false` si falta `public_cliente_id`. Es la bandera que el canvas usa para
     * mostrar un aviso con enlace a la ficha del cliente.
     */
    hasPublicLink: boolean
    /** Estadísticas por fuente, cuando el lector las aporta. */
    sources?: Record<string, SourceStat>
}

/** Lo que hace falta saber del cliente para diagnosticar. Lo resuelve el motor. */
export interface DiagnosticsInput {
    /** Métricas pedidas, en nombres históricos (`spend`, `cpl`, `sheetagg:…`). */
    metrics: string[]
    /** Dimensión pedida, en nombre histórico (`utm_campaign`, `none`, …). */
    dimension?: string | null
    dimension2?: string | null
    /** Campos calculados del informe y fórmulas de widget. */
    calculated?: Array<{ name: string; expression: string }>
    /** ¿El cliente de report_utm está enlazado al cliente público? */
    hasPublicLink: boolean
    /** Campos por los que se filtra y que el gasto no puede atribuir. */
    unattributableFilters?: string[]
    /** Fuentes sin integración configurada para este cliente. */
    notConfigured?: ReadonlySet<string>
}

/**
 * Traduce las expresiones de los campos calculados a ids canónicos.
 *
 * Va identificador por identificador y NO con un `replace` de texto: un
 * `replace('spend', 'ads.spend')` rompería `meta_spend`, que es exactamente el
 * riesgo que corrió la migración 045 al hacer `replace(layout::text, …)`.
 */
function canonicalizarCalculados(
    calculated: Array<{ name: string; expression: string }> | undefined
): Array<{ name: string; expression: string }> {
    // No hace falta reescribir la expresión: al planificador le basta con los
    // identificadores, y los resuelve él. Se pasan tal cual y `expandRequestedFields`
    // ignora los que no existan en el registro.
    return (calculated ?? []).map(c => ({
        name: c.name,
        expression: c.expression.replace(/[a-zA-Z_][a-zA-Z0-9_.]*/g, id => migrateMeasureId(id)),
    }))
}

/**
 * Calcula el diagnóstico de una consulta.
 *
 * Puro: no toca la base. El motor le pasa lo que ya sabe (el enlace de cliente,
 * los filtros), así que no añade ni una consulta.
 *
 * Las claves de `unavailable` se devuelven en el nombre HISTÓRICO de la métrica
 * porque es el que viaja en la petición y el que el widget tiene en las manos.
 */
export function computeDiagnostics(
    input: DiagnosticsInput,
    reg: ResolvedRegistry = BASE_REGISTRY
): QueryDiagnostics {
    const canonicalPorLegacy = new Map<string, string>()
    const fieldIds: string[] = []
    for (const m of input.metrics) {
        const id = migrateMeasureId(m)
        canonicalPorLegacy.set(id, m)
        fieldIds.push(id)
    }

    const ctx: PlanContext = {
        hasPublicLink: input.hasPublicLink,
        notConfigured: input.notConfigured,
        unattributableFilters: input.unattributableFilters?.length
            ? input.unattributableFilters
            : undefined,
    }

    const plan = buildPlan(reg, {
        fieldIds,
        dimensionId: input.dimension ? migrateDimensionId(input.dimension) : null,
        dimension2Id: input.dimension2 ? migrateDimensionId(input.dimension2) : null,
        calculated: canonicalizarCalculados(input.calculated),
    }, ctx)

    // Se devuelve con el nombre que el widget conoce; si la métrica es dinámica
    // o calculada y no tiene nombre histórico, se usa el id canónico.
    const unavailable: Record<string, SkipReason> = {}
    for (const [canonical, reason] of Object.entries(plan.unavailable)) {
        unavailable[canonicalPorLegacy.get(canonical) ?? canonical] = reason
    }

    return {
        unavailable,
        skipped: plan.skipped.map(s => ({
            sourceId: s.sourceId,
            sourceLabel: reg.source(s.sourceId)?.label ?? s.sourceId,
            reason: s.reason,
        })),
        hasPublicLink: input.hasPublicLink,
    }
}

/**
 * Texto para el usuario de un motivo. Vive junto al tipo para que no puedan
 * desincronizarse, y en español porque va directo a la UI (incluida la que ve
 * el cliente final en un enlace compartido).
 */
export function explainSkipReason(reason: SkipReason, sourceLabel?: string): string {
    const fuente = sourceLabel ? `«${sourceLabel}»` : 'esta fuente'
    switch (reason.kind) {
        case 'no_public_link':
            return `Este cliente de Report-UTM no está enlazado con su cliente de Reporting, ` +
                `así que ${fuente} no se puede leer. Se arregla en la ficha del cliente.`
        case 'not_configured':
            return `El cliente no tiene ${fuente} configurada todavía.`
        case 'unattributable_filter':
            return `El gasto de anuncios no se puede repartir por el filtro aplicado ` +
                `(${reason.fields.join(', ')}), porque las métricas de campaña no ` +
                `guardan ese dato. Los leads y las ventas sí quedan filtrados.`
        case 'grain_mismatch':
            return `${fuente[0].toUpperCase()}${fuente.slice(1)} no se desglosa por esta ` +
                `dimensión: su dato está agregado a un nivel que no incluye ese detalle. ` +
                `Prueba agrupando por Fecha o por Campaña.`
        case 'no_data_in_range':
            return `No hay datos de ${fuente} en el rango elegido.`
    }
}

/** ¿Hay algo que explicar? Evita renderizar avisos vacíos. */
export function hasDiagnostics(d: QueryDiagnostics | undefined): boolean {
    if (!d) return false
    return Object.keys(d.unavailable).length > 0 || d.skipped.length > 0
}

/**
 * Versión del diagnóstico apta para un enlace compartido con el cliente.
 *
 * `no_public_link` es plomería interna de la agencia: al cliente no le dice nada
 * y además revela cómo está montado el sistema por dentro. Se traduce a
 * «no configurado», que es lo que significa para él. El resto de motivos sí son
 * información legítima: explican por qué una celda está vacía.
 */
export function sanitizeForClient(d: QueryDiagnostics | undefined): QueryDiagnostics | undefined {
    if (!d) return undefined
    const neutralizar = (r: SkipReason): SkipReason =>
        r.kind === 'no_public_link' ? { kind: 'not_configured' } : r

    return {
        unavailable: Object.fromEntries(
            Object.entries(d.unavailable).map(([k, v]) => [k, neutralizar(v)])
        ),
        skipped: d.skipped.map(s => ({ ...s, reason: neutralizar(s.reason) })),
        // Se omite a propósito: el estado del enlace es asunto interno.
        hasPublicLink: true,
    }
}
