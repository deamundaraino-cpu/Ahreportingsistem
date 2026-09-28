import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateApiToken, requirePermission } from '@/lib/api-token-auth';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';
import { clientesVisiblesDe } from '@/lib/agent/context';

/**
 * GET /api/v1/campaigns
 *
 * Query params:
 *   - client_id (optional) filter by client UUID
 *
 * Headers:
 *   Authorization: Bearer <ads_token>
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await authenticateApiToken(request);
    requirePermission(ctx, 'read:campaigns');

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get('client_id');

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Solo los clientes que ve el usuario del token (rol o asignación).
    const visibles = await clientesVisiblesDe(supabase, ctx.userId);
    if (visibles !== 'all' && visibles.length === 0) {
      return NextResponse.json({ campaign_groups: [] });
    }

    let query = supabase
      .from('campaign_groups')
      .select(
        `
        id, nombre, descripcion, color, created_at,
        clientes!inner(id, nombre),
        campaign_group_mappings(id, campaign_id, campaign_name_pattern)
      `
      )
      .order('nombre', { ascending: true });

    if (visibles !== 'all') query = query.in('cliente_id', visibles);

    if (clientId) {
      query = query.eq('cliente_id', clientId);
    }

    const { data, error } = await query;

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    const groups = (data ?? []).map((g: any) => ({
      id: g.id,
      name: g.nombre,
      description: g.descripcion,
      color: g.color,
      client: { id: g.clientes.id, name: g.clientes.nombre },
      mappings: g.campaign_group_mappings,
      created_at: g.created_at,
    }));

    return NextResponse.json({ campaign_groups: groups });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'GET /api/v1/campaigns');
  }
}
