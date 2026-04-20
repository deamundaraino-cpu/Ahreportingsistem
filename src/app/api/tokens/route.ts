import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/utils/supabase/server';
import { generateApiToken, ALL_PERMISSIONS, type TokenPermission } from '@/lib/api-token-auth';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';

const createTokenSchema = z.object({
  name: z.string().min(1).max(80),
  permissions: z.array(z.enum([
    'read:metrics', 'read:clients', 'read:campaigns', 'read:reports', 'write:sync'
  ])).min(1).default(['read:metrics', 'read:clients', 'read:campaigns']),
  expires_at: z.string().datetime().optional().nullable(),
});

// GET /api/tokens — list tokens for current user
export async function GET() {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
    }

    const { data, error } = await supabase
      .from('api_tokens')
      .select('id, name, token_prefix, permissions, last_used_at, expires_at, is_active, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    return NextResponse.json({ tokens: data });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'GET /api/tokens');
  }
}

// POST /api/tokens — create new token
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
    }

    const body = await request.json();
    const parsed = createTokenSchema.safeParse(body);

    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', 'Invalid request body', 400, parsed.error.issues);
    }

    const { name, permissions, expires_at } = parsed.data;
    const { token, hash, prefix } = generateApiToken();

    const { data, error } = await supabase
      .from('api_tokens')
      .insert({
        user_id: user.id,
        name,
        token_prefix: prefix,
        token_hash: hash,
        permissions,
        expires_at: expires_at ?? null,
        is_active: true,
      })
      .select('id, name, token_prefix, permissions, expires_at, is_active, created_at')
      .single();

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    // Return the plain token ONLY on creation — it is never stored
    return NextResponse.json({ ...data, token }, { status: 201 });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'POST /api/tokens');
  }
}
