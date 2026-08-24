// Catálogo de campos de lead de un cliente (report_utm.lead_campos).
//
//   GET    ?cliente_id=       → campos definidos
//   POST   { …campo }         → alta o edición
//   DELETE ?id=               → baja
//
// Es la administración que usa la ficha del cliente. La lectura que consume el
// BI (con los valores ya calculados sobre el período) vive en
// /api/report-utm/bi/lead-fields.

import { NextRequest, NextResponse } from 'next/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { checkWriteRole, getUserRole } from '@/lib/report-utm/auth';
import { loadLeadCampos, saveLeadCampo, deleteLeadCampo } from '@/lib/report-utm/lead-campos-db';
import { slugCampo } from '@/lib/report-utm/lead-campos';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const role = await getUserRole();
  if (!role) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const clienteId = req.nextUrl.searchParams.get('cliente_id');
  if (!clienteId) return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 });

  const rtm = await reportUtmAdminClient();
  const campos = await loadLeadCampos(rtm, clienteId);
  return NextResponse.json({ data: campos });
}

export async function POST(req: NextRequest) {
  const { ok } = await checkWriteRole();
  if (!ok) return NextResponse.json({ error: 'Sin permiso para editar campos.' }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body?.cliente_id)
    return NextResponse.json({ error: 'cliente_id requerido' }, { status: 400 });

  const rtm = await reportUtmAdminClient();

  // La clave solo se calcula en el ALTA: es lo que quedó guardado dentro de los
  // widgets, así que renombrar el campo no debe moverla.
  let clave = String(body.clave ?? '').trim();
  if (!body.id) {
    clave = slugCampo(clave || String(body.nombre ?? ''));
    if (!clave)
      return NextResponse.json(
        { error: 'El nombre no produce una clave válida.' },
        { status: 400 }
      );
    // Desempate: dos campos distintos pueden slugificar igual ("Rango de
    // ingresos" y "rango_de_ingresos").
    const existentes = await loadLeadCampos(rtm, body.cliente_id);
    if (existentes.some((c) => c.clave === clave)) {
      let n = 2;
      while (existentes.some((c) => c.clave === `${clave}_${n}`)) n++;
      clave = `${clave}_${n}`;
    }
  }

  const res = await saveLeadCampo(rtm, {
    id: body.id,
    cliente_id: body.cliente_id,
    clave,
    nombre: String(body.nombre ?? ''),
    descripcion: body.descripcion ?? null,
    claves_origen: Array.isArray(body.claves_origen) ? body.claves_origen.map(String) : [],
    valores_map: body.valores_map ?? {},
    valores_orden: Array.isArray(body.valores_orden) ? body.valores_orden.map(String) : [],
    sin_mapear: body.sin_mapear,
    activo: body.activo,
    orden: body.orden,
  });

  if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ data: { id: res.id, clave } });
}

export async function DELETE(req: NextRequest) {
  const { ok } = await checkWriteRole();
  if (!ok) return NextResponse.json({ error: 'Sin permiso para borrar campos.' }, { status: 403 });

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });

  const rtm = await reportUtmAdminClient();
  const res = await deleteLeadCampo(rtm, id);
  if (res.error) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
