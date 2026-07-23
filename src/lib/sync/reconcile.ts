/**
 * Reconciliación del gasto publicitario: compara lo guardado contra la fuente de verdad.
 *
 * Por qué existe
 * ─────────────
 * El dashboard NO usa las columnas `meta_spend` / `tiktok_spend` cuando una
 * pestaña filtra por keyword: suma los elementos de los arrays JSONB
 * `meta_campaigns` / `tiktok_campaigns` cuyo nombre matchea (ver
 * `src/lib/campaign-filter.ts`). Si ese array quedó incompleto, el día muestra $0
 * aunque la columna tenga gasto — y como `hasMetaData()`/`hasTikTokData()` solo
 * comprueban que la fila "tenga algo", esa fecha se considera ya sincronizada y
 * no se vuelve a pedir nunca.
 *
 * Así se perdieron ~$90k del cliente "Cris tributario": los días 12, 13 y 14 de
 * julio aparecían en $0 mientras los vecinos rondaban $31k. Dos orígenes
 * conocidos de arrays incompletos:
 *
 *   1. Antes del commit ddbb9e9 (2026-06-23) el worker leía solo la PRIMERA
 *      página de Meta insights sin seguir `paging.next`: cualquier día con más
 *      de 500 filas de campaña perdía el resto en silencio. (TikTok nunca tuvo
 *      este fallo: siempre siguió `page_info.total_page`.)
 *   2. Una página que falla a mitad del rango deja el día a medias.
 *
 * Este módulo es lógica pura (sin red ni base de datos) para poder testearla:
 * compara días, clasifica la divergencia y agrupa los días malos en rangos
 * contiguos para reencolarlos en el menor número de jobs posible. Es agnóstico
 * de plataforma — las filas se normalizan antes de compararlas.
 */

export type Plataforma = 'meta' | 'tiktok'

/**
 * Gasto real por día según la propia plataforma:
 * Meta `level=account`, TikTok `data_level=AUCTION_ADVERTISER`.
 */
export type AccountDaySpend = {
    fecha: string
    spend: number
}

/** Fila guardada, ya normalizada a una plataforma concreta. */
export type StoredDayRow = {
    fecha: string
    /** Columna agregada (`meta_spend` o `tiktok_spend`). */
    spend: number | string | null
    /** Array de campañas (`meta_campaigns` o `tiktok_campaigns`). */
    campaigns: unknown
}

/** Columnas de `metricas_diarias` que corresponden a cada plataforma. */
export const COLUMNAS_PLATAFORMA: Record<Plataforma, { spend: string; campaigns: string }> = {
    meta: { spend: 'meta_spend', campaigns: 'meta_campaigns' },
    tiktok: { spend: 'tiktok_spend', campaigns: 'tiktok_campaigns' },
}

/** Convierte filas crudas de `metricas_diarias` al shape que compara este módulo. */
export function normalizarFilas(rows: any[], plataforma: Plataforma): StoredDayRow[] {
    const cols = COLUMNAS_PLATAFORMA[plataforma]
    return (rows ?? []).map(r => ({
        fecha: r.fecha,
        spend: r[cols.spend],
        campaigns: r[cols.campaigns],
    }))
}

export type DayStatus =
    /** Columna y array cuadran con la cuenta. */
    | 'ok'
    /** No hay fila para ese día pero la cuenta sí registró gasto. */
    | 'fila_faltante'
    /** La columna cuadra con la cuenta pero el array de campañas no la respalda. */
    | 'array_incompleto'
    /** La columna misma difiere del gasto real de la cuenta. */
    | 'spend_desactualizado'

export type DayComparison = {
    fecha: string
    /** Gasto según Meta a nivel de cuenta (fuente de verdad). */
    cuenta: number
    /** Valor de la columna `meta_spend`. */
    columna: number
    /** Suma de `meta_campaigns[].spend`. */
    campanas: number
    /** Nº de campañas en el array (diagnóstico). */
    campanasCount: number
    status: DayStatus
    /** Diferencia absoluta mayor detectada, en la moneda de la cuenta. */
    desvio: number
}

export type ReconcileSummary = {
    dias: DayComparison[]
    /** Solo los días que necesitan reparación. */
    problematicos: DayComparison[]
    totales: {
        cuenta: number
        columna: number
        campanas: number
        /** cuenta − campañas: lo que el dashboard NO está mostrando. */
        faltanteEnDashboard: number
    }
    /** Rangos contiguos listos para encolar como jobs. */
    rangosAReparar: Array<{ start: string; end: string }>
}

/**
 * Tolerancia: 1% del importe, con un piso de 1 unidad monetaria.
 *
 * El piso evita que céntimos de redondeo en cuentas de bajo gasto se reporten
 * como divergencia; el porcentaje evita falsos positivos en cuentas grandes,
 * donde Meta redondea distinto al agregar por cuenta que por campaña.
 */
