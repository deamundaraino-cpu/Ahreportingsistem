/**
 * MCP (Model Context Protocol) Server — HTTP transport
 *
 * Spec: https://spec.modelcontextprotocol.io/
 *
 * Supports tools that AI assistants (Claude, Cursor, etc.) can call
 * to read AdsHouse reporting data.
 *
 * Authentication: Bearer <ads_token> in Authorization header
 * OR ?token=<ads_token> query parameter.
 *
 * Endpoints:
 * GET /api/mcp — server info (no auth required)
 * POST /api/mcp — JSON-RPC 2.0 requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateApiToken, requirePermission, type TokenContext } from '@/lib/api-token-auth';
import { ApiError, handleUnexpectedError } from '@/lib/error-handler';

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message, data } });
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_clients',
    description: 'List all advertising clients in the AdsHouse account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_tabs',
    description: 'Get the campaign tabs (estrategias) configured for a client.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'UUID of the client (obtain from list_clients)',
        },
      },
      required: ['client_id'],
    },
  },
  {
    name: 'get_metrics',
    description:
      'Get daily advertising metrics for a specific client and date range. ' +
      'Use the keyword parameter to filter by campaign tab (e.g. "asesoria", "ebook").',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'UUID of the client (obtain from list_clients)',
        },
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format (defaults to 30 days ago)',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format (defaults to today)',
        },
        keyword: {
          type: 'string',
          description:
            'Optional. Filter metrics to campaigns whose name contains this keyword (case-insensitive). ' +
            'Get the keyword from get_tabs → keyword_meta field. E.g. "asesoria", "ebook".',
        },
      },
      required: ['client_id'],
    },
  },
  {
    name: 'get_summary',
    description:
      'Get aggregated performance totals for a client and date range. ' +
      'Use the keyword parameter to filter by campaign tab (e.g. "asesoria", "ebook"). ' +
      'When filtering by keyword, also returns custom_conversions totals (leads, agendas, etc.) and CPL per conversion.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'UUID of the client',
        },
        from: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        to: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        keyword: {
          type: 'string',
          description:
            'Optional. Filter to campaigns whose name contains this keyword (case-insensitive). ' +
            'Get the keyword from get_tabs → keyword_meta field. E.g. "asesoria", "ebook".',
        },
      },
      required: ['client_id'],
    },
  },
];

// ─── Supabase client factory ─────────────────────────────────────────────────

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function defaultDates(from?: string, to?: string) {
  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(today.getDate() - 30);
  return {
    fromDate: from ?? defaultFrom.toISOString().split('T')[0],
    toDate: to ?? today.toISOString().split('T')[0],
  };
}

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleListClients(ctx: TokenContext) {
  requirePermission(ctx, 'read:clients');

  const { data, error } = await getSupabase()
    .from('clientes')
    .select('id, nombre, created_at')
    .eq('user_id', ctx.userId)
    .order('nombre');

  if (error) throw new Error(error.message);
  return data;
}

async function handleGetTabs(ctx: TokenContext, args: Record<string, string>) {
  requirePermission(ctx, 'read:clients');

  const { client_id } = args;
  if (!client_id) throw new Error('client_id is required');

  const supabase = getSupabase();

  const { data: client } = await supabase
    .from('clientes')
    .select('id, nombre')
    .eq('id', client_id)
    .eq('user_id', ctx.userId)
    .single();

  if (!client) throw new Error('Client not found or access denied');

  const { data, error } = await supabase
    .from('cliente_tabs')
    .select('id, nombre, keyword_meta, orden, fecha_inicio, fecha_finalizacion, presupuesto_objetivo')
    .eq('cliente_id', client_id)
    .order('orden');

  if (error) throw new Error(error.message);

  return {
    client: { id: client.id, name: client.nombre },
    tabs: (data ?? []).map(t => ({
      id: t.id,
      name: t.nombre,
      keyword_meta: t.keyword_meta,
      orden: t.orden,
      fecha_inicio: t.fecha_inicio,
      fecha_finalizacion: t.fecha_finalizacion,
      presupuesto_objetivo: t.presupuesto_objetivo,
    })),
  };
}

async function handleGetMetrics(ctx: TokenContext, args: Record<string, string>) {
  requirePermission(ctx, 'read:metrics');

  const { client_id, from, to, keyword } = args;
  if (!client_id) throw new Error('client_id is required');

  const { fromDate, toDate } = defaultDates(from, to);
  const supabase = getSupabase();

  const { data: client } = await supabase
    .from('clientes')
    .select('id, nombre')
    .eq('id', client_id)
    .eq('user_id', ctx.userId)
    .single();

  if (!client) throw new Error('Client not found or access denied');

  // ── With keyword: filter meta_campaigns by name ───────────────
  if (keyword) {
    const { data, error } = await supabase
      .from('metricas_diarias')
      .select('fecha, meta_campaigns')
      .eq('cliente_id', client_id)
      .gte('fecha', fromDate)
      .lte('fecha', toDate)
      .order('fecha');

    if (error) throw new Error(error.message);

    const kw = keyword.toLowerCase();

    const metrics = (data ?? []).map(row => {
      const campaigns = ((row.meta_campaigns as any[]) ?? []).filter(c =>
        (c.name ?? '').toLowerCase().includes(kw)
      );

      const spend = campaigns.reduce((s, c) => s + (Number(c.spend) || 0), 0);
      const impressions = campaigns.reduce((s, c) => s + (Number(c.impressions) || 0), 0);
      const link_clicks = campaigns.reduce((s, c) => s + (Number(c.link_clicks) || 0), 0);
      const clicks = campaigns.reduce((s, c) => s + (Number(c.clicks) || 0), 0);

      // Aggregate custom_conversions across filtered campaigns
      const custom_conversions: Record<string, number> = {};
      for (const c of campaigns) {
        for (const [k, v] of Object.entries(c.custom_conversions ?? {})) {
          custom_conversions[k] = (custom_conversions[k] || 0) + Number(v);
        }
      }

      const ctr = impressions > 0 ? Math.round((link_clicks / impressions) * 10000) / 100 : 0;
      const cpc = link_clicks > 0 ? Math.round(spend / link_clicks) : 0;

      return {
        fecha: row.fecha,
        meta_spend: spend,
        meta_impressions: impressions,
        meta_link_clicks: link_clicks,
        meta_clicks: clicks,
        ctr,
        cpc,
        custom_conversions,
        campaigns_matched: campaigns.length,
      };
    });

    return {
      client: { id: client.id, name: client.nombre },
      period: { from: fromDate, to: toDate },
      keyword,
      metrics,
    };
  }

  // ── Without keyword: use pre-aggregated columns (original behavior) ────────
  const { data, error } = await supabase
    .from('metricas_diarias')
    .select(
      'fecha, meta_spend, meta_impressions, meta_clicks, ga_sessions, hotmart_pagos_iniciados, ventas_principal, ventas_bump, ventas_upsell'
    )
    .eq('cliente_id', client_id)
    .gte('fecha', fromDate)
    .lte('fecha', toDate)
    .order('fecha');

  if (error) throw new Error(error.message);

  return {
    client: { id: client.id, name: client.nombre },
    period: { from: fromDate, to: toDate },
    metrics: data,
  };
}

async function handleGetSummary(ctx: TokenContext, args: Record<string, string>) {
  requirePermission(ctx, 'read:metrics');

  const { client_id, from, to, keyword } = args;
  if (!client_id) throw new Error('client_id is required');

  const { fromDate, toDate } = defaultDates(from, to);
  const supabase = getSupabase();

  const { data: client } = await supabase
    .from('clientes')
    .select('id, nombre')
    .eq('id', client_id)
    .eq('user_id', ctx.userId)
    .single();

  if (!client) throw new Error('Client not found or access denied');

  // ── With keyword: filter meta_campaigns by name ───────────────
  if (keyword) {
    const { data, error } = await supabase
      .from('metricas_diarias')
      .select('fecha, meta_campaigns')
      .eq('cliente_id', client_id)
      .gte('fecha', fromDate)
      .lte('fecha', toDate);

    if (error) throw new Error(error.message);

    const kw = keyword.toLowerCase();

    let total_spend = 0;
    let total_impressions = 0;
    let total_link_clicks = 0;
    let total_clicks = 0;
    const custom_conversions_total: Record<string, number> = {};

    for (const row of data ?? []) {
      const campaigns = ((row.meta_campaigns as any[]) ?? []).filter(c =>
        (c.name ?? '').toLowerCase().includes(kw)
      );

      for (const c of campaigns) {
        total_spend += Number(c.spend) || 0;
        total_impressions += Number(c.impressions) || 0;
        total_link_clicks += Number(c.link_clicks) || 0;
        total_clicks += Number(c.clicks) || 0;

        for (const [k, v] of Object.entries(c.custom_conversions ?? {})) {
          custom_conversions_total[k] = (custom_conversions_total[k] || 0) + Number(v);
        }
      }
    }

    const ctr =
      total_impressions > 0
        ? Math.round((total_link_clicks / total_impressions) * 10000) / 100
        : 0;
    const cpc = total_link_clicks > 0 ? Math.round(total_spend / total_link_clicks) : 0;

    // CPL per conversion type
    const cpl: Record<string, number> = {};
    for (const [k, v] of Object.entries(custom_conversions_total)) {
      cpl[`cpl_${k}`] = v > 0 ? Math.round(total_spend / v) : 0;
    }

    return {
      client: { id: client.id, name: client.nombre },
      period: { from: fromDate, to: toDate, days: data?.length ?? 0 },
      keyword,
      totals: {
        total_spend,
        total_impressions,
        total_link_clicks,
        total_clicks,
        ctr,
        cpc,
        custom_conversions: custom_conversions_total,
        ...cpl,
      },
    };
  }

  // ── Without keyword: use pre-aggregated columns (original behavior) ────────
  const { data, error } = await supabase
    .from('metricas_diarias')
    .select(
      'meta_spend, meta_clicks, meta_impressions, ga_sessions, ventas_principal, ventas_bump, ventas_upsell'
    )
    .eq('cliente_id', client_id)
    .gte('fecha', fromDate)
    .lte('fecha', toDate);

  if (error) throw new Error(error.message);

  const totals = (data ?? []).reduce(
    (acc, row) => ({
      total_spend: acc.total_spend + Number(row.meta_spend ?? 0),
      total_clicks: acc.total_clicks + Number(row.meta_clicks ?? 0),
      total_impressions: acc.total_impressions + Number(row.meta_impressions ?? 0),
      total_sessions: acc.total_sessions + Number(row.ga_sessions ?? 0),
      total_revenue:
        acc.total_revenue +
        Number(row.ventas_principal ?? 0) +
        Number(row.ventas_bump ?? 0) +
        Number(row.ventas_upsell ?? 0),
    }),
    { total_spend: 0, total_clicks: 0, total_impressions: 0, total_sessions: 0, total_revenue: 0 }
  );

  const roas = totals.total_spend > 0 ? totals.total_revenue / totals.total_spend : 0;
  const ctr =
    totals.total_impressions > 0
      ? (totals.total_clicks / totals.total_impressions) * 100
      : 0;
  const cpc = totals.total_clicks > 0 ? totals.total_spend / totals.total_clicks : 0;

  return {
    client: { id: client.id, name: client.nombre },
    period: { from: fromDate, to: toDate, days: data?.length ?? 0 },
    totals: {
      ...totals,
      roas: Math.round(roas * 100) / 100,
      ctr: Math.round(ctr * 100) / 100,
      cpc: Math.round(cpc * 100) / 100,
    },
  };
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function GET() {
  return NextResponse.json({
    name: 'adshouse-reporting',
    version: '1.1.0',
    description: 'AdsHouse Reporting Dashboard MCP Server',
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
  });
}

export async function POST(request: NextRequest) {
  let id: unknown = null;

  try {
    const body = await request.json();
    id = body.id ?? null;

    if (body.jsonrpc !== '2.0') {
      return rpcError(id, -32600, 'Invalid JSON-RPC version. Expected "2.0"');
    }

    const { method, params } = body;

    // ── unauthenticated methods ───────────────────────────────────

    if (method === 'ping') return rpcResult(id, {});

    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'adshouse-reporting', version: '1.1.0' },
      });
    }

    if (method === 'notifications/initialized') return rpcResult(id, {});

    // ── authenticated methods ─────────────────────────────────────

    const ctx = await authenticateApiToken(request);

    if (method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS });
    }

    if (method === 'tools/call') {
      const toolName: string = params?.name;
      const toolArgs: Record<string, string> = params?.arguments ?? {};

      let result: unknown;

      switch (toolName) {
        case 'list_clients':
          result = await handleListClients(ctx);
          break;
        case 'get_tabs':
          result = await handleGetTabs(ctx, toolArgs);
          break;
        case 'get_metrics':
          result = await handleGetMetrics(ctx, toolArgs);
          break;
        case 'get_summary':
          result = await handleGetSummary(ctx, toolArgs);
          break;
        default:
          return rpcError(id, -32601, `Unknown tool: ${toolName}`);
      }

      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    }

    return rpcError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (error instanceof ApiError) {
      return rpcError(id, -32001, error.message);
    }
    const msg = error instanceof Error ? error.message : 'Internal server error';
    return rpcError(id, -32603, msg);
  }
}
