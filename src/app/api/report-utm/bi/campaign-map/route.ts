import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { checkWriteRole } from '@/lib/report-utm/auth';
import { getCrossDiagnostics } from '@/lib/report-utm/campaign-data';

export const dynamic = 'force-dynamic';

// GET ?cliente_id=&date_from=&date_to=
//   → overrides + campañas + sugerencias (no cruzados) + cobertura por método
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const cliente_id = sp.get('cliente_id') ?? undefined;
  if (!cliente_id) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 });
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

  return NextResponse.json({
    overrides: overrides ?? [],
    campaigns: diag.campaigns,
    suggestions: diag.suggestions,
    invalid: diag.invalid,
    breakdown: diag.breakdown,
    coverage: diag.coverage,
  });
}

// POST → crea un override de mapeo (escritura: requiere rol)
export async function POST(req: NextRequest) {
  const { ok, role } = await checkWriteRole();
  if (!ok)
    return NextResponse.json(
      { error: `Sin permisos para mapear campañas (rol: ${role ?? 'ninguno'})` },
      { status: 403 }
    );

  const body = await req.json();
  const { cliente_id, match_field, match_value, platform, campaign_id, campaign_name } = body;
  if (!cliente_id || !match_value || !campaign_name) {
    return NextResponse.json(
      { error: 'cliente_id, match_value y campaign_name son requeridos' },
      { status: 400 }
    );
  }

  const db = await reportUtmAdminClient();
  const { data, error } = await db
    .from('utm_campaign_map')
    .upsert(
      {
        cliente_id,
        match_field: match_field || 'utm_campaign',
        match_value,
        platform: platform || 'meta',
        campaign_id: campaign_id || null,
        campaign_name,
      },
      { onConflict: 'cliente_id,match_field,match_value' }
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
  const { error } = await db.from('utm_campaign_map').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
