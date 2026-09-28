/**
 * Comprobaciones puras de la auditoría de Hotmart (2026-09-25):
 *
 *   · atribución de ventas heredando la UTM del lead (`src/lib/hotmart/atribucion.ts`)
 *   · lo que aporta cada venta a las métricas hm_* (`src/lib/hotmart/metricas.ts`)
 *   · la guarda de ceros del worker (`src/lib/hotmart/guarda.ts`)
 *   · la fusión del desglose por pestaña con GA4 (`src/lib/hotmart/reagregar.ts`)
 *
 * Todo en memoria, sin BD ni red.
 *
 *   npx tsx --conditions=react-server scripts/verify-hotmart-atribucion.ts
 */

import {
  atribuirLotePuro,
  elegirLead,
  esTracking,
  normalizarEmail,
  tel9,
  type LeadCandidato,
  type VentaAtribuible,
} from '../src/lib/hotmart/atribucion';
import {
  aporteDeVenta,
  aporteVacio,
  derivadasHotmart,
  esCompra,
  sumarAporte,
} from '../src/lib/hotmart/metricas';
import { decidirGuardaHotmart, tieneDatosHotmart } from '../src/lib/hotmart/guarda';
import { fusionarFunnelData } from '../src/lib/hotmart/reagregar';
import { desgloseVacio, registroVacio } from '../src/lib/hotmart/sync';
import { ventanaDiaColombia } from '../src/lib/hotmart/cliente';
import { diaEnZona, ventanaDiaEnZona, zonaHorariaDeCliente } from '../src/lib/zona-horaria';
import { salir } from './_salida';

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

function venta(p: Partial<VentaAtribuible> & { transaction_id: string }): VentaAtribuible {
  return {
    parent_transaction_id: null,
    es_order_bump: false,
    tipo: 'principal',
    comprador_email: null,
    comprador_telefono: null,
    orden_at: '2026-08-10T15:00:00.000Z',
    aprobada_at: '2026-08-10T15:00:05.000Z',
    fecha_venta: '2026-08-10',
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    utm_id: null,
    ...p,
  };
}

function lead(p: Partial<LeadCandidato> & { id: string; created_at: string }): LeadCandidato {
  return {
    email_norm: null,
    tel9: null,
    utm_source: 'Instagram_Feed',
    utm_medium: 'ig',
    utm_campaign: 'CAMP',
    utm_content: 'AD',
    utm_term: 'ADSET',
    utm_id: '120200000000000001',
    ...p,
  };
}

// ════════════════════════════════════════════════════════════
seccion('Normalización: el espejo de la RPC de la 089');
// ════════════════════════════════════════════════════════════
check(
  'email en minúsculas y sin espacios',
  normalizarEmail('  Ana@Ejemplo.COM ') === 'ana@ejemplo.com'
);
check('un texto sin @ no es email', normalizarEmail('ana') === null);
check('teléfono: últimos 9 dígitos', tel9('+56 9 8765 4321') === '987654321');
check('teléfono con menos de 8 dígitos no cruza', tel9('12345') === null);

