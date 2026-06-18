import { NextRequest, NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/utils/supabase/server'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ reportId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { reportId } = await params
    const db = await createAdminClient()
    const { data, error } = await db
        .from('bi_reports')
        .select('*')
        .eq('id', reportId)
        .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ data })
}

export async function PATCH(req: NextRequest, { params }: Params) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { reportId } = await params
    const body = await req.json()
    const allowed = ['nombre', 'descripcion', 'layout', 'filters', 'cliente_id', 'calculated_fields']
    const patch: Record<string, unknown> = {}
    for (const k of allowed) if (k in body) patch[k] = body[k]

    const db = await createAdminClient()
    const { data, error } = await db
        .from('bi_reports')
        .update(patch)
        .eq('id', reportId)
        .select()
        .single()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ data })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { reportId } = await params

    // Prevent deleting template reports (no cliente_id)
    const db = await createAdminClient()
    const { data: report } = await db.from('bi_reports').select('cliente_id').eq('id', reportId).maybeSingle()
    if (report && !report.cliente_id) {
        return NextResponse.json({ error: 'No se pueden eliminar plantillas del sistema' }, { status: 403 })
    }

    const { error } = await db.from('bi_reports').delete().eq('id', reportId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
}
