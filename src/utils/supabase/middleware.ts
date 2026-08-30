import { createServerClient } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

// Routes only accessible by superadmin or admin
const ADMIN_ONLY_ROUTES = [
  '/admin/users',
  '/admin/api-tokens',
  '/admin/configuracion',
  '/admin/reports',
  '/admin/whatsapp',
];

// Routes accessible by superadmin, admin, and trafficker
const AUTHENTICATED_ADMIN_ROUTES = ['/admin/settings', '/admin/layouts'];

/**
 * Rutas `/api` que traen su propia credencial y por tanto NO deben exigir
 * sesión en el proxy. Todo lo que no esté aquí requiere sesión: una ruta nueva
 * nace protegida en vez de abierta.
 *
 *   - /api/cron, /api/worker  -> Bearer CRON_SECRET (`lib/cron-auth.ts`)
 *   - /api/v1, /api/mcp       -> Bearer token `ads_*` (`lib/api-token-auth.ts`)
 *   - /api/auth               -> flujos OAuth (el `state` es la credencial)
 *   - /api/health             -> sonda de disponibilidad
 *   - webhooks                -> HMAC del proveedor (`lib/report-utm/webhook-auth.ts`)
 *   - pixel                   -> ingesta pública desde sitios de cliente
 *   - bi/public/[token]       -> el token del informe compartido es la credencial
 */
const API_SELF_AUTH_PREFIXES = [
  '/api/cron/',
  '/api/worker',
  '/api/v1/',
  '/api/mcp',
  '/api/auth/',
  '/api/health',
  '/api/report-utm/webhooks/',
  '/api/report-utm/pixel/',
  '/api/report-utm/bi/public/',
  // El gateway de WhatsApp firma con HMAC: no tiene cookie de sesion y sin esto
  // el proxy lo rechazaria antes de llegar al handler.
  '/api/agent/whatsapp/',
];

/**
 * `GET /api/report-utm/clientes/<id>/goals` es público a propósito: devuelve
 * solo los objetivos numéricos saneados para pintarlos en informes embebidos.
 * El `PATCH` del mismo handler sí exige rol y lo comprueba por su cuenta.
 */
const PUBLIC_GOALS_RE = /^\/api\/report-utm\/clientes\/[^/]+\/goals\/?$/;

function isSelfAuthenticatedApi(pathname: string, method: string): boolean {
  if (API_SELF_AUTH_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (method === 'GET' && PUBLIC_GOALS_RE.test(pathname)) return true;
  return false;
}

// El proxy corre en TODAS las peticiones, así que una llamada lenta a Supabase
// Auth aquí tumba el dominio entero con MIDDLEWARE_INVOCATION_TIMEOUT (504).
// Cortamos la petición mucho antes del límite de la invocación para que un
// Supabase degradado se traduzca en "sesión no verificada" y no en un 504.
const AUTH_TIMEOUT_MS = 3_000;

/**
 * Rutas públicas que nunca consultan `user`: para ellas no vale la pena pagar
 * un round-trip a Supabase Auth. Son además las de más volumen (pixel y links
 * de tracking), las que más cargaban el proxy.
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith('/report/') || // reportes públicos de cliente
    pathname.startsWith('/p/') || // mirrors
    pathname.startsWith('/t/') || // report-utm: links de tracking
    pathname === '/report-utm-pixel.js' ||
    pathname === '/privacy' ||
    pathname === '/terms'
  );
}

/**
 * ¿Trae la petición una cookie de sesión de Supabase? Si no la trae, ya sabemos
 * que es anónima sin preguntarle a Supabase: nos ahorramos la llamada de red en
 * bots, crawlers y en los endpoints de cron (que autentican con Bearer).
 */
function hasAuthCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((c) => c.name.startsWith('sb-') && c.name.includes('auth-token'));
}

