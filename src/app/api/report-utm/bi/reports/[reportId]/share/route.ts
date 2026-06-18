import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { createClient, createAdminClient } from '@/utils/supabase/server'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ reportId: string }> }

// POST: genera (o devuelve) un token público de solo lectura
export async function POST(_req: NextRequest, { params }: Params) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { reportId } = await params
    const db = await createAdminClient()

    const { data: existing } = await db
        .from('bi_reports')
        .select('public_token')
        .eq('id', reportId)
        .maybeSingle()

    let token = existing?.public_token
    if (!token) {
        token = randomBytes(16).toString('hex')
        const { error } = await db.from('bi_reports').update({ public_token: token }).eq('id', reportId)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ token })
}

// DELETE: revoca el token público
export async function DELETE(_req: NextRequest, { params }: Params) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { reportId } = await params
    const db = await createAdminClient()
    const { error } = await db.from('bi_reports').update({ public_token: null }).eq('id', reportId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
}
