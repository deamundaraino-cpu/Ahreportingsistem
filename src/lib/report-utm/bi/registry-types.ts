// Tipos del registro de fuentes de datos del BI. SOLO tipos y constantes de
// tipo: este archivo no importa nada, ni siquiera de este módulo.
//
// ── Qué problema resuelve ────────────────────────────────────────────────
// Hoy la identidad de una métrica está repartida en ~10 estructuras que hay
// que sincronizar a mano: la unión `BiMetric`, `METRIC_META`, uno de los seis
// arrays (`AD_JSONB_METRICS`, `AD_SCALAR_METRICS`, `MANUAL_JSONB_METRICS`,
// `AD_RATE_METRICS`, `OFFLINE_METRICS`, `SUBS_METRICS`), `ADDITIVE_METRICS`,
// `PIVOT_METRICS`, `FUNNEL_STAGE_METRICS`, `RECOMMENDED_METRICS`,
// `LOWER_IS_BETTER`, `METRIC_GLOSSARY`, la lista `requires([...])` del motor, la
// línea `if (metrics.includes(...))` de `mergeResults`, el bloque `baseValues`,
// y el `switch` de `bi-availability.ts`. Nada de eso lo comprueba el compilador.
//
// Aquí una métrica se declara UNA vez, dentro de su fuente, y todo lo demás se
// deriva. En particular `breakdown` —hoy escrito a mano 72 veces— sale de
// `grain` ∩ `joinAxes`, que es lo que realmente lo determina.

/**
 * De qué columna de cliente cuelga una fuente.
 *
 * Explícito a propósito: los informes se guardan con un `report_utm.clientes.id`,
 * pero el gasto, GA4, Hotmart, offline y los Sheets cuelgan de
 * `public.clientes.id`, y el puente es `report_utm.clientes.public_cliente_id`.
 * Si ese puente es NULL, hoy media plataforma devuelve 0 EN SILENCIO. Al
 * declararlo, el motor puede reportar la causa en vez de emitir ceros.
 */
export type ClientKey =
    | { scope: 'report_utm' }
    /** Necesita `public_cliente_id`. NULL ⇒ la fuente NO está disponible. */
    | { scope: 'public'; via: 'public_cliente_id' }

/**
 * Eje semántico por el que dos fuentes pueden cruzarse.
 *
 * No es un nombre de columna: `campaign` es "utm_campaign resuelto contra el
 * nombre real de la campaña" en leads y `entidad_nombre` en el gasto. Lo que
 * comparten es el EJE, y por eso se pueden unir.
 */
export type JoinAxis =
    | 'date'
    | 'platform'
    /** Entidades de publicidad, resueltas por la cascada de `campaign-resolver`. */
    | 'campaign' | 'adset' | 'ad'
    /** Cualquier columna de `lead_events` (ip_country, form_name, utm_*…). */
    | 'lead_column'
    /** Columnas exclusivas de `sales_events` (product_name, transaction_type…). */
    | 'sales_column'
    /** Clave de `lead_events.raw_fields`, cruda o agrupada por `lead_campos`. */
    | 'lead_raw'
    /** Bucket de un campo de Sheet (`sheet_campo_valores_diarios.valor`). */
    | 'sheet_value'

export type PhysicalLocation =
    | { kind: 'table'; schema: 'public' | 'report_utm'; table: string }
    | { kind: 'jsonb'; schema: 'public' | 'report_utm'; table: string; column: string }

/**
 * Grano de la fuente.
 *
 *  - `row`      una fila por hecho individual (un lead, una venta). Es lo único
 *               que se puede contar y lo único que puede ser eje de un pivot.
 *  - `daily`    preagregada por día (`metricas_diarias`, offline, campos de
 *               Sheet, `ads_daily`).
 *  - `snapshot` una foto puntual sin eje temporal (suscripciones). Solo tiene
 *               sentido en el total del período.
 */
export type GrainKind = 'row' | 'daily' | 'snapshot'

export type Agg =
    | 'sum' | 'avg' | 'weighted_avg' | 'min' | 'max' | 'count' | 'count_distinct' | 'last'

export type Fmt = 'number' | 'currency' | 'percent' | 'ratio' | 'text'

/**
 * Grupo de presentación en el selector del editor.
 *
 * Es SOLO cosmético. La versión anterior (`MetricGroup`) mezclaba presentación
 * con semántica —y el editor la usaba para decidir avisos, así que avisaba en
 * falso sobre 56 de 72 métricas—. Lo semántico vive ahora en `source`, `grain`
 * y `joinAxes`.
 */
export type FieldGroup =
    | 'leads' | 'ventas' | 'inversion' | 'rendimiento'
    | 'campana' | 'ga4' | 'hotmart' | 'offline' | 'subs' | 'manual'
    | 'formulario' | 'sheet'

