/**
 * Comprobaciones de la conversión a día calendario Colombia
 * (`src/lib/colombia-date.ts`).
 *
 * Todo PURO.
 *
 * ── Lo que protege ──────────────────────────────────────────────────────
 * Dos errores que venían de tratar un instante como si fuera una fecha:
 *
 *   1. `String(created_at).slice(0, 10)` daba el día UTC, mientras el gasto se
 *      agrupa por `metricas_diarias.fecha` (día Colombia). Un lead de las 20:00
 *      en Colombia se comparaba contra el gasto del día siguiente.
 *   2. `.gte('created_at', dateFrom + 'T00:00:00')` mandaba un literal SIN zona a
 *      una columna `timestamptz`: «desde el 1 de julio» significaba en realidad
 *      «desde las 19:00 del 30 de junio, hora Colombia».
 *
 * Medido: 26,9% de los leads de julio 2026 caían en el día equivocado.
 *
 *   npx tsx scripts/verify-tz-colombia.ts
 */

import {
    colombiaDateOf, colombiaRangeBounds, addDaysISO, colombiaToday,
    COLOMBIA_UTC_OFFSET, COLOMBIA_UTC_OFFSET_MS,
} from '../src/lib/colombia-date'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

// ════════════════════════════════════════════════════════════
seccion('El desfase es UTC-5 fijo')
// ════════════════════════════════════════════════════════════

check('COLOMBIA_UTC_OFFSET_MS son 5 horas', COLOMBIA_UTC_OFFSET_MS === 5 * 3600 * 1000)
check('el offset ISO es -05:00', COLOMBIA_UTC_OFFSET === '-05:00')

// ════════════════════════════════════════════════════════════
seccion('colombiaDateOf: la franja que causaba el bug')
// ════════════════════════════════════════════════════════════

// EL caso: 20:00 en Colombia = 01:00 UTC del día siguiente. Antes, `slice(0,10)`
// daba el 16; el gasto de ese lead está el 15.
check('20:00 COL del 15 (= 01:00 UTC del 16) es el día 15',
    colombiaDateOf('2026-07-16T01:00:00+00:00') === '2026-07-15',
    colombiaDateOf('2026-07-16T01:00:00+00:00'))
check('23:59 COL del 15 sigue siendo el día 15',
    colombiaDateOf('2026-07-16T04:59:00Z') === '2026-07-15')
check('00:00 COL del 16 ya es el día 16',
    colombiaDateOf('2026-07-16T05:00:00Z') === '2026-07-16')
check('19:00 COL del 15 (el borde exacto) es el día 15',
    colombiaDateOf('2026-07-16T00:00:00Z') === '2026-07-15')
check('18:59 COL del 15 es el día 15',
    colombiaDateOf('2026-07-15T23:59:00Z') === '2026-07-15')

seccion('colombiaDateOf: el resto del día no se mueve')
check('mediodía UTC = mismo día', colombiaDateOf('2026-07-15T12:00:00Z') === '2026-07-15')
check('07:00 UTC = mismo día', colombiaDateOf('2026-07-15T07:00:00Z') === '2026-07-15')
// Antes de las 05:00 UTC todavía es el día ANTERIOR en Colombia.
check('03:00 UTC del 15 es el día 14 en Colombia',
    colombiaDateOf('2026-07-15T03:00:00Z') === '2026-07-14')

seccion('colombiaDateOf: formatos y bordes')
check('acepta el formato de PostgREST (+00:00)',
    colombiaDateOf('2026-07-15T18:30:00+00:00') === '2026-07-15')
check('acepta microsegundos',
    colombiaDateOf('2026-07-15T18:30:00.123456+00:00') === '2026-07-15')
check('acepta un objeto Date',
    colombiaDateOf(new Date('2026-07-16T01:00:00Z')) === '2026-07-15')
// Una fecha de calendario NO tiene hora: convertirla la retrasaría un día. Es el
// caso de `metricas_diarias.fecha`, que ya viene en día Colombia.
check('un yyyy-MM-dd suelto se devuelve intacto (NO se retrasa)',
    colombiaDateOf('2026-07-15') === '2026-07-15')
check('null → cadena vacía', colombiaDateOf(null) === '')
check('undefined → cadena vacía', colombiaDateOf(undefined) === '')
check('cadena vacía → cadena vacía', colombiaDateOf('') === '')
check('basura no revienta', typeof colombiaDateOf('no-es-fecha') === 'string')

seccion('Cambio de mes y de año')
// Los 266 leads que cruzan el borde del mes son exactamente este caso.
check('01/08 01:00 UTC es el 31/07 en Colombia',
    colombiaDateOf('2026-08-01T01:00:00Z') === '2026-07-31')
