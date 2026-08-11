// ════════════════════════════════════════════════════════════════
// Lectura y escritura tolerante de secretos cifrados
// ════════════════════════════════════════════════════════════════
//
// Los tokens OAuth de Hotmart se guardaban EN TEXTO PLANO dentro del JSONB
// `clientes.config_api` (`auth/hotmart/callback/route.ts:64-77`), y el
// `webhook_secret` de las integraciones igual (`migrations/012:69`) — mientras
// `src/lib/report-utm/encryption.ts` (AES-256-GCM) existía desde el principio y
// hasta se importaba en el archivo que escribe el secreto, sin usarse para eso.
//
// ── Migración PEREZOSA, no un script de datos ───────────────────
// Cada camino que lee un secreto lo reescribe cifrado si venía en claro. Cero
// downtime y, sobre todo, cero riesgo de dejar a un cliente sin conexión por un
// script masivo que falle a medias. `necesitaMigracion` es la señal.
//
// ── Por qué `leerSecreto` nunca lanza ───────────────────────────
// Si el descifrado falla (clave rotada, valor corrupto) devolver `null` deja al
// cliente sin Hotmart hasta que alguien lo note. Devolver el valor tal cual
// permite que siga funcionando si lo que había era texto plano, que es
// exactamente el estado del que venimos.

import { encrypt, decrypt } from './report-utm/encryption'

export { encrypt, decrypt }

/** Un valor cifrado tiene la forma `iv:authTag:ciphertext`, los tres en base64. */
const FORMATO_CIFRADO = /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/

export type SecretoLeido = {
    valor: string | null
    /** `true` si el valor venía en claro y conviene reescribirlo cifrado. */
    necesitaMigracion: boolean
}

/**
 * Lee un secreto que puede estar cifrado o en claro.
 *
 * @param cifrado  valor de la columna/clave cifrada (puede faltar)
 * @param plano    valor heredado en claro (puede faltar)
 */
export function leerSecreto(
    cifrado: string | null | undefined,
    plano: string | null | undefined,
): SecretoLeido {
    if (cifrado) {
        try {
            return { valor: decrypt(cifrado), necesitaMigracion: false }
        } catch {
            // Valor ilegible con la clave actual. Se cae al claro si lo hay: es
            // preferible a dejar la integración muerta sin aviso.
        }
    }
    if (plano) {
        // Un valor guardado en la clave "en claro" puede estar ya cifrado si
        // alguien lo migró a medias. Se intenta descifrar antes de darlo por
        // texto plano.
        if (FORMATO_CIFRADO.test(plano)) {
            try {
                return { valor: decrypt(plano), necesitaMigracion: false }
            } catch {
                // No lo era: sigue siendo texto plano.
            }
        }
        return { valor: plano, necesitaMigracion: true }
    }
    return { valor: null, necesitaMigracion: false }
}

/**
 * Cifra un secreto. Devuelve `null` si no hay valor.
 *
 * Lanza si `RUTM_ENCRYPTION_KEY` no está configurada: escribir un secreto en
 * claro pensando que se guardó cifrado es peor que fallar de forma visible.
 */
export function cifrarSecreto(valor: string | null | undefined): string | null {
    if (!valor) return null
    return encrypt(valor)
}

/** ¿Está disponible la clave de cifrado en este proceso? */
export function hayClaveDeCifrado(): boolean {
    const hex = process.env.RUTM_ENCRYPTION_KEY
    return Boolean(hex && hex.length === 64)
}
