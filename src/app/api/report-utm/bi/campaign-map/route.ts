import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { checkWriteRole } from '@/lib/report-utm/auth';
import { getCrossDiagnostics } from '@/lib/report-utm/campaign-data';
import { normLabel } from '@/lib/report-utm/bi-metadata';

export const dynamic = 'force-dynamic';

const NIVELES = new Set(['campaign', 'adset', 'ad']);

/**
 * ¿La sesión puede ver este cliente? Se pregunta con el cliente de la SESIÓN,
 * no con el admin: así decide la RLS de `report_utm.clientes` (can_view). Antes
 * la ruta leía con el cliente admin y devolvía el diagnóstico de cualquier
 * cliente a cualquier usuario con sesión, y el DELETE borraba por `id` sin mirar
 * de quién era la corrección.
 */
async function clienteVisible(clienteId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('id', clienteId)
    .maybeSingle();
  return !error && Boolean(data);
}

// GET ?cliente_id=&date_from=&date_to=
//   → overrides + campañas + sugerencias (no cruzados) + cobertura por método
//     + diagnóstico de conjunto y anuncio + entidades para corregir por nivel
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const cliente_id = sp.get('cliente_id') ?? undefined;
  if (!cliente_id) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 });
  if (!(await clienteVisible(cliente_id))) {
    return NextResponse.json({ error: 'Cliente no encontrado' }, { status: 404 });
  }
  const date_from = sp.get('date_from') ?? undefined;
  const date_to = sp.get('date_to') ?? undefined;

  const db = await reportUtmAdminClient();
  const [{ data: overrides }, diag] = await Promise.all([
    db
      .from('utm_campaign_map')
      .select('*')
      .eq('cliente_id', cliente_id)
      .order('created_at', { ascending: false }),
    getCrossDiagnostics({ cliente_id, date_from, date_to }),
  ]);

  // ¿Está la migración 079? Si las filas no traen `nivel`, la corrección por
  // conjunto/anuncio no se puede guardar todavía y la UI lo dice en vez de
  // fallar al pulsar el botón.
  const filas = (overrides ?? []) as Record<string, unknown>[];
  const porNivel =
    filas.length > 0 ? 'nivel' in filas[0] : await nivelDisponible(db as unknown as DbMapa);

  return NextResponse.json({
    overrides: filas,
    campaigns: diag.campaigns,
    suggestions: diag.suggestions,
    invalid: diag.invalid,
    breakdown: diag.breakdown,
    coverage: diag.coverage,
    excluidos: diag.excluidos,
    niveles: diag.niveles,
    entidades: diag.entidades,
    ambiguos: diag.ambiguos,
    ids: diag.ids,
    mapeo_por_nivel: porNivel,
  });
}

