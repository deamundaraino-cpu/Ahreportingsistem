import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateApiToken, requirePermission } from '@/lib/api-token-auth';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';
import { clientesVisiblesDe } from '@/lib/agent/context';

/**
 * GET /api/v1/clients
 *
 * Clientes que ve el usuario del token: todos si es admin/superadmin; si no,
 * los que tiene asignados. Los clientes son de la empresa, no de un usuario.
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

    const visibles = await clientesVisiblesDe(supabase, ctx.userId);
    if (visibles !== 'all' && visibles.length === 0) return NextResponse.json({ clients: [] });

    let query = supabase
      .from('clientes')
      .select('id, nombre, created_at')
      .order('nombre', { ascending: true });
    if (visibles !== 'all') query = query.in('id', visibles);
    const { data, error } = await query;

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    return NextResponse.json({ clients: data });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'GET /api/v1/clients');
  }
}
