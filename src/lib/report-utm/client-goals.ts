'use client'

// Carga de las metas de un cliente para los semáforos de los scorecards.
//
// Un informe puede tener muchos scorecards y todos comparten el mismo cliente,
// así que la promesa se cachea por cliente: una sola petición por informe, sin
// tener que pasar las metas por props a través de secciones y widgets.

import type { ClienteGoals } from './bi-metadata'

const cache = new Map<string, Promise<ClienteGoals>>()

export function fetchClienteGoals(clienteId: string): Promise<ClienteGoals> {
    const hit = cache.get(clienteId)
    if (hit) return hit

    const p = fetch(`/api/report-utm/clientes/${clienteId}/goals`)
        .then(r => (r.ok ? r.json() : { data: {} }))
        .then(j => (j.data ?? {}) as ClienteGoals)
        .catch(() => ({} as ClienteGoals))

    cache.set(clienteId, p)
    return p
}

/** Invalida la caché tras guardar metas nuevas. */
export function clearClienteGoalsCache(clienteId?: string): void {
    if (clienteId) cache.delete(clienteId)
    else cache.clear()
}
