/**
 * Comprobaciones de las correcciones de seguridad de Hotmart.
 *
 * Todo PURO: no toca la base ni la red. Las claves de prueba se inyectan en
 * `process.env` antes de la primera llamada (los módulos las leen de forma
 * perezosa, no al importarse).
 *
 *   npx tsx scripts/verify-hotmart-seguridad.ts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { firmarState, verificarState, VENTANA_STATE_MS } from '../src/lib/hotmart/oauth-state'
import { leerSecreto, cifrarSecreto, hayClaveDeCifrado } from '../src/lib/secretos'
import { encrypt } from '../src/lib/report-utm/encryption'

// Claves de PRUEBA. Los módulos leen el entorno de forma perezosa (dentro de la
// función, no al importarse), así que asignarlas aquí llega a tiempo.
process.env.CRON_SECRET = 'secreto-de-prueba-para-firmar-el-state'
process.env.RUTM_ENCRYPTION_KEY = 'a'.repeat(64)

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

const CLIENTE = '11111111-2222-3333-4444-555555555555'

// ════════════════════════════════════════════════════════════
seccion('El `state` de OAuth ya no es un UUID adivinable')
// ════════════════════════════════════════════════════════════
// AGUJERO REAL: `/api/auth/hotmart` mandaba `state = clientId` y el callback no
// lo validaba, en una ruta pública. Cualquiera que conociera un cliente_id podía
// completar el flujo con SU cuenta de Hotmart y quedarse con ese reporting.
const firmado = firmarState(CLIENTE)
check('el state no es el cliente_id a secas', firmado.state !== CLIENTE)
check('el state lleva firma', firmado.state.includes('.'))
check('el nonce es aleatorio y largo', firmado.nonce.length >= 32)
check('dos firmas del mismo cliente difieren',
    firmarState(CLIENTE).state !== firmarState(CLIENTE).state)

const ok = verificarState(firmado.state, firmado.nonce)
check('un state legítimo valida', ok.ok && ok.clienteId === CLIENTE)

// ── Los cuatro rechazos ─────────────────────────────────────
check('sin state → formato',
    (() => { const r = verificarState(null, firmado.nonce); return !r.ok && r.motivo === 'formato' })())
check('state sin punto → formato',
    (() => { const r = verificarState('basura', firmado.nonce); return !r.ok && r.motivo === 'formato' })())

// El ataque directo: pasar el cliente_id como state, que es lo que aceptaba
// la versión anterior.
check('el cliente_id crudo como state se RECHAZA',
    (() => { const r = verificarState(CLIENTE, firmado.nonce); return !r.ok })())

// Firma manipulada.
const [carga] = firmado.state.split('.')
check('firma alterada → firma',
    (() => {
        const r = verificarState(`${carga}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, firmado.nonce)
        return !r.ok && r.motivo === 'firma'
    })())

// Carga alterada (otro cliente) manteniendo la firma vieja.
const otroCliente = Buffer.from(JSON.stringify({
    clienteId: '99999999-9999-9999-9999-999999999999',
    nonce: firmado.nonce,
    exp: Date.now() + 60_000,
}), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
check('cambiar el cliente_id invalida la firma',
    (() => {
        const sinFirma = firmado.state.split('.')[1]
        const r = verificarState(`${otroCliente}.${sinFirma}`, firmado.nonce)
        return !r.ok && r.motivo === 'firma'
    })())

// Caducidad.
const viejo = firmarState(CLIENTE, Date.now() - VENTANA_STATE_MS - 1000)
check('un state caducado → expirado',
    (() => { const r = verificarState(viejo.state, viejo.nonce); return !r.ok && r.motivo === 'expirado' })())

// Doble envío: sin la cookie del navegador que abrió el flujo, no vale.
check('sin cookie → nonce',
    (() => { const r = verificarState(firmado.state, null); return !r.ok && r.motivo === 'nonce' })())
check('cookie de otro flujo → nonce',
    (() => {
        const otro = firmarState(CLIENTE)
        const r = verificarState(firmado.state, otro.nonce)
        return !r.ok && r.motivo === 'nonce'
    })())

// ════════════════════════════════════════════════════════════
seccion('Secretos: cifrado con migración perezosa')
// ════════════════════════════════════════════════════════════
check('hay clave de cifrado', hayClaveDeCifrado())

const claro = 'token-de-hotmart-en-claro-abc123'
const cifrado = cifrarSecreto(claro)!
check('cifrar produce algo distinto del original', cifrado !== claro)
check('el formato es iv:tag:ciphertext', cifrado.split(':').length === 3)

const leidoCifrado = leerSecreto(cifrado, null)
check('un valor cifrado se descifra', leidoCifrado.valor === claro)
check('un valor cifrado no pide migración', leidoCifrado.necesitaMigracion === false)

const leidoClaro = leerSecreto(null, claro)
check('un valor en claro se devuelve tal cual', leidoClaro.valor === claro)
// Es la señal que dispara la reescritura cifrada al vuelo, sin script de datos.
check('un valor en claro SÍ pide migración', leidoClaro.necesitaMigracion === true)

check('sin ningún valor → null', leerSecreto(null, null).valor === null)
check('sin valor no pide migración', leerSecreto(null, null).necesitaMigracion === false)

// Un secreto corrupto no debe dejar la integración muerta en silencio: se cae al
// valor en claro si lo hay.
const leidoCorrupto = leerSecreto('esto:no:descifra', claro)
check('un cifrado corrupto cae al claro', leidoCorrupto.valor === claro)
check('y marca que hay que migrarlo', leidoCorrupto.necesitaMigracion === true)
check('un cifrado corrupto sin respaldo → null',
    leerSecreto('esto:no:descifra', null).valor === null)

// Alguien pudo haber dejado un valor ya cifrado en la columna "en claro".
const leidoMezclado = leerSecreto(null, cifrado)
check('un cifrado guardado en la columna en claro se descifra igual',
    leidoMezclado.valor === claro)
check('y no se marca para migrar dos veces', leidoMezclado.necesitaMigracion === false)

// El cifrado es no determinista (IV aleatorio): dos cifrados del mismo valor
// difieren, y los dos descifran bien.
const c1 = encrypt(claro), c2 = encrypt(claro)
check('el cifrado usa IV aleatorio', c1 !== c2)
check('ambos descifran al mismo valor',
    leerSecreto(c1, null).valor === leerSecreto(c2, null).valor)

// ════════════════════════════════════════════════════════════
seccion('Guardarraíl estático: ningún token de Hotmart en claro')
// ════════════════════════════════════════════════════════════
// Si alguien vuelve a escribir `hotmart_access_token: <valor>` en una llamada a
// la base, este check falla antes del merge. Escribir `: null` sí vale: es
// justamente cómo se limpian las claves heredadas.
// Se recorre el sistema de ficheros, no `git grep`: éste solo ve lo trackeado,
// así que con archivos nuevos sin añadir la comprobación pasaría por no
// encontrar nada. Un test que pasa porque no busca es peor que no tenerlo.
const archivos: string[] = []
function recorrer(dir: string) {
    let entradas: string[]
    try { entradas = readdirSync(dir) } catch { return }
    for (const e of entradas) {
        if (e === 'node_modules' || e === '.next' || e === '.git' || e === 'dist') continue
        const p = join(dir, e)
        let st: ReturnType<typeof statSync>
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) { recorrer(p); continue }
        // Los propios scripts de verificación quedan fuera: auditan la tabla
        // ENTERA a propósito, que es justo lo que la regla prohíbe al resto.
        if (/^verify-.*\.ts$/.test(e)) continue
        if (/\.(ts|tsx)$/.test(e)) archivos.push(p)
    }
}
for (const raiz of ['src', 'sync-worker/src', 'scripts']) recorrer(raiz)
check('el recorrido encuentra archivos', archivos.length > 100, String(archivos.length))

// El lookahead va PEGADO a los dos puntos, no después de `\s*`: con `\s*(?!null)`
// el motor retrocede a cero espacios, comprueba la aserción contra el espacio en
// blanco (que no es «null»), y `: null` acaba dando positivo.
const ESCRITURA_EN_CLARO = /hotmart_(access|refresh)_token\s*:(?!\s*null\b)\s*[^,\n}\s]/
const culpables: string[] = []
for (const f of archivos) {
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((linea, i) => {
        // La declaración del tipo y los comentarios no son escrituras.
        if (/^\s*(\/\/|\*|\/\*)/.test(linea)) return
        if (/@deprecated|\?:\s*string|ESCRITURA_EN_CLARO/.test(linea)) return
        if (ESCRITURA_EN_CLARO.test(linea)) culpables.push(`${f}:${i + 1}`)
    })
}
check('nadie escribe un token de Hotmart en claro', culpables.length === 0, culpables.join(', '))

// ════════════════════════════════════════════════════════════
seccion('Guardarraíl estático: el cron de tokens está programado')
// ════════════════════════════════════════════════════════════
// El endpoint existía desde hacía meses y la documentación afirmaba que corría,
// pero NO estaba en ningún planificador. Este check impide que vuelva a
// quedarse huérfano.
const RUTA_CRON = 'refresh-hotmart-tokens'
const scheduler = readFileSync('sync-worker/src/index.ts', 'utf8')
check('el scheduler del VPS lo invoca', scheduler.includes(RUTA_CRON))
const workflow = readFileSync('.github/workflows/sync-fallback.yml', 'utf8')
check('el workflow de respaldo lo invoca', workflow.includes(RUTA_CRON))

// ════════════════════════════════════════════════════════════
seccion('Guardarraíl estático: hotmart_ventas siempre acotada por cliente')
// ════════════════════════════════════════════════════════════
// Mismo patrón que `verify-ads-daily.ts` con `.eq('nivel'`: una lectura sin
// filtro de cliente mezcla las ventas de todos y el número parece plausible.
const sinCliente: string[] = []
for (const f of archivos) {
    const texto = readFileSync(f, 'utf8')
    const re = /from\(['"]hotmart_ventas['"]\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(texto))) {
        // La sentencia encadenada ocupa varias líneas: se mira una ventana, no
        // solo la línea del `from`.
        const trozo = texto.slice(m.index, m.index + 600)
        if (!/\.eq\(\s*['"]cliente_id['"]/.test(trozo) && !/\.eq\(\s*['"]id['"]/.test(trozo)) {
            sinCliente.push(`${f}:${texto.slice(0, m.index).split(/\r?\n/).length}`)
        }
    }
}
check('toda lectura de hotmart_ventas fija cliente_id (o id)',
    sinCliente.length === 0, sinCliente.join(', '))

// ════════════════════════════════════════════════════════════
console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
process.exit(fallos === 0 ? 0 : 1)