export function tolerancia(importe: number): number {
    return Math.max(1, Math.abs(importe) * 0.01)
}

/** ¿Dos importes son equivalentes dentro de la tolerancia del mayor de ambos? */
export function importesCuadran(a: number, b: number): boolean {
    return Math.abs(a - b) <= tolerancia(Math.max(Math.abs(a), Math.abs(b)))
}

/** Suma el `spend` de un array de campañas tal como lo hace el dashboard. */
export function sumarCampanas(metaCampaigns: unknown): { total: number; count: number } {
    if (!Array.isArray(metaCampaigns)) return { total: 0, count: 0 }
    let total = 0
    for (const c of metaCampaigns) {
        total += parseFloat((c as any)?.spend ?? '0') || 0
    }
    return { total, count: metaCampaigns.length }
}

/**
 * Compara el gasto por día de la cuenta contra lo guardado.
 *
 * `accountDays` debe traer una entrada por día CON gasto; los días sin gasto en
 * Meta no se comparan (no hay nada que reparar y una fila ausente es correcta).
 */
export function compararDias(
    accountDays: AccountDaySpend[],
    storedRows: StoredDayRow[],
): DayComparison[] {
    const porFecha = new Map<string, StoredDayRow>()
    for (const r of storedRows) porFecha.set(r.fecha, r)

    const out: DayComparison[] = []
    for (const dia of accountDays) {
        const cuenta = Number(dia.spend) || 0
        const fila = porFecha.get(dia.fecha)

        if (!fila) {
            // Sin gasto en la cuenta y sin fila: no hay nada que reconciliar.
            if (cuenta <= 0) continue
            out.push({
                fecha: dia.fecha,
                cuenta,
                columna: 0,
                campanas: 0,
                campanasCount: 0,
                status: 'fila_faltante',
                desvio: cuenta,
            })
            continue
        }

        const columna = Number(fila.spend) || 0
        const { total: campanas, count: campanasCount } = sumarCampanas(fila.campaigns)

        const columnaOk = importesCuadran(cuenta, columna)
        const arrayOk = importesCuadran(cuenta, campanas)

        let status: DayStatus
        if (columnaOk && arrayOk) status = 'ok'
        else if (!columnaOk) status = 'spend_desactualizado'
        else status = 'array_incompleto'

        out.push({
            fecha: dia.fecha,
            cuenta,
            columna,
            campanas,
            campanasCount,
            status,
            desvio: Math.max(Math.abs(cuenta - columna), Math.abs(cuenta - campanas)),
        })
    }

    out.sort((a, b) => a.fecha.localeCompare(b.fecha))
    return out
}

/**
 * Agrupa fechas sueltas en rangos contiguos.
 *
 * Reparar 12, 13 y 14 de julio como un solo job (12→14) en vez de tres reduce
 * las llamadas a Meta: el worker pide TODO el rango en una sola petición
 * paginada con `time_increment=1`.
 */
export function agruparEnRangos(fechas: string[]): Array<{ start: string; end: string }> {
    const ordenadas = Array.from(new Set(fechas)).sort()
    if (ordenadas.length === 0) return []

    const DAY = 86_400_000
    const rangos: Array<{ start: string; end: string }> = []
    let start = ordenadas[0]
    let prev = ordenadas[0]

    for (let i = 1; i < ordenadas.length; i++) {
        const actual = ordenadas[i]
        const salto = Date.parse(`${actual}T00:00:00Z`) - Date.parse(`${prev}T00:00:00Z`)
        if (salto !== DAY) {
            rangos.push({ start, end: prev })
            start = actual
        }
        prev = actual
    }
    rangos.push({ start, end: prev })
    return rangos
}

/** Informe completo listo para devolver por HTTP o para encolar reparaciones. */
export function construirResumen(
    accountDays: AccountDaySpend[],
    storedRows: StoredDayRow[],
): ReconcileSummary {
    const dias = compararDias(accountDays, storedRows)
    const problematicos = dias.filter(d => d.status !== 'ok')

    const totales = dias.reduce(
        (acc, d) => ({
            cuenta: acc.cuenta + d.cuenta,
            columna: acc.columna + d.columna,
            campanas: acc.campanas + d.campanas,
            faltanteEnDashboard: 0,
        }),
        { cuenta: 0, columna: 0, campanas: 0, faltanteEnDashboard: 0 },
    )
    totales.faltanteEnDashboard = totales.cuenta - totales.campanas

    return {
        dias,
        problematicos,
        totales,
        rangosAReparar: agruparEnRangos(problematicos.map(d => d.fecha)),
    }
}
