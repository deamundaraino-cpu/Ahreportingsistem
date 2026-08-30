/**
 * Comprobaciones del motor de valores contra datos REALES.
 *
 * Lo que se verifica aquí no se puede verificar en puro: que las defensas de las
 * RPCs aborten de verdad, que el corte sea el top-N real y no una página
 * arbitraria, y que el presupuesto de tiempo quepa en el `statement_timeout`.
 *
 *   npx tsx scripts/verify-bi-valores-db.ts
 */

import { config as loadEnv } from 'dotenv';
loadEnv({ path: '.env.local' });

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}
function seccion(t: string) {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);
}

// Rango CERRADO: con uno que llegue a hoy entran leads durante la prueba y los
// totales se mueven entre una consulta y la siguiente.
const DESDE = '2026-07-01';
const HASTA = '2026-07-31';
/** Margen sobre el `statement_timeout` de 8 s. */
const PRESUPUESTO_MS = 6000;

async function main() {
  const { createAdminClient } = await import('../src/utils/supabase/server');
  const { runValores, runDistinctValues } = await import('../src/lib/report-utm/bi-query');
  const db = await createAdminClient();

  const { data: csRaw } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id,nombre,public_cliente_id')
    .order('nombre');
  const clientes = (csRaw ?? []) as Array<{
    id: string;
    nombre: string;
    public_cliente_id: string | null;
  }>;

  // El cliente con más leads: es el que puede reventar el presupuesto.
  let mayor = clientes[0];
  let maxLeads = -1;
  for (const c of clientes) {
    const { count } = await db
      .schema('report_utm')
      .from('lead_events')
      .select('id', { count: 'planned', head: true })
      .eq('cliente_id', c.id);
    if ((count ?? 0) > maxLeads) {
      maxLeads = count ?? 0;
      mayor = c;
    }
  }
  console.log(`\nCliente de referencia: ${mayor.nombre.trim()}`);

  // ════════════════════════════════════════════════════════════
  seccion('Las RPCs se niegan a lo que no deben hacer');
  // ════════════════════════════════════════════════════════════
  /**
   * Aborta CON EL MOTIVO ESPERADO.
   *
   * Comprobar solo que hay error no vale: la primera versión de estas pruebas
   * pasaba entera porque las llamadas fallaban con «función no encontrada»
   * —la RPC vive en el esquema `report_utm` y se estaba invocando en
   * `public`—, no porque ninguna defensa saltara. Exigir el texto convierte
   * un falso verde en un fallo.
   */
  const abortaCon = async (
    nombre: string,
    esperado: string,
    fn: () => PromiseLike<{ error: unknown }>
  ) => {
    const { error } = await fn();
    const msg = String((error as { message?: string } | null)?.message ?? '');
    if (!error) {
      check(nombre, false, 'la llamada NO abortó');
      return;
    }
    check(nombre, msg.includes(esperado), `abortó por otro motivo: ${msg}`);
  };

  const rutm = db.schema('report_utm');

  await abortaCon('una tabla que no es lead/sales aborta', 'p_tabla debe ser', () =>
    rutm.rpc('bi_valores_conteo', {
      p_cliente_id: null,
      p_tabla: 'clientes',
      p_desde: `${DESDE}T00:00:00Z`,
      p_hasta: `${HASTA}T00:00:00Z`,
      p_columna: 'utm_source',
      p_claves_json: null,
      p_limite: 10,
    })
  );

  // La lista blanca es la ÚNICA defensa contra la inyección por identificador:
  // un GROUP BY no admite parámetro, así que la columna se interpola.
  await abortaCon(
    'una columna fuera de la lista blanca aborta',
    'no permitida en lead_events',
    () =>
      rutm.rpc('bi_valores_conteo', {
        p_cliente_id: null,
        p_tabla: 'lead_events',
        p_desde: `${DESDE}T00:00:00Z`,
        p_hasta: `${HASTA}T00:00:00Z`,
        p_columna: 'lead_email',
        p_claves_json: null,
        p_limite: 10,
      })
  );

  await abortaCon(
    'un intento de inyección por identificador aborta',
    'no permitida en lead_events',
    () =>
      rutm.rpc('bi_valores_conteo', {
        p_cliente_id: null,
        p_tabla: 'lead_events',
        p_desde: `${DESDE}T00:00:00Z`,
        p_hasta: `${HASTA}T00:00:00Z`,
        p_columna: 'utm_source; DROP TABLE report_utm.lead_events; --',
        p_claves_json: null,
        p_limite: 10,
      })
  );

  await abortaCon(
    'raw_fields sobre sales_events aborta',
    'raw_fields solo existe en lead_events',
    () =>
      rutm.rpc('bi_valores_conteo', {
        p_cliente_id: null,
        p_tabla: 'sales_events',
        p_desde: `${DESDE}T00:00:00Z`,
        p_hasta: `${HASTA}T00:00:00Z`,
        p_columna: null,
        p_claves_json: ['x'],
        p_limite: 10,
      })
  );

  await abortaCon('columna y claves a la vez aborta', 'no ambos ni ninguno', () =>
    rutm.rpc('bi_valores_conteo', {
      p_cliente_id: null,
      p_tabla: 'lead_events',
      p_desde: `${DESDE}T00:00:00Z`,
      p_hasta: `${HASTA}T00:00:00Z`,
      p_columna: 'utm_source',
      p_claves_json: ['x'],
      p_limite: 10,
    })
  );

  await abortaCon('una columna de Hotmart no permitida aborta', 'no permitida', () =>
    db.rpc('hotmart_valores_conteo', {
      p_cliente_publico_id: mayor.public_cliente_id,
      p_columna: 'comprador_email',
      p_desde: DESDE,
      p_hasta: HASTA,
      p_limite: 10,
    })
  );

  // Un valor con comillas y comodines tiene que sobrevivir como literal.
  {
    const { error } = await rutm.rpc('bi_valores_conteo', {
      p_cliente_id: mayor.id,
      p_tabla: 'lead_events',
      p_desde: `${DESDE}T00:00:00Z`,
      p_hasta: `${HASTA}T00:00:00Z`,
      p_columna: null,
      p_claves_json: ["o'brien%_"],
      p_limite: 10,
    });
    check(
      'una clave JSONB con comillas y comodines no rompe la consulta',
      !error,
      String((error as { message?: string } | null)?.message ?? '')
    );
  }

  const { count: sigueViva } = await db
    .schema('report_utm')
    .from('lead_events')
    .select('id', { count: 'planned', head: true });
  check('la tabla sigue existiendo tras los intentos', (sigueViva ?? 0) > 0);

  // ════════════════════════════════════════════════════════════
  seccion('El corte es el top-N real, no una página arbitraria');
  // ════════════════════════════════════════════════════════════
  // Es la regresión que fija el arreglo: antes se pedía `.limit(5000)` sin
  // ORDER BY y qué valores llegaban era indefinido.
  {
    const r = await runValores({
      cliente_id: mayor.id,
      dimension: 'utm_campaign',
      date_from: DESDE,
      date_to: HASTA,
      limit: 5,
    });
    check('devuelve como mucho el límite', r.valores.length <= 5, `${r.valores.length}`);
    const orden = r.valores.map((v) => v.n);
    check(
      'vienen ordenados por frecuencia descendente',
      orden.every((n, i) => i === 0 || orden[i - 1] >= n),
      orden.join(',')
    );
    check(
      'el total refleja el conjunto entero, no el recorte',
      r.total > r.valores.length,
      `total=${r.total} devueltos=${r.valores.length}`
    );
    check('se declara truncado', r.truncado);
    check(
      'todos traen un recuento positivo',
      r.valores.every((v) => v.n > 0)
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('El recuento cuadra con la realidad');
  // ════════════════════════════════════════════════════════════
  {
    const r = await runValores({
      cliente_id: mayor.id,
      dimension: 'utm_source',
      date_from: DESDE,
      date_to: HASTA,
      limit: 500,
    });
    const suma = r.valores.reduce((s, v) => s + v.n, 0);

    // Contraste independiente: se cuenta con `planned` (nunca `exact`, que ya
    // agotó el tiempo límite en otra parte del proyecto).
    const { count: totalRango } = await db
      .schema('report_utm')
      .from('lead_events')
      .select('id', { count: 'planned', head: true })
      .eq('cliente_id', mayor.id);

    check(
      'la suma de los recuentos no supera los leads del cliente',
      suma <= (totalRango ?? Number.MAX_SAFE_INTEGER),
      `suma=${suma} leads=${totalRango}`
    );
    check('hay al menos un valor', r.valores.length > 0);
    check(
      'sin truncar, el total es el número de valores',
      r.truncado || r.total === r.valores.length,
      `total=${r.total} n=${r.valores.length}`
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('El contrato histórico sigue intacto');
  // ════════════════════════════════════════════════════════════
  {
    const planos = await runDistinctValues({
      cliente_id: mayor.id,
      dimension: 'utm_source',
      date_from: DESDE,
      date_to: HASTA,
    });
    const conConteo = await runValores({
      cliente_id: mayor.id,
      dimension: 'utm_source',
      date_from: DESDE,
      date_to: HASTA,
    });
    check(
      'runDistinctValues devuelve string[]',
      Array.isArray(planos) && planos.every((v) => typeof v === 'string')
    );
    check(
      'y es exactamente la proyección del motor',
      planos.join('') === conConteo.valores.map((v) => v.valor).join('')
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('El defecto de `source`: ventas ya no lista leads');
  // ════════════════════════════════════════════════════════════
  // `form_name` solo existe en lead_events. Antes el parámetro se ignoraba y
  // un slicer sobre ventas devolvía nombres de formulario igualmente.
  {
    const enVentas = await runValores({
      cliente_id: mayor.id,
      dimension: 'form_name',
      date_from: DESDE,
      date_to: HASTA,
      source: 'sales',
    });
    check(
      'un campo de leads pedido sobre ventas no devuelve valores',
      enVentas.valores.length === 0
    );
    // Y lo dice: una lista vacía muda sería indistinguible de «no hay datos».
    check(
      'y explica por qué',
      enVentas.motivo === 'dimension_no_listable',
      String(enVentas.motivo)
    );

    const enLeads = await runValores({
      cliente_id: mayor.id,
      dimension: 'form_name',
      date_from: DESDE,
      date_to: HASTA,
      source: 'leads',
    });
    check('sobre leads sí devuelve valores', enLeads.valores.length > 0);
  }

  // ════════════════════════════════════════════════════════════
  seccion('Dimensiones no enumerables');
  // ════════════════════════════════════════════════════════════
  for (const dim of ['none', 'date'] as const) {
    const r = await runValores({ cliente_id: mayor.id, dimension: dim });
    check(`«${dim}» se rechaza con motivo`, r.motivo === 'dimension_no_listable');
  }

  // ════════════════════════════════════════════════════════════
  seccion('Presupuesto de tiempo');
  // ════════════════════════════════════════════════════════════
  // El caso peor medido fue 3,9 s en frío. Si alguna rama se acerca a los 8 s
  // del `statement_timeout`, hay que enterarse aquí y no en un informe.
  const ramas: Array<[string, string]> = [
    ['columna directa', 'utm_campaign'],
    ['columna de baja cardinalidad', 'ip_country'],
    ['unificada (resolver)', 'utm_content'],
  ];
  for (const [nombre, dim] of ramas) {
    const t0 = Date.now();
    const r = await runValores({
      cliente_id: mayor.id,
      dimension: dim as never,
      date_from: DESDE,
      date_to: HASTA,
    });
    const ms = Date.now() - t0;
    check(
      `${nombre} (${dim}) — ${ms} ms · ${r.valores.length} valores`,
      ms < PRESUPUESTO_MS,
      `tardó ${ms} ms, presupuesto ${PRESUPUESTO_MS} ms`
    );
  }

  // ════════════════════════════════════════════════════════════
  seccion('La caché deduplica y acelera');
  // ════════════════════════════════════════════════════════════
  {
    const base = {
      cliente_id: mayor.id,
      dimension: 'utm_campaign' as never,
      date_from: DESDE,
      date_to: HASTA,
    };
    await runValores(base); // calienta
    const t0 = Date.now();
    const [a, b] = await Promise.all([runValores(base), runValores(base)]);
    const ms = Date.now() - t0;
    check(`dos llamadas idénticas responden al instante (${ms} ms)`, ms < 100, `${ms} ms`);
    check('y devuelven lo mismo', a.valores.length === b.valores.length && a.total === b.total);
  }
}

main()
  .then(() => {
    console.log(fallos === 0 ? '\n✓ TODO OK' : `\n✗ ${fallos} comprobación(es) fallida(s)`);
    process.exit(fallos === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('\n✗ Error inesperado:', err);
    process.exit(1);
  });
