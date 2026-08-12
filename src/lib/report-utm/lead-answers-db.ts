/**
 * Respuestas de formulario, plegadas y cruzadas con las campañas reales.
 *
 * Es la capa que alimenta el bloque de respuestas del dashboard general. Su
 * trabajo son tres pasos, en este orden:
 *
 *   1. La base pliega los leads a (día Colombia × valor crudo × tupla UTM) con
 *      su recuento — `report_utm.bi_respuestas_por_dia`, migración 071.
 *   2. Node aplica el catálogo de campos de lead (`bucketDeValor`) para convertir
 *      el valor crudo en su bucket, y resuelve la campaña UNA VEZ POR TUPLA UTM
 *      con la cascada de 7 pasos de `campaign-resolver`.
 *   3. El resultado se colapsa a (día × campaña × bucket) y se codifica por
 *      diccionario. Eso —y no el plegado de SQL— es lo que hace que al navegador
 *      lleguen unos KB en vez de decenas de miles de filas.
 *
 * Por qué el cruce a campaña se resuelve por tupla y no por fila: es el mismo
 * patrón que la migración 070 §2 estableció para los desplegables. Un cliente con
 * 9.000 leads tiene unas pocas decenas de tuplas UTM distintas; resolver por fila
 * repetiría el mismo trabajo miles de veces.
 *
 * NO hay dato derivado ni recálculo: igual que los campos de lead (migración
 * 060), el catálogo se aplica al consultar, así que editar una agrupación se ve
 * en el dashboard al recargar.
 */

import { colombiaRangeBounds } from '@/lib/colombia-date'
import { bucketDeValor, ordenarBuckets } from './lead-campos'
import type { LeadCampoDef } from './lead-campos'
import { loadResolver, SIN_CAMPANA } from './campaign-resolver'
import type { CampaignResolver } from './campaign-resolver'

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Tope de filas que pide cada llamada a la RPC. Superarlo NO se degrada en
 * silencio: la RPC devuelve `total_filas` y el dataset se marca `incompleto`
 * para que la UI lo diga.
 */
export const LIMITE_FILAS_RPC = 60000

/**
 * Tope de campos por carga. Un layout con más renderiza los primeros y avisa:
 * cada campo es una consulta independiente, y cuatro ya cubren de sobra el uso
 * real (el cliente con más preguntas configuradas tiene tres).
 */
export const MAX_CAMPOS_POR_CARGA = 4

/** Bucket sintético de los leads que no cruzaron con ninguna campaña real. */
export { SIN_CAMPANA }

/** Un campo de lead tal como lo ve el bloque, con sus buckets ya ordenados. */
export interface LeadAnswerCatalogo {
    clave: string
    nombre: string
    /** Buckets en el orden configurado (`valores_orden`), o por frecuencia. */
    buckets: string[]
    claves_origen: string[]
    origen: 'catalogo' | 'auto'
    /** Leads del período que respondieron este campo. */
    cobertura: number
}

/**
 * El cubo de respuestas listo para filtrar en el navegador.
 *
 * Codificado por diccionario a propósito: los tripletes son la parte que crece
 * (día × campaña × bucket) y repetir el nombre de la campaña —que en producción
 * llega a tener 40 caracteres con emojis y corchetes— en cada uno multiplicaría
 * el payload por diez.
 */
export interface LeadAnswerDataset {
    /** Nombres de campaña. El índice 0 es SIEMPRE `(sin campaña)`. */
    campanas: string[]
    /** `campaign_id` paralelo a `campanas` (null si no cruzó o no lo tiene). */
    campanaIds: (string | null)[]
    campos: LeadAnswerCatalogo[]
    /** fecha (yyyy-MM-dd) → índice de campo → tripletes [bucket, campaña, n]. */
    porFecha: Record<string, Array<Array<[number, number, number]>>>
    /**
     * TODOS los contactos del día, respondan o no: fecha → pares [campaña, n].
     *
     * Es el denominador. Sin él, los buckets suman menos que la realidad y nadie
     * sabe si el resto no respondió o si el sistema se los perdió; con él existe
     * `(sin respuesta)` y la cuenta cierra siempre.
     *
     * Se carga aunque el layout no tenga ningún bloque de respuestas, porque la
     * métrica `utm_leads` tiene que estar disponible en cualquier tarjeta,
     * gráfica o columna que quiera usarla el trafficker.
     */
    totalesPorFecha: Record<string, Array<[number, number]>>
    /** Alguna consulta se truncó o falló: la UI tiene que decirlo. */
    incompleto: boolean
}

