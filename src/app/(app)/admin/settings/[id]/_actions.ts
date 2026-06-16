'use server'

import { createClient, createAdminClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

export type BitacoraVisibilidad = 'privado' | 'trafficker' | 'publico'

export interface Bitacora {
    id: string
    cliente_id: string
    author_id: string
    author_name: string | null
    titulo: string
    contenido: string
    visibilidad: BitacoraVisibilidad
    created_at: string
    updated_at: string
}

export async function getBitacoras(clienteId: string): Promise<Bitacora[]> {
    const supabase = await createClient()
    const { data, error } = await supabase
        .from('bitacoras')
        .select('*')
        .eq('cliente_id', clienteId)
        .order('created_at', { ascending: false })

    if (error) {
        console.error('Error fetching bitacoras:', error)
        return []
    }
    return data ?? []
}

export async function createBitacora(
    clienteId: string,
    titulo: string,
    contenido: string,
    visibilidad: BitacoraVisibilidad
): Promise<{ success?: boolean; error?: string }> {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: 'No autenticado' }

    const { data: profile } = await supabase
        .from('user_profiles')
        .select('full_name')
        .eq('id', user.id)
        .single()

    const { error } = await supabase.from('bitacoras').insert({
        cliente_id: clienteId,
        author_id: user.id,
        author_name: profile?.full_name ?? null,
        titulo,
        contenido,
        visibilidad,
    })

    if (error) return { error: error.message }
    revalidatePath(`/admin/settings/${clienteId}`)
    return { success: true }
}

export async function updateBitacora(
    id: string,
    clienteId: string,
    titulo: string,
    contenido: string,
    visibilidad: BitacoraVisibilidad
): Promise<{ success?: boolean; error?: string }> {
    const supabase = await createClient()
    const { error } = await supabase
        .from('bitacoras')
        .update({ titulo, contenido, visibilidad, updated_at: new Date().toISOString() })
        .eq('id', id)

    if (error) return { error: error.message }
    revalidatePath(`/admin/settings/${clienteId}`)
    return { success: true }
}

export async function deleteBitacora(
    id: string,
    clienteId: string
): Promise<{ success?: boolean; error?: string }> {
    const supabase = await createClient()
    const { error } = await supabase.from('bitacoras').delete().eq('id', id)

    if (error) return { error: error.message }
    revalidatePath(`/admin/settings/${clienteId}`)
    return { success: true }
}

// Usada desde la página pública /p/[token] — sin autenticación, service role
export async function getPublicBitacoras(token: string): Promise<Bitacora[]> {
    const supabase = await createAdminClient()

    // Resolver token → cliente_id (primero por tab, luego por cliente)
    let clienteId: string | null = null

    const { data: tab } = await supabase
        .from('cliente_tabs')
        .select('cliente_id')
        .eq('public_token', token)
        .maybeSingle()

    if (tab?.cliente_id) {
        clienteId = tab.cliente_id
    } else {
        const { data: cliente } = await supabase
            .from('clientes')
            .select('id')
            .eq('public_token', token)
            .maybeSingle()
        clienteId = cliente?.id ?? null
    }

    if (!clienteId) return []

    const { data, error } = await supabase
        .from('bitacoras')
        .select('*')
        .eq('cliente_id', clienteId)
        .eq('visibilidad', 'publico')
        .order('created_at', { ascending: false })

    if (error) return []
    return data ?? []
}
