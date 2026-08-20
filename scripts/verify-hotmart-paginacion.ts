/**
 * Guardas de `paginarHotmart`: qué respuestas de la API NO pueden pasar por
 * buenas.
 *
 * Todo PURO: se sustituye `globalThis.fetch` por un doble, no se toca la red ni
 * la base.
 *
 *   npx tsx scripts/verify-hotmart-paginacion.ts
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────
 * `completo` es la única señal que impide que un día a medias pise las ventas
 * ya guardadas: el worker la convierte en `apiSuccess` y, si es `false`, omite
 * las columnas de Hotmart del upsert.
 *
 * El agujero que cierra este archivo: `bufferedFetch` deja `parsed: null`
 * cuando el cuerpo no es JSON. La versión anterior de `paginarHotmart` solo
 * miraba el cuerpo, así que una página HTML de un WAF o un 502 de un proxy
 * pasaba las tres guardas (`data?.error` indefinido, `items` no es array,
 * `next_page_token` tampoco) y devolvía `completo: true` con CERO items. El
 * worker lo leía como "un día sin ventas" y lo escribía sobre las ventas
 * reales.
 */

import { clasificarErrorHotmart, paginarHotmart } from '../src/lib/hotmart/cliente'
import { setRetryDeadline } from '../src/lib/rate-limit'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

// Los reintentos de 429/5xx harían esperar hasta 30s por caso. Un deadline ya
// vencido hace que `withRetry` devuelva la primera respuesta tal cual.
setRetryDeadline(Date.now() - 1)

type Respuesta = { status?: number; body: string; headers?: Record<string, string> }

const fetchReal = globalThis.fetch
/** URLs que recibió el doble, para comprobar qué se envió de verdad. */
let urlsVistas: string[] = []

/** Sustituye `fetch` por una cola de respuestas; la última se repite. */
function simular(respuestas: Respuesta[]) {
    urlsVistas = []
    let i = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
        urlsVistas.push(String(url))
        const r = respuestas[Math.min(i++, respuestas.length - 1)]
        return new Response(r.body, {
            status: r.status ?? 200,
            headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
        })
    }) as typeof fetch
}

const pagina = (items: unknown[], next?: string) =>
    JSON.stringify({ items, page_info: next ? { next_page_token: next } : {} })

const RUTA = '/payments/api/v1/sales/history'
const correr = () => paginarHotmart<unknown>({
    ruta: RUTA,
    params: [['start_date', '1786770000000'], ['max_results', '100']],
    token: 'token-de-prueba',
})

