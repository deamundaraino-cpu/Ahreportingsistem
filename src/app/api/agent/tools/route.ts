/**
 * Catálogo de herramientas del agente, para documentarlo en la interfaz.
 *
 * Autenticación por cookie de sesión: es material de pantalla interna, no una
 * vía de datos. Devuelve el catálogo COMPLETO —nombres, descripciones, scopes y
 * parámetros—, no el que puede usar quien pregunta: el panel necesita enseñar
 * también lo que haría falta para desbloquear cada herramienta. Los datos de
 * clientes siguen saliendo solo por `/api/mcp`, con token y con sus filtros.
 */

import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';
import { catalogoPublico } from '@/lib/agent/catalogo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError('UNAUTHORIZED', 'Authentication required', 401);
    }

    return NextResponse.json({ tools: catalogoPublico() });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'GET /api/agent/tools');
  }
}
