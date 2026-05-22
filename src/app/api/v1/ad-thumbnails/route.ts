import { NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'

export interface AdThumbnailInfo {
    thumbnail: string | null
    previewUrl: string | null
}

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

    const result: Record<string, AdThumbnailInfo> = {}

    await Promise.all(adIds.map(async (adId) => {
        try {
            const url = new URL(`https://graph.facebook.com/v19.0/${adId}`)
            // Pedimos thumbnail + story ID de la publicación + preview_shareable_link
            url.searchParams.set('fields', 'creative{thumbnail_url,effective_object_story_id},preview_shareable_link')
            url.searchParams.set('access_token', token)
            const res = await fetch(url.toString())
            const data = await res.json()

            const thumbnail: string | null = data?.creative?.thumbnail_url ?? null

            // Mejor link disponible, en orden de preferencia
            let previewUrl: string | null = null

            // 1. preview_shareable_link (fb.me/adspreview/...)
            if (data?.preview_shareable_link) {
                previewUrl = data.preview_shareable_link
            }

            // 2. effective_object_story_id → permalink de la publicación en Facebook
            if (!previewUrl && data?.creative?.effective_object_story_id) {
                const storyId: string = data.creative.effective_object_story_id
                const parts = storyId.split('_')
                if (parts.length === 2) {
                    previewUrl = `https://www.facebook.com/permalink.php?story_fbid=${parts[1]}&id=${parts[0]}`
                }
            }

            result[adId] = { thumbnail, previewUrl }
        } catch {
            result[adId] = { thumbnail: null, previewUrl: null }
        }
    }))

    return NextResponse.json(result)
}
