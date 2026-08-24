/**
 * Comprobaciones de las mitigaciones de la auditoría de seguridad:
 *   · saneado del HTML de bitácoras (XSS almacenado en /p/[token])
 *   · validación de color y logo del branding (inyección CSS en layout.tsx)
 */
import { sanitizarHtmlBitacora } from '../src/lib/sanitize-html'
import { colorSeguro, urlLogoSegura } from '../src/lib/branding'

let ok = 0, fail = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) { ok++; console.log('  ✓ ' + nombre) }
    else { fail++; console.log('  ✗ ' + nombre + (detalle ? '  → ' + detalle : '')) }
}

console.log('\n── Saneado de bitácoras ─────────────────────────────────────')
const xss = [
    '<img src=x onerror="alert(1)">',
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe src="https://evil.test"></iframe>',
    '<div onclick="alert(1)">hola</div>',
    '<style>body{display:none}</style>',
    '<form action="https://evil.test"><input name="p"></form>',
]
for (const entrada of xss) {
    const s = sanitizarHtmlBitacora(entrada)
    const limpio = !/onerror|onclick|<script|<iframe|<style|<form|<input|javascript:/i.test(s)
    check(`neutraliza ${entrada.slice(0, 34)}`, limpio, s)
}

console.log('\n── El contenido legítimo de TipTap sobrevive ────────────────')
const legitimo = '<p>Hola <strong>mundo</strong> y <em>algo</em></p><ul><li>uno</li></ul><a href="https://ejemplo.test">enlace</a>'
const salida = sanitizarHtmlBitacora(legitimo)
check('conserva <strong>', salida.includes('<strong>'))
check('conserva la lista', salida.includes('<li>uno</li>'))
check('conserva el enlace https', salida.includes('href="https://ejemplo.test"'))
check('vacío devuelve cadena vacía', sanitizarHtmlBitacora(null) === '')

console.log('\n── Colores del branding ────────────────────────────────────')
check('acepta #hex', colorSeguro('#3b82f6') === '#3b82f6')
check('acepta rgb()', colorSeguro('rgb(59, 130, 246)') === 'rgb(59, 130, 246)')
check('acepta oklch()', colorSeguro('oklch(0.7 0.1 250)') === 'oklch(0.7 0.1 250)')
check('rechaza el escape con ;', colorSeguro('#fff; } body { display:none') === undefined)
check('rechaza url() con expresión', colorSeguro('red; background:url(https://evil.test/x)') === undefined)
check('rechaza cadena arbitraria', colorSeguro('nope') === undefined)
check('rechaza no-string', colorSeguro(42) === undefined)

console.log('\n── URL del logo ────────────────────────────────────────────')
check('acepta https', urlLogoSegura('https://cdn.test/logo.png') === 'https://cdn.test/logo.png')
check('acepta ruta interna', urlLogoSegura('/logo.png') === '/logo.png')
check('rechaza javascript:', urlLogoSegura('javascript:alert(1)') === undefined)
check('rechaza data:', urlLogoSegura('data:text/html,<script>alert(1)</script>') === undefined)
const escape = urlLogoSegura("https://cdn.test/x.png'); } body { display:none } .x{ background:url('")
check('escapa comillas y paréntesis que cerrarían url()', !escape || !/['()]/.test(escape), escape)
check('rechaza basura', urlLogoSegura('no es una url') === undefined)

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`)
process.exit(fail === 0 ? 0 : 1)
