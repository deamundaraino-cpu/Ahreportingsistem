// Cron: resumen diario de métricas a grupos de WhatsApp.
//
// Para cada cliente con datos del día anterior, arma un resumen corto y lo
// envía vía sendWhatsAppNotification(type='metrics_summary'). El ruteo decide
// a qué grupo(s) va (ruta del cliente, o global por tipo). Protegido por
// CRON_SECRET (mismo patrón que /api/cron/refresh-meta-tokens).
//
// Moneda: el gasto de Meta está en la moneda de la cuenta publicitaria y las
// ventas de Hotmart en USD. Las ventas se convierten a la moneda de reporte del
// cliente con la tasa del día (lo mismo que el dashboard) y cada importe lleva
// su código ISO: un «$» a secas no decía si eran dólares o pesos.

import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { createAdminClient } from '@/utils/supabase/server';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import { colombiaYesterday } from '@/lib/date-utils';
import {
  cargarConversor,
  formatearMoneda,
  monedaDeClientePublico,
  type ConversorMoneda,
  type MonedaReporte,
} from '@/lib/moneda-reporte';
import { ingresosEnMonedaReporte } from '@/lib/notifications/rules-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DailyRow = {
  cliente_id: string;
  fecha: string;
  meta_spend: number | null;
  meta_clicks: number | null;
  hotmart_pagos_iniciados: number | null;
  ventas_principal: number | null;
  ventas_bump: number | null;
  ventas_upsell: number | null;
  ventas_downsell: number | null;
};

function buildMessage(nombre: string, fecha: string, r: DailyRow, conv: ConversorMoneda): string {
  const spend = Number(r.meta_spend ?? 0);
  // Misma definición que `total_facturacion_neta`: principal + bump + upsell +
  // downsell, ya en la moneda de reporte.
  const ventas = ingresosEnMonedaReporte([r], conv);
  // Sin tasa del día las ventas se quedan en USD (el conversor nunca las pone a
  // 0): se etiquetan como tales y no se calcula un ROAS que mezclaría monedas.
  const sinTasa = ventas !== 0 && conv.tasa(fecha) === null;
  const monedaVentas = sinTasa ? 'USD' : conv.moneda;
  const pagos = Number(r.hotmart_pagos_iniciados ?? 0);
  const clicks = Number(r.meta_clicks ?? 0);
  const roas = spend > 0 && !sinTasa ? (ventas / spend).toFixed(2) : '—';

  return (
    `📊 *${nombre}* — ${fecha}\n` +
    `Inversión Meta: ${formatearMoneda(spend, conv.moneda)}\n` +
    `Clicks: ${clicks}\n` +
    `Pagos iniciados: ${pagos}\n` +
    `Ventas: ${formatearMoneda(ventas, monedaVentas)}` +
    (sinTasa ? ` (sin tasa de cambio a ${conv.moneda})` : '') +
    `\n` +
    `ROAS: ${roas}`
  );
}

export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const supabase = await createAdminClient();
  const fecha = colombiaYesterday(); // "ayer" en hora Colombia (UTC-5)

  const { data: rows, error } = await supabase
    .from('metricas_diarias')
    .select(
      'cliente_id, fecha, meta_spend, meta_clicks, hotmart_pagos_iniciados, ventas_principal, ventas_bump, ventas_upsell, ventas_downsell'
    )
    .eq('fecha', fecha);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: clientes } = await supabase.from('clientes').select('id, nombre');
  const nombreById = new Map((clientes ?? []).map((c) => [c.id, c.nombre]));

  // Un conversor por moneda: todos los clientes comparten la fecha, así que la
  // tasa de CLP de ayer es la misma para cualquiera que reporte en CLP.
  const conversores = new Map<MonedaReporte, Promise<ConversorMoneda>>();
  const conversorDe = (moneda: MonedaReporte) => {
    let p = conversores.get(moneda);
    if (!p) {
      p = cargarConversor(supabase, moneda, fecha, fecha);
      conversores.set(moneda, p);
    }
    return p;
  };

  const results: { cliente_id: string; sent: number; failed: number; skipped: boolean }[] = [];
  for (const r of (rows ?? []) as DailyRow[]) {
    const nombre = nombreById.get(r.cliente_id) ?? 'Cliente';
    try {
      const conv = await conversorDe(await monedaDeClientePublico(supabase, r.cliente_id));
      const message = buildMessage(nombre, fecha, r, conv);
      const res = await sendWhatsAppNotification({
        db: supabase,
        clienteId: r.cliente_id,
        notificationType: 'metrics_summary',
        message,
      });
      results.push({ cliente_id: r.cliente_id, ...res });
    } catch (err) {
      results.push({ cliente_id: r.cliente_id, sent: 0, failed: 1, skipped: false });
      console.error('[whatsapp-digest] error', r.cliente_id, err);
    }
  }

  const sent = results.reduce((a, r) => a + r.sent, 0);
  return NextResponse.json({ ok: true, fecha, clientes: results.length, sent, results });
}