export function datasetVacio(): LeadAnswerDataset {
    return { campanas: [], campanaIds: [], campos: [], porFecha: {}, totalesPorFecha: {}, incompleto: false }
}

/** ¿El dataset tiene algo que pintar? */
export function datasetTieneDatos(ds: LeadAnswerDataset | null | undefined): boolean {
    return !!ds && ds.campos.length > 0 && Object.keys(ds.porFecha).length > 0
}

/** ¿Hay al menos contactos, aunque no haya ninguna pregunta configurada? */
export function datasetTieneLeads(ds: LeadAnswerDataset | null | undefined): boolean {
    return !!ds && Object.keys(ds.totalesPorFecha).length > 0
}

/**
 * Tamaño de página de PostgREST. **También corta las respuestas de RPC**, no solo
 * las de tabla: una función que agrupa 1.608 filas devuelve 1.000 y no avisa.
 * Es el mismo motivo por el que `lead-campos-db.ts` usa `fetchAllRows`.
 */
const PAGINA_POSTGREST = 1000

/**
 * Trae TODAS las filas de una RPC, paginando con `range`.
 *
 * Detecta el truncado comparando contra `total_filas`, que la propia función
 * devuelve con un `COUNT(*) OVER ()`. Sin esto, el desglose de un cliente con
 * más de mil combinaciones mostraba de menos con aspecto de dato completo —y
 * cuadrando consigo mismo, que es lo que lo hacía indetectable a ojo.
 *
 * La paginación es estable porque las dos RPC ordenan por su GRANO COMPLETO: con
 * un `ORDER BY n DESC` los empates cambiarían de página entre peticiones y se
 * duplicarían unas filas mientras se perderían otras.
 */
async function traerTodasLasFilas(
    consulta: (desde: number, hasta: number) => PromiseLike<{ data: unknown; error: any }>,
): Promise<{ filas: any[]; error: any; truncado: boolean }> {
    const filas: any[] = []
    let total: number | null = null

    for (let offset = 0; offset < LIMITE_FILAS_RPC; offset += PAGINA_POSTGREST) {
        const { data, error } = await consulta(offset, offset + PAGINA_POSTGREST - 1)
        if (error) return { filas, error, truncado: false }

        const lote = (data ?? []) as any[]
        if (lote.length === 0) break
        if (total === null) total = Number(lote[0].total_filas ?? 0)
        filas.push(...lote)

        if (lote.length < PAGINA_POSTGREST) break
        if (total !== null && filas.length >= total) break
    }

    return { filas, error: null, truncado: total !== null && filas.length < total }
}

/** Mensaje típico de PostgREST cuando falta la migración 071. */
function esFuncionAusente(error: any): boolean {
    const msg = String(error?.message ?? '')
    return (
        error?.code === 'PGRST202' ||
        error?.code === '42883' ||
        /could not find the function|does not exist|schema cache/i.test(msg)
    )
}

/**
 * Sintetiza un `LeadCampoDef` a partir de unas claves crudas, para las preguntas
 * auto-detectadas que todavía no están en el catálogo.
 *
 * Es lo que permite que haya UN SOLO camino de ejecución: a partir de aquí, una
 * pregunta detectada y una configurada son indistinguibles para el resto del
 * módulo, porque `bucketDeValor` solo necesita `valores_map` y `sin_mapear`. Sin
 * esto, cada arreglo del bucketizado habría que hacerlo dos veces.
 */
export function campoSintetico(
    clave: string,
    nombre: string,
    clavesOrigen: string[],
): LeadCampoDef {
    return {
        id: `auto:${clave}`,
        cliente_id: '',
        clave,
        nombre,
        descripcion: null,
        claves_origen: clavesOrigen,
        // Sin agrupación: el valor crudo normalizado ES el bucket. Es la
        // diferencia real entre una pregunta detectada y una configurada, y por
        // eso el modal ofrece "Guardar en el catálogo".
        valores_map: {},
        valores_orden: [],
        sin_mapear: 'crudo',
        max_valores: 200,
        activo: true,
        orden: 0,
    }
}

