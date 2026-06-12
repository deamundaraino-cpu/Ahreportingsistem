import { NextResponse } from 'next/server'
import { hasAgencyGoogleConnection } from '@/lib/integrations/google-auth'
import { listGoogleSheets } from '@/lib/integrations/google-sheets-conversiones'

/**
 * GET /api/admin/list-google-sheets
 * Lista todos los Google Sheets accesibles para la cuenta OAuth de la agencia.
 * Usa el scope drive.readonly ya incluido en el OAuth de agencia.
 */
export async function GET() {
  try {
    const hasConnection = await hasAgencyGoogleConnection()
    if (!hasConnection) {
      return NextResponse.json(
        { error: 'No hay conexión OAuth de Google activa. Conecta la cuenta de la agencia primero en Ajustes → Google.' },
        { status: 400 }
      )
    }

    const sheets = await listGoogleSheets()
    return NextResponse.json({ sheets })
  } catch (err: any) {
    console.error('list-google-sheets error:', err)
    return NextResponse.json(
      { error: err.message || 'Error al listar Google Sheets desde Drive' },
      { status: 500 }
    )
  }
}
