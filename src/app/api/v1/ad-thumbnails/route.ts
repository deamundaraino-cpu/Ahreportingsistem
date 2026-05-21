import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url)
    const clienteId = searchParams.get('clienteId')
    const adIdsParam = searchParams.get('adIds')

    if (!clienteId || !adIdsParam) {
        return NextResponse.json({ error: 'Missing clienteId or adIds' }, { status: 400 })
    }

    const adIds = adIdsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 50)
    if (adIds.length === 0) return NextResponse.json({})

    const supabase = await createClient()

    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Verify this client belongs to the authenticated user
    const { data: cliente, error: clienteErr } = await supabase
        .from('clientes')
        .select('id, config_api')
        .eq('id', clienteId)
        .single()

    if (clienteErr || !cliente) {
        return NextResponse.json({ error: 'Cliente not found' }, { status: 404 })
    }

    const config = cliente.config_api as any
    const token: string =
        config?.meta_token ||
        config?.meta_accounts?.[0]?.token ||
        ''

    if (!token) {
        return NextResponse.json({ error: 'No Meta token configured' }, { status: 422 })
    }

    // Batch fetch thumbnails from Meta Graph API
    const result: Record<string, string | null> = {}

    await Promise.all(adIds.map(async (adId) => {
        try {
            const url = new URL(`https://graph.facebook.com/v19.0/${adId}`)
            url.searchParams.set('fields', 'creative{thumbnail_url}')
            url.searchParams.set('access_token', token)
            const res = await fetch(url.toString())
            const data = await res.json()
            result[adId] = data?.creative?.thumbnail_url ?? null
        } catch {
            result[adId] = null
        }
    }))

    return NextResponse.json(result)
}