// ════════════════════════════════════════════════════════════
seccion('Elegir lead: último antes de la compra, email antes que teléfono');
// ════════════════════════════════════════════════════════════
{
  const v = venta({
    transaction_id: 'T1',
    comprador_email: 'ana@x.com',
    comprador_telefono: '+56987654321',
  });
  const candidatos = [
    lead({
      id: 'L-viejo',
      created_at: '2026-08-01T10:00:00Z',
      email_norm: 'ana@x.com',
      utm_campaign: 'VIEJA',
    }),
    lead({
      id: 'L-nuevo',
      created_at: '2026-08-09T10:00:00Z',
      email_norm: 'ana@x.com',
      utm_campaign: 'NUEVA',
    }),
    lead({
      id: 'L-despues',
      created_at: '2026-08-11T10:00:00Z',
      email_norm: 'ana@x.com',
      utm_campaign: 'TARDE',
    }),
    lead({
      id: 'L-tel',
      created_at: '2026-08-10T14:00:00Z',
      tel9: '987654321',
      utm_campaign: 'TEL',
    }),
  ];
  const r = elegirLead(v, candidatos);
  check('el último lead ANTERIOR a la compra (last touch)', r?.lead.id === 'L-nuevo', r?.lead.id);
  check('por email antes que por teléfono', r?.metodo === 'lead_email');

  const soloTel = elegirLead(venta({ ...v, comprador_email: 'otra@x.com' }), candidatos);
  check(
    'sin email que cruce, cae al teléfono',
    soloTel?.metodo === 'lead_telefono' && soloTel.lead.id === 'L-tel'
  );

  const viejo = elegirLead(v, [
    lead({ id: 'L-2025', created_at: '2025-12-01T10:00:00Z', email_norm: 'ana@x.com' }),
  ]);
  check('un lead de hace más de 180 días no cuenta', viejo === null);

  const reloj = elegirLead(v, [
    lead({ id: 'L-casi', created_at: '2026-08-10T15:03:00Z', email_norm: 'ana@x.com' }),
  ]);
  check('tolera unos minutos de reloj tras la orden', reloj?.lead.id === 'L-casi');
}

// ════════════════════════════════════════════════════════════
seccion('Lote: tracking gana, padres primero, añadidos heredan');
// ════════════════════════════════════════════════════════════
{
  const conTracking = venta({
    transaction_id: 'P-TRACK',
    comprador_email: 'b@x.com',
    utm_campaign: 'DE_HOTMART',
  });
  const principal = venta({ transaction_id: 'P1', comprador_email: 'ana@x.com' });
  const bump = venta({
    transaction_id: 'B1',
    comprador_email: 'Ana@x.com',
    tipo: 'bump',
    orden_at: '2026-08-10T15:00:20.000Z',
  });
  const huerfano = venta({ transaction_id: 'U1', comprador_email: 'nadie@x.com', tipo: 'upsell' });
  const candidatos = [
    lead({
      id: 'L1',
      created_at: '2026-08-09T10:00:00Z',
      email_norm: 'ana@x.com',
      utm_campaign: 'CAMP_LEAD',
    }),
    lead({
      id: 'L2',
      created_at: '2026-08-09T10:00:00Z',
      email_norm: 'b@x.com',
      utm_campaign: 'NO_DEBE',
    }),
  ];
  const r = atribuirLotePuro(
    [bump, conTracking, principal, huerfano],
    candidatos,
    [],
    new Date('2026-09-25T00:00:00Z')
  );

  check(
    'una venta con campaña propia queda como tracking',
    conTracking.atribucion_metodo === 'tracking'
  );
  check('y el lead NO la pisa', conTracking.utm_campaign === 'DE_HOTMART');
  check(
    'el principal hereda del lead',
    principal.utm_campaign === 'CAMP_LEAD' && principal.atribucion_metodo === 'lead_email'
  );
  check('con el id del lead', principal.atribucion_lead_id === 'L1');
  check(
    'la tupla entera, como bloque',
    principal.utm_term === 'ADSET' && principal.utm_id === '120200000000000001'
  );
  check(
    'el bump hereda de su principal (mismo email, mismo checkout)',
    bump.atribucion_metodo === 'padre' && bump.utm_campaign === 'CAMP_LEAD'
  );
  check(
    'un añadido sin padre ni lead queda sin atribuir',
    !huerfano.atribucion_metodo && !huerfano.utm_campaign
  );
  check('cuenta 2 atribuidas nuevas', r.atribuidas === 2, String(r.atribuidas));
  check(
    'desglose por método',
    r.porMetodo.tracking === 1 && r.porMetodo.lead_email === 1 && r.porMetodo.padre === 1
  );
}
{
  // Padre guardado en una corrida anterior (fuera del lote).
  const padreViejo = venta({
    transaction_id: 'P0',
    comprador_email: 'c@x.com',
    utm_campaign: 'CAMP_TRACK_PADRE',
  });
  const hijo = venta({
    transaction_id: 'H0',
    parent_transaction_id: 'P0',
    tipo: 'upsell',
    comprador_email: 'c@x.com',
  });
  atribuirLotePuro([hijo], [], [padreViejo]);
  check(
    'un añadido encuentra a su padre fuera del lote',
    hijo.atribucion_metodo === 'padre' && hijo.utm_campaign === 'CAMP_TRACK_PADRE'
  );
}

