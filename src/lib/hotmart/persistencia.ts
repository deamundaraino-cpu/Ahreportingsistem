// ════════════════════════════════════════════════════════════════
// Persistencia de ventas de Hotmart
// ════════════════════════════════════════════════════════════════
//
// Todo pasa por la RPC `guardar_hotmart_venta` (migración 065) en vez de por el
// upsert de PostgREST, y no por gusto: la RPC lleva la GUARDA DE ORDEN.
//
// El upsert anterior (`onConflict` con `ignoreDuplicates:false`) tenía dos
// fallos que solo se ven cuando Hotmart reintenta, que es siempre:
//   • Un PURCHASE_REFUNDED machacaba la fila del PURCHASE_APPROVED y se perdía
//     el importe original — imposible calcular la tasa de reembolso.
//   • Un reintento tardío del PURCHASE_APPROVED devolvía a 'aprobada' una venta
//     ya reembolsada.

import { clasificarVenta, leerFunnel } from './clasificador'
import type { FunnelHotmart } from './clasificador'
import type { VentaHotmart } from './tipos'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type ResultadoGuardado = {
    id: string | null
    /** `false` cuando la guarda de orden descartó el evento por ser más viejo. */
    escrita: boolean
}

/** Serializa una venta al JSONB que espera la RPC. */
export function aFilaJson(clienteId: string, venta: VentaHotmart): Record<string, unknown> {
    return {
        cliente_id: clienteId,
        transaction_id: venta.transaction_id,
        parent_transaction_id: venta.parent_transaction_id,
        fecha_venta: venta.fecha_venta,
        aprobada_at: venta.aprobada_at,
        orden_at: venta.orden_at,
        estado: venta.estado,
        evento_ts: venta.evento_ts,
        reembolsada_at: venta.reembolsada_at,
        tipo: venta.tipo,
        clasificacion_origen: venta.clasificacion_origen,
        tab_id: venta.tab_id,
        producto_id: venta.producto_id,
        producto_nombre: venta.producto_nombre,
        oferta_codigo: venta.oferta_codigo,
        es_order_bump: venta.es_order_bump,
        moneda: venta.moneda,
        bruto: venta.bruto,
        bruto_usd: venta.bruto_usd,
        neto_productor_usd: venta.neto_productor_usd,
        neto_afiliado_usd: venta.neto_afiliado_usd,
        neto_coproductor_usd: venta.neto_coproductor_usd,
        usd_rate: venta.usd_rate,
        pago_tipo: venta.pago_tipo,
        pago_cuotas: venta.pago_cuotas,
        comprador_email: venta.comprador_email,
        comprador_nombre: venta.comprador_nombre,
        comprador_telefono: venta.comprador_telefono,
        comprador_doc: venta.comprador_doc,
        comprador_pais: venta.comprador_pais,
        checkout_pais: venta.checkout_pais,
        utm_source: venta.utm_source,
        utm_medium: venta.utm_medium,
        utm_campaign: venta.utm_campaign,
        utm_content: venta.utm_content,
        utm_term: venta.utm_term,
        utm_id: venta.utm_id,
        click_id: venta.click_id,
        src: venta.src,
        sck: venta.sck,
        xcod: venta.xcod,
        raw_payload: venta.raw_payload ?? null,
        origen: venta.origen,
        sales_event_id: null,
    }
}

/** Guarda una venta. `escrita: false` significa evento viejo descartado. */
export async function guardarVenta(
    db: Db,
    clienteId: string,
    venta: VentaHotmart,
): Promise<ResultadoGuardado> {
    const { data, error } = await db.rpc('guardar_hotmart_venta', {
        p_fila: aFilaJson(clienteId, venta),
    })
    if (error) throw new Error(`guardar_hotmart_venta: ${error.message}`)
    const fila = Array.isArray(data) ? data[0] : data
    return { id: fila?.id ?? null, escrita: Boolean(fila?.escrita) }
}

/** Guarda un lote. Devuelve cuántas se escribieron de verdad. */
export async function guardarLote(
    db: Db,
    clienteId: string,
    ventas: VentaHotmart[],
): Promise<{ escritas: number; descartadas: number; ids: string[] }> {
    let escritas = 0
    let descartadas = 0
    const ids: string[] = []
    for (const v of ventas) {
        const r = await guardarVenta(db, clienteId, v)
        if (r.escrita) escritas++
        else descartadas++
        if (r.id) ids.push(r.id)
    }
    return { escritas, descartadas, ids }
}

/**
 * Carga los embudos configurados de un cliente (`cliente_tabs.hotmart_funnel`).
 */
export async function cargarFunnels(db: Db, clienteId: string): Promise<FunnelHotmart[]> {
    const { data } = await db
        .from('cliente_tabs')
        .select('id, hotmart_funnel')
        .eq('cliente_id', clienteId)
    const funnels: FunnelHotmart[] = []
    for (const tab of data ?? []) {
        const f = leerFunnel(tab.id, tab.hotmart_funnel)
        if (f) funnels.push(f)
    }
    return funnels
}

/** Aplica la clasificación a un lote ya parseado. Muta en sitio. */
export function clasificarLote(ventas: VentaHotmart[], funnels: FunnelHotmart[]): void {
    for (const v of ventas) {
        const r = clasificarVenta(v, funnels)
        v.tipo = r.tipo
        v.tab_id = r.tab_id
        v.clasificacion_origen = r.origen
    }
}

/**
 * Reclama el envío de una conversión saliente ANTES de mandarla.
 *
 * El webhook anterior disparaba Meta CAPI y Google Ads sin consultar
 * `capi_sent_at` / `gads_sent_at`: solo los escribía DESPUÉS. Como Hotmart
 * reintenta, cada reintento mandaba la conversión otra vez y las plataformas
 * contaban compras que no existían.
 *
 * El `UPDATE ... WHERE ... IS NULL RETURNING id` es atómico: si devuelve cero
 * filas, otro proceso ya se lo llevó y hay que salir sin enviar.
 */
export async function reclamarEnvio(
    db: Db,
    ventaId: string,
    columna: 'capi_enviado_at' | 'gads_enviado_at',
): Promise<boolean> {
    const { data, error } = await db
        .from('hotmart_ventas')
        .update({ [columna]: new Date().toISOString() })
        .eq('id', ventaId)
        .is(columna, null)
        .select('id')
    if (error) return false
    return Array.isArray(data) && data.length > 0
}

/** Devuelve la reclamación si el envío acabó fallando, para poder reintentar. */
export async function liberarEnvio(
    db: Db,
    ventaId: string,
    columna: 'capi_enviado_at' | 'gads_enviado_at',
): Promise<void> {
    await db.from('hotmart_ventas').update({ [columna]: null }).eq('id', ventaId)
}

/**
 * Resuelve el puente `report_utm.clientes.public_cliente_id`.
 *
 * `hotmart_ventas` cuelga de `public.clientes`, pero el webhook llega con el id
 * de `report_utm.clientes`. Sin el puente enlazado la venta no se puede escribir
 * en la tabla de hechos — es el mismo fallo silencioso que `salud-fuentes`
 * reporta como crítico para el gasto y GA4.
 */
export async function publicClienteIdDe(db: Db, clienteReportUtmId: string): Promise<string | null> {
    const { data } = await db
        .schema('report_utm')
        .from('clientes')
        .select('public_cliente_id')
        .eq('id', clienteReportUtmId)
        .maybeSingle()
    return data?.public_cliente_id ?? null
}
