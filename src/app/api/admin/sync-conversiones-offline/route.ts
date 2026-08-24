import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  syncClienteConversiones,
  syncTabConversiones,
  consolidarLoteSheet,
  cleanupOrphanConversiones,
  mergeAgregadosParciales,
  finalizarAgregados,
  normalizeSheetConfigs,
  logSyncResult,
} from '@/lib/integrations/google-sheets-conversiones';
import type {
  ConversionDiariaParcial,
  TabSyncQuality,
} from '@/lib/integrations/google-sheets-conversiones';
import { requireAdminRole } from '@/lib/report-utm/auth';
import { esUuid } from '@/lib/validation';

// Releer un documento entero y recalcular los campos no cabe en el timeout por
// defecto: sin esto la petición moría a mitad y el cliente no se enteraba.
export const maxDuration = 60;

/**
 * Sync manual de conversiones offline desde Google Sheets.
 * POST /api/admin/sync-conversiones-offline
 *
 * Tres modos, de más troceado a menos:
 *
 *   { clientId, sheetId, tabId, batchId }        → una pestaña del lote
 *   { clientId, sheetId, batchId, consolidar, aggregates }
 *                                                → cierra el lote de ese sheet
 *   { clientId, sheetId?, recalcularCampos? }    → documento(s) enteros de una vez
 *
 * El modo por pestaña existe porque un documento grande no cabe en los 60 s de la
 * función: la UI recorre las pestañas con un mismo `batchId` y consolida al
 * final. Hasta la consolidación no se toca el dato anterior, así que una corrida
 * interrumpida nunca deja al cliente sin datos — solo un lote suelto, que el
 * siguiente sync retira.
 *
 * El modo entero se conserva para el worker diario y los clientes pequeños.
 */
