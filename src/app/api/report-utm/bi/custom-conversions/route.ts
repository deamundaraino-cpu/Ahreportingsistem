import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import type { MetaCustomConvMeta } from '@/lib/report-utm/bi-metadata';

export const dynamic = 'force-dynamic';

/**
 * Conversiones personalizadas de Meta de un cliente, para ofrecerlas en el BI
 * como métricas (token `metacc:<clave>`).
 *
 *   GET /api/report-utm/bi/custom-conversions?cliente_id=<report_utm id>
 *
 * Salen de `meta_conversiones_catalogo`, el mismo catálogo que ya usaba el
 * dashboard clásico: el worker lo mantiene con el nombre real de cada conversión
 * en Meta, así que aquí se ve lo mismo que en el Administrador de anuncios.
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

    const { data, error } = await admin
      .from('meta_conversiones_catalogo')
      .select('conversion_key, label, last_seen')
      .eq('cliente_id', publicId)
      .order('label');
    if (error) return NextResponse.json({ data: [] });

    const vistas = new Set<string>();
    const out: MetaCustomConvMeta[] = [];
    for (const r of (data ?? []) as Array<{ conversion_key: string; label: string | null }>) {
      if (!r.conversion_key || vistas.has(r.conversion_key)) continue;
      vistas.add(r.conversion_key);
      out.push({ key: r.conversion_key, label: r.label || r.conversion_key });
    }
    return NextResponse.json({ data: out });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
