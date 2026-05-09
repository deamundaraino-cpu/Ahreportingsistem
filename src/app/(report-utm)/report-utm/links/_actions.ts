'use server'

import crypto from 'crypto'
import { revalidatePath } from 'next/cache'
import { reportUtmClient } from '@/lib/report-utm/client'

const SLUG_RE = /^[a-z0-9-]{3,40}$/

function generateSlug(): string {
    // 8 chars base36 — corto, suficiente para >2.8 billones de combinaciones
    return crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || crypto.randomBytes(4).toString('hex')
}

export async function createTrackingLinkAction(formData: FormData) {
    const cliente_id = String(formData.get('cliente_id') ?? '').trim()
    const nombre = String(formData.get('nombre') ?? '').trim()
    const destination_url = String(formData.get('destination_url') ?? '').trim()
    const slugInput = String(formData.get('slug') ?? '').trim().toLowerCase()
    const utm_source = String(formData.get('utm_source') ?? '').trim() || null
    const utm_medium = String(formData.get('utm_medium') ?? '').trim() || null
    const utm_campaign = String(formData.get('utm_campaign') ?? '').trim() || null
    const utm_content = String(formData.get('utm_content') ?? '').trim() || null
    const utm_term = String(formData.get('utm_term') ?? '').trim() || null

    if (!cliente_id) return { ok: false, error: 'Cliente requerido' }
    if (!nombre) return { ok: false, error: 'Nombre requerido' }
    if (!destination_url) return { ok: false, error: 'URL destino requerida' }

    try {
        new URL(destination_url)
    } catch {
        return { ok: false, error: 'URL destino inválida' }
    }

    const slug = slugInput || generateSlug()
    if (!SLUG_RE.test(slug)) {
        return { ok: false, error: 'Slug inválido (3-40 chars: a-z 0-9 -)' }
    }

    const supabase = await reportUtmClient()
    const { error } = await supabase.from('tracking_links').insert({
        cliente_id,
        nombre,
        slug,
        destination_url,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
    })

    if (error) return { ok: false, error: error.message }

    revalidatePath('/report-utm/links')
    return { ok: true, slug }
}

type SimpleResult = { ok: true } | { ok: false; error: string }

export async function toggleTrackingLinkAction(id: string, enabled: boolean): Promise<SimpleResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase.from('tracking_links').update({ enabled }).eq('id', id)
    if (error) return { ok: false, error: error.message }
    revalidatePath('/report-utm/links')
    return { ok: true }
}

export async function deleteTrackingLinkAction(id: string): Promise<SimpleResult> {
    const supabase = await reportUtmClient()
    const { error } = await supabase.from('tracking_links').delete().eq('id', id)
    if (error) return { ok: false, error: error.message }
    revalidatePath('/report-utm/links')
    return { ok: true }
}
