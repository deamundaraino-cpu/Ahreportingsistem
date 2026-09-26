// Preguntas de formulario de un cliente, de TODAS sus fuentes juntas.
//
//   GET /api/report-utm/lead-preguntas?cliente_id=&refrescar=1
//
// Es la lista de la pantalla de Leads: lo que se ve en los leads (claves de
// `raw_fields` con sus respuestas y recuentos) fundido con lo que publican las
// plataformas (`lead_preguntas`, migración 091: Meta Lead Ads, GoHighLevel,
// plugin de WordPress), con el tipo de pregunta y sus opciones reales.
//
// `cliente_id` es el id de report_utm.

import { NextRequest, NextResponse } from 'next/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { getUserRole } from '@/lib/report-utm/auth';
import { detectarPreguntas } from '@/lib/leads/respuestas/deteccion-db';
import { cargarPreguntas } from '@/lib/leads/respuestas/preguntas-db';
import { unificarPreguntas } from '@/lib/leads/respuestas/catalogo';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const role = await getUserRole();
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const clienteId = sp.get('cliente_id');
  if (!clienteId) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 });

  try {
    const rtm = await reportUtmAdminClient();
    const [deteccion, plataforma] = await Promise.all([
      detectarPreguntas(rtm, clienteId, { refrescar: sp.get('refrescar') === '1' }),
      cargarPreguntas(rtm, clienteId),
    ]);
    return NextResponse.json(
      {
        data: unificarPreguntas(deteccion.claves, plataforma),
        leads: deteccion.leads,
        // Sin la 091 (o sin ninguna plataforma que publique preguntas) la lista
        // sale solo de los leads: la pantalla lo dice.
        conPlataforma: plataforma.length > 0,
      },
      { headers: { 'Cache-Control': 'private, no-store' } }
    );
  } catch (err) {
    console.error('[lead-preguntas]', err);
    return NextResponse.json({ error: 'No se pudieron leer las preguntas.' }, { status: 500 });
  }
}