// ════════════════════════════════════════════════════════════
seccion('Macros e IDs del lead (auditoría del 2026-09-28)');
// ════════════════════════════════════════════════════════════
{
  const conMacro = venta({
    transaction_id: 'HP-MACRO',
    utm_campaign: '{{campaign.name}}',
    comprador_email: 'm@x.com',
  });
  check('una macro sin rellenar NO es tracking propio', !esTracking(conMacro));
  const soloIds = lead({
    id: 'L-IDS',
    created_at: '2026-08-09T15:00:00.000Z',
    email_norm: 'm@x.com',
    utm_campaign: null,
    utm_id: null,
    utm_content: null,
    utm_term: null,
    ad_id: '120200000000000777',
    adset_id: '120200000000000070',
    campaign_id: '120200000000000007',
  });
  atribuirLotePuro([conMacro], [soloIds]);
  check(
    'un lead que solo trae IDs es candidato, y la macro ya no bloquea',
    conMacro.atribucion_lead_id === 'L-IDS',
    String(conMacro.atribucion_lead_id)
  );
  check(
    'la venta hereda el ID más específico en utm_id (el anuncio)',
    conMacro.utm_id === '120200000000000777',
    String(conMacro.utm_id)
  );
  const soloMacro = lead({
    id: 'L-MACRO',
    created_at: '2026-08-09T15:00:00.000Z',
    email_norm: 'n@x.com',
    utm_campaign: '{{campaign.name}}',
    utm_id: null,
  });
  const v2 = venta({ transaction_id: 'HP-N', comprador_email: 'n@x.com' });
  atribuirLotePuro([v2], [soloMacro]);
  check('un lead cuya única señal es una macro no se hereda', !v2.atribucion_metodo);
}

