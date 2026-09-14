import { NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const db = await reportUtmAdminClient();
  // Los archivados no se ofrecen en selectores: archivar es justamente dejar de
  // verlos sin perder su historia.
  const { data, error } = await db
    .from('clientes')
    .select('id,nombre,slug')
    .neq('status', 'archived')
    .order('nombre')
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data });
}
