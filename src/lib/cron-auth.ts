/**
 * Cron job authentication
 * Validates CRON_SECRET from request headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { ApiError } from './error-handler';

/**
 * Authenticate cron job request
 * Expects Bearer token in Authorization header matching CRON_SECRET env var
 */
export function authenticateCron(request: NextRequest): void {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  // Fallar cerrado: sin secreto configurado NO se atiende la petición. Antes se
  // permitía "por compatibilidad", lo que dejaba los endpoints de cron abiertos
  // si la env var faltaba en algún entorno.
  if (!cronSecret) {
    throw new ApiError('INVALID_CONFIG', 'CRON_SECRET no configurado en el servidor', 503);
  }

  // Validate authorization header format
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(
      'UNAUTHORIZED',
      'Missing or invalid Authorization header. Expected: Bearer {CRON_SECRET}',
      401,
      { headerFormat: 'Bearer {token}' }
    );
  }

  // Extract token from header
  const token = authHeader.slice(7); // Remove 'Bearer ' prefix

  // Compare tokens using constant-time comparison to prevent timing attacks
  if (!constantTimeCompare(token, cronSecret)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid CRON_SECRET', 401);
  }
}

/**
 * Variante sin throw para route handlers: devuelve la respuesta de error
 * (503 si falta el secreto, 401 si el Bearer no coincide) o `null` si la
 * petición está autenticada. Reemplaza el patrón inline permisivo
 * `if (process.env.CRON_SECRET && authHeader !== ...)`, que dejaba el endpoint
 * abierto cuando la env var no estaba definida.
 */
export function requireCronAuth(request: Request): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET no configurado en el servidor' },
      { status: 503 }
    );
  }
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !constantTimeCompare(token, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

/**
 * Constant-time string comparison to prevent timing attacks
 * Reference: Node.js crypto.timingSafeEqual behavior
 */
function constantTimeCompare(a: string, b: string): boolean {
  // If lengths differ, strings are definitely not equal
  // But continue comparing to avoid leaking length info
  if (a.length !== b.length) {
    // Se recorre igualmente y se descarta el resultado: el objetivo es gastar
    // el mismo tiempo que en el caso de longitudes iguales, no el valor.
    let _result = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      _result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return false;
  }

  // Equal lengths: compare each character
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
