import { NextRequest, NextResponse } from 'next/server';
import { reportUtmClient } from '@/lib/report-utm/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Paginar hasta MAX_ROWS en una sola invocación puede tardar bastante y por
// defecto Vercel corta a los 10 s: sin este tope explícito el export grande
// se cae a medias en vez de terminar.
export const maxDuration = 60;

/**
 * Exporta los leads (filtrados) a CSV.
 *
 *   GET /api/report-utm/leads/export?clienteId=&utm_source=&utm_campaign=&...
 *
 * Usa el cliente con sesión del usuario, por lo que RLS aplica:
 * solo superadmin/admin/trafficker autenticados pueden exportar.
 */

// PostgREST limita cada respuesta a `db-max-rows` (≈1000) sin importar el
// `.limit()` que se pida, así que traemos TODO paginando con `.range()`.
const PAGE_SIZE = 1000;
// Tope de seguridad para evitar bucles infinitos ante datasets enormes.
const MAX_ROWS = 500_000;

const COLUMNS: { key: string; header: string }[] = [
  { key: 'created_at', header: 'Fecha' },
  { key: 'lead_name', header: 'Nombre' },
  { key: 'lead_email', header: 'Email' },
  { key: 'lead_phone', header: 'Teléfono' },
  { key: 'form_name', header: 'Formulario' },
  { key: 'form_plugin', header: 'Plugin' },
  { key: 'utm_source', header: 'UTM Source' },
  { key: 'utm_medium', header: 'UTM Medium' },
  { key: 'utm_campaign', header: 'UTM Campaign' },
  { key: 'utm_content', header: 'UTM Content' },
  { key: 'utm_term', header: 'UTM Term' },
  { key: 'utm_id', header: 'UTM ID' },
  { key: 'click_id', header: 'Click ID' },
  { key: 'attribution_method', header: 'Atribución' },
  { key: 'ip_country', header: 'País' },
  { key: 'page_url', header: 'Página de destino' },
];

const UTM_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);

/** Decodifica percent-encoding solo si el valor todavía viene codificado. */
function dec(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return s;
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Escapa un campo para CSV (RFC 4180). */
function csvField(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const supabase = await reportUtmClient();

  const clienteId = sp.get('clienteId');
  const formPlugin = sp.get('form_plugin');
  const utmSource = sp.get('utm_source');
  const utmCampaign = sp.get('utm_campaign');
  const utmContent = sp.get('utm_content');
  const from = sp.get('from');
  const to = sp.get('to');

  // Si `to` viene como fecha (YYYY-MM-DD) sin hora, incluimos todo ese día
  // hasta las 23:59:59 — igual que la página de leads. Sin esto la
  // exportación por rango excluía casi todo el último día del rango.
  const toBound = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59` : to;

  // Aplica todos los filtros a una query nueva (se reconstruye por página).
  const applyFilters = () => {
    let q = supabase
      .from('lead_events')
      .select(
        'created_at, lead_name, lead_email, lead_phone, form_name, form_plugin, utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, click_id, attribution_method, ip_country, page_url, raw_fields'
      );
    if (clienteId) q = q.eq('cliente_id', clienteId);
    if (formPlugin) q = q.eq('form_plugin', formPlugin);
    if (utmSource) q = q.ilike('utm_source', `%${utmSource}%`);
    if (utmCampaign) q = q.ilike('utm_campaign', `%${utmCampaign}%`);
    if (utmContent) q = q.ilike('utm_content', `%${utmContent}%`);
    if (from) q = q.gte('created_at', from);
    if (toBound) q = q.lte('created_at', toBound);
    return q;
  };

  // Pagina con `.range()` hasta agotar el dataset: PostgREST devuelve como
  // máximo ≈1000 filas por respuesta, así que un solo request nunca baja todo.
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await applyFilters()
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const batch = (data ?? []) as Record<string, unknown>[];
    rows.push(...batch);
    // Última página: vino incompleta (o vacía).
    if (batch.length < PAGE_SIZE) break;
  }

  // Descubre todas las claves de campos personalizados (raw_fields) presentes,
  // en orden de aparición, para darle a cada una su propia columna en el CSV.
  const customKeys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const rf = row.raw_fields;
    if (rf && typeof rf === 'object' && !Array.isArray(rf)) {
      for (const k of Object.keys(rf as Record<string, unknown>)) {
        if (!seen.has(k)) {
          seen.add(k);
          customKeys.push(k);
        }
      }
    }
  }

  const toCell = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  // Cabecera: columnas fijas + una columna por cada campo personalizado.
  const header = [...COLUMNS.map((c) => c.header), ...customKeys.map((k) => `campo: ${k}`)];
  const lines = [header.map(csvField).join(',')];

  for (const row of rows) {
    const rf = (row.raw_fields ?? {}) as Record<string, unknown>;
    const fixed = COLUMNS.map((c) => {
      const raw = row[c.key];
      return csvField(UTM_KEYS.has(c.key) ? dec(raw) : raw == null ? '' : String(raw));
    });
    const custom = customKeys.map((k) => csvField(toCell(rf[k])));
    lines.push([...fixed, ...custom].join(','));
  }

  // BOM para que Excel reconozca UTF-8 (acentos, emojis en utm_content)
  const csv = '﻿' + lines.join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="leads-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
