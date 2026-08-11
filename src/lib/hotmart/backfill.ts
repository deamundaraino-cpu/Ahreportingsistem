// ════════════════════════════════════════════════════════════════
// Backfill histórico de ventas de Hotmart
// ════════════════════════════════════════════════════════════════
//
// Rellena `public.hotmart_ventas` hacia atrás. Lo usan dos llamadores que
// comparten este motor:
//
//   • `scripts/backfill-hotmart.ts` — carga inicial larga, fuera de Vercel.
//   • `/api/worker/hotmart` — el job de la cola, para el goteo y las
//     reclasificaciones.
//
// ── IDEMPOTENCIA ────────────────────────────────────────────────
// La da `UNIQUE (cliente_id, transaction_id)` más la guarda de orden por
// `evento_ts` de `guardar_hotmart_venta`. Para el origen API el `evento_ts` es
// la fecha de aprobación, que es más VIEJA que la de cualquier webhook
// posterior: un backfill nunca pisa un dato llegado en vivo.

import { addDaysISO, colombiaToday } from '../colombia-date'
import { obtenerToken } from './cliente'
import type { ConfigHotmart } from './cliente'
import { sincronizarDiaHotmart } from './sync'
import { cargarFunnels } from './persistencia'
import type { FunnelHotmart } from './clasificador'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any

export type OpcionesBackfill = {
    /** Solo cuenta transacciones; no escribe ni una fila. */
    soloContar?: boolean
    /** Corta tras N días procesados (presupuesto de tiempo del job). */
    maxDias?: number
    /** Se consulta antes de cada día: permite parar limpio al agotar el tiempo. */
    hayTiempo?: () => boolean
    log?: (msg: string) => void
}

export type ResultadoBackfill = {
    clienteId: string
    desde: string
    hasta: string
    /** Último día COMPLETADO. Es el cursor para reanudar. */
    ultimoDia: string | null
    dias: number
    transacciones: number
    escritas: number
    descartadas: number
    /** Días cuya paginación quedó incompleta: hay que repetirlos. */
    diasIncompletos: string[]
    sinTasa: number
    monedas: string[]
    error?: string
}

/**
 * Recorre un rango de días hacia atrás y sincroniza cada uno.
 *
 * Se va de HOY hacia el pasado, no al revés, para que una carga interrumpida
 * deje primero lo reciente — que es lo que se mira.
 */
export async function backfillRango(
    db: Db,
    cliente: { id: string; nombre?: string; config_api: ConfigHotmart },
    desde: string,
    hasta: string,
    opts: OpcionesBackfill = {},
): Promise<ResultadoBackfill> {
    const log = opts.log ?? (() => {})
    const base: ResultadoBackfill = {
        clienteId: cliente.id, desde, hasta, ultimoDia: null,
        dias: 0, transacciones: 0, escritas: 0, descartadas: 0,
        diasIncompletos: [], sinTasa: 0, monedas: [],
    }

    const auth = await obtenerToken(cliente.config_api)
    if (!auth.token) {
        return { ...base, error: auth.motivo ?? 'Sin token de Hotmart' }
    }
    if (auth.parche) {
        await db.rpc('fusionar_config_api', { p_cliente_id: cliente.id, p_parche: auth.parche })
    }

    const funnels: FunnelHotmart[] = await cargarFunnels(db, cliente.id)
    const monedas = new Set<string>()
    const hoy = colombiaToday()
    // Pedir el futuro solo genera días vacíos y gasta cuota.
    const tope = hasta > hoy ? hoy : hasta

    for (let fecha = tope; fecha >= desde; fecha = addDaysISO(fecha, -1)) {
        if (opts.maxDias && base.dias >= opts.maxDias) break
        if (opts.hayTiempo && !opts.hayTiempo()) {
            log(`[backfill] Presupuesto agotado en ${fecha} — se reanuda desde aquí.`)
            break
        }

        if (opts.soloContar) {
            // Modo sondeo: se llama a la API pero NO se escribe ni una fila. Es
            // el paso previo para dimensionar el volumen antes de tocar la base.
            const r = await sincronizarDiaHotmart(
                db, cliente.id, fecha, auth.token, funnels, () => {}, { persistir: false },
            )
            base.transacciones += r.ventas
            base.dias++
            base.ultimoDia = fecha
            if (!r.completo) base.diasIncompletos.push(fecha)
            continue
        }

        const r = await sincronizarDiaHotmart(db, cliente.id, fecha, auth.token, funnels, log)
        base.dias++
        base.transacciones += r.ventas
        base.escritas += r.escritas
        base.descartadas += r.descartadas
        base.sinTasa += r.sin_tasa
        for (const m of r.monedas) monedas.add(m)
        if (!r.completo) base.diasIncompletos.push(fecha)
        base.ultimoDia = fecha
    }

    base.monedas = Array.from(monedas)
    return base
}

/**
 * Cuenta transacciones sin escribir nada.
 *
 * Existe porque la decisión de alcance de este trabajo es de ALMACENAMIENTO: la
 * base está en 449 MB de 500 MB. Antes de cargar un histórico conviene saber
 * cuántas filas son. Medido el 2026-08-10 sobre `metricas_diarias`: 671
 * transacciones en 5 meses, es decir ~3 MB/año con índices. Cabe holgado, pero
 * el sondeo sigue siendo el paso correcto si el volumen de un cliente cambia.
 */
export async function contarRango(
    db: Db,
    cliente: { id: string; nombre?: string; config_api: ConfigHotmart },
    desde: string,
    hasta: string,
    log?: (msg: string) => void,
): Promise<ResultadoBackfill> {
    return backfillRango(db, cliente, desde, hasta, { soloContar: true, log })
}

/** Estimación de espacio, en MB, para un número de filas. */
export function estimarMb(filas: number, conPayload = true): number {
    // ~600 B de fila + ~1 KB de raw_payload TOASTeado + ~250 B de índices.
    const bytes = filas * (600 + (conPayload ? 1024 : 0) + 250)
    return Math.round((bytes / 1024 / 1024) * 10) / 10
}
