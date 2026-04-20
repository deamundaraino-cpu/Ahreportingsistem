import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateApiToken, requirePermission } from '@/lib/api-token-auth';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';

/**
 * GET /api/v1/clients
 *
 * Returns all clients belonging to the authenticated user.
 *
 * Headers:
 *   Authorization: Bearer <ads_token>
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await authenticateApiToken(request);
    requirePermission(ctx, 'read:clients');

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data, error } = await supabase
      .from('clientes')
      .select('id, nombre, created_at')
      .eq('user_id', ctx.userId)
      .order('nombre', { ascending: true });

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    return NextResponse.json({ clients: data });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'GET /api/v1/clients');
  }
}
