// ════════════════════════════════════════════════════════════════
// Cliente HTTP de Hotmart
// ════════════════════════════════════════════════════════════════
//
// Toda la lógica de red de Hotmart vivía INLINE en `src/app/api/worker/route.ts`
// (~330 líneas), duplicada en dos bucles de paginación casi idénticos con las
// mismas guardas escritas dos veces. Aquí está una sola vez.
//
// Lo que NO se toca: `hotmartFetch` de `src/lib/rate-limit.ts`, que ya
// implementa el reintento con backoff ante 429/5xx y errores de red.
//
// ── La señal que importa: `completo` ────────────────────────────
// `paginarHotmart` devuelve si consumió TODAS las páginas. Es lo que el worker
// usa como `apiSuccess` para decidir si puede pisar los datos ya guardados. Un
// fallo a media paginación con `completo: true` escribiría un total bajo que
// parece real — exactamente el fallo silencioso que las guardas anti-cero del
// worker existen para evitar.

import { hotmartFetch } from '../rate-limit'
import { cifrarSecreto, leerSecreto } from '../secretos'
import type { PaginaHotmart } from './tipos'

export const HOTMART_AUTH_BASE = 'https://api-sec-vlc.hotmart.com'
export const HOTMART_API_BASE = 'https://developers.hotmart.com'

/** 60 × 100 = 6.000 transacciones por tanda. El tope que ya usaba el worker. */
export const MAX_PAGINAS = 60

/**
 * Config de Hotmart dentro de `clientes.config_api`.
 *
 * Las claves `*_enc` son la versión cifrada; las planas son las heredadas. Se
 * lee de la que haya (`leerSecreto`) y se reescribe cifrada al vuelo: migración
 * perezosa, sin script de datos que pueda dejar a un cliente sin conexión.
 */
export type ConfigHotmart = {
    hotmart_auth_mode?: string
    hotmart_access_token_enc?: string | null
    hotmart_refresh_token_enc?: string | null
    hotmart_basic_enc?: string | null
    /** @deprecated en claro — se migra a `hotmart_access_token_enc` al leerla. */
    hotmart_access_token?: string | null
    /** @deprecated en claro — se migra a `hotmart_refresh_token_enc` al leerla. */
    hotmart_refresh_token?: string | null
    /** @deprecated en claro — se migra a `hotmart_basic_enc` al leerla. */
    hotmart_basic?: string | null
    hotmart_token_expires_at?: string | null
    hotmart_client_id?: string | null
    hotmart_client_secret?: string | null
    hotmart_token?: string | null
    [k: string]: unknown
}

/** Access token descifrado, si lo hay. */
export function accessTokenDe(config: ConfigHotmart) {
    return leerSecreto(config.hotmart_access_token_enc, config.hotmart_access_token)
}

/** Refresh token descifrado, si lo hay. */
export function refreshTokenDe(config: ConfigHotmart) {
    return leerSecreto(config.hotmart_refresh_token_enc, config.hotmart_refresh_token)
}

/**
 * ¿Este cliente tiene Hotmart configurado?
 *
 * Existía DOS veces con criterios distintos: el dashboard miraba
 * `hotmart_basic || hotmart_token` (`dashboard/_actions.ts:625`) y el worker
 * `hotmart_auth_mode === 'hotconnect' ? tokens : basic|client_id+secret`
 * (`worker/route.ts:382-384`). Un cliente conectado por HotConnect quedaba
 * fuera de `availablePlatforms` en el dashboard, y con ello perdía la
 * resolución de los alias `$facturacion_*` del motor de fórmulas.
 */
export function hotmartConectado(config: ConfigHotmart | null | undefined): boolean {
    if (!config) return false
    if (config.hotmart_auth_mode === 'hotconnect') {
        return Boolean(
            config.hotmart_access_token_enc || config.hotmart_access_token ||
            config.hotmart_refresh_token_enc || config.hotmart_refresh_token,
        )
    }
    return Boolean(
        config.hotmart_basic_enc ||
        config.hotmart_basic ||
        config.hotmart_token ||
        (config.hotmart_client_id && config.hotmart_client_secret),
    )
}

/** Credencial Basic derivada de la config, si la hay. */
export function basicDeConfig(config: ConfigHotmart): string | null {
    const { valor } = leerSecreto(config.hotmart_basic_enc, config.hotmart_basic)
    if (valor) return valor
    if (config.hotmart_client_id && config.hotmart_client_secret) {
        return Buffer.from(
            `${config.hotmart_client_id}:${config.hotmart_client_secret}`,
        ).toString('base64')
    }
    return null
}

export type ResultadoToken = {
    token: string | null
    /** Motivo legible cuando no hay token. Va al log de la plataforma. */
    motivo?: string
    /** Config a persistir tras refrescar. `null` si no cambió nada. */
    parche?: Record<string, unknown> | null
}

/**
 * Consigue un access token válido, sea cual sea el modo de conexión.
 *
 * No escribe en la base: devuelve el `parche` para que lo persista quien tenga
 * el cliente de BD a mano. Así esta función es pura respecto a la persistencia
 * y se puede llamar desde el worker, el cron y el backfill sin que cada uno
 * reinvente el read-modify-write de `config_api` (que además pisaba cambios
 * concurrentes: por eso existe ahora la RPC `fusionar_config_api`).
 */
