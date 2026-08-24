// Qué métricas del catálogo tienen datos para un cliente y rango.
// El editor de widgets lo usa para marcar "Sin datos en el rango" y evitar que
// se configuren scorecards que van a mostrar 0 sin explicación.

import { NextRequest, NextResponse } from 'next/server';
import { getMetricAvailability } from '@/lib/report-utm/bi-availability';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  try {
    const data = await getMetricAvailability({
      cliente_id: sp.get('cliente_id') ?? undefined,
      date_from: sp.get('date_from') ?? undefined,
      date_to: sp.get('date_to') ?? undefined,
    });
    return NextResponse.json({ data });
  } catch (err) {
    console.error('[bi/metrics-availability]', err);
    // Fallo suave: sin el mapa el editor simplemente no marca nada.
    return NextResponse.json({ data: {} });
  }
}
