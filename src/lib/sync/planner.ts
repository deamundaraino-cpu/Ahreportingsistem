/**
 * Planner: decide QUÉ jobs encolar y cuándo.
 *
 * Sustituye a los 9 crons de `vercel.json` (el plan Hobby solo admite 2). En vez
 * de nueve disparadores independientes, un único planner encola el plan del día
 * y el runner lo drena en el orden que marca la prioridad.
 */

import { enqueueJob, enqueueRange, type SyncJobTipo } from './queue'
import { colombiaToday, colombiaYesterday, COLOMBIA_UTC_OFFSET_MS } from '../date-utils'

/** Prioridades: menor = antes. El sync manual (1) siempre adelanta al cron. */
export const PRIORIDAD = {
    manual: 1,
    intradia: 3,
    diario: 5,
    cierre: 7,
} as const

export type PlanResult = { encolados: number; detalle: Record<string, number> }

/**
 * Plan diario completo: métricas de ayer y hoy para todos los clientes activos,
 * más los workers de Sheets, leads de Meta y la agregación UTM.
 *
 * Se encola ayer Y hoy a propósito: "ayer" ya cerró en Colombia y trae las
 * cifras definitivas; "hoy" da una foto parcial para que el dashboard no
 * aparezca vacío durante la jornada.
 */
export async function planDiario(db: any, opts?: { triggeredBy?: string }): Promise<PlanResult> {
    const triggeredBy = opts?.triggeredBy ?? 'planner'
    const hoy = colombiaToday()
    const ayer = colombiaYesterday()
    const detalle: Record<string, number> = {}

    const { data: clientes, error } = await db.from('clientes').select('id')
    if (error) throw new Error(`planDiario: ${error.message}`)

    let total = 0
    for (const c of (clientes ?? []) as Array<{ id: string }>) {
        const job = await enqueueJob(db, {
            tipo: 'metricas',
            clienteId: c.id,
            start: ayer,
            end: hoy,
            prioridad: PRIORIDAD.diario,
            triggeredBy,
        })
        if (job) total++
    }
    detalle.metricas = total

    // Estos tres iteran clientes internamente: un job global por tipo basta.
    // `sheets_leads` se retiró en la migración 059: su hoja pasó a sincronizarse
    // por `sheets_conversiones`, como el resto de Google Sheets.
    const globales: SyncJobTipo[] = ['sheets_conversiones', 'meta_leads', 'utm_aggregate']
    for (const tipo of globales) {
        const job = await enqueueJob(db, {
            tipo,
            start: ayer,
            end: hoy,
            prioridad: PRIORIDAD.diario,
            triggeredBy,
        })
        if (job) { total++; detalle[tipo] = 1 }
    }

    return { encolados: total, detalle }
}

/**
 * Refresco intradía: solo el día en curso, para todos los clientes.
 * Barato — Meta y TikTok se piden en una llamada por rango, y un solo día de
 * Hotmart/GA4 son pocas peticiones.
 */
export async function planIntradia(db: any, opts?: { triggeredBy?: string }): Promise<PlanResult> {
    const hoy = colombiaToday()
    const { data: clientes, error } = await db.from('clientes').select('id')
    if (error) throw new Error(`planIntradia: ${error.message}`)

    let total = 0
    for (const c of (clientes ?? []) as Array<{ id: string }>) {
        const job = await enqueueJob(db, {
            tipo: 'metricas',
            clienteId: c.id,
            start: hoy,
            end: hoy,
            prioridad: PRIORIDAD.intradia,
            triggeredBy: opts?.triggeredBy ?? 'intradia',
        })
        if (job) total++
    }
    return { encolados: total, detalle: { metricas: total } }
}

/**
 * Cierre mensual: re-descarga final del mes anterior con la ventana de
 * atribución completa y congelado del período.
 *
 * Se lanza el día 7 para dar margen a la reatribución de Meta (hasta 28 días
 * para conversiones, pero la mayor parte del ajuste ocurre en la primera
 * semana). `refresh_days: 35` fuerza a re-pedir todo el mes aunque las fechas ya
 * tuvieran datos.
 */
export async function planCierreMes(db: any, periodo?: string): Promise<PlanResult> {
    const hoy = colombiaToday()
    const ref = periodo ? new Date(`${periodo}T00:00:00Z`) : new Date(`${hoy}T00:00:00Z`)
    // Mes anterior al de referencia.
    const primerDiaMesAnterior = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - 1, 1))
    const ultimoDiaMesAnterior = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 0))
    const start = primerDiaMesAnterior.toISOString().slice(0, 10)
    const end = ultimoDiaMesAnterior.toISOString().slice(0, 10)

    const { data: clientes, error } = await db.from('clientes').select('id')
    if (error) throw new Error(`planCierreMes: ${error.message}`)

    let total = 0
    for (const c of (clientes ?? []) as Array<{ id: string }>) {
        // Primero la re-descarga forzada del mes...
        total += await enqueueRange(db, {
            tipo: 'metricas',
            clienteId: c.id,
            start,
            end,
            params: { force: true, refresh_days: 35 },
            prioridad: PRIORIDAD.cierre,
            triggeredBy: 'cierre_mes',
        })
        // ...y luego el congelado, que corre después por prioridad más baja.
        const job = await enqueueJob(db, {
            tipo: 'cierre_mes',
            clienteId: c.id,
            start,
            end,
            prioridad: PRIORIDAD.cierre + 1,
            triggeredBy: 'cierre_mes',
        })
        if (job) total++
    }

    return { encolados: total, detalle: { periodo: 1, rango: total } }
}