export async function POST(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole();
  if (denied) return denied;

  try {
    const { clientId, sheetId, tabId, batchId, consolidar, aggregates, quality, recalcularCampos } =
      await request.json();
    if (!clientId) {
      return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: cliente, error: clientError } = await supabase
      .from('clientes')
      .select('id, nombre, config_api')
      .eq('id', clientId)
      .single();

    if (clientError || !cliente) {
      return NextResponse.json({ error: 'Cliente no encontrado' }, { status: 404 });
    }

    const rawConfig = cliente.config_api?.google_sheets_conversiones;
    const enabledSheets = normalizeSheetConfigs(rawConfig).filter((s) => s.enabled && s.sheet_url);

    if (enabledSheets.length === 0) {
      return NextResponse.json(
        { error: 'No hay sheets de conversiones habilitados para este cliente' },
        { status: 400 }
      );
    }

    if (sheetId && !enabledSheets.some((s) => s.id === sheetId)) {
      return NextResponse.json(
        { error: 'El sheet indicado no existe o está deshabilitado' },
        { status: 400 }
      );
    }

    const sheetCfg = sheetId ? enabledSheets.find((s) => s.id === sheetId)! : null;

    // ── Modo pestaña: inserta lo suyo en el lote y devuelve su agregado ──────
    if (sheetCfg && tabId) {
      if (!batchId) {
        return NextResponse.json({ error: 'Falta el batchId del lote' }, { status: 400 });
      }
      const tab = await syncTabConversiones(supabase, cliente.id, sheetCfg, tabId, batchId);
      return NextResponse.json({
        success: true,
        batchId,
        tab_name: tab.tab_name,
        totalFilas: tab.rowsProcessed,
        filasCrudas: tab.rawProcessed,
        filasDescartadas: tab.rowsDescartadas,
        aggregates: tab.aggregates,
        quality: tab.quality,
        ...(tab.rawError ? { warnings: [`${tab.tab_name}: ${tab.rawError}`] } : {}),
      });
    }

    // ── Modo consolidación: cierra el lote del sheet ─────────────────────────
    if (sheetCfg && consolidar) {
      if (!batchId) {
        return NextResponse.json({ error: 'Falta el batchId del lote' }, { status: 400 });
      }

      const parciales = (aggregates ?? []) as ConversionDiariaParcial[];
      const cerrado = await consolidarLoteSheet(
        supabase,
        cliente.id,
        sheetCfg.id!,
        batchId,
        finalizarAgregados(mergeAgregadosParciales([parciales]))
      );

      // El log alimenta el "Último sync" de la UI; la calidad la traen las
      // pestañas, que son las que leyeron el documento.
      const calidad = (quality ?? []) as TabSyncQuality[];
      const hayAvisos = calidad.some((q) => q.warnings.length > 0) || !!cerrado.replaceError;
      await logSyncResult(
        supabase,
        cliente.id,
        sheetCfg.id!,
        hayAvisos ? 'partial' : 'ok',
        calidad,
        cerrado.replaceError
      );

      const limpieza = await cleanupOrphanConversiones(
        supabase,
        cliente.id,
        normalizeSheetConfigs(rawConfig).map((s) => s.id!)
      );

      let campos: { campos: number; error?: string } | undefined;
      if (recalcularCampos !== false) {
        try {
          const { recalcularCamposCliente } = await import('@/lib/sheets/campos-db');
          campos = await recalcularCamposCliente(supabase, cliente.id);
        } catch (err: any) {
          campos = { campos: 0, error: err?.message || 'Error al recalcular los campos' };
        }
      }

      return NextResponse.json({
        success: true,
        diasProcesados: cerrado.daysProcessed,
        camposRecalculados: campos?.campos ?? 0,
        warnings: [
          ...(cerrado.replaceError ? [cerrado.replaceError] : []),
          ...limpieza.errors.map((e) => `No se pudieron retirar todas las filas huérfanas — ${e}`),
          ...(campos?.error ? [`Campos de Sheet: ${campos.error}`] : []),
        ],
        timestamp: new Date().toISOString(),
      });
    }

    const { results, rows, campos, limpieza } = await syncClienteConversiones(
      supabase,
      cliente.id,
      rawConfig,
      {
        sheetId,
        // Por defecto se recalcula; el sync por sheet no, porque el recálculo
        // recorre la capa cruda entera y se lanza una sola vez al terminar todos.
        recalcularCampos: recalcularCampos ?? !sheetId,
      }
    );

    const porTipo = rows.reduce<Record<string, { cantidad: number; valor: number }>>((acc, r) => {
      if (!acc[r.tipo]) acc[r.tipo] = { cantidad: 0, valor: 0 };
      acc[r.tipo].cantidad += r.cantidad;
      acc[r.tipo].valor += r.valor ?? 0;
      return acc;
    }, {});

    const warnings = [
      ...results.filter((r) => !r.success).map((r) => `${r.name}: ${r.error}`),
      ...results.flatMap((r) =>
        r.quality.flatMap((q) => q.warnings.map((w) => `${r.name} › ${q.tab_name}: ${w}`))
      ),
      ...(campos?.error ? [`Campos de Sheet: ${campos.error}`] : []),
      ...(campos?.avisos ?? []),
      // Una limpieza a medias deja filas de sheets retirados contando en los
      // totales. Antes solo se veía en el log del servidor.
      ...limpieza.errors.map((e) => `No se pudieron retirar todas las filas huérfanas — ${e}`),
    ];

    return NextResponse.json({
      success: results.some((r) => r.success),
      clientName: cliente.nombre,
      totalFilas: rows.length,
      diasProcesados: results.reduce((s, r) => s + r.daysProcessed, 0),
      filasDescartadas: results.reduce((s, r) => s + r.rowsDescartadas, 0),
      filasCrudas: results.reduce((s, r) => s + r.rawProcessed, 0),
      sheetsProcessed: results.length,
      camposRecalculados: campos?.campos ?? 0,
      porTipo,
      sheets: results.map((r) => ({
        sheet_id: r.sheet_id,
        name: r.name,
        success: r.success,
        filas: r.rowsProcessed,
        dias: r.daysProcessed,
        descartadas: r.rowsDescartadas,
        crudas: r.rawProcessed,
        quality: r.quality,
        ...(r.error ? { error: r.error } : {}),
      })),
      ...(warnings.length > 0 ? { warnings } : {}),
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Error sync conversiones offline:', error);
    return NextResponse.json(
      { error: error.message || 'Error al sincronizar conversiones offline' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/admin/sync-conversiones-offline?clientId=UUID
 * Verifica si el cliente tiene al menos un sheet habilitado y devuelve el
 * estado del último sync de cada uno (filas ok/descartadas, avisos por pestaña).
 */
export async function GET(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole();
  if (denied) return denied;

  try {
    const clientId = request.nextUrl.searchParams.get('clientId');
    if (!esUuid(clientId)) {
      return NextResponse.json({ error: 'clientId debe ser un UUID válido' }, { status: 400 });
    }

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );

    const { data: cliente } = await supabase
      .from('clientes')
      .select('config_api')
      .eq('id', clientId)
      .single();

    const sheets = normalizeSheetConfigs(cliente?.config_api?.google_sheets_conversiones);
    const enabledSheets = sheets.filter((s) => s.enabled && s.sheet_url);

    // Último log por sheet. La tabla puede no existir aún (migración 056 sin
    // aplicar): en ese caso simplemente no se reporta estado.
    const lastSync: Record<string, any> = {};
    const { data: logs } = await supabase
      .from('conversiones_offline_sync_log')
      .select('sheet_id, run_at, status, rows_ok, rows_descartadas, detalle')
      .eq('cliente_id', clientId)
      .order('run_at', { ascending: false })
      .limit(100);

    for (const log of (logs ?? []) as any[]) {
      if (!lastSync[log.sheet_id]) lastSync[log.sheet_id] = log;
    }

    return NextResponse.json({
      isConfigured: enabledSheets.length > 0,
      sheetsCount: enabledSheets.length,
      sheetNames: enabledSheets.map((s) => s.name || s.sheet_url),
      lastSync,
    });
  } catch {
    return NextResponse.json({ error: 'Error al verificar configuración' }, { status: 500 });
  }
}