async function main() {
    // ════════════════════════════════════════════════════════════
    seccion('El camino feliz sigue funcionando')
    // ════════════════════════════════════════════════════════════
    simular([{ body: pagina([{ a: 1 }, { a: 2 }]) }])
    let r = await correr()
    check('una página se lee entera', r.completo && r.items.length === 2)
    check('sin familia de error', r.familia === undefined)

    simular([{ body: pagina([{ a: 1 }], 'tok2') }, { body: pagina([{ a: 2 }]) }])
    r = await correr()
    check('dos páginas se concatenan', r.completo && r.items.length === 2, `items=${r.items.length}`)
    check('la 2ª petición lleva page_token', urlsVistas[1]?.includes('page_token=tok2'))

    // ════════════════════════════════════════════════════════════
    seccion('EL BUG: 200 con un cuerpo que no es la página esperada')
    // ════════════════════════════════════════════════════════════
    // Antes: `completo: true` con 0 items → el worker escribía ceros encima de
    // las ventas reales. Es el fallo silencioso más caro posible.
    simular([{ body: '<html><body>Access denied</body></html>' }])
    r = await correr()
    check('una página HTML NO se toma por un día sin ventas', !r.completo)
    check('se clasifica como respuesta inválida', r.familia === 'respuesta_invalida', String(r.familia))
    check('no inventa items', r.items.length === 0)

    simular([{ body: JSON.stringify({ resultado: 'otra forma' }) }])
    r = await correr()
    check('un JSON sin `items` tampoco pasa', !r.completo && r.familia === 'respuesta_invalida')

    simular([{ body: '' }])
    r = await correr()
    check('un cuerpo vacío tampoco pasa', !r.completo && r.familia === 'respuesta_invalida')

    // Y el caso que de verdad duele: la 1ª página bien y la 2ª rota.
    simular([{ body: pagina([{ a: 1 }], 'tok2') }, { body: 'no-json' }])
    r = await correr()
    check('un fallo en la 2ª página marca TODO incompleto', !r.completo)
    check('los items de la 1ª página se conservan (pero no se agregan)', r.items.length === 1)

    // ════════════════════════════════════════════════════════════
    seccion('El status HTTP se mira ANTES que el cuerpo')
    // ════════════════════════════════════════════════════════════
    const errorHotmart = JSON.stringify({
        error: 'invalid_parameter',
        error_description: 'The request was unacceptable, often due to a misconfigured parameter.',
    })

    simular([{ status: 400, body: errorHotmart }])
    r = await correr()
    check('400 → incompleto', !r.completo)
    check('400 → familia `parametros`', r.familia === 'parametros', String(r.familia))
    check('el motivo incluye el status HTTP', /HTTP 400/.test(r.motivo ?? ''), r.motivo)
    // Sin la query no se puede reproducir la petición que falló.
    check('el motivo incluye la query enviada',
        /start_date=1786770000000/.test(r.motivo ?? ''), r.motivo)
    check('el motivo NO incluye el token', !/token-de-prueba/.test(r.motivo ?? ''))

    simular([{ status: 401, body: JSON.stringify({ error: 'unauthorized' }) }])
    r = await correr()
    check('401 → familia `credenciales`', !r.completo && r.familia === 'credenciales')

    simular([{ status: 403, body: JSON.stringify({ error: 'forbidden' }) }])
    r = await correr()
    check('403 → familia `credenciales`', !r.completo && r.familia === 'credenciales')

    simular([{ status: 429, body: '{}', headers: { 'retry-after': '30' } }])
    r = await correr()
    check('429 → familia `limite`', !r.completo && r.familia === 'limite')
    check('el motivo recoge retry-after', /retry-after=30/.test(r.motivo ?? ''), r.motivo)

    simular([{ status: 503, body: 'Service Unavailable' }])
    r = await correr()
    check('503 → familia `indisponible`', !r.completo && r.familia === 'indisponible')

    // Un 200 con error en el cuerpo: Hotmart lo hace en algunos endpoints.
    simular([{ status: 200, body: errorHotmart }])
    r = await correr()
    check('200 con `error` en el cuerpo tampoco pasa', !r.completo)

    // ════════════════════════════════════════════════════════════
    seccion('Las guardas de bucle infinito siguen en pie')
    // ════════════════════════════════════════════════════════════
    simular([{ body: pagina([{ a: 1 }], 'siempre-el-mismo') }])
    r = await correr()
    check('un next_page_token repetido corta', !r.completo)
    check('y lo dice en el motivo', /repetido/i.test(r.motivo ?? ''), r.motivo)

    let n = 0
    urlsVistas = []
    globalThis.fetch = (async () => {
        n++
        return new Response(pagina([{ a: n }], `tok-${n}`), {
            status: 200, headers: { 'content-type': 'application/json' },
        })
    }) as typeof fetch
    r = await paginarHotmart<unknown>({ ruta: RUTA, params: [], token: 't', maxPaginas: 3 })
    check('el tope de páginas corta', !r.completo && r.paginas === 3, `paginas=${r.paginas}`)
    check('y lo dice en el motivo', /Tope de 3/.test(r.motivo ?? ''), r.motivo)

    // ════════════════════════════════════════════════════════════
    seccion('Clasificación de status → familia')
    // ════════════════════════════════════════════════════════════
    check('400 → parametros', clasificarErrorHotmart(400).familia === 'parametros')
    check('422 → parametros', clasificarErrorHotmart(422).familia === 'parametros')
    check('404 → parametros', clasificarErrorHotmart(404).familia === 'parametros')
    check('401 → credenciales', clasificarErrorHotmart(401).familia === 'credenciales')
    check('403 → credenciales', clasificarErrorHotmart(403).familia === 'credenciales')
    check('429 → limite', clasificarErrorHotmart(429).familia === 'limite')
    check('500 → indisponible', clasificarErrorHotmart(500).familia === 'indisponible')
    check('502 → indisponible', clasificarErrorHotmart(502).familia === 'indisponible')
    check('418 → desconocido', clasificarErrorHotmart(418).familia === 'desconocido')
    // La etiqueta la lee un humano en la campanita: no puede venir vacía.
    check('toda familia trae etiqueta legible',
        [400, 401, 403, 404, 422, 429, 500, 418].every(s => clasificarErrorHotmart(s).etiqueta.length > 10))
    check('un 400 y un 401 NO dicen lo mismo',
        clasificarErrorHotmart(400).etiqueta !== clasificarErrorHotmart(401).etiqueta)
}

main()
    .catch((e) => { console.error(e); fallos++ })
    .finally(() => {
        globalThis.fetch = fetchReal
        console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
        process.exit(fallos === 0 ? 0 : 1)
    })
