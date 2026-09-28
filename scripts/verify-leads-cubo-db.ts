/**
 * El cubo único de leads y respuestas (`report_utm.leads_cubo`, migración 090)
 * contra los datos reales.
 *
 * Comprueba, para los clientes con preguntas medidas:
 *   • que el total de contactos es EXACTAMENTE el conteo de `lead_events`
 *     (no excluidos) del rango;
 *   • que las respuestas de cada pregunta suman lo mismo que la RPC anterior
 *     (`bi_respuestas_por_dia`), que es la referencia de la regla 071;
 *   • que responde dentro de presupuesto y no se trunca en un rango normal.
 *
 * Mientras la 090 no esté aplicada, avisa y no falla: el código usa el camino
 * anterior y ese lo cubren `verify-lead-answers-db` y `verify-lead-segmentos-db`.
 *
 *   npx tsx --conditions=react-server scripts/verify-leads-cubo-db.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from 'dotenv';
import { salir } from './_salida';
import { addDaysISO, colombiaToday, colombiaRangeBounds } from '../src/lib/colombia-date';

config({ path: '.env.local' });

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const HASTA = addDaysISO(colombiaToday(), -2);
const DESDE = addDaysISO(HASTA, -179);
const PRESUPUESTO_MS = 8000;

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { cargarCuboCrudo, esFuncionAusente } = await import('../src/lib/leads/respuestas/cubo-db');
  const { loadLeadCampos } = await import('../src/lib/report-utm/lead-campos-db');

  const rtm = (await createAdminClient()).schema('report_utm');
  const b = colombiaRangeBounds(DESDE, HASTA);

  const sonda = await rtm.rpc('leads_cubo', {
    p_cliente_id: '00000000-0000-0000-0000-000000000000',
    p_desde: b.gte,
    p_hasta: b.lt,
    p_campos: [],
    p_limite: 1,
  });
  if (sonda.error && !esFuncionAusente(sonda.error)) {
    check('la RPC responde', false, sonda.error.message);
    return salir(fallos);
  }
  if (sonda.error) {
    console.log(
      `\n⚠ report_utm.leads_cubo no está disponible (${sonda.error.message}).` +
        '\n  Aplica migrations/090_respuestas_de_lead.sql; hasta entonces el dashboard usa el camino anterior.\n'
    );
    return salir(0);
  }

  const { data: clientes } = await rtm
    .from('clientes')
    .select('id,nombre')
    .eq('status', 'active')
    .order('nombre');
  let probados = 0;
  for (const c of (clientes ?? []) as any[]) {
    const campos = await loadLeadCampos(rtm, c.id, { soloActivos: true });
    if (campos.length === 0 || probados >= 3) continue;
    probados++;
    console.log(`\n── ${c.nombre.trim()} (${campos.length} preguntas) · ${DESDE} → ${HASTA}`);

    const t0 = Date.now();
    const cubo = await cargarCuboCrudo(
      rtm,
      c.id,
      DESDE,
      HASTA,
      campos.map((x) => x.claves_origen)
    );
    const ms = Date.now() - t0;
    if (!cubo) {
      check('el cubo responde', false, 'devolvió null');
      continue;
    }
    check('cabe en el presupuesto', ms < PRESUPUESTO_MS, `${ms} ms`);
    check('no se trunca en un rango de 180 días', !cubo.truncado);

    const total = cubo.totales.reduce((s, [, , n]) => s + n, 0);
    const [todos, excluidos] = await Promise.all([
      rtm
        .from('lead_events')
        .select('id', { count: 'exact', head: true })
        .eq('cliente_id', c.id)
        .gte('created_at', b.gte)
        .lt('created_at', b.lt),
      rtm
        .from('lead_events')
        .select('id', { count: 'exact', head: true })
        .eq('cliente_id', c.id)
        .gte('created_at', b.gte)
        .lt('created_at', b.lt)
        .eq('excluido', true),
    ]);
    const exacto = (todos.count ?? 0) - (excluidos.count ?? 0);
    check('el total de contactos es exacto', total === exacto, `${total} vs ${exacto}`);

    for (let i = 0; i < campos.length; i++) {
      const campo = campos[i];
      if (campo.claves_origen.length === 0) continue;
      const delCubo = cubo.respuestas
        .filter(([, , ic]) => ic === i)
        .reduce((s, [, , , , n]) => s + n, 0);
      // La referencia se pagina: PostgREST corta cada respuesta en 1.000 filas
      // aunque se pida un rango mayor (ver `traerTodasLasFilas`).
      let referencia = 0;
      let fallo: string | null = null;
      for (let desde = 0; desde < 60000; desde += 1000) {
        const { data, error } = await rtm
          .rpc('bi_respuestas_por_dia', {
            p_cliente_id: c.id,
            p_desde: b.gte,
            p_hasta: b.lt,
            p_claves_json: campo.claves_origen,
            p_limite: 60000,
          })
          .range(desde, desde + 999);
        if (error) {
          fallo = error.message;
          break;
        }
        const lote = (data ?? []) as any[];
        referencia += lote.reduce((s, r) => s + Number(r.n ?? 0), 0);
        if (lote.length < 1000) break;
      }
      if (fallo) {
        console.log(`  · «${campo.nombre}»: la RPC de referencia falló (${fallo}), se omite`);
        continue;
      }
      check(
        `«${campo.nombre}»: mismas respuestas que la RPC anterior`,
        delCubo === referencia,
        `${delCubo} vs ${referencia}`
      );
    }
  }
  if (probados === 0)
    console.log('\n⚠ Ningún cliente tiene preguntas medidas: nada que comprobar.');

  console.log(
    fallos === 0
      ? '\n✅ Cubo único de leads: todas las comprobaciones pasan\n'
      : `\n❌ ${fallos} comprobación(es) fallaron\n`
  );
  salir(fallos);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
