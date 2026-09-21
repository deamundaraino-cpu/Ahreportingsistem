import { NextRequest, NextResponse } from 'next/server';
import { reportUtmClient } from '@/lib/report-utm/client';
import { columnaExcluidoDisponible, MOTIVOS_EXCLUSION } from '@/lib/report-utm/lead-exclusion';
import { leerFiltros, aplicarFiltrosLeads } from '@/lib/report-utm/leads-filtros';
import { colombiaDateTimeOf } from '@/lib/colombia-date';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Paginar hasta MAX_ROWS en una sola invocación puede tardar bastante y por
// defecto Vercel corta a los 10 s: sin este tope explícito el export grande
// se cae a medias en vez de terminar.
export const maxDuration = 60;

/**
 * Exporta los leads (filtrados) a CSV.
 *
 *   GET /api/report-utm/leads/export?clienteId=&q=&utm_source=&...
 *
 * Usa el cliente con sesión del usuario, por lo que RLS aplica:
 * solo superadmin/admin/trafficker autenticados pueden exportar.
 *
 * Los filtros NO se escriben aquí: salen de `leads-filtros.ts`, el mismo módulo
 * que usa la página. Cuando estaban duplicados divergieron — este endpoint
 * mandaba los límites de fecha SIN zona horaria, que Postgres lee en UTC, así que
 * el CSV cogía 5 h de más al principio del rango y perdía las 5 últimas. El total
 * de la pantalla y el número de filas del CSV no cuadraban y no había forma de
 * saber cuál de los dos mentía.
 */

// PostgREST limita cada respuesta a `db-max-rows` (≈1000) sin importar el
// `.limit()` que se pida, así que traemos TODO paginando con `.range()`.
const PAGE_SIZE = 1000;
// Tope de seguridad para evitar bucles infinitos ante datasets enormes.
const MAX_ROWS = 500_000;
// Un cliente con formularios muy distintos puede tener cientos de claves en
// `raw_fields`. Sin tope, el CSV salía con una columna por cada una y se volvía
// inabrible; las que se recortan siguen en la app.
const MAX_CAMPOS_PERSONALIZADOS = 60;

const COLUMNS: { key: string; header: string }[] = [
  { key: 'created_at', header: 'Fecha' },
  { key: 'cliente', header: 'Cliente' },
  { key: 'lead_name', header: 'Nombre' },
  { key: 'lead_email', header: 'Email' },
  { key: 'lead_phone', header: 'Teléfono' },
  { key: 'form_name', header: 'Formulario' },
  { key: 'form_plugin', header: 'Origen' },
  { key: 'utm_source', header: 'UTM Source' },
  { key: 'utm_medium', header: 'UTM Medium' },
  { key: 'utm_campaign', header: 'UTM Campaign' },
  { key: 'utm_content', header: 'UTM Content' },
  { key: 'utm_term', header: 'UTM Term' },
  { key: 'utm_id', header: 'UTM ID' },
  { key: 'click_id', header: 'Click ID' },
  { key: 'attribution_method', header: 'Atribución' },
  { key: 'ip_country', header: 'País (IP servidor)' },
  { key: 'page_url', header: 'Página de destino' },
];

/** Columnas que solo existen con la migración 079 aplicada. */
const COLUMNS_EXCLUSION: { key: string; header: string }[] = [
  { key: 'excluido', header: '¿Excluido?' },
  { key: 'excluido_motivo', header: 'Motivo de exclusión' },
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
  const supabase = await reportUtmClient();
  const f = leerFiltros(req.nextUrl.searchParams);

  // Estado de exclusión: por defecto se exporta lo mismo que cuenta el informe.
  // `estado=excluidos` o `estado=todos` para auditar lo que la regla dejó fuera.
  const conExclusion = await columnaExcluidoDisponible(supabase);

  const columnas = conExclusion ? [...COLUMNS, ...COLUMNS_EXCLUSION] : COLUMNS;

  const seleccion =
    'cliente_id, created_at, lead_name, lead_email, lead_phone, form_name, form_plugin, ' +
    'utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id, click_id, ' +
    'attribution_method, ip_country, page_url, raw_fields' +
    (conExclusion ? ', excluido, excluido_motivo' : '');

  // Aplica todos los filtros a una query nueva (se reconstruye por página).
  const consulta = () =>
    aplicarFiltrosLeads(supabase.from('lead_events').select(seleccion), f, {
      conExclusion,
      conEstado: true,
    });

  // El nombre del cliente no está en `lead_events`. Se resuelve con un mapa, no
  // con un embed: `cliente_tabs→clientes` es ambiguo en PostgREST y aquí no hace
  // falta arriesgarse a un 300.
  const nombreCliente = new Map<string, string>();
  const { data: clientes } = await supabase.from('clientes').select('id, nombre');
  for (const c of clientes ?? []) nombreCliente.set(c.id as string, (c.nombre as string) ?? '');

  // Pagina con `.range()` hasta agotar el dataset: PostgREST devuelve como
  // máximo ≈1000 filas por respuesta, así que un solo request nunca baja todo.
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await consulta()
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // `unknown` intermedio: con la lista de columnas armada en tiempo de
    // ejecución, supabase-js no puede inferir la forma de la fila.
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
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
        if (!seen.has(k) && customKeys.length < MAX_CAMPOS_PERSONALIZADOS) {
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

  /** El valor de una columna fija, ya legible. */
  const celda = (row: Record<string, unknown>, key: string): string => {
    // La fecha se imprimía como ISO, es decir el instante UTC: un lead de las
    // 20:00 salía fechado el día siguiente, mientras el resto de la app habla en
    // hora Colombia.
    if (key === 'created_at') return colombiaDateTimeOf(row.created_at as string);
    if (key === 'cliente') return nombreCliente.get(row.cliente_id as string) ?? '';
    if (key === 'excluido') return row.excluido === true ? 'sí' : 'no';
    if (key === 'excluido_motivo') {
      const m = row.excluido_motivo as keyof typeof MOTIVOS_EXCLUSION | null;
      return m ? (MOTIVOS_EXCLUSION[m] ?? m) : '';
    }
    const raw = row[key];
    if (UTM_KEYS.has(key)) return dec(raw);
    return raw == null ? '' : String(raw);
  };

  // Cabecera: columnas fijas + una columna por cada campo personalizado.
  const header = [...columnas.map((c) => c.header), ...customKeys.map((k) => `campo: ${k}`)];
  const lines = [header.map(csvField).join(',')];

  for (const row of rows) {
    const rf = (row.raw_fields ?? {}) as Record<string, unknown>;
    const fixed = columnas.map((c) => csvField(celda(row, c.key)));
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
