import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = await createAdminClient();
  const { data, error } = await db
    .from('bi_reports')
    .select('id,nombre,descripcion,filters,created_at,updated_at,cliente_id,is_template')
    .order('updated_at', { ascending: false })
    .limit(100);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json();
  const {
    nombre,
    descripcion,
    cliente_id,
    layout,
    filters,
    calculated_fields,
    // Copiar el contenido de otro informe/plantilla (crear desde plantilla,
    // o guardar un informe como plantilla).
    source_report_id,
    is_template,
  } = body;

  if (!nombre) return NextResponse.json({ error: 'nombre is required' }, { status: 400 });

  const db = await createAdminClient();

  // Base del contenido: el informe origen si se indicó, o lo que venga en el body.
  let baseLayout = layout ?? [];
  let baseFilters: Record<string, unknown> = filters ?? {};
  let baseCalc = calculated_fields ?? [];

  if (source_report_id) {
    const { data: src, error: srcError } = await db
      .from('bi_reports')
      .select('layout, filters, calculated_fields')
      .eq('id', source_report_id)
      .maybeSingle();
    if (srcError) return NextResponse.json({ error: srcError.message }, { status: 500 });
    if (!src) return NextResponse.json({ error: 'Informe origen no encontrado' }, { status: 404 });

    baseLayout = Array.isArray(src.layout) ? src.layout : [];
    baseCalc = Array.isArray(src.calculated_fields) ? src.calculated_fields : [];
    const srcFilters = {
      ...((typeof src.filters === 'object' && src.filters ? src.filters : {}) as Record<
        string,
        unknown
      >),
    };
    // El cliente y el rango de fechas NO se heredan: los define el informe nuevo.
    for (const k of ['cliente_id', 'date_from', 'date_to']) delete srcFilters[k];
    baseFilters = { ...srcFilters, ...(filters ?? {}) };
  }

  const row: Record<string, unknown> = {
    nombre,
    descripcion,
    cliente_id: cliente_id || null,
    layout: baseLayout,
    filters: baseFilters,
    calculated_fields: baseCalc,
    // Marca la autoría: las plantillas del sistema tienen created_by NULL y
    // están protegidas contra borrado.
    created_by: user.id,
  };
  if (is_template) row.is_template = true;

  let { data, error } = await db.from('bi_reports').insert(row).select().single();

  // Retrocompatibilidad: si alguna columna opcional aún no existe (migraciones
  // 035/044 sin aplicar), se reintenta sin ellas en vez de fallar el guardado.
  if (error && error.code === '42703') {
    delete row.is_template;
    delete row.created_by;
    ({ data, error } = await db.from('bi_reports').insert(row).select().single());
  }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data }, { status: 201 });
}