// ── Caché de módulo ───────────────────────────────────────────────────
// El dashboard interno y el espejo público del mismo cliente piden lo mismo, y
// el periodo anterior dispara una segunda tanda con otro rango. TTL igual que el
// del resolver de campañas, por coherencia: los dos dependen de lo mismo (que el
// worker no haya sincronizado nada nuevo).

const DATASET_TTL_MS = 60_000

interface CacheEntry { ds: LeadAnswerDataset; ts: number }
const datasetCache = new Map<string, CacheEntry>()

function pruneCache(now: number): void {
    for (const [k, v] of datasetCache) {
        if (now - v.ts > DATASET_TTL_MS) datasetCache.delete(k)
    }
}

/** Firma estable de los campos pedidos, para no servir un dataset de otra consulta. */
function firmaDeCampos(campos: LeadCampoDef[]): string {
    return campos
        .map(c => `${c.clave}:${c.claves_origen.join('~')}:${Object.keys(c.valores_map ?? {}).length}:${c.sin_mapear}`)
        .join('|')
}

/**
 * Índice nombre de campaña → `campaign_id`, para que el diccionario del dataset
 * pueda llevar el id. Lo necesitan los grupos de campaña del dashboard, que
 * mapean por id además de por patrón de nombre.
 */
function idsPorNombre(resolver: CampaignResolver | null): Map<string, string | null> {
    const out = new Map<string, string | null>()
    if (!resolver) return out
    for (const agg of resolver.index.campaigns.values()) {
        // Si dos plataformas comparten nombre, gana la primera: el id solo se usa
        // para cruzar con los grupos, y un grupo se define por plataforma.
        if (!out.has(agg.name)) out.set(agg.name, agg.campaign_id)
    }
    return out
}

/**
 * Carga el cubo de respuestas de un cliente report_utm para un rango.
 *
 * Nunca lanza: cualquier fallo (falta la migración, la RPC agota el tiempo, el
 * cliente no tiene índice de campañas) devuelve un dataset marcado `incompleto`
 * en vez de tumbar la carga del dashboard.
 *
 * `db` tiene que venir YA acotado al esquema report_utm
 * (`createAdminClient().schema('report_utm')`), igual que en `lead-campos-db.ts`:
 * así quien llama decide una sola vez con qué credenciales entra.
 */
