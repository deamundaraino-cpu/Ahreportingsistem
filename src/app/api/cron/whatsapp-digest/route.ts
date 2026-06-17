// Cron: resumen diario de métricas a grupos de WhatsApp.
//
// Para cada cliente con datos del día anterior, arma un resumen corto y lo
// envía vía sendWhatsAppNotification(type='metrics_summary'). El ruteo decide
// a qué grupo(s) va (ruta del cliente, o global por tipo). Protegido por
// CRON_SECRET (mismo patrón que /api/cron/refresh-meta-tokens).

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/utils/supabase/server';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import { colombiaYesterday } from '@/lib/date-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type DailyRow = {
  cliente_id: string;
  meta_spend: number | null;
  meta_clicks: number | null;
  hotmart_pagos_iniciados: number | null;
  ventas_principal: number | null;
  ventas_bump: number | null;
  ventas_upsell: number | null;
};

function buildMessage(nombre: string, fecha: string, r: DailyRow): string {
  const spend = Number(r.meta_spend ?? 0);
  const ventas =
    Number(r.ventas_principal ?? 0) + Number(r.ventas_bump ?? 0) + Number(r.ventas_upsell ?? 0);
  const pagos = Number(r.hotmart_pagos_iniciados ?? 0);
  const clicks = Number(r.meta_clicks ?? 0);
  const roas = spend > 0 ? (ventas / spend).toFixed(2) : '—';

  return (
    `📊 *${nombre}* — ${fecha}\n` +
    `Inversión Meta: $${spend.toFixed(2)}\n` +
    `Clicks: ${clicks}\n` +
    `Pagos iniciados: ${pagos}\n` +
    `Ventas: $${ventas.toFixed(2)}\n` +
    `ROAS: ${roas}`
  );
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = await createAdminClient();
  const fecha = colombiaYesterday(); // "ayer" en hora Colombia (UTC-5)

  const { data: rows, error } = await supabase
    .from('metricas_diarias')
    .select(
      'cliente_id, meta_spend, meta_clicks, hotmart_pagos_iniciados, ventas_principal, ventas_bump, ventas_upsell'
    )
    .eq('fecha', fecha);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: clientes } = await supabase.from('clientes').select('id, nombre');
  const nombreById = new Map((clientes ?? []).map((c) => [c.id, c.nombre]));

  const results: { cliente_id: string; sent: number; failed: number; skipped: boolean }[] = [];
  for (const r of (rows ?? []) as DailyRow[]) {
    const nombre = nombreById.get(r.cliente_id) ?? 'Cliente';
    const message = buildMessage(nombre, fecha, r);
    try {
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