/** Origen de un campo descubierto por cliente en tiempo de ejecución. */
export type DynamicOrigin =
    | 'raw_field'      // clave cruda de lead_events.raw_fields
    | 'lead_campo'     // report_utm.lead_campos (claves unificadas + buckets)
    | 'sheet_campo'    // public.sheet_campos
    | 'sheet_vista'    // public.sheet_campo_vistas
    | 'offline_custom' // conversiones_offline_diarias.custom_fields

export interface DynamicRef {
    origin: DynamicOrigin
    /** La clave estable del catálogo del cliente. */
    clave: string
    /** Agregación elegida, para los campos que la llevan en el token. */
    agg?: Agg
}

export interface MeasureField {
    kind: 'measure'
    /** Id canónico `<fuente>.<campo>`. Inmutable: es lo que se guarda en los informes. */
    id: string
    label: string
    /**
     * Explicación en lenguaje de cliente. Obligatoria: sustituye al
     * `METRIC_GLOSSARY` opcional, donde 30 de 72 métricas caían en el texto
     * genérico de su grupo.
     */
    help: string
    format: Fmt
    group: FieldGroup
    agg: Agg
    /** Columna física, o clave dentro del JSONB de la fuente. Ausente si es derivada. */
    column?: string
    /** Para `weighted_avg`: id del campo que hace de denominador (el peso). */
    weightBy?: string
    /** Medida derivada. Puede referenciar campos de OTRAS fuentes. */
    formula?: string
    /**
     * Denominadores que deben ser > 0 para que la medida tenga valor; si no,
     * `null`. Es el ÚNICO sitio donde se decide el null de CPL/CPA/ROAS, que
     * hoy está implementado dos veces con resultados distintos: `mergeResults`
     * da `null` y el bloque `baseValues` da `0`, así que un scorecard muestra
     * "—" mientras una fórmula que referencia lo mismo calcula con 0.
     */
    nullUnless?: string[]
    /**
     * Cuenta entidades ÚNICAS: sumarla entre filas cuenta doble a quien aparece
     * en varias (`reach` = personas alcanzadas).
     */
    dedup?: boolean
    /** Posición en el embudo, si sirve como etapa. Menor = más arriba. */
    funnelStage?: number
    /** Se muestra antes de "Ver todas". */
    recommended?: boolean
    /** `down` = bajar es mejorar (costes, rebote, frecuencia). */
    direction?: 'up' | 'down'
    /** Meta del cliente contra la que se evalúa (`ClienteGoals`). */
    goal?: 'cpl_max' | 'cpa_max' | 'roas_min' | 'leads_target' | 'budget'
    /**
     * Medidas que MIDEN LO MISMO desde fuentes distintas y por tanto se solapan:
     * sumarlas cuenta doble. Versión legible por máquina del problema
     * `leads_count` / `leads_form` / `offline_leads`, que hoy solo se advierte
     * en prosa dentro de la etiqueta.
     */
    conflictsWith?: string[]
    dynamic?: DynamicRef
}

export interface DimensionField {
    kind: 'dimension'
    id: string
    label: string
    axis: JoinAxis
    group: FieldGroup
    column?: string
    /** Resolución necesaria para producir la clave de agrupación. */
    resolve?: 'entity' | 'entity_raw' | 'raw_field' | 'lead_campo' | 'sheet_value' | 'date_trunc'
    /** Se ofrece como filtro pero no como agrupación (correos, ids…). */
    highCardinality?: boolean
    /** No se lista en el selector (alias histórico). */
    hidden?: boolean
    dynamic?: DynamicRef
}

export type Field = MeasureField | DimensionField

export interface DataSource {
    id: string
    label: string
    location: PhysicalLocation
    clientKey: ClientKey
    grainKind: GrainKind
    /** Qué hace única una fila física. Documentación Y contrato del join. */
    grain: string[]
    /** Ejes por los que esta fuente puede emitir una clave. ES la regla de breakdown. */
    joinAxes: JoinAxis[]
    /** Columna de fecha para recortar por rango. Ausente = snapshot. */
    dateColumn?: string
    /** `timestamptz` necesita convertir a día local; `date` ya viene en local. */
    dateType?: 'date' | 'timestamptz'
    fields: Field[]
    /** Cargador de los campos por cliente que se añaden a esta fuente. */
    dynamicLoader?: DynamicOrigin[]
}

/** Por qué una fuente quedó fuera del plan de consulta. Se reporta, no se calla. */
export type SkipReason =
    /** `public_cliente_id` es NULL: el informe no puede ver esta fuente. */
    | { kind: 'no_public_link' }
    /** La fuente no se desglosa por la dimensión pedida. */
    | { kind: 'grain_mismatch'; axis: JoinAxis | null }
    /** Hay un filtro que esta fuente no puede honrar (país, formulario, campo…). */
    | { kind: 'unattributable_filter'; fields: string[] }
    /** El cliente no tiene esta integración configurada. */
    | { kind: 'not_configured' }
    /** No hay datos en el rango. */
    | { kind: 'no_data_in_range' }