export async function cargarRespuestasLead(
    db: any,
    rtmClienteId: string,
    dateFrom: string,
    dateTo: string,
    campos: LeadCampoDef[],
    origenes: Record<string, 'catalogo' | 'auto'> = {},
    /**
     * Traer el total diario de contactos. Es la consulta cara —lee todos los
     * leads del rango— y solo hace falta si algo la va a usar: un bloque de
     * respuestas (que lo necesita para su `(sin respuesta)`) o una fórmula que
     * mencione `utm_leads`/`lf__`. Ver `layoutUsaRespuestasLead`.
     */
    conTotales = true,
): Promise<LeadAnswerDataset> {
    // Sin campos SÍ se sigue si se piden totales: `utm_leads` tiene que existir
    // aunque el cliente no tenga ninguna pregunta configurada.
    if (!rtmClienteId) return datasetVacio()
    if (campos.length === 0 && !conTotales) return datasetVacio()

    const usados = campos.slice(0, MAX_CAMPOS_POR_CARGA)
    const key = `${rtmClienteId}|${dateFrom}|${dateTo}|${conTotales ? 't' : ''}|${firmaDeCampos(usados)}`
    const now = Date.now()
    const hit = datasetCache.get(key)
    if (hit && now - hit.ts <= DATASET_TTL_MS) return hit.ds

    const bounds = colombiaRangeBounds(dateFrom, dateTo)

    // El resolver se carga UNA vez para todos los campos: ya cachea 60 s por su
    // cuenta, pero pedirlo N veces en paralelo dispararía N construcciones del
    // índice antes de que la primera llegue a poblar su caché.
    const resolver = await loadResolver(rtmClienteId, dateFrom, dateTo).catch(() => null)
    const idsCampana = idsPorNombre(resolver)

    // Diccionario compartido por todos los campos. El índice 0 se reserva a
    // `(sin campaña)` para que el filtro de pestaña pueda excluirlo sin buscarlo
    // por nombre.
    const campanas: string[] = [SIN_CAMPANA]
    const campanaIds: (string | null)[] = [null]
    const idxCampana = new Map<string, number>([[SIN_CAMPANA, 0]])

    const indiceDeCampana = (label: string): number => {
        const yaEsta = idxCampana.get(label)
        if (yaEsta !== undefined) return yaEsta
        const i = campanas.length
        campanas.push(label)
        campanaIds.push(idsCampana.get(label) ?? null)
        idxCampana.set(label, i)
        return i
    }

    // Memo por tupla UTM: es el ahorro que justifica el diseño. Un cliente con
    // 1.300 filas plegadas tiene ~30 tuplas distintas.
    const memoTupla = new Map<string, number>()
    const campanaDeTupla = (r: any): number => {
        const k = `${r.utm_id ?? ''}|${r.utm_campaign ?? ''}|${r.utm_content ?? ''}|${r.utm_term ?? ''}`
        const yaEsta = memoTupla.get(k)
        if (yaEsta !== undefined) return yaEsta
        const label = resolver
            ? resolver.campaignOf({
                utm_id: r.utm_id, utm_campaign: r.utm_campaign,
                utm_content: r.utm_content, utm_term: r.utm_term,
            }).label
            // Sin resolver (cliente sin enlazar o sin índice) no se puede afirmar
            // a qué campaña pertenece un lead. Se etiqueta como tal en vez de
            // inventar el cruce con el utm_campaign crudo, que parecería resuelto.
            : SIN_CAMPANA
        const i = indiceDeCampana(label || SIN_CAMPANA)
        memoTupla.set(k, i)
        return i
    }

    const porFecha: Record<string, Array<Array<[number, number, number]>>> = {}
    const catalogo: LeadAnswerCatalogo[] = []
    let incompleto = false

    // El total diario va en paralelo con los desgloses: es una consulta mucho más
    // barata (no toca `raw_fields`) y no depende de qué campos se pidan.
    const totalesPromise = conTotales
        ? traerTodasLasFilas((desde, hasta) => db
            .rpc('bi_leads_por_dia', {
                p_cliente_id: rtmClienteId,
                p_desde: bounds.gte,
                p_hasta: bounds.lt,
                p_limite: LIMITE_FILAS_RPC,
            })
            .range(desde, hasta))
        : null

    const respuestas = await Promise.all(
        usados.map(async campo => {
            if ((campo.claves_origen ?? []).length === 0) return { campo, filas: [] as any[], parcial: true }
            const { filas, error, truncado } = await traerTodasLasFilas((desde, hasta) => db
                .rpc('bi_respuestas_por_dia', {
                    p_cliente_id: rtmClienteId,
                    p_desde: bounds.gte,
                    p_hasta: bounds.lt,
                    p_claves_json: campo.claves_origen,
                    p_limite: LIMITE_FILAS_RPC,
                })
                .range(desde, hasta))
            if (error) {
                if (!esFuncionAusente(error)) {
                    console.error('[lead-answers] bi_respuestas_por_dia falló:', error.message)
                }
                return { campo, filas: [] as any[], parcial: true }
            }
            // Truncado ≠ fallo: las filas que llegaron son buenas y se usan; lo
            // que hay que impedir es que se presenten como el total.
            return { campo, filas, parcial: truncado }
        }),
    )

    respuestas.forEach(({ campo, filas, parcial }, iCampo) => {
        if (parcial) incompleto = true

        // Acumulador (fecha → bucket → campaña → n). Se agrega aquí y no al
        // emitir porque varias filas crudas caen en el mismo bucket: es
        // exactamente el caso de Goodprop, cuyas dos variantes de escritura del
        // mismo rango tienen que sumarse, no aparecer como dos barras.
        const acc = new Map<string, Map<string, Map<number, number>>>()
        const bucketsVistos = new Map<string, number>()
        let cobertura = 0

        for (const fila of filas) {
            const bucket = bucketDeValor(campo, fila.valor)
            // `null` = el analista mandó ignorar ese valor (`sin_mapear:'ignorar'`
            // o un valor vacío). No cuenta como respuesta.
            if (!bucket) continue

            const dia = String(fila.dia ?? '').slice(0, 10)
            if (!dia) continue
            const n = Number(fila.n ?? 0)
            if (!n) continue

            cobertura += n
            bucketsVistos.set(bucket, (bucketsVistos.get(bucket) ?? 0) + n)

            const iCampana = campanaDeTupla(fila)

            let porBucket = acc.get(dia)
            if (!porBucket) { porBucket = new Map(); acc.set(dia, porBucket) }
            let porCampana = porBucket.get(bucket)
            if (!porCampana) { porCampana = new Map(); porBucket.set(bucket, porCampana) }
            porCampana.set(iCampana, (porCampana.get(iCampana) ?? 0) + n)
        }

        // Orden de los buckets: el configurado manda (es lo que hace que los
        // rangos de ingresos salgan de menor a mayor y no alfabéticamente). Para
        // una pregunta auto-detectada no hay orden declarado, así que se ordena
        // por frecuencia, que es lo más útil de leer.
        const tieneOrden = (campo.valores_orden ?? []).length > 0
        const buckets = tieneOrden
            ? ordenarBuckets(campo, Array.from(bucketsVistos.keys()))
            : Array.from(bucketsVistos.entries())
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([b]) => b)

        const idxBucket = new Map(buckets.map((b, i) => [b, i]))

        for (const [dia, porBucket] of acc) {
            const tripletes: Array<[number, number, number]> = []
            for (const [bucket, porCampana] of porBucket) {
                const iBucket = idxBucket.get(bucket)
                if (iBucket === undefined) continue
                for (const [iCampana, n] of porCampana) tripletes.push([iBucket, iCampana, n])
            }
            if (tripletes.length === 0) continue
            const delDia = porFecha[dia] ?? (porFecha[dia] = [])
            // Hueco explícito para los campos que ese día no tienen nada: el
            // índice del array TIENE que coincidir con el del catálogo.
            while (delDia.length < iCampo) delDia.push([])
            delDia[iCampo] = tripletes
        }

        catalogo.push({
            clave: campo.clave,
            nombre: campo.nombre,
            buckets,
            claves_origen: campo.claves_origen ?? [],
            origen: origenes[campo.clave] ?? 'catalogo',
            cobertura,
        })
    })

    // Rellena los huecos de cola: un día donde solo respondió el primer campo
    // deja el array corto y el lector accedería a `undefined`.
    for (const dia of Object.keys(porFecha)) {
        const delDia = porFecha[dia]
        while (delDia.length < catalogo.length) delDia.push([])
    }

    // ── Totales del día ───────────────────────────────────────────────
    // Se resuelven con el MISMO memo de tuplas y el mismo diccionario que los
    // desgloses: si usaran índices distintos, filtrar por campaña recortaría el
    // total y el desglose por criterios que no coinciden, y `(sin respuesta)`
    // podría salir negativo.
    const totalesPorFecha: Record<string, Array<[number, number]>> = {}
    if (totalesPromise) {
        const { filas, error, truncado } = await totalesPromise
        if (error) {
            if (!esFuncionAusente(error)) {
                console.error('[lead-answers] bi_leads_por_dia falló:', error.message)
            }
            incompleto = true
        } else {
            if (truncado) incompleto = true

            const acc = new Map<string, Map<number, number>>()
            for (const fila of filas) {
                const dia = String(fila.dia ?? '').slice(0, 10)
                if (!dia) continue
                const n = Number(fila.n ?? 0)
                if (!n) continue
                const iCampana = campanaDeTupla(fila)
                let porCampana = acc.get(dia)
                if (!porCampana) { porCampana = new Map(); acc.set(dia, porCampana) }
                porCampana.set(iCampana, (porCampana.get(iCampana) ?? 0) + n)
            }
            for (const [dia, porCampana] of acc) {
                totalesPorFecha[dia] = [...porCampana.entries()]
            }
        }
    }

    const ds: LeadAnswerDataset = {
        campanas, campanaIds, campos: catalogo, porFecha, totalesPorFecha, incompleto,
    }

    // Un dataset incompleto NO se cachea: reintentar en la siguiente carga es
    // mejor que servir un minuto entero de cifras parciales.
    if (!incompleto) {
        pruneCache(now)
        datasetCache.set(key, { ds, ts: now })
    }
    return ds
}
