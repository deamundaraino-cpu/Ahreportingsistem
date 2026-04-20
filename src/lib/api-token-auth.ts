import { createHash } from 'crypto';
import { randomBytes } from 'crypto';
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { ApiError } from './error-handler';

export type TokenPermission =
  | 'read:metrics'
  | 'read:clients'
  | 'read:campaigns'
  | 'read:reports'
  | 'write:sync';

export const ALL_PERMISSIONS: TokenPermission[] = [
  'read:metrics',
  'read:clients',
  'read:campaigns',
  'read:reports',
  'write:sync',
];

export const PERMISSION_LABELS: Record<TokenPermission, string> = {
  'read:metrics': 'Leer métricas diarias',
  'read:clients': 'Leer clientes',
  'read:campaigns': 'Leer grupos de campañas',
  'read:reports': 'Leer reportes mensuales',
  'write:sync': 'Disparar sincronización de datos',
};

export interface TokenContext {
  userId: string;
  tokenId: string;
  permissions: TokenPermission[];
}

/** Generate a new API token. Returns the plain token (shown once) and its hash + prefix. */
export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const raw = randomBytes(24).toString('base64url'); // 32-char URL-safe string
  const token = `ads_${raw}`;
  const hash = createHash('sha256').update(token).digest('hex');
  const prefix = token.slice(0, 12); // "ads_" + 8 chars
  return { token, hash, prefix };
}

/** Validate a Bearer token from the request and return its context. */
export async function authenticateApiToken(request: NextRequest): Promise<TokenContext> {
  const authHeader = request.headers.get('authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    throw new ApiError('UNAUTHORIZED', 'Missing or invalid Authorization header. Expected: Bearer <token>', 401);
  }

  const token = authHeader.slice(7);

  if (!token.startsWith('ads_')) {
    throw new ApiError('UNAUTHORIZED', 'Invalid token format. Expected token starting with ads_', 401);
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data, error } = await supabase
    .from('api_tokens')
    .select('id, user_id, permissions, expires_at, is_active')
    .eq('token_hash', tokenHash)
    .single();

  if (error || !data) {
    throw new ApiError('UNAUTHORIZED', 'Invalid API token', 401);
  }

  if (!data.is_active) {
    throw new ApiError('UNAUTHORIZED', 'This API token has been revoked', 401);
  }

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    throw new ApiError('UNAUTHORIZED', 'This API token has expired', 401);
  }

  // Update last_used_at asynchronously (don't block the request)
  supabase
    .from('api_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {});

  return {
    userId: data.user_id,
    tokenId: data.id,
    permissions: data.permissions as TokenPermission[],
  };
}

export function requirePermission(context: TokenContext, permission: TokenPermission): void {
  if (!context.permissions.includes(permission)) {
    throw new ApiError(
      'UNAUTHORIZED',
      `Insufficient permissions. This token requires the '${permission}' scope.`,
      403
    );
  }
}
