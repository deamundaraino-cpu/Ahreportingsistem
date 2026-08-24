import crypto from 'crypto';

/**
 * Valida la autenticidad de un webhook entrante.
 *
 * Soporta dos esquemas (lo que Hotmart actualmente envía depende del setup):
 *
 *   1. `x-hotmart-signature: <hmac-sha256-hex>` — HMAC del raw body con el
 *      webhook_secret. Es el patrón estándar de webhooks (recomendado).
 *
 *   2. `x-hotmart-hottok: <token>` o `?hottok=<token>` o `body.hottok` —
 *      string-compare contra el webhook_secret. Es el sistema legacy de
 *      Hotmart (token compartido).
 *
 * Devolvemos `true` si cualquiera de los dos valida correctamente.
 */
export function verifyWebhookSignature(args: {
  rawBody: string;
  secret: string;
  signatureHeader: string | null;
  hottokHeader: string | null;
  hottokQuery: string | null;
  payload: unknown;
}): { valid: boolean; method: 'hmac' | 'hottok' | null } {
  const { rawBody, secret, signatureHeader, hottokHeader, hottokQuery, payload } = args;

  if (!secret) return { valid: false, method: null };

  // 1) HMAC en header
  if (signatureHeader) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (timingSafeEqual(expected, signatureHeader.trim())) {
      return { valid: true, method: 'hmac' };
    }
  }

  // 2) hottok header / query / body
  const candidates = [
    hottokHeader,
    hottokQuery,
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).hottok
      : null,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c && timingSafeEqual(c.trim(), secret)) {
      return { valid: true, method: 'hottok' };
    }
  }

  return { valid: false, method: null };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
