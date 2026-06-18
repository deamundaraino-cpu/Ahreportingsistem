import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/utils/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET() {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const db = await createAdminClient()
    const { data, error } = await db
        .from('bi_reports')
        .select('id,nombre,descripcion,filters,created_at,updated_at,cliente_id')
        .order('updated_at', { ascending: false })
        .limit(100)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data })
}

export async function POST(req: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const { nombre, descripcion, cliente_id, layout, filters } = body

    if (!nombre) return NextResponse.json({ error: 'nombre is required' }, { status: 400 })

    const db = await createAdminClient()
    const { data, error } = await db
        .from('bi_reports')
        .insert({ nombre, descripcion, cliente_id: cliente_id || null, layout: layout ?? [], filters: filters ?? {} })
        .select()
        .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data }, { status: 201 })
}
