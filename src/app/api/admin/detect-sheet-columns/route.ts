import { NextRequest, NextResponse } from 'next/server';
import { detectSheetColumns } from '@/lib/integrations/google-sheets-conversiones';
import type {
  ConversionesConfig,
  SheetTabConfig,
} from '@/lib/integrations/google-sheets-conversiones';
import { requireAdminRole } from '@/lib/report-utm/auth';

/**
 * POST /api/admin/detect-sheet-columns
 * Body: { sheetConfig: ConversionesConfig, tab?: SheetTabConfig }
 *
 * Lee los encabezados de la pestaña indicada (o de la primera del doc si no se
 * pasa) y devuelve las columnas extra con tipo propuesto, más los headers
 * completos para poblar el mapeo estándar. Acepta el config inline (no necesita
 * estar guardado en DB primero). No modifica nada en la DB.
 */
export async function POST(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole();
  if (denied) return denied;

  try {
    const { sheetConfig, tab } = (await request.json()) as {
      sheetConfig: ConversionesConfig;
      tab?: SheetTabConfig;
    };

    if (!sheetConfig?.sheet_url) {
      return NextResponse.json({ error: 'Configura primero la URL del Sheet' }, { status: 400 });
    }

    const { headers, columns } = await detectSheetColumns(sheetConfig, tab);
    return NextResponse.json({ headers, columns });
  } catch (err: any) {
    console.error('detect-sheet-columns error:', err);
    return NextResponse.json({ error: err.message || 'Error al leer el Sheet' }, { status: 500 });
  }
}