// POST → crea un override de mapeo (escritura: requiere rol)
//   body: { cliente_id, match_field, match_value, platform, campaign_id, campaign_name,
//           nivel?: 'campaign'|'adset'|'ad', target_id?, target_name? }
export async function POST(req: NextRequest) {
  const { ok, role } = await checkWriteRole();
  if (!ok)
    return NextResponse.json(
      { error: `Sin permisos para mapear campañas (rol: ${role ?? 'ninguno'})` },
      { status: 403 }
    );

  const body = await req.json();
  const { cliente_id, match_field, match_value, platform, campaign_id, campaign_name } = body;
  const nivel = typeof body.nivel === 'string' && NIVELES.has(body.nivel) ? body.nivel : 'campaign';
  const target_id = body.target_id ? String(body.target_id) : null;
  const target_name = body.target_name ? String(body.target_name) : null;

  if (!cliente_id || !match_value) {
    return NextResponse.json({ error: 'cliente_id y match_value son requeridos' }, { status: 400 });
  }
  // Una corrección de campaña necesita la campaña; una de conjunto o anuncio,
  // la entidad. La campaña de esta última es opcional: el índice la deduce.
  if (nivel === 'campaign' && !campaign_name) {
    return NextResponse.json({ error: 'campaign_name es requerido' }, { status: 400 });
  }
  if (nivel !== 'campaign' && !target_name) {
    return NextResponse.json(
      { error: 'target_name es requerido para corregir un conjunto o anuncio' },
      { status: 400 }
    );
  }

  if (!(await clienteVisible(String(cliente_id)))) {
    return NextResponse.json({ error: 'Cliente no encontrado' }, { status: 404 });
  }

  const db = await reportUtmAdminClient();
  const campo =
    match_field ||
    (nivel === 'ad' ? 'utm_content' : nivel === 'adset' ? 'utm_term' : 'utm_campaign');
  const fila: Record<string, unknown> = {
    cliente_id,
    match_field: campo,
    match_value,
    platform: platform || 'meta',
    campaign_id: campaign_id || null,
    // `campaign_name` es NOT NULL en filas de campaña; para conjunto/anuncio sin
    // campaña conocida se guarda el nombre de la entidad, que el resolver no usa
    // para el gasto porque prefiere `target_id` (ver claveCampanaDeOverride).
    campaign_name: campaign_name || target_name,
    // Siempre, también en las de campaña: re-mapear como campaña un valor que
    // antes era de anuncio dejaba el `nivel`/`target_*` viejo y el título del
    // anuncio anterior seguía apareciendo.
    nivel,
    target_id: nivel === 'campaign' ? null : target_id,
    target_name: nivel === 'campaign' ? null : target_name,
  };

  // La unicidad de la tabla es sobre el valor CRUDO, pero el resolver compara el
  // NORMALIZADO: «Promo_Verano» y «promo verano» se guardaban como dos filas que
  // corregían lo mismo, y cuál ganaba dependía del orden de lectura. Si ya hay
  // una fila equivalente, se actualiza esa y se borran sus duplicados.
  const { data: previas } = await db
    .from('utm_campaign_map')
    .select('id, match_value')
    .eq('cliente_id', cliente_id)
    .eq('match_field', campo);
  const equivalentes = ((previas ?? []) as Array<{ id: string; match_value: string }>).filter(
    (p) => normLabel(p.match_value) === normLabel(String(match_value))
  );
  let resultado;
  if (equivalentes.length > 0) {
    const [principal, ...sobrantes] = equivalentes;
    resultado = await db
      .from('utm_campaign_map')
      .update(fila)
      .eq('id', principal.id)
      .select()
      .single();
    if (!resultado.error && sobrantes.length > 0) {
      await db
        .from('utm_campaign_map')
        .delete()
        .in(
          'id',
          sobrantes.map((s) => s.id)
        );
    }
  } else {
    resultado = await db
      .from('utm_campaign_map')
      .upsert(fila, { onConflict: 'cliente_id,match_field,match_value' })
      .select()
      .single();
  }
  const { data, error } = resultado;

  if (error) {
    // 42703 / PGRST204: la columna `nivel` no existe → falta la migración 079.
    const code = (error as { code?: string }).code;
    if (nivel !== 'campaign' && (code === '42703' || code === 'PGRST204')) {
      return NextResponse.json(
        {
          error:
            'La corrección por conjunto o anuncio necesita la migración 079 en la base. Pide que la apliquen (migrations/079_leads_excluidos_y_mapeo_por_nivel.sql).',
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data }, { status: 201 });
}

// DELETE ?id= → elimina un override (escritura: requiere rol)
export async function DELETE(req: NextRequest) {
  const { ok, role } = await checkWriteRole();
  if (!ok)
    return NextResponse.json(
      { error: `Sin permisos para eliminar mapeos (rol: ${role ?? 'ninguno'})` },
      { status: 403 }
    );

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

  const db = await reportUtmAdminClient();
  const { data: fila } = await db
    .from('utm_campaign_map')
    .select('cliente_id')
    .eq('id', id)
    .maybeSingle();
  const clienteId = (fila as { cliente_id?: string } | null)?.cliente_id;
  if (!clienteId || !(await clienteVisible(clienteId))) {
    return NextResponse.json({ error: 'Corrección no encontrada' }, { status: 404 });
  }
  const { error } = await db
    .from('utm_campaign_map')
    .delete()
    .eq('id', id)
    .eq('cliente_id', clienteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

type DbMapa = {
  from: (t: string) => {
    select: (c: string) => { limit: (n: number) => Promise<{ error: { code?: string } | null }> };
  };
};

/** Sin filas no se puede mirar la forma: se pregunta a la columna directamente. */
async function nivelDisponible(db: DbMapa): Promise<boolean> {
  const { error } = await db.from('utm_campaign_map').select('nivel').limit(1);
  return !error;
}