// ════════════════════════════════════════════════════════════
seccion('Aporte de cada venta: ventas frente a compras');
// ════════════════════════════════════════════════════════════
// Cris jul-ago: 53 principales + 34 bumps + 1 upsell = 88 «ventas». El CPA
// dividido entre 88 sale un ~40 % más bajo que lo que cuesta un comprador.
{
  const conv = (usd: number) => usd * 1000;
  const filas = [
    {
      fecha_venta: '2026-08-10',
      estado: 'completa',
      tipo: 'principal',
      neto_productor_usd: 10,
      bruto_usd: 20,
    },
    {
      fecha_venta: '2026-08-10',
      estado: 'completa',
      tipo: 'bump',
      es_order_bump: true,
      neto_productor_usd: 3,
      bruto_usd: 6,
    },
    {
      fecha_venta: '2026-08-10',
      estado: 'aprobada',
      tipo: 'upsell',
      neto_productor_usd: 5,
      bruto_usd: 9,
    },
    {
      fecha_venta: '2026-08-10',
      estado: 'reembolsada',
      tipo: 'principal',
      neto_productor_usd: 10,
      bruto_usd: 20,
    },
    {
      fecha_venta: '2026-08-10',
      estado: 'pendiente',
      tipo: 'principal',
      neto_productor_usd: 10,
      bruto_usd: 20,
    },
    // Sin embudo configurado todo es `sin_clasificar`: sigue siendo una compra.
    {
      fecha_venta: '2026-08-10',
      estado: 'completa',
      tipo: 'sin_clasificar',
      neto_productor_usd: 7,
      bruto_usd: 14,
    },
  ];
  const t = filas.reduce((acc, f) => sumarAporte(acc, aporteDeVenta(f, conv)), aporteVacio());
  check('hm_ventas cuenta transacciones cobradas (4)', t.hm_ventas === 4, String(t.hm_ventas));
  check(
    'hm_compras cuenta pedidos (principal + sin clasificar = 2)',
    t.hm_compras === 2,
    String(t.hm_compras)
  );
  check('hm_bumps (1)', t.hm_bumps === 1);
  check('hm_neto convertido y SIN lo reembolsado', t.hm_neto === 25_000, String(t.hm_neto));
  check('hm_neto_usd sin convertir', t.hm_neto_usd === 25);
  check('reembolsos aparte', t.hm_reembolsos === 1 && t.hm_neto_reembolsado === 10_000);
  check('una pendiente no aporta nada', aporteDeVenta(filas[4], conv).hm_ventas === 0);
  check(
    'un bump con padre no es compra',
    !esCompra({ estado: 'completa', tipo: 'principal', parent_transaction_id: 'X' })
  );

  const d = derivadasHotmart(t, 50_000, 10);
  check('CPA por compra = gasto / compras', d.hm_cpa_compra === 25_000);
  check('CPA por venta = gasto / ventas', d.hm_cpa === 12_500);
  check('ROAS = neto / gasto', d.hm_roas === 0.5);
  check(
    'tasa de reembolso sobre lo facturado ANTES de devolver (10/35)',
    Math.abs((d.hm_tasa_reembolso ?? 0) - (10_000 / 35_000) * 100) < 1e-9,
    String(d.hm_tasa_reembolso)
  );
  check('tasa de bump = bumps / compras', d.hm_tasa_bump === 50);
  check('conversión = compras / leads', d.hm_conversion === 20);
  check(
    'sin gasto, ROAS y CPA son null (no 0)',
    derivadasHotmart(t, 0).hm_roas === null && derivadasHotmart(t, 0).hm_cpa === null
  );
  check(
    'la mitad devuelta da 50 %, no 100 %',
    derivadasHotmart({ ...aporteVacio(), hm_neto: 50, hm_neto_reembolsado: 50 }, 1)
      .hm_tasa_reembolso === 50
  );
}

// ════════════════════════════════════════════════════════════
seccion('Guarda del worker: día con solo reembolsos y ventas que cambian de día');
// ════════════════════════════════════════════════════════════
{
  const soloReembolso = { ...registroVacio(), ventas_count: 0, reembolsado_count: 1 };
  const prev = { ventas_principal_count: 1, ventas_principal: 9.7 };
  check(
    'una fila con solo reembolsos «tiene datos»',
    tieneDatosHotmart({ ventas_reembolsado_count: 1 })
  );
  check(
    'un día cuyo único pedido se reembolsó se ESCRIBE (antes quedaba congelado)',
    !decidirGuardaHotmart(prev, soloReembolso, false).preservar
  );
  const cero = { ...registroVacio(), ventas_count: 0, reembolsado_count: 0 };
  check(
    'dentro de la tabla, un cero es un cero (la venta se movió de día)',
    !decidirGuardaHotmart(prev, cero, true).preservar
  );
  check(
    'fuera de la tabla (datos heredados), el cero con datos previos se preserva',
    decidirGuardaHotmart(prev, cero, false).preservar
  );
  const caida = { ...registroVacio(), ventas_count: 2, reembolsado_count: 0 };
  check(
    'caída relativa fuerte fuera de la tabla se preserva',
    decidirGuardaHotmart({ ventas_principal_count: 5, ventas_bump_count: 5 }, caida, false)
      .motivo === 'caida_relativa'
  );
  check(
    'la caída relativa cuenta bumps y downsells previos',
    decidirGuardaHotmart({ ventas_bump_count: 6, ventas_downsell_count: 4 }, caida, false)
      .ventasPrevias === 10
  );
}