check('01/01 02:00 UTC es el 31/12 del año anterior',
    colombiaDateOf('2027-01-01T02:00:00Z') === '2026-12-31')
// Año bisiesto: 2028 lo es.
check('01/03 03:00 UTC de un año bisiesto es el 29/02',
    colombiaDateOf('2028-03-01T03:00:00Z') === '2028-02-29')

// ════════════════════════════════════════════════════════════
seccion('colombiaRangeBounds: límites de la consulta')
// ════════════════════════════════════════════════════════════

const b = colombiaRangeBounds('2026-07-01', '2026-07-31')
check('el límite inferior lleva la zona explícita',
    b.gte === '2026-07-01T00:00:00-05:00', b.gte)
// Superior EXCLUSIVO al día siguiente: con `<= 23:59:59` se perdía cualquier fila
// caída en ese último segundo, y con microsegundos ocurre de verdad.
check('el límite superior es el día SIGUIENTE, exclusivo',
    b.lt === '2026-08-01T00:00:00-05:00', b.lt)

// Comprobación de que los límites encierran exactamente el rango pretendido.
const dentro = (iso: string) => Date.parse(iso) >= Date.parse(b.gte) && Date.parse(iso) < Date.parse(b.lt)
check('00:00 COL del 1 de julio está DENTRO', dentro('2026-07-01T05:00:00Z'))
check('23:59:59.999 COL del 31 de julio está DENTRO', dentro('2026-08-01T04:59:59.999Z'))
check('00:00 COL del 1 de agosto está FUERA', !dentro('2026-08-01T05:00:00Z'))
check('23:00 COL del 30 de junio está FUERA', !dentro('2026-07-01T04:00:00Z'))
// Y esto es lo que ANTES entraba de más: el literal sin zona equivalía a UTC, así
// que las 19:00-23:59 del 30 de junio se colaban dentro de «julio».
check('las 20:00 COL del 30 de junio ya NO se cuelan en julio',
    !dentro('2026-07-01T01:00:00Z'))

seccion('Rangos de un solo día')
const un = colombiaRangeBounds('2026-07-15', '2026-07-15')
const dentroUn = (iso: string) => Date.parse(iso) >= Date.parse(un.gte) && Date.parse(iso) < Date.parse(un.lt)
check('un día cubre 24 horas exactas',
    Date.parse(un.lt) - Date.parse(un.gte) === 24 * 3600 * 1000)
check('00:00 COL entra', dentroUn('2026-07-15T05:00:00Z'))
check('23:30 COL entra', dentroUn('2026-07-16T04:30:00Z'))
check('00:00 COL del día siguiente no entra', !dentroUn('2026-07-16T05:00:00Z'))

seccion('addDaysISO')
check('suma un día', addDaysISO('2026-07-15', 1) === '2026-07-16')
check('cruza el mes', addDaysISO('2026-07-31', 1) === '2026-08-01')
check('cruza el año', addDaysISO('2026-12-31', 1) === '2027-01-01')
check('resta', addDaysISO('2026-08-01', -1) === '2026-07-31')
check('29 de febrero bisiesto', addDaysISO('2028-02-28', 1) === '2028-02-29')
check('no bisiesto salta al 1 de marzo', addDaysISO('2027-02-28', 1) === '2027-03-01')
check('una fecha mal formada se devuelve intacta', addDaysISO('xx', 1) === 'xx')

seccion('Coherencia con colombiaToday, que ya existía')
// `colombiaToday` ya usaba el mismo desplazamiento: las dos funciones tienen que
// coincidir, o «hoy» y el día de un lead de hoy podrían discrepar.
const ahora = new Date()
check('colombiaDateOf(ahora) === colombiaToday()',
    colombiaDateOf(ahora) === colombiaToday(ahora),
    `${colombiaDateOf(ahora)} vs ${colombiaToday(ahora)}`)

// Barrido de las 24 horas de un día: cada instante tiene que caer en el día que
// dicta el desfase, sin excepciones.
let malas = 0
for (let h = 0; h < 24; h++) {
    const iso = `2026-07-15T${String(h).padStart(2, '0')}:00:00Z`
    const esperado = h < 5 ? '2026-07-14' : '2026-07-15'
    if (colombiaDateOf(iso) !== esperado) malas++
}
check('las 24 horas del día caen donde deben (corte en 05:00 UTC)', malas === 0,
    `${malas} hora(s) mal`)

console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
process.exit(fallos === 0 ? 0 : 1)