/**
 * Reconciliación: verifica que el gasto guardado de Meta cuadre con el real de
 * cada cuenta y repara los días que no.
 *
 * Existe porque el dashboard suma `meta_campaigns[]` filtrado por keyword, no la
 * columna `meta_spend`: un array truncado hace que un día muestre $0 aunque haya
 * habido gasto, y el worker nunca lo re-pide porque la fila "tiene datos". Los
 * 120 días por defecto cubren con margen la época del bug de paginación de Meta
 * (corregido el 2026-06-23).
 *
 * Cada job cuesta 1 fila por día a nivel de cuenta; solo se re-descargan los días
 * que realmente divergen.
 */
export async function planReconciliacion(
    db: any,
    opts?: { dias?: number; triggeredBy?: string },
): Promise<PlanResult> {
    const dias = opts?.dias ?? 120
    const hoy = colombiaToday()
    const start = new Date(Date.parse(`${hoy}T00:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10)

    const { data: clientes, error } = await db.from('clientes').select('id, config_api')
    if (error) throw new Error(`planReconciliacion: ${error.message}`)

    let total = 0
    for (const c of (clientes ?? []) as Array<{ id: string; config_api: any }>) {
        const cfg = c.config_api ?? {}
        const tieneMeta = (Array.isArray(cfg.meta_accounts) && cfg.meta_accounts.length > 0)
            || (!!cfg.meta_token && !!cfg.meta_account_id)
        if (!tieneMeta) continue

        const job = await enqueueJob(db, {
            tipo: 'reconciliar',
            clienteId: c.id,
            start,
            end: hoy,
            params: { dias },
            prioridad: PRIORIDAD.cierre,
            triggeredBy: opts?.triggeredBy ?? 'reconciliacion',
        })
        if (job) total++
    }

    return { encolados: total, detalle: { reconciliar: total } }
}

/**
 * Garantiza que el plan diario esté encolado en la franja horaria actual.
 *
 * El scheduler del VPS (`sync-worker/`) es el planner primario, pero es un único
 * punto de fallo: si el contenedor está caído, nadie llena la cola y los
 * drenadores de respaldo (Vercel Cron, GitHub Actions) encuentran `sync_jobs`
 * vacía. Esta función convierte a cualquier drenador en un planner de respaldo:
 * antes de drenar, comprueba si ya se encoló un plan en la franja vigente
 * (05:00 o 14:00 hora Colombia) y, si no, lo encola.
 *
 * Idempotencia en dos capas: (1) este guard temporal evita re-planificar una
 * franja ya cubierta aunque sus jobs ya estén `done` (el índice único solo
 * dedupe mientras están `pending|running`); (2) el índice único parcial de la
 * migración impide duplicar un job todavía pendiente si el VPS y un drenador
 * planifican a la vez.
 */
export async function ensurePlanDiario(
    db: any,
): Promise<{ ensured: boolean; encolados: number; franja: string }> {
    // "Ahora" en reloj de pared colombiano: desplazamos el instante UTC y luego
    // leemos sus componentes con getUTC* (Colombia = UTC-5 fijo, sin DST).
    const col = new Date(Date.now() - COLOMBIA_UTC_OFFSET_MS)
    const h = col.getUTCHours()
    const y = col.getUTCFullYear()
    const m = col.getUTCMonth()
    const d = col.getUTCDate()

    // Última franja programada ya pasada, en reloj colombiano.
    let franjaCol: Date
    let esManana: boolean
    if (h >= 14) {
        franjaCol = new Date(Date.UTC(y, m, d, 14, 0, 0))
        esManana = false
    } else if (h >= 5) {
        franjaCol = new Date(Date.UTC(y, m, d, 5, 0, 0))
        esManana = true
    } else {
        // Antes de las 05:00 COL la última franja fue la de las 14:00 de ayer.
        franjaCol = new Date(Date.UTC(y, m, d - 1, 14, 0, 0))
        esManana = false
    }

    // Colombia = UTC-5, así que el instante UTC real es la hora local + 5h.
    const franjaUtcIso = new Date(franjaCol.getTime() + COLOMBIA_UTC_OFFSET_MS).toISOString()

    const { data, error } = await db
        .from('sync_jobs')
        .select('id')
        .in('triggered_by', ['planner', 'planner:auto'])
        .eq('tipo', 'metricas')
        .gte('created_at', franjaUtcIso)
        .limit(1)
    if (error) throw new Error(`ensurePlanDiario: ${error.message}`)
    if (data && data.length > 0) return { ensured: false, encolados: 0, franja: franjaUtcIso }

    const res = await planDiario(db, { triggeredBy: 'planner:auto' })
    // La limpieza de historial se hace una vez al día, en la franja de la mañana.
    if (esManana) await limpiarHistorial(db)
    return { ensured: true, encolados: res.encolados, franja: franjaUtcIso }
}

/** Borra jobs y runs viejos. Llamar una vez al día desde el planner. */
export async function limpiarHistorial(db: any, dias = 30): Promise<void> {
    const corte = new Date(Date.now() - dias * 86_400_000).toISOString()
    await db.from('sync_jobs').delete().in('estado', ['done', 'cancelled']).lt('updated_at', corte)
    await db.from('sync_runs').delete().lt('started_at', corte)
    await purgarPixelEvents(db)
    await purgarAdsDaily(db)
}

/** Días que se conservan del nivel ANUNCIO en `ads_daily`. */
export const ADS_DAILY_NIVEL_AD_RETENCION_DIAS = 30

/**
 * Purga las filas de nivel ANUNCIO antiguas de `public.ads_daily`.
 *
 * Sin esto la tabla no cabe. El nivel anuncio es el 65% de las filas posibles
 * (111.800 de 171.666) y la base está en 368 MB contra el tope de 500 MB del
 * plan — la migración 061 existe porque llegó a 539 MB y hubo que soltar una
 * tabla y seis índices para recuperarla.
 *
 * Los niveles CAMPAÑA y CONJUNTO no se tocan nunca: son los ejes con los que se
 * agrupan los informes, incluidos los antiguos, y son baratos. El desglose por
 * anuncio de fechas viejas sigue disponible en el JSONB de `metricas_diarias`.
 *
 * Delega en la función SQL `purgar_ads_daily` (migración 063) en vez de hacer el
 * DELETE desde aquí: así el criterio de retención vive junto a la tabla y no se
 * puede desincronizar con lo que el comentario de la migración promete.
 */
export async function purgarAdsDaily(
    // Mismo tipo laxo que `purgarPixelEvents`: el planificador recibe tanto el
    // cliente de la app como el del worker self-hosted, que no comparten tipos.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: any,
    dias = ADS_DAILY_NIVEL_AD_RETENCION_DIAS,
): Promise<number> {
    const { data, error } = await db.rpc('purgar_ads_daily', { p_dias: dias })
    if (error) {
        // No es fatal: `ads_daily` es un espejo de `metricas_diarias`. Que crezca
        // de más es un problema de espacio, no de exactitud.
        console.error('[planner] purga de ads_daily:', error.message)
        return 0
    }
    const borradas = Number(data ?? 0)
    if (borradas > 0) console.log(`[planner] ads_daily: ${borradas} fila(s) de nivel anuncio purgadas`)
    return borradas
}

/** Días de `pixel_events` que se conservan. */
export const PIXEL_EVENTS_RETENCION_DIAS = 90

/**
 * Purga los `report_utm.pixel_events` antiguos.
 *
 * Es la única tabla del sistema que recibe una fila por pageview de todos los
 * clientes y no tenía tope: crecía ~22 MB al mes sin que nada la recortara. Solo
 * se lee para resolver la atribución de una venta, que mira eventos recientes, y
 * para el journey de un visitante — nada necesita el histórico completo.
 *
 * Se borra por días sueltos, de más viejo a más nuevo: un solo DELETE por rango
 * abierto podría no caber en el `statement_timeout` de 8 s de PostgREST, que es
 * exactamente cómo se acumuló la basura de `sheet_filas`.
 */
export async function purgarPixelEvents(
    db: any,
    dias = PIXEL_EVENTS_RETENCION_DIAS,
): Promise<number> {
    const rutm = typeof db.schema === 'function' ? db.schema('report_utm') : db
    const corteMs = Date.now() - dias * 86_400_000
    let borrados = 0

    // Tope de días por corrida: con la purga diaria basta 1, el resto es margen
    // para ponerse al día la primera vez sin dejar la tabla a medias.
    for (let i = 0; i < 120; i++) {
        const { data, error } = await rutm
            .from('pixel_events')
            .select('created_at')
            .lt('created_at', new Date(corteMs).toISOString())
            .order('created_at', { ascending: true })
            .limit(1)
        if (error) {
            console.error('[planner] purga de pixel_events:', error.message)
            return borrados
        }
        if (!data || data.length === 0) return borrados

        // Cierra el día del evento más viejo y borra solo esa ventana.
        const masViejo = new Date(data[0].created_at as string)
        const finDelDia = new Date(masViejo)
        finDelDia.setUTCHours(24, 0, 0, 0)
        const hasta = new Date(Math.min(finDelDia.getTime(), corteMs))

        const { error: delError, count } = await rutm
            .from('pixel_events')
            .delete({ count: 'exact' })
            .lt('created_at', hasta.toISOString())
        if (delError) {
            console.error('[planner] purga de pixel_events:', delError.message)
            return borrados
        }
        borrados += count ?? 0
    }
    return borrados
}
