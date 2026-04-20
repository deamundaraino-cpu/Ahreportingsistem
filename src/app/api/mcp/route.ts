/**
 * MCP (Model Context Protocol) Server — HTTP transport
 * Spec: https://spec.modelcontextprotocol.io/
 *
 * Supports tools that AI assistants (Claude, Cursor, etc.) can call
 * to read AdsHouse reporting data.
 *
 * Authentication: Bearer <ads_token> in Authorization header.
 *
 * Endpoints:
 *   GET  /api/mcp  — server info (no auth required)
 *   POST /api/mcp  — JSON-RPC 2.0 requests
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateApiToken, requirePermission, type TokenContext } from '@/lib/api-token-auth';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';

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
    name: 'get_metrics',
    description: 'Get daily advertising and sales metrics for a specific client and date range.',
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
      },
      required: ['client_id'],
    },
  },
  {
    name: 'get_campaign_groups',
    description: 'Get campaign groups and their mappings for a client.',
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description: 'UUID of the client (optional — omit to get all clients)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_summary',
    description: 'Get aggregated performance summary (totals) for a client and date range.',
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
      },
      required: ['client_id'],
    },
  },
];

// ─── Tool handlers ───────────────────────────────────────────────────────────

async function handleListClients(ctx: TokenContext) {
  requirePermission(ctx, 'read:clients');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  const { data, error } = await supabase
    .from('clientes')
    .select('id, nombre, created_at')
    .eq('user_id', ctx.userId)
    .order('nombre');
  if (error) throw new Error(error.message);
  return data;
}

async function handleGetMetrics(ctx: TokenContext, args: Record<string, string>) {
  requirePermission(ctx, 'read:metrics');
  const { client_id, from, to } = args;

  if (!client_id) throw new Error('client_id is required');

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(today.getDate() - 30);

  const fromDate = from ?? defaultFrom.toISOString().split('T')[0];
  const toDate = to ?? today.toISOString().split('T')[0];

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: client } = await supabase
    .from('clientes')
    .select('id, nombre')
    .eq('id', client_id)
    .eq('user_id', ctx.userId)
    .single();

  if (!client) throw new Error('Client not found or access denied');

  const { data, error } = await supabase
    .from('metricas_diarias')
    .select('fecha, meta_spend, meta_impressions, meta_clicks, ga_sessions, hotmart_pagos_iniciados, ventas_principal, ventas_bump, ventas_upsell')
    .eq('cliente_id', client_id)
    .gte('fecha', fromDate)
    .lte('fecha', toDate)
    .order('fecha');

  if (error) throw new Error(error.message);

  return { client: { id: client.id, name: client.nombre }, period: { from: fromDate, to: toDate }, metrics: data };
}

async function handleGetCampaignGroups(ctx: TokenContext, args: Record<string, string>) {
  requirePermission(ctx, 'read:campaigns');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  let query = supabase
    .from('campaign_groups')
    .select(`id, nombre, descripcion, color, clientes!inner(id, nombre, user_id), campaign_group_mappings(campaign_id, campaign_name_pattern)`)
    .eq('clientes.user_id', ctx.userId)
    .order('nombre');

  if (args.client_id) {
    query = query.eq('cliente_id', args.client_id);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data ?? []).map((g: any) => ({
    id: g.id,
    name: g.nombre,
    description: g.descripcion,
    color: g.color,
    client: { id: g.clientes.id, name: g.clientes.nombre },
    mappings: g.campaign_group_mappings,
  }));
}

async function handleGetSummary(ctx: TokenContext, args: Record<string, string>) {
  requirePermission(ctx, 'read:metrics');
  const { client_id, from, to } = args;
  if (!client_id) throw new Error('client_id is required');

  const today = new Date();
  const defaultFrom = new Date(today);
  defaultFrom.setDate(today.getDate() - 30);

  const fromDate = from ?? defaultFrom.toISOString().split('T')[0];
  const toDate = to ?? today.toISOString().split('T')[0];

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: client } = await supabase
    .from('clientes')
    .select('id, nombre')
    .eq('id', client_id)
    .eq('user_id', ctx.userId)
    .single();

  if (!client) throw new Error('Client not found or access denied');

  const { data, error } = await supabase
    .from('metricas_diarias')
    .select('meta_spend, meta_clicks, meta_impressions, ga_sessions, ventas_principal, ventas_bump, ventas_upsell')
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
      total_revenue: acc.total_revenue + Number(row.ventas_principal ?? 0) + Number(row.ventas_bump ?? 0) + Number(row.ventas_upsell ?? 0),
    }),
    { total_spend: 0, total_clicks: 0, total_impressions: 0, total_sessions: 0, total_revenue: 0 }
  );

  const roas = totals.total_spend > 0 ? totals.total_revenue / totals.total_spend : 0;
  const ctr = totals.total_impressions > 0 ? (totals.total_clicks / totals.total_impressions) * 100 : 0;
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

// GET — server info / capabilities (no auth required for discovery)
export async function GET() {
  return NextResponse.json({
    name: 'adshouse-reporting',
    version: '1.0.0',
    description: 'AdsHouse Reporting Dashboard MCP Server',
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
  });
}

// POST — JSON-RPC 2.0 dispatcher
export async function POST(request: NextRequest) {
  let id: unknown = null;

  try {
    const ctx = await authenticateApiToken(request);
    const body = await request.json();
    id = body.id ?? null;

    if (body.jsonrpc !== '2.0') {
      return rpcError(id, -32600, 'Invalid JSON-RPC version. Expected "2.0"');
    }

    const { method, params } = body;

    // ── initialize ────────────────────────────────────────────────
    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'adshouse-reporting', version: '1.0.0' },
      });
    }

    // ── tools/list ────────────────────────────────────────────────
    if (method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS });
    }

    // ── tools/call ────────────────────────────────────────────────
    if (method === 'tools/call') {
      const toolName: string = params?.name;
      const toolArgs: Record<string, string> = params?.arguments ?? {};

      let result: unknown;

      switch (toolName) {
        case 'list_clients':
          result = await handleListClients(ctx);
          break;
        case 'get_metrics':
          result = await handleGetMetrics(ctx, toolArgs);
          break;
        case 'get_campaign_groups':
          result = await handleGetCampaignGroups(ctx, toolArgs);
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
