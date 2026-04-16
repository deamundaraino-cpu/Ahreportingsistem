/**
 * Cron job authentication
 * Validates CRON_SECRET from request headers
 */

import { NextRequest } from 'next/server';
import { ApiError } from './error-handler';

/**
 * Authenticate cron job request
 * Expects Bearer token in Authorization header matching CRON_SECRET env var
 */
export function authenticateCron(request: NextRequest): void {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  // If no secret is configured, allow (for backward compatibility)
  if (!cronSecret) {
    console.warn('CRON_SECRET not configured. Cron requests will be allowed without authentication.');
    return;
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
    throw new ApiError(
      'UNAUTHORIZED',
      'Invalid CRON_SECRET',
      401
    );
  }
}

/**
 * Constant-time string comparison to prevent timing attacks
 * Reference: Node.js crypto.timingSafeEqual behavior
 */
function constantTimeCompare(a: string, b: string): boolean {
  // If lengths differ, strings are definitely not equal
  // But continue comparing to avoid leaking length info
  if (a.length !== b.length) {
    // Still do full comparison to prevent timing attack
    let result = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
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
