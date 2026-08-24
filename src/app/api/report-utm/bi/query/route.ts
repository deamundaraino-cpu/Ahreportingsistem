import { NextRequest, NextResponse } from 'next/server';
import { parseBiQueryParams, esConsultaDeValores } from '@/lib/report-utm/bi-query-params';
import { dispatchBiQuery } from '@/lib/report-utm/bi-dispatch';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const parsed = parseBiQueryParams(req.nextUrl.searchParams);
    const result = await dispatchBiQuery(parsed);
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
    }
    // `meta` es aditivo: los widgets que solo leen `data` no se enteran.
    // Lleva el motivo por el que un campo no se pudo medir, para pintar «—»
    // con explicación en vez de un 0 que no significa cero.
    //
    // Enumerar valores sí se cachea 30 s: al abrir un panel de filtros se
    // pide la misma lista varias veces (montar, teclear, cerrar y reabrir),
    // y esa lista no cambia de un segundo a otro. Los datos del informe NO
    // se cachean, que es lo que se espera al pulsar «Aplicar».
    const headers = esConsultaDeValores(parsed.type)
      ? { 'Cache-Control': 'private, max-age=30' }
      : undefined;
    return NextResponse.json({ data: result.data, meta: result.meta }, { headers });
  } catch (err) {
    console.error('[bi/query]', err);
    return NextResponse.json({ error: 'Query error' }, { status: 500 });
  }
}
