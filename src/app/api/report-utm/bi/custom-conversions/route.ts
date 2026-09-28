import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import type { MetaCustomConvMeta } from '@/lib/report-utm/bi-metadata';
import { leerCatalogoConversiones } from '@/lib/meta/conversiones-catalogo';

export const dynamic = 'force-dynamic';

/**
 * Conversiones personalizadas de Meta de un cliente, para ofrecerlas en el BI
 * como métricas (token `metacc:<clave>`).
 *
 *   GET /api/report-utm/bi/custom-conversions?cliente_id=<report_utm id>
 *
 * Salen de `meta_conversiones_catalogo`, el mismo catálogo que usa el dashboard
 * clásico: el sync lo mantiene con el nombre real de cada conversión en Meta y
 * el equipo puede renombrarlas en ajustes → Meta.
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

    // Todas, con su estado: el editor muestra las activas y las ya elegidas, y
    // guarda el resto tras «Ver antiguas».
    const out: MetaCustomConvMeta[] = (await leerCatalogoConversiones(admin, publicId)).map(
      (c) => ({
        key: c.key,
        label: c.label,
        alias: c.alias,
        tipo: c.tipo,
        es_resultado: c.es_resultado,
        activa: c.activa,
        archivada: c.archivada,
        ultima_actividad: c.ultima_actividad,
      })
    );
    return NextResponse.json({ data: out });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
