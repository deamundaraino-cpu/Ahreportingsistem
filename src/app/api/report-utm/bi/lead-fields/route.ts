import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/utils/supabase/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { fetchAllRows } from '@/lib/report-utm/bi-query';
import { loadLeadCampos, loadLeadSegmentos } from '@/lib/report-utm/lead-campos-db';
import {
  bucketDeLeadRaw,
  ordenarBuckets,
  segmentoIncluyeBucket,
} from '@/lib/report-utm/lead-campos';
import type { LeadFieldMeta, LeadSegmentoMeta } from '@/lib/report-utm/bi-metadata';
import { colombiaRangeBounds } from '@/lib/colombia-date';

export const dynamic = 'force-dynamic';

/** Tope de leads que se escanean para listar los valores de cada campo. */
const MAX_LEADS = 30000;

/**
 * Campos de lead del cliente, listos para el editor de widgets y el constructor
 * de filtros.
 *
 *   GET /api/report-utm/bi/lead-fields?cliente_id=&date_from=&date_to=
 *
 * A diferencia de /bi/form-fields —que lista las claves CRUDAS de raw_fields tal
 * como llegaron— esto devuelve el catálogo que definió el analista: un campo por
 * pregunta, con las claves equivalentes ya unidas y los valores ya agrupados y
 * ordenados. Es lo que se ofrece como dimensión `leadfield:<clave>`.
 *
 * Los valores se calculan sobre los leads del período pedido para que el
 * desplegable de filtro no ofrezca opciones que nadie respondió en ese rango.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const clienteId = sp.get('cliente_id') ?? undefined;
  if (!clienteId) return NextResponse.json({ data: [] });

  const dateFrom =
    sp.get('date_from') ?? new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const dateTo = sp.get('date_to') ?? new Date().toISOString().slice(0, 10);

  try {
    const rtm = await reportUtmAdminClient();
    const campos = await loadLeadCampos(rtm, clienteId, { soloActivos: true });
    if (campos.length === 0) return NextResponse.json({ data: [], segments: [] });
    // Los segmentos viajan en una clave HERMANA de `data`, no dentro de cada
    // campo: todo lo que hoy lee `json.data` (constructor de filtros, chips)
    // sigue funcionando sin tocarlo.
    const segmentos = await loadLeadSegmentos(rtm, clienteId, campos, { soloActivos: true });

    const rows = await fetchAllRows(
      () =>
        rtm
          .from('lead_events')
          .select('id,raw_fields')
          .eq('cliente_id', clienteId)
          .gte('created_at', colombiaRangeBounds(dateFrom, dateTo).gte)
          .lt('created_at', colombiaRangeBounds(dateFrom, dateTo).lt)
          .not('raw_fields', 'is', null),
      1000,
      MAX_LEADS
    );

    // La cobertura de cada segmento se calcula en la MISMA pasada que ya hace
    // el campo: coste cero, y permite atenuar en el editor un segmento que no
    // recoge a nadie en el período elegido.
    const coberturaSeg = new Map<string, number>();
    const data: LeadFieldMeta[] = campos.map((campo) => {
      const susSegmentos = segmentos.filter((s) => s.campo_clave === campo.clave);
      const set = new Set<string>();
      let cobertura = 0;
      for (const r of rows) {
        const b = bucketDeLeadRaw(campo, r.raw_fields as Record<string, unknown> | null);
        if (!b) continue;
        cobertura++;
        if (set.size < campo.max_valores + 1) set.add(b);
        for (const s of susSegmentos) {
          if (segmentoIncluyeBucket(s, b))
            coberturaSeg.set(s.clave, (coberturaSeg.get(s.clave) ?? 0) + 1);
        }
      }
      return {
        clave: campo.clave,
        nombre: campo.nombre,
        descripcion: campo.descripcion,
        valores: ordenarBuckets(campo, Array.from(set)),
        claves_origen: campo.claves_origen,
        cobertura,
        alta_cardinalidad: set.size > campo.max_valores,
      };
    });

    const porClave = new Map(campos.map((c) => [c.clave, c.nombre]));
    const segments: LeadSegmentoMeta[] = segmentos.map((s) => ({
      clave: s.clave,
      nombre: s.nombre,
      campo_clave: s.campo_clave,
      campo_nombre: porClave.get(s.campo_clave),
      operador: s.operador,
      valores: s.valores,
      cobertura: coberturaSeg.get(s.clave) ?? 0,
    }));

    return NextResponse.json({ data, segments });
  } catch (err) {
    console.error('[bi/lead-fields]', err);
    return NextResponse.json({ error: 'Query error' }, { status: 500 });
  }
}
