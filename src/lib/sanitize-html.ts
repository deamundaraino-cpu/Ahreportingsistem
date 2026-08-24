import DOMPurify from 'isomorphic-dompurify'

/**
 * Saneado del HTML de las bitácoras.
 *
 * El contenido lo produce TipTap en el editor y se guarda tal cual, pero se
 * pinta con `dangerouslySetInnerHTML` en `/p/[token]`, que es una página
 * pública, sin sesión y servida con `frame-ancestors *`. Sin sanear, cualquiera
 * que pueda escribir una bitácora inyecta script en el informe de un cliente.
 *
 * La allowlist es exactamente lo que genera el editor
 * (`components/editor/RichTextEditor.tsx`: starter-kit + link + image). Todo lo
 * demás se cae, incluidos `<script>`, `<style>`, `<iframe>` y cualquier
 * atributo `on*`.
 */
const ALLOWED_TAGS = [
    'p', 'br', 'hr',
    'strong', 'b', 'em', 'i', 'u', 's', 'code', 'mark',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'blockquote', 'pre',
    'a', 'img',
    'span', 'div',
]

const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt', 'title', 'width', 'height', 'class']

/**
 * Sanea HTML de bitácora. Se llama en los dos extremos a propósito: al guardar,
 * para que lo almacenado ya sea seguro, y al renderizar, para que las filas que
 * ya estaban en la base de datos antes de este cambio también queden cubiertas.
 */
export function sanitizarHtmlBitacora(html: string | null | undefined): string {
    if (!html) return ''
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
        // `javascript:` y `data:` fuera; solo esquemas de navegación e imágenes.
        ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|\/|#)/i,
        FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
        FORBID_ATTR: ['style', 'srcset', 'formaction', 'form'],
    })
}
