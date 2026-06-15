import { verifyWebhookSignature } from './webhook-auth'

/**
 * Verifica la firma HMAC-SHA256 de una petición S2S entrante.
 *
 * El cliente PHP firma el body con:
 *   $sig = hash_hmac('sha256', $body, $s2sToken);
 *
 * Y envía:
 *   X-Rutm-S2S-Signature: <hex>
 */
export function verifyS2SSignature(
    rawBody: string,
    secret: string,
    signatureHeader: string | null,
): boolean {
    const { valid } = verifyWebhookSignature({
        rawBody,
        secret,
        signatureHeader,
        hottokHeader: null,
        hottokQuery: null,
        payload: null,
    })
    return valid
}
