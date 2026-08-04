/**
 * Comprobaciones de la lectura de valores en los widgets
 * (`src/components/report-utm/bi/widgetDiagnostics.tsx`).
 *
 * Todo PURO.
 *
 * Es un archivo pequeño pero cubre un cambio de comportamiento VISIBLE, así que
 * conviene que esté fijado por tests:
 *
 * Antes, cada widget hacía `Number(row[metric] ?? 0)`. El motor SÍ devuelve
 * `null` cuando un ratio no se puede calcular (un CPL con 0 leads, un ROAS con 0
 * de gasto), y ese `?? 0` lo convertía en un 0. Como el render solo pinta «—» si
 * el valor es `null`, esa rama nunca se alcanzaba y el informe mostraba
 * «CPL 0» — que un cliente lee como «los leads salieron gratis».
 *
 *   npx tsx scripts/verify-bi-widget-values.ts
 */

import { readValue, readUnavailable } from '../src/components/report-utm/bi/widgetDiagnostics'
import type { QueryDiagnostics } from '../src/lib/report-utm/bi/diagnostics'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) console.log(`  ✓ ${nombre}`)
    else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`) }
}
function seccion(t: string) {
    console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`)
}

// ════════════════════════════════════════════════════════════
seccion('Un cero real sigue siendo un cero')
// ════════════════════════════════════════════════════════════

check('0 se lee como 0', readValue({ leads_count: 0 }, 'leads_count') === 0)
check('un número se lee tal cual', readValue({ spend: 1234.5 }, 'spend') === 1234.5)
check('un número en texto se convierte', readValue({ spend: '99' }, 'spend') === 99)
check('un negativo se conserva', readValue({ roi: -25 }, 'roi') === -25)

// ════════════════════════════════════════════════════════════
seccion('El null del motor NO se convierte en 0 (el bug)')
// ════════════════════════════════════════════════════════════

// Esto es lo que antes daba 0 y se mostraba como «CPL 0».
check('null explícito → null', readValue({ cpl: null }, 'cpl') === null)
check('un ROAS nulo → null, no 0', readValue({ roas: null }, 'roas') === null)
check('un valor no numérico → null', readValue({ x: 'hola' }, 'x') === null)

// ════════════════════════════════════════════════════════════
seccion('Compatibilidad: la clave ausente sigue valiendo 0')
// ════════════════════════════════════════════════════════════

// El motor omite claves que no se pidieron. Ahí un 0 no engaña, y cambiarlo
// movería informes existentes sin ninguna razón que dar al usuario.
check('clave ausente → 0', readValue({ otra: 5 }, 'leads_count') === 0)
check('sin fila → 0', readValue(undefined, 'leads_count') === 0)
check('undefined explícito → 0', readValue({ leads_count: undefined }, 'leads_count') === 0)
check('cadena vacía → 0', readValue({ leads_count: '' }, 'leads_count') === 0)

// ════════════════════════════════════════════════════════════
seccion('Con motivo en el diagnóstico, manda el motivo')
// ════════════════════════════════════════════════════════════

const meta: QueryDiagnostics = {
    unavailable: { spend: { kind: 'no_public_link' } },
    skipped: [{ sourceId: 'ads', sourceLabel: 'Anuncios (Meta / TikTok)', reason: { kind: 'no_public_link' } }],
    hasPublicLink: false,
}

const na = readUnavailable(meta, 'spend')
check('se detecta el motivo', na !== null)
check('el texto nombra la fuente',
    na!.text.includes('Anuncios (Meta / TikTok)'), na!.text)
check('el texto dice dónde arreglarlo',
    na!.text.includes('ficha del cliente'), na!.text)

// El caso completo: el motor devolvió 0 (porque no pudo leer la fuente) pero el
// widget NO debe mostrar ese 0.
check('un 0 con motivo se muestra como hueco',
    readValue({ spend: 0 }, 'spend', na) === null)
check('sin motivo, ese mismo 0 se muestra como 0',
    readValue({ spend: 0 }, 'spend', null) === 0)

seccion('Métricas sin motivo no se ven afectadas')
check('leads_count no tiene motivo', readUnavailable(meta, 'leads_count') === null)
check('y su valor se lee normal', readValue({ leads_count: 617 }, 'leads_count', null) === 617)

seccion('Varias claves: se explica la primera que falla')
const naVarias = readUnavailable(meta, ['leads_count', 'spend', 'cpl'])
check('encuentra el motivo aunque no sea la primera clave', naVarias?.kind === 'no_public_link')
check('sin diagnóstico no inventa motivos', readUnavailable(undefined, 'spend') === null)
check('con diagnóstico vacío tampoco',
    readUnavailable({ unavailable: {}, skipped: [], hasPublicLink: true }, 'spend') === null)

console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`)
process.exit(fallos === 0 ? 0 : 1)
