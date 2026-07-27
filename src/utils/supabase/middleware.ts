import { createServerClient } from "@supabase/ssr"
import { NextRequest, NextResponse } from "next/server"

// Routes only accessible by superadmin or admin
const ADMIN_ONLY_ROUTES = [
  '/admin/users',
  '/admin/api-tokens',
  '/admin/configuracion',
  '/admin/reports',
  '/admin/whatsapp',
]

// Routes accessible by superadmin, admin, and trafficker
const AUTHENTICATED_ADMIN_ROUTES = [
  '/admin/settings',
  '/admin/layouts',
]

// El proxy corre en TODAS las peticiones, así que una llamada lenta a Supabase
// Auth aquí tumba el dominio entero con MIDDLEWARE_INVOCATION_TIMEOUT (504).
// Cortamos la petición mucho antes del límite de la invocación para que un
// Supabase degradado se traduzca en "sesión no verificada" y no en un 504.
const AUTH_TIMEOUT_MS = 3_000

/**
 * Rutas públicas que nunca consultan `user`: para ellas no vale la pena pagar
 * un round-trip a Supabase Auth. Son además las de más volumen (pixel y links
 * de tracking), las que más cargaban el proxy.
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith('/report/') ||   // reportes públicos de cliente
    pathname.startsWith('/p/') ||        // mirrors
    pathname.startsWith('/t/') ||        // report-utm: links de tracking
    pathname === '/report-utm-pixel.js' ||
    pathname === '/privacy' ||
    pathname === '/terms'
  )
}

/**
 * ¿Trae la petición una cookie de sesión de Supabase? Si no la trae, ya sabemos
 * que es anónima sin preguntarle a Supabase: nos ahorramos la llamada de red en
 * bots, crawlers y en los endpoints de cron (que autentican con Bearer).
 */
function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(
    c => c.name.startsWith('sb-') && c.name.includes('auth-token')
  )
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  if (isPublicPath(pathname)) {
    return NextResponse.next({ request })
  }

  const isLoginPage = pathname.startsWith('/login')
  const isApiPage = pathname.startsWith('/api/')

  let supabaseResponse = NextResponse.next({
    request,
  })

  // Sin cookie de sesión no hay nada que refrescar ni que verificar.
  if (!hasAuthCookie(request)) {
    if (!isLoginPage && !isApiPage) {
      const url = request.nextUrl.clone()
      url.pathname = '/login'
      return NextResponse.redirect(url)
    }
    return supabaseResponse
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        // Aborta la llamada a Supabase antes de que Vercel corte la invocación.
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) }),
      },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // `authUnavailable` distingue "Supabase dice que no hay sesión" (denegar) de
  // "no pudimos preguntarle a Supabase" (no denegar). Tratar el segundo caso
  // como el primero expulsa al login a usuarios con sesión válida cada vez que
  // Auth tiene un hipo.
  let user = null
  let authUnavailable = false
  try {
    const { data, error } = await supabase.auth.getUser()
    user = data?.user ?? null
    // Errores de red/timeout (no un 401 legítimo por sesión inválida).
    if (error && (error.status === undefined || error.status >= 500)) {
      authUnavailable = true
    }
  } catch (e) {
    console.error('[proxy] auth.getUser falló:', e)
    authUnavailable = true
  }

  // Con Auth caído dejamos pasar la petición: la página y las server actions
  // vuelven a verificar la sesión por su cuenta y las RLS siguen protegiendo
  // los datos, así que el proxy no es la única barrera. Preferimos degradar la
  // navegación antes que cerrar la sesión de todo el mundo.
  if (authUnavailable) {
    return supabaseResponse
  }

  // Las rutas públicas (/report, /p, /t, pixel, legales) ya salieron arriba en
  // `isPublicPath`, así que aquí solo quedan /login, /api y el resto de la app.

  // 1. Redirect unauthenticated users to login
  if (!user && !isLoginPage && !isApiPage) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // 2. Redirect authenticated users away from login
  if (user && isLoginPage) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  // 3. Role-based route protection for authenticated users
  if (user && pathname.startsWith('/admin')) {
    const isAdminOnlyRoute = ADMIN_ONLY_ROUTES.some(r => pathname.startsWith(r))
    const isAuthenticatedAdminRoute = AUTHENTICATED_ADMIN_ROUTES.some(r => pathname.startsWith(r))

    // Any /admin route requires at least a privileged role. Stricter routes
    // (ADMIN_ONLY_ROUTES) require superadmin/admin; the rest also allow trafficker.
    if (isAdminOnlyRoute || isAuthenticatedAdminRoute) {
      let profile = null
      let profileUnavailable = false
      try {
        const { data, error } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single()
        profile = data
        // PGRST116 = "no rows": el perfil realmente no existe, sí degradamos.
        if (error && error.code !== 'PGRST116') profileUnavailable = true
      } catch (e) {
        console.error('[proxy] consulta de rol falló:', e)
        profileUnavailable = true
      }

      // Mismo criterio que arriba: si no pudimos leer el rol, no lo degradamos
      // a `viewer` — eso echaba del panel a admins legítimos ante cualquier
      // fallo transitorio de la base de datos.
      if (!profileUnavailable) {
        const role = profile?.role ?? 'viewer'
        const allowedRoles = isAdminOnlyRoute
          ? ['superadmin', 'admin']
          : ['superadmin', 'admin', 'trafficker']

        if (!allowedRoles.includes(role)) {
          const url = request.nextUrl.clone()
          url.pathname = '/dashboard'
          return NextResponse.redirect(url)
        }
      }
    }
  }

  return supabaseResponse
}
