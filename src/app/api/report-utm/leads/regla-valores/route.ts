import { NextRequest, NextResponse } from 'next/server';
import { checkWriteRole } from '@/lib/report-utm/auth';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { cargarValoresRegla, type ValoresRegla } from '@/lib/report-utm/lead-regla-valores';

export const dynamic = 'force-dynamic';

/**
 * Valores reales de los leads de un cliente, con su recuento, para armar la
 * regla «Qué leads cuentan» de la ficha del cliente.
 *
 *   GET /api/report-utm/leads/regla-valores?cliente_id=<report_utm.clientes.id>
 *
 * Solo para quien puede editar la regla (mismo guard que la server action que
 * la guarda). Ver `lead-regla-valores.ts`.
 */

/** Abrir y cerrar la tarjeta no debe releer miles de leads cada vez. */
const CACHE_MS = 60_000;
const cache = new Map<string, { ts: number; datos: ValoresRegla }>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const { ok, role } = await checkWriteRole();
  if (!ok) {
    return NextResponse.json(
      { error: role ? 'Forbidden' : 'Unauthorized' },
      { status: role ? 403 : 401 }
    );
  }

  const clienteId = req.nextUrl.searchParams.get('cliente_id') ?? '';
  if (!UUID.test(clienteId)) {
    return NextResponse.json({ error: 'cliente_id inválido' }, { status: 400 });
  }

  const enCache = cache.get(clienteId);
  if (enCache && Date.now() - enCache.ts < CACHE_MS) {
    return NextResponse.json(enCache.datos);
  }

  try {
    const db = await reportUtmAdminClient();
    const datos = await cargarValoresRegla(db, clienteId);
    cache.set(clienteId, { ts: Date.now(), datos });
    return NextResponse.json(datos);
  } catch (err) {
    console.error('[leads/regla-valores]', err);
    return NextResponse.json({ error: 'No se pudieron leer los valores' }, { status: 500 });
  }
}
