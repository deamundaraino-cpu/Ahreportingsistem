import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/utils/supabase/server'
import { firmarState, COOKIE_STATE, VENTANA_STATE_MS } from '@/lib/hotmart/oauth-state'
import { HOTMART_AUTH_BASE } from '@/lib/hotmart/cliente'

/**
 * Inicia el flujo OAuth de Hotmart (HotConnect — authorization code).
 * Uso: /api/auth/hotmart?client_id={CLIENTE_ID}
 *
 * ── Dos agujeros que esta versión cierra ────────────────────────
 *  1. La ruta era PÚBLICA: cualquiera podía abrir el flujo para cualquier
 *     cliente. Ahora exige sesión con rol admin o superadmin.
 *  2. El `state` era el `cliente_id` a secas — un UUID que aparece en la URL del
 *     panel — y el callback no lo validaba. Cualquiera que lo conociera podía
 *     completar el flujo con SU cuenta de Hotmart y sobrescribir los tokens del
 *     cliente. Ahora va firmado, caduca a los 10 minutos y su `nonce` tiene que
 *     coincidir con una cookie httpOnly de este mismo navegador.
 */
export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url)
    const clienteId = searchParams.get('client_id')

    if (!clienteId) {
        return NextResponse.json({ error: 'client_id requerido' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        return NextResponse.json({ error: 'No autenticado' }, { status: 401 })
    }
    const { data: perfil } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()
    if (!['admin', 'superadmin'].includes(perfil?.role ?? '')) {
        return NextResponse.json({ error: 'Sin permiso para conectar integraciones' }, { status: 403 })
    }

    const appClientId = process.env.HOTMART_APP_CLIENT_ID
    if (!appClientId) {
        return NextResponse.json({ error: 'HOTMART_APP_CLIENT_ID no configurado' }, { status: 500 })
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (!appUrl) {
        return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL no configurado' }, { status: 500 })
    }

    let firmado: ReturnType<typeof firmarState>
    try {
        firmado = firmarState(clienteId)
    } catch {
        // Falta CRON_SECRET. Preferimos fallar visiblemente antes que caer al
        // `state` sin firmar, que es justo la vulnerabilidad que se está cerrando.
        return NextResponse.json({ error: 'Servidor sin CRON_SECRET configurado' }, { status: 500 })
    }

    const authUrl = new URL(`${HOTMART_AUTH_BASE}/security/oauth/authorize`)
    authUrl.searchParams.set('client_id', appClientId)
    authUrl.searchParams.set('redirect_uri', `${appUrl}/api/auth/hotmart/callback`)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('state', firmado.state)

    const res = NextResponse.redirect(authUrl.toString())
    res.cookies.set(COOKIE_STATE, firmado.nonce, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        // `lax` y no `strict`: la vuelta desde Hotmart es una navegación
        // top-level de otro sitio, y con `strict` la cookie no se enviaría.
        sameSite: 'lax',
        path: '/api/auth/hotmart',
        maxAge: Math.floor(VENTANA_STATE_MS / 1000),
    })
    return res
}
