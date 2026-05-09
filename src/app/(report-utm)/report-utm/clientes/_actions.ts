'use server'

import { revalidatePath } from 'next/cache'
import { reportUtmClient } from '@/lib/report-utm/client'

function slugify(input: string): string {
    return input
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
}

export async function createClienteAction(formData: FormData) {
    const nombre = String(formData.get('nombre') ?? '').trim()
    const descripcion = String(formData.get('descripcion') ?? '').trim() || null
    const color = String(formData.get('color') ?? 'emerald').trim()
    const slugInput = String(formData.get('slug') ?? '').trim()

    if (!nombre) {
        return { ok: false, error: 'El nombre es obligatorio' }
    }

    const slug = slugify(slugInput || nombre)
    if (!slug) {
        return { ok: false, error: 'Slug inválido' }
    }

    const supabase = await reportUtmClient()
    const { error } = await supabase.from('clientes').insert({
        nombre,
        slug,
        descripcion,
        color,
    })

    if (error) {
        return { ok: false, error: error.message }
    }

    revalidatePath('/report-utm/clientes')
    revalidatePath('/report-utm')
    return { ok: true }
}

export async function updateClienteStatusAction(id: string, status: 'active' | 'paused' | 'archived') {
    const supabase = await reportUtmClient()
    const { error } = await supabase.from('clientes').update({ status }).eq('id', id)
    if (error) return { ok: false, error: error.message }

    revalidatePath('/report-utm/clientes')
    revalidatePath(`/report-utm/clientes/${id}`)
    return { ok: true }
}

export async function deleteClienteAction(id: string) {
    const supabase = await reportUtmClient()
    const { error } = await supabase.from('clientes').delete().eq('id', id)
    if (error) return { ok: false, error: error.message }

    revalidatePath('/report-utm/clientes')
    revalidatePath('/report-utm')
    return { ok: true }
}
