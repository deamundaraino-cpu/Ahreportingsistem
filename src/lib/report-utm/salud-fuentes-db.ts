/**
 * Recolección de las señales de salud desde la base.
 *
 * Separado de `salud-fuentes.ts` a propósito: aquí vive todo lo que toca
 * Postgres, allí solo las reglas. Es lo que permite comprobar las reglas —las
 * siete, incluidas las que hoy no dispara ningún cliente— sin depender de que la
 * producción tenga un caso roto a mano.
 */

import { createAdminClient } from '@/utils/supabase/server'
import { colombiaDateOf } from '@/lib/colombia-date'
import {
    evaluarCliente, ordenarPorGravedad, TOLERANCIA_DIAS,
} from './salud-fuentes'
import type { SaludCliente, SenalesCliente, SenalFuente, SenalIntegracion, EstadoFuente } from './salud-fuentes'
import { atribucionDeFila } from '@/lib/sheets/atribucion'

/** Días hacia atrás sobre los que se mide el cruce UTM ↔ campaña. */
const VENTANA_CRUCE_DIAS = 30

/** Máximo de leads muestreados para medir el cruce. */
const MUESTRA_LEADS = 3000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/**
 * Última fecha con datos de una tabla, para un cliente.
 *
 * Deliberadamente SIN `count: 'exact'`. Contar exactamente `lead_events` de un
 * cliente con decenas de miles de filas agota el `statement_timeout` de 8 s, y
 * el error se traducía en «esta fuente no tiene datos» — un fallo inventado
 * sobre la fuente más sana de la plataforma.
 *
 * La pregunta que el panel necesita responder no es «cuántas filas hay» sino
 * «¿hay alguna, y de cuándo es la última?». Eso lo contesta un `order + limit 1`
 * que usa el índice y vuelve en milisegundos.
 *
 * Un error de consulta devuelve `desconocida`, nunca `vacia`.
 */
async function ultimaFecha(
    db: Db, tabla: string, columnaFecha: string, filtro: Record<string, string>, schema?: string
): Promise<{ ultimaFecha: string | null; estado: EstadoFuente }> {
    let q = (schema ? db.schema(schema) : db).from(tabla).select(columnaFecha)
    for (const [k, v] of Object.entries(filtro)) q = q.eq(k, v)
    const { data, error } = await q
        .order(columnaFecha, { ascending: false }).limit(1)

    if (error) return { ultimaFecha: null, estado: 'desconocida' }

    const fila = (data ?? [])[0] as Record<string, unknown> | undefined
    const cruda = fila?.[columnaFecha]
    return cruda
        ? { ultimaFecha: String(cruda).slice(0, 10), estado: 'con_datos' }
        : { ultimaFecha: null, estado: 'vacia' }
}

/**
 * Señales de un cliente. Una consulta por fuente, y cada una es un
 * `order + limit 1` que resuelve por índice: nunca un escaneo.
 */
export async function recogerSenales(cliente: {
    id: string; nombre: string; public_cliente_id: string | null
}): Promise<SenalesCliente> {
    const db = await createAdminClient()
    const pid = cliente.public_cliente_id
    const hoy = colombiaDateOf(new Date())

    // ── Fuentes del esquema report_utm (no necesitan puente) ─────────
    const leads = await ultimaFecha(db, 'lead_events', 'created_at', { cliente_id: cliente.id }, 'report_utm')
    const sales = await ultimaFecha(db, 'sales_events', 'created_at', { cliente_id: cliente.id }, 'report_utm')

    // ── Fuentes del esquema public (necesitan el puente) ─────────────
    const cuenta = pid
        ? await ultimaFecha(db, 'metricas_diarias', 'fecha', { cliente_id: pid })
        : { ultimaFecha: null, estado: 'vacia' as EstadoFuente }
    // `ads_daily` fija el nivel: los niveles no suman entre sí y leer sin
    // filtrarlo daría un recuento inflado (ver migración 063).
    const ads = pid
        ? await ultimaFecha(db, 'ads_daily', 'fecha', { cliente_id: pid, nivel: 'campaign' })
        : { ultimaFecha: null, estado: 'vacia' as EstadoFuente }
    const offline = pid
        ? await ultimaFecha(db, 'conversiones_offline_diarias', 'fecha', { cliente_id: pid })
        : { ultimaFecha: null, estado: 'vacia' as EstadoFuente }
    const sheet = pid
        ? await ultimaFecha(db, 'sheet_filas', 'fecha', { cliente_id: pid })
        : { ultimaFecha: null, estado: 'vacia' as EstadoFuente }
    const subs = pid
        ? await ultimaFecha(db, 'hotmart_subscriptions_snapshot', 'captured_date', { cliente_id: pid })
        : { ultimaFecha: null, estado: 'vacia' as EstadoFuente }

    // ── Qué tiene configurado el cliente ─────────────────────────────
    // Sin esto el panel avisaría de siete fuentes muertas por cliente, cuando
    // la mayoría simplemente no se usan.
    let config: Record<string, unknown> = {}
    if (pid) {
        const { data } = await db.from('clientes').select('config_api').eq('id', pid).maybeSingle()
        config = ((data?.config_api ?? {}) as Record<string, unknown>)
    }
    const tiene = (k: string) => Object.prototype.hasOwnProperty.call(config, k)

    const { data: integRaw } = await db.schema('report_utm')
        .from('integrations')
        .select('tipo,status,last_error,last_sync_at')
        .eq('cliente_id', cliente.id)
    const integraciones: SenalIntegracion[] = ((integRaw ?? []) as Record<string, unknown>[])
        .map(i => ({
            tipo: String(i.tipo ?? ''),
            status: String(i.status ?? ''),
            ultimoError: i.last_error ? String(i.last_error) : null,
            ultimoSync: i.last_sync_at ? String(i.last_sync_at) : null,
        }))

    const fuentes: SenalFuente[] = [
        {
            id: 'leads', label: 'Leads', ...leads, toleranciaDias: TOLERANCIA_DIAS.leads,
            // Los leads llegan por píxel s2s o por Meta Lead Ads: si hay alguna
            // integración, se espera que entren.
            configurada: integraciones.length > 0, requierePuente: false,
        },
        {
            id: 'sales', label: 'Ventas', ...sales, toleranciaDias: TOLERANCIA_DIAS.sales,
            // Solo se espera venta si hay una pasarela dada de alta.
            configurada: integraciones.some(i => ['hotmart', 'cartpanda', 'shopify'].includes(i.tipo)),
            requierePuente: false,
        },
        {
            id: 'ads', label: 'Anuncios (gasto)', ...ads, toleranciaDias: TOLERANCIA_DIAS.ads,
            configurada: tiene('meta_token') || tiene('tiktok_accounts'), requierePuente: true,
        },
        {
            id: 'cuenta', label: 'Cuenta (día)', ...cuenta, toleranciaDias: TOLERANCIA_DIAS.cuenta,
            configurada: Boolean(pid), requierePuente: true,
        },
        {
            id: 'offline', label: 'Conversiones offline', ...offline, toleranciaDias: TOLERANCIA_DIAS.offline,
            configurada: tiene('google_sheets_conversiones'), requierePuente: true,
        },
        {
            id: 'sheet', label: 'Sheet (filas)', ...sheet, toleranciaDias: TOLERANCIA_DIAS.sheet,
            configurada: tiene('google_sheets') || tiene('google_sheets_conversiones'), requierePuente: true,
        },
        {
            id: 'subs', label: 'Suscripciones', ...subs, toleranciaDias: TOLERANCIA_DIAS.subs,
            configurada: tiene('hotmart_client_id'), requierePuente: true,
        },
    ]

    return {
        clienteId: cliente.id,
        nombre: cliente.nombre,
        tienePuente: pid !== null,
        hoy,
        fuentes,
        integraciones,
        pctLeadsCruzados: await medirCruce(db, cliente.id, pid, hoy),
        sheetFilasAjenas: pid ? await medirSheetAjeno(db, pid) : null,
    }
}

