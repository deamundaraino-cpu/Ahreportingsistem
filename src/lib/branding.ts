import 'server-only'
import { unstable_cache } from 'next/cache'
import { createAdminClient } from '@/utils/supabase/server'

export const BRANDING_CACHE_TAG = 'branding'

export interface Branding {
    app_name?: string
    app_tag?: string
    utm_name?: string
    utm_tag?: string
    logo_url?: string
    favicon_url?: string
    colors?: { primary?: string; secondary?: string }
}

/**
 * Un color CSS aceptable para inyectar en una custom property.
 *
 * El valor lo edita un admin desde el panel y acaba dentro de un bloque
 * `<style>` con `dangerouslySetInnerHTML`, así que un `;` o un `}` sueltos
 * escapan del contexto y permiten reescribir la hoja de estilos entera. Solo
 * dejamos pasar formas de color inequívocas.
 */
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla|oklch|lab|lch)\([0-9a-zA-Z.,%\s/+-]{1,64}\))$/

export function colorSeguro(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const v = value.trim()
    return COLOR_RE.test(v) ? v : undefined
}

/**
 * URL de logo aceptable dentro de `url('...')`. Además de exigir http(s) o una
 * ruta interna, se codifica para que ni comillas ni paréntesis puedan cerrar la
 * función `url()`.
 */
/**
 * Los cuatro caracteres que pueden cerrar el `url('...')` y salirse del
 * contexto CSS. Ojo: `encodeURIComponent` NO los codifica — están en su
 * conjunto de caracteres "no reservados"—, así que hay que mapearlos a mano.
 */
const ESCAPES_CSS: Record<string, string> = {
    "'": '%27',
    '"': '%22',
    '(': '%28',
    ')': '%29',
}

function neutralizarCierresDeUrl(s: string): string {
    return s.replace(/['"()]/g, c => ESCAPES_CSS[c])
}

export function urlLogoSegura(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const v = value.trim()
    if (!v) return undefined

    // Ruta interna: viene en crudo, así que se codifica antes de escapar.
    if (v.startsWith('/')) return neutralizarCierresDeUrl(encodeURI(v))

    try {
        const u = new URL(v)
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
        // `URL.toString()` ya devuelve la forma codificada: volver a pasarle
        // `encodeURI` convertiría cada `%` en `%25` y rompería la URL.
        return neutralizarCierresDeUrl(u.toString())
    } catch {
        return undefined
    }
}

async function leerBranding(): Promise<Branding | null> {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) return null

    try {
        const supabase = await createAdminClient()
        const { data } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'branding')
            .single()
        return (data?.value ?? null) as Branding | null
    } catch (e) {
        console.error('[branding] no se pudo leer system_settings.branding:', e)
        return null
    }
}

/**
 * Branding de la instancia, cacheado.
 *
 * Antes esta misma consulta se hacía tres veces por carga de página
 * (`generateMetadata`, `RootLayout` y el layout de grupo), sin caché y contra el
 * service role. Cambia como mucho cuando un admin toca Configuración, así que
 * se cachea y se invalida explícitamente con `revalidateTag(BRANDING_CACHE_TAG)`
 * desde la acción que lo guarda.
 */
export const getBranding = unstable_cache(leerBranding, ['branding'], {
    tags: [BRANDING_CACHE_TAG],
    revalidate: 300,
})
