import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';

// DELETE /api/tokens/[id] — revoke / delete a token
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
    }

    const { error } = await supabase
      .from('api_tokens')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'DELETE /api/tokens/[id]');
  }
}

// PATCH /api/tokens/[id] — toggle is_active
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
    }

    const body = await request.json();
    const { is_active } = body;

    if (typeof is_active !== 'boolean') {
      throw new ApiError('VALIDATION_ERROR', 'is_active must be a boolean', 400);
    }

    const { data, error } = await supabase
      .from('api_tokens')
      .update({ is_active })
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id, name, is_active')
      .single();

    if (error) throw new ApiError('DATABASE_ERROR', error.message, 500);

    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'PATCH /api/tokens/[id]');
  }
}
