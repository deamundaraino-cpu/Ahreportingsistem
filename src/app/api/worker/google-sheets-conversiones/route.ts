import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  syncClienteConversiones,
  normalizeSheetConfigs,
} from '@/lib/integrations/google-sheets-conversiones';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Sin este export la ruta se quedaba con la duración por defecto de la
 * plataforma: era la ÚNICA de `/api/worker/*` que no la declaraba, y por eso su
 * ejecución podía sobrevivir al `AbortSignal` del runner y seguir escribiendo
 * en la base después de que el job ya se hubiera dado por fallido.
 */
export const maxDuration = 60;

/**
 * Worker de conversiones offline — sincroniza Google Sheets → DB.
 *
 * GET /api/worker/google-sheets-conversiones
 * Authorization: Bearer {CRON_SECRET}
 *   ?client_id=UUID  procesa solo ese cliente (es lo que encola el planner)
 *   ?sheet_id=ID     además, solo ese sheet del cliente
 *
 * El rango de fechas del job NO se usa: un Sheet se lee entero siempre — su
 * verdad es el documento, no una ventana temporal. El rango viaja en el job
 * únicamente para que el panel muestre a qué corrida pertenece.
 *
 * ── Sobre el código de estado ────────────────────────────────────
 * Devolver 200 pase lo que pase era el fallo más caro de todo el módulo: el
 * runner solo mira `res.ok`, así que un sync en el que TODOS los clientes
 * fallaban se marcaba `done`, entraba en `sync_runs` como 'ok' y no generaba
 * aviso. Entre el 11 y el 12 de agosto de 2026 la cola estuvo verde mientras las
 * tres hojas escribían cero filas (las RPC de la migración 069 no existían en la
 * base). Ahora el estado HTTP dice la verdad: 500 si no se salvó ningún cliente,
 * 200 con `parcial: true` si unos sí y otros no.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const clientIdFilter = request.nextUrl.searchParams.get('client_id');
  const sheetIdFilter = request.nextUrl.searchParams.get('sheet_id') ?? undefined;

  let query = supabase.from('clientes').select('id, nombre, config_api');
  if (clientIdFilter) query = query.eq('id', clientIdFilter);

  const { data: clientes, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  const results: Record<string, any> = {};
  const errores: string[] = [];
  let conSheets = 0;
  let fallidos = 0;

  for (const cliente of clientes || []) {
    const rawConfig = cliente.config_api?.google_sheets_conversiones;
    const enabledSheets = normalizeSheetConfigs(rawConfig).filter((s) => s.enabled && s.sheet_url);
    if (enabledSheets.length === 0) continue;
    conSheets++;

    // La clave es el id, no el nombre: dos clientes homónimos se pisaban la
    // entrada y el recuento de fallos salía corto.
    const key = `${cliente.nombre} (${cliente.id.slice(0, 8)})`;

    try {
      // Cada sheet se guarda por separado: uno que falle no borra los datos de
      // los demás ni aborta el resto del cliente.
      const { results: sheetResults, campos } = await syncClienteConversiones(
        supabase,
        cliente.id,
        rawConfig,
        { sheetId: sheetIdFilter }
      );

      const failed = sheetResults.filter((r) => !r.success);
      // Un cliente cuyos sheets fallaron TODOS no es un éxito, por mucho que la
      // función no haya lanzado: los fallos vienen dentro del resultado.
      const clienteOk = sheetResults.length > 0 && failed.length < sheetResults.length;
      if (!clienteOk) {
        fallidos++;
        errores.push(...failed.map((r) => `${cliente.nombre} › ${r.name}: ${r.error}`));
      }

      results[key] = {
        success: failed.length === 0,
        sheets: sheetResults.length,
        rowsProcessed: sheetResults.reduce((s, r) => s + r.rowsProcessed, 0),
        daysProcessed: sheetResults.reduce((s, r) => s + r.daysProcessed, 0),
        rowsDescartadas: sheetResults.reduce((s, r) => s + r.rowsDescartadas, 0),
        rawProcessed: sheetResults.reduce((s, r) => s + r.rawProcessed, 0),
        camposRecalculados: campos?.campos ?? 0,
        ...(campos?.error ? { camposError: campos.error } : {}),
        ...(failed.length > 0 ? { errors: failed.map((r) => `${r.name}: ${r.error}`) } : {}),
      };
    } catch (err: any) {
      fallidos++;
      errores.push(`${cliente.nombre}: ${err.message}`);
      results[key] = { success: false, error: err.message };
    }
  }

  const todosFallaron = conSheets > 0 && fallidos === conSheets;

  return NextResponse.json(
    {
      ok: !todosFallaron,
      processed: conSheets,
      fallidos,
      parcial: fallidos > 0 && !todosFallaron,
      results,
      ...(errores.length > 0 ? { errores: errores.slice(0, 20) } : {}),
      timestamp: new Date().toISOString(),
    },
    { status: todosFallaron ? 500 : 200 }
  );
}
