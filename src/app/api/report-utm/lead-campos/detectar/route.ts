// Descubrimiento de preguntas de formulario para un cliente.
//
//   GET /api/report-utm/lead-campos/detectar?cliente_id=&date_from=&date_to=&todas=1
//
// Escanea `report_utm.lead_events.raw_fields` y devuelve las claves detectadas
// con sus valores y cuántos leads tiene cada uno. Es lo que alimenta el alta de
// un campo (qué preguntas hay) y el agrupador (qué valores hay que unificar).
//
// Por defecto oculta las claves que nunca son un campo cruzable (correo,
// teléfono, UTM, ids de Elementor sin etiqueta); `todas=1` las incluye.

import { NextRequest, NextResponse } from 'next/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { getUserRole } from '@/lib/report-utm/auth';
import { detectarCamposDeLeads } from '@/lib/report-utm/lead-campos-db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const role = await getUserRole();
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const clienteId = sp.get('cliente_id');
  if (!clienteId) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 });

  // Ventana amplia por defecto: el alta de un campo mira el histórico del
  // cliente, no el período que tenga abierto un informe.
  const dateFrom =
    sp.get('date_from') ?? new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const dateTo = sp.get('date_to') ?? new Date().toISOString().slice(0, 10);

  try {
    const rtm = await reportUtmAdminClient();
    const { claves, leads } = await detectarCamposDeLeads(rtm, clienteId, {
      dateFrom,
      dateTo,
      incluirIgnoradas: sp.get('todas') === '1',
    });
    return NextResponse.json({ data: claves, leads });
  } catch (err) {
    console.error('[lead-campos/detectar]', err);
    return NextResponse.json({ error: 'No se pudieron leer los leads.' }, { status: 500 });
  }
}
