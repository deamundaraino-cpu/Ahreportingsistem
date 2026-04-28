import { createServerClient } from "@supabase/ssr"
import { NextRequest, NextResponse } from "next/server"

// Routes only accessible by superadmin or admin
const ADMIN_ONLY_ROUTES = [
  '/admin/users',
  '/admin/api-tokens',
  '/admin/reports',
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

  // 1. Redirect unauthenticated users to login
  if (!user && !isLoginPage && !isApiPage && !isReportPage && !isMirrorPage) {
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

    if (isAdminOnlyRoute) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()

      const role = profile?.role ?? 'viewer'
      if (!['superadmin', 'admin'].includes(role)) {
        const url = request.nextUrl.clone()
        url.pathname = '/dashboard'
        return NextResponse.redirect(url)
      }
    }
  }

  return supabaseResponse
}
