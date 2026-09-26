// Activar una pregunta de formulario en UN clic.
//
//   POST /api/report-utm/lead-campos/activar
//   { cliente_id, claves_origen: string[], nombre?: string }
//
// Crea el campo de lead ya usable: nombre legible, todas sus claves de origen,
// respuestas nombradas (las de la plataforma si las publica), variantes de
// escritura fundidas, placeholders apartados como «sin respuesta» y rangos
// ordenados de menor a mayor. Ver `activarPregunta`.

import { NextRequest, NextResponse } from 'next/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { checkWriteRole } from '@/lib/report-utm/auth';
import { activarPregunta } from '@/lib/leads/respuestas/activar-db';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const { ok } = await checkWriteRole();
  if (!ok) return NextResponse.json({ error: 'Sin permiso para crear campos.' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const clienteId = String(body?.cliente_id ?? '');
  if (!clienteId) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 });

  try {
    const rtm = await reportUtmAdminClient();
    const r = await activarPregunta(rtm, clienteId, {
      claves_origen: Array.isArray(body?.claves_origen) ? body.claves_origen.map(String) : [],
      nombre: body?.nombre ?? null,
    });
    if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ data: { id: r.id, clave: r.clave, existente: !!r.existente } });
  } catch (err) {
    console.error('[lead-campos/activar]', err);
    return NextResponse.json({ error: 'No se pudo activar la pregunta.' }, { status: 500 });
  }
}
