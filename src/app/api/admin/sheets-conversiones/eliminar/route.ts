import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizeSheetConfigs } from '@/lib/integrations/google-sheets-conversiones';
import { loadCamposCliente } from '@/lib/sheets/campos-db';
import { requireAdminRole } from '@/lib/report-utm/auth';
import { esUuid } from '@/lib/validation';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const maxDuration = 60;

/**
 * Retirar un documento de Sheets **con sus datos**.
 *
 * Antes, quitar un sheet del formulario solo lo sacaba del JSON de config: sus
 * filas se quedaban en las tres tablas hasta que un sync posterior las barriera
 * como huérfanas. Ese barrido se hacía en una sola sentencia, no cabía en el
 * `statement_timeout` y su error se descartaba, así que en la práctica los datos
 * se quedaban ahí para siempre, contando en los totales de un documento que ya
 * nadie ve en la pantalla.
 *
 *   GET  ?clientId=&sheetId=  → qué se va a borrar (filas y campos afectados)
 *   POST { clientId, sheetId } → borra una tanda y dice si queda trabajo
 *
 * El POST borra por páginas y devuelve `done:false` mientras queden filas, para
 * que el cliente lo repita: así un documento de decenas de miles de filas se
 * retira entero sin que ninguna petición se acerque al límite de tiempo. Cuando
 * ya no queda nada, la última pasada quita el sheet de la config y recalcula los
 * campos que se alimentaban de él.
 */

const TABLAS = ['conversiones_offline', 'conversiones_offline_diarias', 'sheet_filas'] as const;
const PAGINA = 500;
/** Tope por petición: deja margen de sobra dentro de los 60 s. */
const PAGINAS_POR_TANDA = 40;

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function contar(db: any, tabla: string, clienteId: string, sheetId: string) {
  const { count } = await db
    .from(tabla)
    .select('id', { count: 'exact', head: true })
    .eq('cliente_id', clienteId)
    .eq('sheet_id', sheetId);
  return count ?? 0;
}

export async function GET(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole();
  if (denied) return denied;

  const clientId = request.nextUrl.searchParams.get('clientId');
  const sheetId = request.nextUrl.searchParams.get('sheetId');
  if (!esUuid(clientId) || !sheetId) {
    return NextResponse.json(
      { error: 'clientId debe ser un UUID válido y sheetId es obligatorio' },
      { status: 400 }
    );
  }

  try {
    const db = admin();
    const [conversiones, diarias, crudas] = await Promise.all(
      TABLAS.map((t) => contar(db, t, clientId, sheetId))
    );

    // Campos que se alimentan de este documento. Un origen con sheet_id '*' lee
    // de todos los sheets: pierde una fuente, pero no se queda sin ninguna.
    const { campos } = await loadCamposCliente(db, clientId, { soloActivos: false });
    const afectados = campos
      .filter((c) => (c.origenes ?? []).some((o) => o.sheet_id === sheetId || o.sheet_id === '*'))
      .map((c) => {
        const propios = (c.origenes ?? []).filter((o) => o.sheet_id === sheetId);
        const otros = (c.origenes ?? []).filter((o) => o.sheet_id !== sheetId);
        return {
          nombre: c.nombre,
          clave: c.clave,
          origenesQuePierde: propios.length,
          quedaSinOrigen: propios.length > 0 && otros.length === 0,
        };
      })
      .filter((c) => c.origenesQuePierde > 0);

    return NextResponse.json({
      filas: { conversiones, diarias, crudas, total: conversiones + diarias + crudas },
      campos: afectados,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Error al consultar el sheet' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole();
  if (denied) return denied;

  try {
    const { clientId, sheetId } = await request.json();
    if (!clientId || !sheetId) {
      return NextResponse.json({ error: 'clientId y sheetId son obligatorios' }, { status: 400 });
    }

    const db = admin();
    let borradas = 0;

    for (const tabla of TABLAS) {
      for (let i = 0; i < PAGINAS_POR_TANDA; i++) {
        const { data, error } = await db
          .from(tabla)
          .select('id')
          .eq('cliente_id', clientId)
          .eq('sheet_id', sheetId)
          .limit(PAGINA);
        if (error)
          return NextResponse.json({ error: `${tabla}: ${error.message}` }, { status: 500 });
        if (!data || data.length === 0) break;

        const ids = (data as { id: string }[]).map((r) => r.id);
        const { error: delErr } = await db.from(tabla).delete().in('id', ids);
        if (delErr)
          return NextResponse.json({ error: `${tabla}: ${delErr.message}` }, { status: 500 });
        borradas += ids.length;
      }
    }

    const restantes = (
      await Promise.all(TABLAS.map((t) => contar(db, t, clientId, sheetId)))
    ).reduce((a, b) => a + b, 0);

    if (restantes > 0) {
      return NextResponse.json({ done: false, borradas, restantes });
    }

    // ── Última pasada: ya no quedan filas, se retira de la config ──────────
    const { data: cliente } = await db
      .from('clientes')
      .select('config_api')
      .eq('id', clientId)
      .single();

    const config = (cliente as any)?.config_api ?? {};
    const sheets = normalizeSheetConfigs(config.google_sheets_conversiones);
    const quedan = sheets.filter((s) => s.id !== sheetId);

    if (quedan.length !== sheets.length) {
      const { error } = await db
        .from('clientes')
        .update({ config_api: { ...config, google_sheets_conversiones: quedan } })
        .eq('id', clientId);
      if (error) {
        return NextResponse.json(
          {
            error: `Datos borrados, pero no se pudo actualizar la configuración: ${error.message}`,
          },
          { status: 500 }
        );
      }
    }

    await db
      .from('conversiones_offline_sync_log')
      .delete()
      .eq('cliente_id', clientId)
      .eq('sheet_id', sheetId);

    // El desglose de los campos se recalcula sin este origen. No llama a Google
    // y un fallo aquí no revierte el borrado: se puede relanzar solo.
    let camposError: string | undefined;
    try {
      const { recalcularCamposCliente } = await import('@/lib/sheets/campos-db');
      const res = await recalcularCamposCliente(db, clientId);
      if (res.error) camposError = res.error;
    } catch (err: any) {
      camposError = err?.message || 'Error al recalcular los campos';
    }

    return NextResponse.json({
      done: true,
      borradas,
      sheetsRestantes: quedan.length,
      ...(camposError ? { warning: `Los campos de Sheet no se recalcularon: ${camposError}` } : {}),
    });
  } catch (err: any) {
    console.error('[sheets-conversiones/eliminar]', err);
    return NextResponse.json(
      { error: err.message || 'Error al eliminar el sheet' },
      { status: 500 }
    );
  }
}
