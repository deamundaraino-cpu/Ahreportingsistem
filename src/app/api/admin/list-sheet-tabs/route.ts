import { NextRequest, NextResponse } from 'next/server'
import { listSheetTabs } from '@/lib/integrations/google-sheets-conversiones'
import type { ConversionesConfig } from '@/lib/integrations/google-sheets-conversiones'
import { requireAdminRole } from '@/lib/report-utm/auth'

/**
 * POST /api/admin/list-sheet-tabs
 * Body: { sheetConfig: ConversionesConfig }  (basta con sheet_url)
 *
 * Lista las pestañas reales del documento para que el analista las elija en vez
 * de teclear el nombre. No modifica nada en la DB.
 */
export async function POST(request: NextRequest) {
  // Guard de rol: el proxy ya exige sesión en /api/admin, esto añade el rol.
  const denied = await requireAdminRole()
  if (denied) return denied

  try {
    const { sheetConfig } = await request.json() as { sheetConfig: ConversionesConfig }

    if (!sheetConfig?.sheet_url) {
      return NextResponse.json(
        { error: 'Configura primero la URL del Sheet' },
        { status: 400 }
      )
    }

    const tabs = await listSheetTabs(sheetConfig)
    return NextResponse.json({ tabs })
  } catch (err: any) {
    console.error('list-sheet-tabs error:', err)
    return NextResponse.json(
      { error: err.message || 'Error al listar las pestañas del Sheet' },
      { status: 500 }
    )
  }
}
