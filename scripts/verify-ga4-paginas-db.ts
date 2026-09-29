/**
 * GA4 por página (migración 100) contra la base REAL. Solo lecturas.
 *
 * Lo que solo se ve con datos de verdad:
 *   · por página de entrada, la suma de sesiones cuadra con la de campañas
 *     (las dos salen de GA4; con umbrales podrían diferir, se admite un 5 %);
 *   · los leads por página suman el total, y el gasto sale «—», nunca 0;
 *   · las vistas por página y los visitantes llegan, y lo que no aplica sale null;
 *   · el filtro de página de entrada tiene valores (también los de GA4).
 *
 * Usa el primer cliente con páginas de GA4 sincronizadas y el que más leads con
 * página tenga. Sin ninguno de los dos, lo dice y no falla: no es un error del
 * código que un entorno aún no tenga GA4 por página.
 *
 *   npx tsx --conditions=react-server scripts/verify-ga4-paginas-db.ts
 */
import { config as loadEnv } from 'dotenv';
import { salir } from './_salida';
loadEnv({ path: '.env.local' });

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

async function main() {
  const { createClient } = await import('@supabase/supabase-js');
  const { runBiQuery, runValores } = await import('../src/lib/report-utm/bi-query');
  const { addDaysISO, colombiaToday } = await import('../src/lib/colombia-date');
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const hasta = addDaysISO(colombiaToday(), -2);
  const desde = addDaysISO(hasta, -26);
  const rtmDe = async (publicId: string) =>
    (
      await db
        .schema('report_utm')
        .from('clientes')
        .select('id')
        .eq('public_cliente_id', publicId)
        .maybeSingle()
    ).data?.id as string | undefined;

  // ── Cliente con GA4 por página ──────────────────────────────────
  const { data: est, error } = await db
    .from('ga4_estado')
    .select('cliente_id, paginas_ultimo_ok_at')
    .not('paginas_ultimo_ok_at', 'is', null)
    .limit(1);
  if (error) {
    console.log(`  · ga4_estado sin columnas de páginas (¿migración 100?): ${error.message}`);
  }
  const conGa = est?.[0]?.cliente_id as string | undefined;
  const rtmGa = conGa ? await rtmDe(conGa) : undefined;

  console.log(`\n── GA4 por página (${desde} … ${hasta}) ──────────────────────────`);
  if (!rtmGa) {
    console.log('  · Ningún cliente tiene páginas de GA4 sincronizadas: se omite.');
  } else {
    const base = { cliente_id: rtmGa, date_from: desde, date_to: hasta } as never;
    const q = (p: Record<string, unknown>) => runBiQuery({ ...(base as object), ...p } as never);

    const porCampana = await q({
      metrics: ['ga4_sesiones'],
      dimension: 'utm_campaign',
      limit: 1000,
    });
    const porLanding = await q({
      metrics: [
        'ga4_sesiones',
        'ga4_visitantes',
        'leads_count',
        'spend',
        'cpl',
        'ga4_coste_sesion',
      ],
      dimension: 'landing',
      limit: 1000,
    });
    const suma = (rs: Record<string, unknown>[], k: string) =>
      rs.reduce((a, r) => a + (Number(r[k] ?? 0) || 0), 0);
    const sc = suma(porCampana, 'ga4_sesiones');
    const sl = suma(porLanding, 'ga4_sesiones');
    check(
      `Σ sesiones por landing ≈ por campaña (${sl} frente a ${sc})`,
      sc > 0 && Math.abs(sl - sc) / sc <= 0.05
    );
    check(
      'por landing, gasto, CPL y coste por sesión salen «—» (null), nunca 0',
      porLanding.every((r) => r.spend === null && r.cpl === null && r.ga4_coste_sesion === null)
    );
    check(
      'por landing, ninguna fila sin nombre',
      porLanding.every((r) => r.dimension_value)
    );
    check(
      'los visitantes llegan y no superan a las sesiones',
      suma(porLanding, 'ga4_visitantes') > 0 &&
        porLanding.every((r) => Number(r.ga4_visitantes ?? 0) <= Number(r.ga4_sesiones ?? 0))
    );

    const vistas = await q({
      metrics: ['ga4_vistas', 'leads_count'],
      dimension: 'ga4_pagina',
      limit: 50,
    });
    check('hay vistas por página', suma(vistas, 'ga4_vistas') > 0);
    check(
      'por página vista, los leads salen «—» (no tienen página vista)',
      vistas.every((r) => r.leads_count === null)
    );
    const total = await q({ metrics: ['ga4_vistas', 'ga4_sesiones'], dimension: 'none' });
    check(
      'las vistas del total ≥ sesiones (cada sesión ve al menos una página)',
      Number(total[0]?.ga4_vistas ?? 0) >= Number(total[0]?.ga4_sesiones ?? 0) * 0.9
    );

    const anuncio = await q({ metrics: ['ga4_vistas'], dimension: 'utm_content', limit: 2 });
    check(
      'vistas por anuncio → «—»',
      anuncio.every((r) => r.ga4_vistas === null)
    );

    const valores = await runValores({
      cliente_id: rtmGa,
      dimension: 'landing',
      date_from: desde,
      date_to: hasta,
    } as never);
    const lista = (valores as { valores?: Array<{ valor: string }> }).valores ?? [];
    check('el filtro «Página de entrada» tiene valores', lista.length > 0);
    if (lista.length) {
      const pagina = lista[0].valor;
      const filtrado = await q({
        metrics: ['ga4_sesiones', 'spend'],
        dimension: 'none',
        filters: { landing: pagina },
      });
      const deEsa = porLanding.find((r) => r.dimension_value === pagina);
      check(
        `filtrar por «${pagina}» da las sesiones de esa página`,
        Number(filtrado[0]?.ga4_sesiones ?? -1) === Number(deEsa?.ga4_sesiones ?? -2),
        `${filtrado[0]?.ga4_sesiones} frente a ${deEsa?.ga4_sesiones}`
      );
      check('y el gasto, que no tiene página, sale «—»', filtrado[0]?.spend === null);
    }
  }

  // ── Leads por página ────────────────────────────────────────────
  console.log('\n── Leads por página de entrada ─────────────────────────────');
  const { data: conUrl } = await db
    .schema('report_utm')
    .from('lead_events')
    .select('cliente_id')
    .not('page_url', 'is', null)
    .gte('created_at', `${desde}T00:00:00Z`)
    .limit(1);
  const rtmLeads = conUrl?.[0]?.cliente_id as string | undefined;
  if (!rtmLeads) {
    console.log('  · Ningún lead con página en el rango: se omite.');
  } else {
    const base = { cliente_id: rtmLeads, date_from: desde, date_to: hasta };
    const total = await runBiQuery({
      ...base,
      metrics: ['leads_count'],
      dimension: 'none',
    } as never);
    const porLanding = await runBiQuery({
      ...base,
      metrics: ['leads_count', 'spend'],
      dimension: 'landing',
      limit: 5000,
    } as never);
    const sumaLeads = porLanding.reduce((a, r) => a + Number(r.leads_count ?? 0), 0);
    check(
      `Σ leads por landing = total (${sumaLeads} frente a ${total[0]?.leads_count})`,
      sumaLeads === Number(total[0]?.leads_count ?? -1)
    );
    check(
      'el gasto por landing sale «—»',
      porLanding.every((r) => r.spend === null)
    );
    check(
      'las rutas vienen normalizadas (sin host, query ni barra final)',
      porLanding.every((r) => {
        const v = String(r.dimension_value ?? '');
        return (
          v === '(sin página)' ||
          (v.startsWith('/') && !v.includes('?') && (v === '/' || !v.endsWith('/')))
        );
      })
    );
  }

  console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
  salir(fallos);
}

main().catch((e) => {
  console.error('FALLO', e?.stack ?? e);
  process.exit(1);
});