/**
 * % de leads recientes que se atan a una campaña real.
 *
 * Se mide sobre una muestra y con el resolver de verdad, no con una heurística
 * aparte: si aquí se usara otra forma de cruzar, el panel diría que todo va bien
 * mientras el informe cruza distinto.
 */
async function medirCruce(
    db: Db, clienteId: string, pid: string | null, hoy: string
): Promise<number | null> {
    if (!pid) return null

    const desde = new Date(Date.parse(`${hoy}T00:00:00Z`) - VENTANA_CRUCE_DIAS * 86400_000)
        .toISOString().slice(0, 10)

    const { data } = await db.schema('report_utm').from('lead_events')
        .select('utm_id,utm_campaign,utm_content,utm_term')
        .eq('cliente_id', clienteId)
        .gte('created_at', `${desde}T00:00:00Z`)
        .limit(MUESTRA_LEADS)

    const leads = (data ?? []) as Array<Record<string, string | null>>
    if (leads.length === 0) return null

    const { loadResolver } = await import('./campaign-resolver')
    const resolver = await loadResolver(clienteId, desde, hoy)
    if (!resolver) return null

    let cruzados = 0
    for (const l of leads) if (resolver.campaignOf(l).matched) cruzados++
    return (100 * cruzados) / leads.length
}

/**
 * Filas de Sheet cuyo id de campaña no pertenece a ningún anuncio del cliente.
 *
 * Un Sheet propio cruza casi entero; uno ajeno no cruza nada. Es lo que delata
 * que un cliente está conectado al documento de otro.
 */
async function medirSheetAjeno(
    db: Db, pid: string
): Promise<{ total: number; sinCruce: number } | null> {
    const { data } = await db.from('sheet_filas')
        .select('valores').eq('cliente_id', pid).limit(500)
    const filas = (data ?? []) as Array<{ valores: Record<string, string> }>
    if (filas.length === 0) return null

    const conId = filas
        .map(f => atribucionDeFila(f.valores).campaign_id)
        .filter(Boolean)
    // Un Sheet sin ids de campaña (un CRM a mano) no se puede juzgar así: no es
    // ajeno, simplemente no trae identidad publicitaria.
    if (conId.length === 0) return null

    const { data: propias } = await db.from('ads_daily')
        .select('entidad_id').eq('cliente_id', pid).eq('nivel', 'campaign').limit(2000)
    const conocidas = new Set(
        ((propias ?? []) as Array<{ entidad_id: string | null }>)
            .map(a => a.entidad_id).filter(Boolean) as string[]
    )
    // Sin campañas conocidas no hay con qué comparar: callar es lo correcto.
    if (conocidas.size === 0) return null

    return {
        total: conId.length,
        sinCruce: conId.filter(id => !conocidas.has(id)).length,
    }
}

/** Salud de todos los clientes del reporting, lo peor primero. */
export async function saludDeTodos(): Promise<SaludCliente[]> {
    const db = await createAdminClient()
    const { data } = await db.schema('report_utm')
        .from('clientes').select('id,nombre,public_cliente_id').order('nombre')
    const clientes = (data ?? []) as Array<{ id: string; nombre: string; public_cliente_id: string | null }>

    const out: SaludCliente[] = []
    for (const c of clientes) out.push(evaluarCliente(await recogerSenales(c)))
    return ordenarPorGravedad(out)
}
