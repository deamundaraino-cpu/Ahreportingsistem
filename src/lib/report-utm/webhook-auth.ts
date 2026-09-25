import crypto from 'crypto';

/**
 * Valida la autenticidad de un webhook entrante.
 *
 * Tres credenciales posibles:
 *
 *   1. `x-hotmart-signature: <hmac-sha256-hex>` — HMAC del raw body con NUESTRO
 *      secreto (`generateWebhookSecret`). Hotmart no firma así; se conserva
 *      para integraciones propias y para GHL.
 *
 *   2. El HOTTOK DE HOTMART, en la cabecera `x-hotmart-hottok` (o en
 *      `body.hottok`). Lo genera Hotmart por cuenta, es fijo y no se puede
 *      editar: el usuario lo copia de la pantalla de Webhook de Hotmart y lo
 *      pega en la tarjeta (`config.hottok_enc`).
 *
 *   3. `?hottok=<secreto>` en la URL, contra NUESTRO secreto. Es el esquema
 *      heredado: la única forma en que la validación podía pasar antes, porque
 *      comparaba la cabecera de Hotmart con un secreto que Hotmart no conoce.
 *      Se mantiene para no romper una URL ya registrada, pero no se anuncia:
 *      un secreto en la URL acaba en los logs.
 *
 * ── `hottokHotmart` presente o ausente ──────────────────────────
 * Con la clave presente (aunque valga null) el llamador es el webhook de
 * Hotmart: cabecera y body se comparan SOLO contra el hottok de Hotmart, y la
 * query SOLO contra nuestro secreto. Sin la clave (GHL, S2S) se conserva el
 * comportamiento de siempre: cabecera, query y body contra `secret`.
 *
 * Sin ninguna credencial configurada no valida nada.
 */
export function verifyWebhookSignature(args: {
  rawBody: string;
  /** Nuestro secreto. `null`/vacío si la integración no lo tiene. */
  secret: string | null;
  signatureHeader: string | null;
  hottokHeader: string | null;
  hottokQuery: string | null;
  payload: unknown;
  /** Hottok que generó Hotmart y pegó el usuario. Ver arriba. */
  hottokHotmart?: string | null;
}): { valid: boolean; method: 'hmac' | 'hottok' | 'query' | null } {
  const { rawBody, signatureHeader, hottokHeader, hottokQuery, payload } = args;
  const secret = args.secret || null;
  const modoHotmart = args.hottokHotmart !== undefined;
  const hottokHotmart = args.hottokHotmart?.trim() || null;

  if (!secret && !hottokHotmart) return { valid: false, method: null };

  // 1) HMAC en header (nuestro secreto)
  if (secret && signatureHeader) {
    const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    if (timingSafeEqual(expected, signatureHeader.trim())) {
      return { valid: true, method: 'hmac' };
    }
  }

  const deBody =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).hottok
      : null;

  if (modoHotmart) {
    // 2) Hottok de Hotmart: cabecera o body
    if (hottokHotmart) {
      for (const c of [hottokHeader, deBody]) {
        if (typeof c === 'string' && c && timingSafeEqual(c.trim(), hottokHotmart)) {
          return { valid: true, method: 'hottok' };
        }
      }
    }
    // 3) Heredado: `?hottok=` contra nuestro secreto
    if (secret && typeof hottokQuery === 'string' && hottokQuery) {
      if (timingSafeEqual(hottokQuery.trim(), secret)) return { valid: true, method: 'query' };
    }
    return { valid: false, method: null };
  }

  // Compatibilidad (GHL, S2S): cabecera / query / body contra nuestro secreto.
  if (secret) {
    for (const c of [hottokHeader, hottokQuery, deBody]) {
      if (typeof c === 'string' && c && timingSafeEqual(c.trim(), secret)) {
        return { valid: true, method: 'hottok' };
      }
    }
  }

  return { valid: false, method: null };
}

/**
 * Comparación en tiempo constante que tampoco filtra la LONGITUD: se comparan
 * los SHA-256 de ambos lados, que siempre miden 32 bytes. Con el
 * `crypto.timingSafeEqual` directo había que salir antes si las longitudes
 * diferían, y ese atajo medible decía cuánto mide el secreto.
 */
function timingSafeEqual(a: string, b: string): boolean {
  try {
    const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
    const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
    return crypto.timingSafeEqual(ha, hb) && a === b;
  } catch {
    return false;
  }
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
