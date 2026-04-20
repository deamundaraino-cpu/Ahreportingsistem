import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateApiToken, requirePermission } from '@/lib/api-token-auth';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';

/**
 * GET /api/v1/metrics
 *
 * Query params:
 *   - client_id   (required) UUID of the client
 *   - from        (optional) YYYY-MM-DD, defaults to 30 days ago
 *   - to          (optional) YYYY-MM-DD, defaults to today
 *   - limit       (optional) max rows, defaults to 90
 *
 * Headers:
 *   Authorization: Bearer <ads_token>
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await authenticateApiToken(request);
    requirePermission(ctx, 'read:metrics');

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get('client_id');

    if (!clientId) {
      throw new ApiError('VALIDATION_ERROR', 'client_id query parameter is required', 400);
    }

    const today = new Date();
    const defaultFrom = new Date(today);
    defaultFrom.setDate(today.getDate() - 30);

    const from = searchParams.get('from') ?? defaultFrom.toISOString().split('T')[0];
    const to = searchParams.get('to') ?? today.toISOString().split('T')[0];
    const limit = Math.min(Number(searchParams.get('limit') ?? '90'), 365);

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Verify the client belongs to this token's user
    const { data: client } = await supabase
      .from('clientes')
      .select('id, nombre')
      .eq('id', clientId)
      .eq('user_id', ctx.userId)
      .single();

    if (!client) {
      throw new ApiError('NOT_FOUND', 'Client not found or access denied', 404);
    }

    const { data, error } = await supabase
      .from('metricas_diarias')
      .select('fecha, meta_spend, meta_impressions, meta_clicks, ga_sessions, hotmart_pagos_iniciados, ventas_principal, ventas_bump, ventas_upsell')
      .eq('cliente_id', clientId)
      .gte('fecha', from)
      .lte('fecha', to)
      .order('fecha', { ascending: true })
      .limit(limit);

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    return NextResponse.json({
      client: { id: client.id, name: client.nombre },
      period: { from, to },
      metrics: data,
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'GET /api/v1/metrics');
  }
}
