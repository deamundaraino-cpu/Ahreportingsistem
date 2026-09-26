import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import { columnasOfflineDeConfig } from '@/lib/report-utm/bi/campos-cliente';

export const dynamic = 'force-dynamic';

/**
 * Columnas adicionales de los Google Sheets offline de un cliente, para que el
 * BI las ofrezca como métricas (token "offfield:<clave>").
 *
 *   GET /api/report-utm/bi/offline-fields?cliente_id=
 *
 * Salen de la CONFIG del cliente (`clientes.config_api.google_sheets_conversiones`,
 * formato con `tabs` o el plano anterior), no de escanear datos: el analista ya
 * declaró ahí qué columnas se sincronizan y de qué tipo son. Las de tipo texto o
 * fecha se omiten — el BI solo grafica números.
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
    const { data: rtmCliente } = await admin
      .schema('report_utm')
      .from('clientes')
      .select('public_cliente_id')
      .eq('id', clienteId)
      .maybeSingle();
    const publicId = rtmCliente?.public_cliente_id;
    if (!publicId) return NextResponse.json({ data: [] });

    const { data: cliente } = await admin
      .from('clientes')
      .select('config_api')
      .eq('id', publicId)
      .maybeSingle();

    // El parseo vive en lib: lo comparte la herramienta list_report_fields.
    const data = columnasOfflineDeConfig(cliente?.config_api);
    return NextResponse.json({ data });
  } catch (err) {
    console.error('[bi/offline-fields]', err);
    return NextResponse.json({ error: 'Query error' }, { status: 500 });
  }
}
