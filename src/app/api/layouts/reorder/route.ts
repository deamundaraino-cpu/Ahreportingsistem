import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  // Verify auth
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 })
  }

  const body = await request.json()
  const { clienteId, tabOrder } = body as {
    clienteId: string
    tabOrder: { id: string; position: number }[]
  }

  if (!clienteId || !tabOrder || !Array.isArray(tabOrder)) {
    return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 })
  }

  // Verify user has access to this client
  const { data: cliente } = await supabase
    .from('clientes')
    .select('id')
    .eq('id', clienteId)
    .single()

  if (!cliente) {
    return NextResponse.json({ error: 'Cliente no encontrado' }, { status: 404 })
  }

  // Update positions - use service role for batch update
  const { createAdminClient } = await import('@/utils/supabase/server')
  const adminSupabase = await createAdminClient()

  const updates = tabOrder.map(({ id, position }) =>
    adminSupabase
      .from('cliente_tabs')
      .update({ position, orden: position, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('cliente_id', clienteId)
  )

  const results = await Promise.all(updates)
  const errors = results.filter(r => r.error)

  if (errors.length > 0) {
    return NextResponse.json({ error: 'Error actualizando posiciones' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
