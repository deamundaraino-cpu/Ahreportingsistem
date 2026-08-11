// Salud de las fuentes de datos de todos los clientes.
//
// Alimenta /report-utm/salud. Es la respuesta al problema que dejó tres fallos
// vivos durante semanas: un informe con una fuente muerta no se ve roto, se ve
// vacío, así que nadie lo reporta.

import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import { saludDeTodos } from '@/lib/report-utm/salud-fuentes-db'

export const dynamic = 'force-dynamic'

export async function GET() {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    try {
        const clientes = await saludDeTodos()
        return NextResponse.json({
            data: {
                clientes,
                resumen: {
                    criticos: clientes.filter(c => c.gravedad === 'critico').length,
                    avisos: clientes.filter(c => c.gravedad === 'aviso').length,
                    ok: clientes.filter(c => c.gravedad === 'ok').length,
                },
            },
            // Sin caché: el valor de este panel es decir qué pasa AHORA. Una
            // respuesta de hace diez minutos reintroduce justo el retraso que
            // esta pantalla existe para eliminar.
        }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
        console.error('[salud-fuentes]', err)
        return NextResponse.json({ error: 'Error evaluando la salud de las fuentes' }, { status: 500 })
    }
}
