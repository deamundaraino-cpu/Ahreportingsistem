import { NextRequest, NextResponse } from 'next/server'
import { detectSheetColumns } from '@/lib/integrations/google-sheets-conversiones'
import type { ConversionesConfig } from '@/lib/integrations/google-sheets-conversiones'

/**
 * POST /api/admin/detect-sheet-columns
 * Body: { sheetConfig: ConversionesConfig }
 *
 * Lee los encabezados del Sheet y devuelve las columnas extra con tipo propuesto.
 * Acepta el config inline (no necesita estar guardado en DB primero).
 * No modifica nada en la DB.
 */
export async function POST(request: NextRequest) {
  try {
    const { sheetConfig } = await request.json() as { sheetConfig: ConversionesConfig }

    if (!sheetConfig?.sheet_url) {
      return NextResponse.json(
        { error: 'Configura primero la URL del Sheet' },
        { status: 400 }
      )
    }

    const columns = await detectSheetColumns(sheetConfig)
    return NextResponse.json({ columns })
  } catch (err: any) {
    console.error('detect-sheet-columns error:', err)
    return NextResponse.json(
      { error: err.message || 'Error al leer el Sheet' },
      { status: 500 }
    )
  }
}