// ════════════════════════════════════════════════════════════
seccion('Reagregar no pisa lo que midió GA4');
// ════════════════════════════════════════════════════════════
{
  const reg = registroVacio();
  reg.by_tab = { T1: desgloseVacio() };
  reg.by_tab.T1.principal = { count: 3, gross: 60, net: 30 };
  const previo = {
    by_tab: {
      T1: {
        ...desgloseVacio(),
        principal: { count: 1, gross: 20, net: 10 },
        upsell: { count: 0, gross: 0, net: 0, page_visits: 42 },
        pagos_iniciados: 7,
        landing_sessions: 900,
      },
    },
    extras: [],
    otra_clave: 'se conserva',
  };
  const f = fusionarFunnelData(previo, reg);
  check('las ventas se reemplazan', f.by_tab?.T1?.principal?.count === 3);
  check(
    'las visitas a la página de upsell (GA4) se conservan',
    (f.by_tab?.T1?.upsell as { page_visits: number }).page_visits === 42
  );
  check('los pagos iniciados (GA4) se conservan', f.by_tab?.T1?.pagos_iniciados === 7);
  check('las sesiones de landing (GA4) se conservan', f.by_tab?.T1?.landing_sessions === 900);
  check('otras claves del JSON se conservan', f.otra_clave === 'se conserva');
}

// ════════════════════════════════════════════════════════════
seccion('Zona horaria por cliente (infraestructura, sin activar)');
// ════════════════════════════════════════════════════════════
{
  const bog = ventanaDiaEnZona('2026-08-10', 'America/Bogota');
  const col = ventanaDiaColombia('2026-08-10');
  check('Bogotá reproduce ventanaDiaColombia', bog.inicio === col.inicio && bog.fin === col.fin);
  // Santiago en agosto: UTC-4 (invierno austral).
  const scl = ventanaDiaEnZona('2026-08-10', 'America/Santiago');
  check(
    'Santiago en invierno empieza a las 04:00 UTC',
    new Date(scl.inicio).toISOString() === '2026-08-10T04:00:00.000Z',
    new Date(scl.inicio).toISOString()
  );
  // Santiago en septiembre ya está en UTC-3.
  const sclVerano = ventanaDiaEnZona('2026-09-24', 'America/Santiago');
  check(
    'Santiago en verano empieza a las 03:00 UTC',
    new Date(sclVerano.inicio).toISOString() === '2026-09-24T03:00:00.000Z',
    new Date(sclVerano.inicio).toISOString()
  );
  check(
    'el día termina 1 ms antes del siguiente',
    scl.fin === ventanaDiaEnZona('2026-08-11', 'America/Santiago').inicio - 1
  );
  check(
    'a las 23:30 de Chile, los dos países siguen en el mismo día',
    diaEnZona('2026-08-11T03:30:00Z', 'America/Santiago') === '2026-08-10' &&
      diaEnZona('2026-08-11T03:30:00Z', 'America/Bogota') === '2026-08-10'
  );
  check(
    'a las 00:30 de Chile, Colombia sigue en el día anterior',
    diaEnZona('2026-08-11T04:30:00Z', 'America/Santiago') === '2026-08-11' &&
      diaEnZona('2026-08-11T04:30:00Z', 'America/Bogota') === '2026-08-10'
  );
  check('sin zona configurada, Colombia', zonaHorariaDeCliente({}) === 'America/Bogota');
  check(
    'una zona inválida cae a Colombia',
    zonaHorariaDeCliente({ zona_horaria: 'Marte/Olympus' }) === 'America/Bogota'
  );
  check(
    'una zona válida se respeta',
    zonaHorariaDeCliente({ zona_horaria: 'America/Santiago' }) === 'America/Santiago'
  );
}

console.log(`\n${fallos === 0 ? '✓ TODO OK' : `✗ ${fallos} FALLO(S)`}\n`);
salir(fallos);