/** 401 en JSON: a una llamada de API se le responde, no se le redirige al login. */
function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (isPublicPath(pathname)) {
    return NextResponse.next({ request });
  }

  const isLoginPage = pathname.startsWith('/login');
  const isApiPage = pathname.startsWith('/api/');
  // Solo las rutas de API con credencial propia se saltan el gate de sesión.
  const isOpenApiPage = isApiPage && isSelfAuthenticatedApi(pathname, request.method);

  let supabaseResponse = NextResponse.next({
    request,
  });

  // Sin cookie de sesión no hay nada que refrescar ni que verificar.
  if (!hasAuthCookie(request)) {
    if (isApiPage) {
      return isOpenApiPage ? supabaseResponse : unauthorized();
    }
    if (!isLoginPage) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
    return supabaseResponse;
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
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // `authUnavailable` distingue "Supabase dice que no hay sesión" (denegar) de
  // "no pudimos preguntarle a Supabase" (no denegar). Tratar el segundo caso
  // como el primero expulsa al login a usuarios con sesión válida cada vez que
  // Auth tiene un hipo.
  // `getClaims()` en vez de `getUser()`: el proyecto firma los JWT con claves
  // asimétricas (ES256, publicadas en /auth/v1/.well-known/jwks.json), así que
  // la verificación es local con Web Crypto y NO hay round-trip al servidor de
  // Auth. Antes se pagaba esa petición de red en cada navegación autenticada,
  // dentro del proxy, es decir en el camino crítico de todas las páginas.
  // `getUser()` sigue siendo lo correcto donde haga falta el registro canónico
  // del usuario; aquí solo se decide si hay sesión y con qué id.
  let user: { id: string } | null = null;
  let authUnavailable = false;
  try {
    const { data, error } = await supabase.auth.getClaims();
    const sub = data?.claims?.sub;
    user = sub ? { id: sub } : null;
    // Errores de red/timeout (no un 401 legítimo por sesión inválida).
    if (error && (error.status === undefined || error.status >= 500)) {
      authUnavailable = true;
    }
  } catch (e) {
    console.error('[proxy] auth.getClaims falló:', e);
    authUnavailable = true;
  }

  // Con Auth caído dejamos pasar la petición: la página y las server actions
  // vuelven a verificar la sesión por su cuenta y las RLS siguen protegiendo
  // los datos, así que el proxy no es la única barrera. Preferimos degradar la
  // navegación antes que cerrar la sesión de todo el mundo.
  if (authUnavailable) {
    return supabaseResponse;
  }

  // Las rutas públicas (/report, /p, /t, pixel, legales) ya salieron arriba en
  // `isPublicPath`, así que aquí solo quedan /login, /api y el resto de la app.

  // 1. Sin usuario: la API responde 401 y el resto se va al login.
  if (!user) {
    if (isApiPage) {
      return isOpenApiPage ? supabaseResponse : unauthorized();
    }
    if (!isLoginPage) {
      const url = request.nextUrl.clone();
      url.pathname = '/login';
      return NextResponse.redirect(url);
    }
  }

  // 2. Redirect authenticated users away from login
  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  // 3. Role-based route protection for authenticated users
  if (user && pathname.startsWith('/admin')) {
    const isAdminOnlyRoute = ADMIN_ONLY_ROUTES.some((r) => pathname.startsWith(r));
    const isAuthenticatedAdminRoute = AUTHENTICATED_ADMIN_ROUTES.some((r) =>
      pathname.startsWith(r)
    );

    // Any /admin route requires at least a privileged role. Stricter routes
    // (ADMIN_ONLY_ROUTES) require superadmin/admin; the rest also allow trafficker.
    if (isAdminOnlyRoute || isAuthenticatedAdminRoute) {
      let profile = null;
      let profileUnavailable = false;
      try {
        const { data, error } = await supabase
          .from('user_profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        profile = data;
        // PGRST116 = "no rows": el perfil realmente no existe, sí degradamos.
        if (error && error.code !== 'PGRST116') profileUnavailable = true;
      } catch (e) {
        console.error('[proxy] consulta de rol falló:', e);
        profileUnavailable = true;
      }

      // Mismo criterio que arriba: si no pudimos leer el rol, no lo degradamos
      // a `viewer` — eso echaba del panel a admins legítimos ante cualquier
      // fallo transitorio de la base de datos.
      if (!profileUnavailable) {
        const role = profile?.role ?? 'viewer';
        const allowedRoles = isAdminOnlyRoute
          ? ['superadmin', 'admin']
          : ['superadmin', 'admin', 'trafficker'];

        if (!allowedRoles.includes(role)) {
          const url = request.nextUrl.clone();
          url.pathname = '/dashboard';
          return NextResponse.redirect(url);
        }
      }
    }
  }

  return supabaseResponse;
}
