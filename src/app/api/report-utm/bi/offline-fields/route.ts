import { NextRequest, NextResponse } from 'next/server';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import type { OfflineFieldMeta } from '@/lib/report-utm/bi-metadata';

export const dynamic = 'force-dynamic';

/**
 * Columnas adicionales de los Google Sheets offline de un cliente, para que el
 * BI las ofrezca como métricas (token "offfield:<clave>").
 *
 *   GET /api/report-utm/bi/offline-fields?cliente_id=
 *
 * Salen de la CONFIG del cliente (`clientes.config_api.google_sheets_conversiones`,
 * formato con `tabs` o el plano anterior), no de escanear datos: el analista ya
 * declaró ahí qué columnas se sincronizan y de qué tipo son. Las de tipo texto o
 * fecha se omiten — el BI solo grafica números.
 */
export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const clienteId = req.nextUrl.searchParams.get('cliente_id');
  if (!clienteId) return NextResponse.json({ data: [] });

  try {
    const admin = await createAdminClient();
    const { data: rtmCliente } = await admin
      .schema('report_utm')
      .from('clientes')
      .select('public_cliente_id')
      .eq('id', clienteId)
      .maybeSingle();
    const publicId = rtmCliente?.public_cliente_id;
    if (!publicId) return NextResponse.json({ data: [] });

    const { data: cliente } = await admin
      .from('clientes')
      .select('config_api')
      .eq('id', publicId)
      .maybeSingle();

    // Forma mínima de la config que hace falta acá (la completa vive en
    // ConversionesConfig, en la librería de Sheets, que es server-only).
    interface ColDef {
      col_name?: string;
      type?: string;
      label?: string;
      include?: boolean;
    }
    interface TabCfg {
      sheet_name?: string;
      custom_columns?: Record<string, ColDef>;
    }
    interface SheetCfg {
      name?: string;
      custom_columns?: Record<string, ColDef>;
      tabs?: TabCfg[];
    }

    const raw = (cliente?.config_api as Record<string, unknown> | null)?.google_sheets_conversiones;
    const sheets: SheetCfg[] = Array.isArray(raw)
      ? (raw as SheetCfg[])
      : raw && typeof raw === 'object'
        ? [raw as SheetCfg]
        : [];

    const byKey = new Map<string, OfflineFieldMeta>();
    const absorb = (cols: Record<string, ColDef> | undefined, source: string) => {
      for (const [key, def] of Object.entries(cols ?? {})) {
        if (!def || def.include === false) continue;
        if (def.type !== 'count' && def.type !== 'currency' && def.type !== 'percentage') continue;
        const existing = byKey.get(key);
        if (existing) {
          if (!existing.sources.includes(source)) existing.sources.push(source);
        } else {
          byKey.set(key, {
            key,
            label: def.label || def.col_name || key,
            type: def.type,
            sources: [source],
          });
        }
      }
    };

    for (const sheet of sheets) {
      const sheetName = sheet.name || 'Sheet';
      absorb(sheet.custom_columns, sheetName);
      for (const tab of sheet.tabs ?? []) {
        absorb(tab.custom_columns, `${sheetName} › ${tab.sheet_name || '(primera pestaña)'}`);
      }
    }

    const data = Array.from(byKey.values()).sort((a, b) => a.label.localeCompare(b.label));
    return NextResponse.json({ data });
  } catch (err) {
    console.error('[bi/offline-fields]', err);
    return NextResponse.json({ error: 'Query error' }, { status: 500 });
  }
}
