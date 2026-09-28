import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import { ga4EvAlias, type Ga4EventoMeta } from '@/lib/report-utm/bi-metadata';

export const dynamic = 'force-dynamic';

/**
 * Eventos clave de GA4 de un cliente, para ofrecerlos en el BI como métricas
 * (token `ga4ev:<evento>`, alias `ga4ev__<evento>` en fórmulas).
 *
 *   GET /api/report-utm/bi/ga4-events?cliente_id=<report_utm id>
 *
 * Salen de `ga4_estado.eventos` (migración 097): el job `ga4` guarda ahí cada
 * evento clave visto en la propiedad y su última fecha con actividad.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const clienteId = req.nextUrl.searchParams.get('cliente_id');
  if (!clienteId) return NextResponse.json({ data: [] });

  try {
    const admin = await createAdminClient();
    const { data: rtm } = await admin
      .schema('report_utm')
      .from('clientes')
      .select('public_cliente_id')
      .eq('id', clienteId)
      .maybeSingle();
    const publicId = rtm?.public_cliente_id;
    if (!publicId) return NextResponse.json({ data: [] });

    const { data } = await admin
      .from('ga4_estado')
      .select('eventos')
      .eq('cliente_id', publicId)
      .maybeSingle();
    const eventos = (data?.eventos ?? {}) as Record<string, string>;
    const out: Ga4EventoMeta[] = Object.entries(eventos)
      .filter(([k]) => /^[a-z][a-z0-9_]*$/i.test(k))
      .sort((a, b) => String(b[1]).localeCompare(String(a[1])))
      .map(([key, ultima]) => ({
        key,
        label: key,
        alias: ga4EvAlias(key),
        ultima_actividad: ultima ?? null,
      }));
    return NextResponse.json({ data: out });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