export async function obtenerToken(config: ConfigHotmart): Promise<ResultadoToken> {
    if (config.hotmart_auth_mode === 'hotconnect') {
        const access = accessTokenDe(config)
        const refresh = refreshTokenDe(config)

        const expiraMs = config.hotmart_token_expires_at
            ? new Date(config.hotmart_token_expires_at).getTime()
            : 0
        const vencido =
            !access.valor ||
            !expiraMs ||
            Number.isNaN(expiraMs) ||
            expiraMs - Date.now() < 60_000

        if (!vencido) {
            // Migración perezosa: si el token estaba en claro, se devuelve cifrado
            // en el parche para que quien persista lo reescriba bien.
            return {
                token: access.valor,
                parche: access.necesitaMigracion
                    ? {
                        hotmart_access_token_enc: cifrarSecreto(access.valor),
                        hotmart_access_token: null,
                        ...(refresh.necesitaMigracion && refresh.valor
                            ? {
                                hotmart_refresh_token_enc: cifrarSecreto(refresh.valor),
                                hotmart_refresh_token: null,
                            }
                            : {}),
                    }
                    : null,
            }
        }

        const clientId = process.env.HOTMART_APP_CLIENT_ID
        const clientSecret = process.env.HOTMART_APP_CLIENT_SECRET
        if (!refresh.valor || !clientId || !clientSecret) {
            return { token: null, motivo: 'HotConnect sin refresh_token o app no configurada' }
        }

        const params = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refresh.valor,
        })
        const res = await fetch(`${HOTMART_AUTH_BASE}/security/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        })
        const data = await res.json().catch(() => ({}))
        if (!data?.access_token) {
            return { token: null, motivo: `Error refrescando HotConnect: ${JSON.stringify(data)}` }
        }
        const expiresIn = Number(data.expires_in) || 6 * 60 * 60
        return {
            token: String(data.access_token),
            parche: {
                hotmart_access_token_enc: cifrarSecreto(String(data.access_token)),
                hotmart_access_token: null,
                // Hotmart rota el refresh token: quedarse con el viejo caduca la
                // conexión a la siguiente vuelta.
                hotmart_refresh_token_enc: cifrarSecreto(data.refresh_token ?? refresh.valor),
                hotmart_refresh_token: null,
                hotmart_token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
                hotmart_connection_status: 'connected',
            },
        }
    }

    const basic = basicDeConfig(config)
    if (!basic) return { token: null, motivo: 'Sin credenciales Basic ni client_id/secret' }

    const res = await fetch(
        `${HOTMART_AUTH_BASE}/security/oauth/token?grant_type=client_credentials`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: `Basic ${basic}`,
            },
        },
    )
    const data = await res.json().catch(() => ({}))
    if (!data?.access_token) {
        return { token: null, motivo: `Error client_credentials: ${JSON.stringify(data)}` }
    }
    return { token: String(data.access_token), parche: null }
}

export type ResultadoPaginado<T> = {
    items: T[]
    /** `false` si quedó alguna página sin leer, por el motivo que sea. */
    completo: boolean
    motivo?: string
    paginas: number
}

/**
 * Recorre un endpoint paginado de Hotmart hasta agotarlo.
 *
 * Las tres guardas son las del worker, ahora en un solo sitio:
 *
 *  1. Error en la respuesta (`error` o `message` en el cuerpo) → se corta.
 *  2. Tope de páginas → un `next_page_token` que Hotmart devolviera siempre
 *     dejaría el bucle girando hasta matar la función.
 *  3. `next_page_token` REPETIDO → el mismo bucle infinito, disfrazado.
 *
 * En los tres casos `completo` es `false`, y ese es el dato que impide que un
 * día a medias pise las ventas ya guardadas.
 */
export async function paginarHotmart<T>(opts: {
    ruta: string
    params: Array<[string, string]>
    token: string
    maxPaginas?: number
    log?: (msg: string) => void
}): Promise<ResultadoPaginado<T>> {
    const max = opts.maxPaginas ?? MAX_PAGINAS
    const items: T[] = []
    const vistos = new Set<string>()
    let pageToken = ''
    let paginas = 0

    for (;;) {
        if (paginas >= max) {
            const motivo = `Tope de ${max} páginas en ${opts.ruta}`
            opts.log?.(`[Hotmart] ${motivo} — datos incompletos, se preservan los previos.`)
            return { items, completo: false, motivo, paginas }
        }
        paginas++

        const url = new URL(`${HOTMART_API_BASE}${opts.ruta}`)
        for (const [k, v] of opts.params) url.searchParams.append(k, v)
        if (pageToken) url.searchParams.append('page_token', pageToken)

        const res = await hotmartFetch(url.toString(), {
            headers: { Authorization: `Bearer ${opts.token}` },
        })
        const data = (await res.json()) as PaginaHotmart<T>

        if (data?.error || data?.message) {
            const motivo = `Error de API en ${opts.ruta}: ${JSON.stringify(data)}`
            opts.log?.(`[Hotmart] ${motivo}`)
            return { items, completo: false, motivo, paginas }
        }

        if (Array.isArray(data?.items)) items.push(...data.items)

        const siguiente = data?.page_info?.next_page_token
        if (!siguiente) return { items, completo: true, paginas }

        if (vistos.has(siguiente)) {
            const motivo = `next_page_token repetido en ${opts.ruta}`
            opts.log?.(`[Hotmart] ${motivo} — se corta la paginación.`)
            return { items, completo: false, motivo, paginas }
        }
        vistos.add(siguiente)
        pageToken = siguiente
    }
}

/**
 * Ventana de un día de calendario colombiano en epoch ms.
 *
 * Hotmart filtra `sales/history` por epoch en milisegundos. Colombia es UTC-5
 * fijo, así que el ancla `-05:00` es exacta todo el año.
 */
export function ventanaDiaColombia(fecha: string): { inicio: number; fin: number } {
    return {
        inicio: new Date(`${fecha}T00:00:00.000-05:00`).getTime(),
        fin: new Date(`${fecha}T23:59:59.999-05:00`).getTime(),
    }
}
