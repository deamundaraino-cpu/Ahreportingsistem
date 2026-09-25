import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateApiToken, requirePermission } from '@/lib/api-token-auth';
import { ApiError, apiErrorResponse, handleUnexpectedError } from '@/lib/error-handler';
import { getMetricasCliente, type FilaMetricas } from '@/lib/metrics/client-metrics';
import { addDaysISO, colombiaToday } from '@/lib/colombia-date';
import { SUFIJO_USD } from '@/lib/moneda-reporte';

/**
 * GET /api/v1/metrics
 *
 * Query params:
 *   - client_id   (required) UUID of the client
 *   - from        (optional) YYYY-MM-DD, defaults to 30 days ago (Colombia time)
 *   - to          (optional) YYYY-MM-DD, defaults to today (Colombia time)
 *   - limit       (optional) max days, defaults to 90, max 365
 *
 * Headers:
 *   Authorization: Bearer <ads_token>
 *
 * Las cifras salen de `getMetricasCliente`, el mismo camino que el dashboard, el
 * MCP y el agente. Esta ruta leía las columnas crudas de `metricas_diarias` y
 * era una forma más de calcular lo mismo que no cuadraba con las demás.
 *
 * La forma de la respuesta se conserva: mismas claves, una fila por día en orden
 * ascendente. Lo que cambia de SIGNIFICADO:
 *
 *   · `meta_spend`, `meta_impressions`, `meta_clicks`: suma del array
 *     `meta_campaigns[]`, como el dashboard, no la columna. Si la paginación de
 *     Meta se truncó y no cuadran, el día se avisa en `warnings`.
 *   · `ventas_principal`, `ventas_bump`, `ventas_upsell`: en la moneda de reporte
 *     del cliente (`moneda`), convertidas con la tasa de cada día. Antes iban en
 *     USD; el USD sigue en las nuevas `ventas_*_usd`. Un día sin ninguna tasa
 *     conocida se queda en USD y se avisa en `warnings`.
 *   · `ventas_cerradas`: el valor cargado a mano (`metricas_manuales`). La
 *     columna homónima está obsoleta desde la migración 045 y valía siempre 0.
 *   · `period`: el rango APLICADO (sin días futuros y como mucho `limit` días),
 *     no el eco de los parámetros.
 *
 * Nuevo: `moneda` (código ISO) y `warnings`. Fechas o `limit` mal formados dan
 * 400 en vez del 500 que devolvía la base de datos.
 */

/** Tope de días por petición, el mismo que tenía el `limit` de filas. */
const LIMITE_MAX = 365;
const LIMITE_DEFECTO = 90;

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columnas diarias que siempre ha devuelto esta ruta (salvo `ventas_cerradas`). */
const CLAVES_DIA = [
  'meta_spend',
  'meta_impressions',
  'meta_clicks',
  'ga_sessions',
  'hotmart_pagos_iniciados',
  'ventas_principal',
  'ventas_bump',
  'ventas_upsell',
] as const;

/** Las de dinero de Hotmart: van convertidas y llevan al lado su gemela en USD. */
const VENTAS = ['ventas_principal', 'ventas_bump', 'ventas_upsell'] as const;

/** `2026-02-31` pasa la expresión regular pero no es una fecha. */
function fechaValida(s: string): boolean {
  if (!RE_FECHA.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function leerLimite(raw: string | null): number {
  if (raw === null || raw === '') return LIMITE_DEFECTO;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) {
    throw new ApiError('VALIDATION_ERROR', 'limit must be a positive integer', 400, { limit: raw });
  }
  return Math.min(n, LIMITE_MAX);
}

/**
 * `ventas_cerradas` vive en `metricas_manuales`: la columna homónima quedó
 * obsoleta en la migración 045 y devuelve 0 siempre.
 */
function ventasCerradas(row: FilaMetricas): number {
  const manuales = row.metricas_manuales;
  if (!manuales || typeof manuales !== 'object') return 0;
  return Number((manuales as Record<string, unknown>).VENTAS_CERRADAS ?? 0) || 0;
}

function filaPublica(row: FilaMetricas): Record<string, unknown> {
  const out: Record<string, unknown> = { fecha: row.fecha };
  for (const k of CLAVES_DIA) out[k] = row[k] ?? null;
  out.ventas_cerradas = ventasCerradas(row);
  for (const k of VENTAS) out[`${k}${SUFIJO_USD}`] = row[`${k}${SUFIJO_USD}`] ?? null;
  return out;
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await authenticateApiToken(request);
    requirePermission(ctx, 'read:metrics');

    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get('client_id');

    if (!clientId) {
      throw new ApiError('VALIDATION_ERROR', 'client_id query parameter is required', 400);
    }
    if (!RE_UUID.test(clientId)) {
      throw new ApiError('VALIDATION_ERROR', 'client_id must be a UUID', 400);
    }

    // Hoy en hora Colombia, como el resto del sistema: con UTC, a partir de las
    // 19:00 el «hoy» por defecto ya era mañana.
    const hoy = colombiaToday();
    const from = searchParams.get('from') ?? addDaysISO(hoy, -30);
    const to = searchParams.get('to') ?? hoy;
    if (!fechaValida(from) || !fechaValida(to)) {
      throw new ApiError('VALIDATION_ERROR', 'from and to must be valid YYYY-MM-DD dates', 400, {
        from,
        to,
      });
    }
    const limit = leerLimite(searchParams.get('limit'));

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    // Verify the client belongs to this token's user
    const { data: client, error: errClient } = await supabase
      .from('clientes')
      .select('id, nombre')
      .eq('id', clientId)
      .eq('user_id', ctx.userId)
      .maybeSingle();

    if (errClient) throw new ApiError('DATABASE_ERROR', errClient.message, 500);
    if (!client) {
      throw new ApiError('NOT_FOUND', 'Client not found or access denied', 404);
    }

    // `limit` era un tope de FILAS en orden ascendente: los primeros `limit`
    // días desde `from`. Se conserva recortando el final del rango, y así no se
    // cargan días que luego no se devolverían.
    const warnings: string[] = [];
    let hasta = to;
    if (from <= to) {
      const tope = addDaysISO(from, limit - 1);
      if (tope < to && tope < hoy) {
        hasta = tope;
        warnings.push(
          `Como mucho ${limit} días por petición (limit): el periodo se acortó a ${from} → ${tope}.`
        );
      }
    }

    const res = await getMetricasCliente({
      clienteId: clientId,
      from,
      to: hasta,
      maxDias: limit,
    });

    return NextResponse.json({
      client: { id: client.id, name: client.nombre },
      period: { from: res.rango.from, to: res.rango.to },
      moneda: res.moneda,
      metrics: res.rows.slice(0, limit).map(filaPublica),
      warnings: [...warnings, ...res.warnings],
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    return handleUnexpectedError(error, 'GET /api/v1/metrics');
  }
}
