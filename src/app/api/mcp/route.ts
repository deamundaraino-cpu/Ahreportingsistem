/**
 * Servidor MCP (Model Context Protocol) — transporte HTTP
 *
 * Spec: https://spec.modelcontextprotocol.io/
 *
 * Expone el registro de herramientas de `src/lib/agent` para que un asistente
 * externo (Claude, Cursor…) pueda consultar los datos del proyecto.
 *
 * Autenticación: `Authorization: Bearer <ads_token>`. Solo cabecera — el
 * fallback `?token=` se retiró porque dejaba la credencial en los logs y en el
 * `Referer`.
 *
 * Endpoints:
 *   GET  /api/mcp — información del servidor (sin auth)
 *   POST /api/mcp — peticiones JSON-RPC 2.0
 *
 * ── Qué cambió al pasar al registro ────────────────────────────────────────
 *
 * Antes, cada herramienta se declaraba en un array de JSON Schema escrito a mano
 * y se despachaba en un `switch`, y sus handlers calculaban las métricas por su
 * cuenta. Eso producía cifras que no coincidían con el dashboard. Ahora todas
 * las herramientas salen de `ALL_TOOLS` y las métricas de `getMetricasCliente`.
 *
 * Las cifras de algunas respuestas CAMBIAN respecto a la versión anterior, a
 * propósito, porque las de antes estaban mal:
 *
 *   · El gasto se suma del array `meta_campaigns[]`, como en el dashboard, en
 *     vez de leerse de la columna `meta_spend`.
 *   · El filtro de pestaña se resuelve con `parseTabFilter`, así que entiende
 *     los filtros compuestos `__cf:`. Antes, una pestaña con filtro compuesto
 *     devolvía gasto 0 sin ningún aviso.
 *   · Las fechas por defecto se calculan en la zona de Colombia, no en UTC.
 *   · `ventas_cerradas` se lee de `metricas_manuales`; la columna homónima está
 *     obsoleta desde la migración 045 y siempre vale 0.
 *   · CTR y CPC tienen una única definición, independientemente de si se filtra
 *     por estrategia o no.
 *
 * La comprobación está en `scripts/verify-mcp-paridad.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateApiToken } from '@/lib/api-token-auth';
import { ApiError } from '@/lib/error-handler';
import { contextoDesdeToken } from '@/lib/agent/context';
import { ejecutarTool } from '@/lib/agent/execute';
import { toolsFor } from '@/lib/agent/registry';
import type { AnyAgentTool } from '@/lib/agent/types';

const NOMBRE_SERVIDOR = 'adshouse-reporting';
const VERSION = '2.0.0';
const PROTOCOLO = '2024-11-05';

// ─── Helpers JSON-RPC ────────────────────────────────────────────────────────

function rpcResult(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, error: { code, message, data } });
}

/**
 * Traduce una herramienta del registro al formato que espera MCP.
 *
 * El schema se deriva del mismo zod que valida la entrada, así que descripción
 * y validación no pueden desincronizarse.
 */
function aFormatoMcp(tool: AnyAgentTool) {
  const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
  // `$schema` es ruido en este contexto y algunos clientes lo rechazan.
  delete schema.$schema;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: schema,
  };
}

// ─── Route handlers ──────────────────────────────────────────────────────────

export async function GET() {
  return NextResponse.json({
    name: NOMBRE_SERVIDOR,
    version: VERSION,
    description: 'AdsHouse Reporting Dashboard MCP Server',
    protocolVersion: PROTOCOLO,
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

    // ── Métodos sin autenticación ─────────────────────────────────

    if (method === 'ping') return rpcResult(id, {});

    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOLO,
        capabilities: { tools: {} },
        serverInfo: { name: NOMBRE_SERVIDOR, version: VERSION },
      });
    }

    if (method === 'notifications/initialized') return rpcResult(id, {});

    // ── Métodos autenticados ──────────────────────────────────────

    const token = await authenticateApiToken(request);
    const ctx = await contextoDesdeToken(token, { origin: 'mcp' });

    if (method === 'tools/list') {
      // Solo las que este token puede usar: ofrecer una herramienta que va a
      // rechazarse solo sirve para que el asistente prometa lo que no puede.
      return rpcResult(id, { tools: toolsFor(ctx).map(aFormatoMcp) });
    }

    if (method === 'tools/call') {
      const nombre: string = params?.name;
      const args: unknown = params?.arguments ?? {};

      if (!nombre) return rpcError(id, -32602, 'Falta el nombre de la herramienta.');

      const res = await ejecutarTool(nombre, args, ctx);

      if (!res.ok) {
        const code = res.error?.code === 'UNAUTHORIZED' ? -32001 : -32603;
        return rpcError(id, code, res.error?.message ?? 'Error ejecutando la herramienta.');
      }

      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }],
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
