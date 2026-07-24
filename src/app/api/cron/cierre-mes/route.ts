import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Congela un mes ya cerrado.
 *
 * Un informe mensual entregado al cliente no puede cambiar después. Sin este
 * cierre, cualquier re-sincronización posterior reescribe `metricas_diarias`:
 * Meta reatribuye conversiones hasta 28 días más tarde y un fallo de API podía
 * meter ceros sobre datos buenos.
 *
 * El flujo lo encola `planCierreMes`, que primero mete jobs de re-descarga
 * forzada del mes (con `refresh_days=35`) y solo después este congelado, para
 * que la foto que se guarda ya incluya la atribución tardía.
 *
 *   POST /api/cron/cierre-mes?client_id=&start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Idempotente: reejecutarlo sobre un mes ya cerrado actualiza el snapshot y deja
 * el candado como estaba.
 */

/** Hash estable del contenido: detecta si las filas vivas divergen del snapshot. */
function checksum(obj: any): string {
    const str = JSON.stringify(obj)
    let h = 5381
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(33, h) + str.charCodeAt(i) | 0
    }
    return (h >>> 0).toString(16)
}

export async function POST(request: Request) {
    const authError = requireCronAuth(request)
    if (authError) return authError
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY requerido' }, { status: 500 })
    }
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY)

    const { searchParams } = new URL(request.url)
    const clienteId = searchParams.get('client_id')
    const start = searchParams.get('start')
    const end = searchParams.get('end')

    if (!start || !end) {
        return NextResponse.json({ error: 'Faltan `start` y `end` (primer y último día del mes)' }, { status: 400 })
    }
    const periodo = `${start.slice(0, 7)}-01`

    // El cierre solo tiene sentido sobre un mes terminado: congelar el mes en
    // curso dejaría fuera las ventas que aún faltan por llegar.
    const hoy = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10)
    if (end >= hoy) {
        return NextResponse.json({ error: `El período ${periodo} aún no ha terminado (fin ${end} >= hoy ${hoy})` }, { status: 400 })
    }

    let clienteIds: string[]
    if (clienteId) {
        clienteIds = [clienteId]
    } else {
        const { data: clientes, error } = await db.from('clientes').select('id')
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        clienteIds = (clientes ?? []).map((c: any) => c.id)
    }

    const resultados: Array<{ cliente_id: string; filas: number; estado: string }> = []

    for (const id of clienteIds) {
        const { data: filas, error } = await db
            .from('metricas_diarias')
            .select('*')
            .eq('cliente_id', id)
            .gte('fecha', start)
            .lte('fecha', end)
            .order('fecha', { ascending: true })

        if (error) {
            resultados.push({ cliente_id: id, filas: 0, estado: `error: ${error.message}` })
            continue
        }
        if (!filas || filas.length === 0) {
            // Sin datos no hay nada que congelar; tampoco se pone candado, por si
            // el mes se sincroniza más tarde.
            resultados.push({ cliente_id: id, filas: 0, estado: 'sin_datos' })
            continue
        }

        const { error: snapError } = await db.from('metricas_snapshots').upsert({
            cliente_id: id,
            periodo,
            congelado_at: new Date().toISOString(),
            filas,
            filas_count: filas.length,
            checksum: checksum(filas),
        }, { onConflict: 'cliente_id,periodo' })

        if (snapError) {
            resultados.push({ cliente_id: id, filas: filas.length, estado: `error snapshot: ${snapError.message}` })
            continue
        }

        // El candado va DESPUÉS del snapshot: si el snapshot falla, el mes sigue
        // sincronizándose con normalidad en vez de quedar bloqueado y sin copia.
        const { error: lockError } = await db.from('periodos_cerrados').upsert({
            cliente_id: id,
            periodo,
            cerrado_at: new Date().toISOString(),
            cerrado_por: 'cron',
        }, { onConflict: 'cliente_id,periodo' })

        resultados.push({
            cliente_id: id,
            filas: filas.length,
            estado: lockError ? `error candado: ${lockError.message}` : 'congelado',
        })
    }

    const congelados = resultados.filter(r => r.estado === 'congelado').length
    return NextResponse.json({ ok: true, periodo, clientes: resultados.length, congelados, resultados })
}
