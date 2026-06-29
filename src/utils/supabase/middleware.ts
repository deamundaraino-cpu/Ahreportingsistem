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

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
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

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname
  const isLoginPage = pathname.startsWith('/login')
  const isApiPage = pathname.startsWith('/api/')
  const isReportPage = pathname.startsWith('/report/')
  const isMirrorPage = pathname.startsWith('/p/')
  // report-utm: tracking links públicos + pixel JS estático
  const isTrackingLink = pathname.startsWith('/t/')
  const isPixelScript = pathname === '/report-utm-pixel.js'
  // Páginas legales públicas (requeridas por revisión de apps de Meta/TikTok)
  const isLegalPage = pathname === '/privacy' || pathname === '/terms'

  // 1. Redirect unauthenticated users to login
  if (!user && !isLoginPage && !isApiPage && !isReportPage && !isMirrorPage && !isTrackingLink && !isPixelScript && !isLegalPage) {
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
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

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

  return supabaseResponse
}
