import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Content-Security-Policy.
// Kept intentionally permissive on script/style because the App Router relies on
// inline scripts for hydration and Recharts/Tailwind emit inline styles. We still
// lock down object/base/form targets and restrict who can frame the app.
// `frame-ancestors 'self'` is overridden for public report routes below.
const cspBase = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // Supabase REST + realtime y las APIs externas que el navegador llama de
    // verdad. Antes esto terminaba en un `https:` suelto, que permitía mandar
    // datos a cualquier host y dejaba la CSP sin valor como control de
    // exfiltración. Las integraciones server-side (Google, Hotmart, TikTok…) no
    // van aquí: las hace el servidor, no el navegador.
    [
        "connect-src 'self'",
        "https://*.supabase.co",
        "wss://*.supabase.co",
        "https://graph.facebook.com",
        "https://open.er-api.com",
    ].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
];

// Security headers applied to every response.
const baseSecurityHeaders = [
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
    compress: true,
    poweredByHeader: false,
    serverExternalPackages: [
        '@google-analytics/data',
        'google-auth-library',
        'google-spreadsheet',
    ],
    experimental: {
        // Estos paquetes se importan como barril en decenas de archivos
        // (`lucide-react` llega a 26 iconos en una sola línea). Hoy el
        // tree-shaking funciona por defecto del bundler; declararlo lo vuelve
        // explícito en vez de accidental.
        optimizePackageImports: [
            'lucide-react',
            'date-fns',
            'recharts',
            'radix-ui',
            '@dnd-kit/core',
            '@dnd-kit/sortable',
        ],
    },
    async headers() {
        return [
            // Public, shareable/embeddable report routes: no frame restrictions so
            // clients can embed them in their own portals.
            {
                source: "/p/:path*",
                headers: [
                    ...baseSecurityHeaders,
                    { key: "Content-Security-Policy", value: [...cspBase, "frame-ancestors *"].join("; ") },
                ],
            },
            {
                source: "/report/:path*",
                headers: [
                    ...baseSecurityHeaders,
                    { key: "Content-Security-Policy", value: [...cspBase, "frame-ancestors *"].join("; ") },
                ],
            },
            // Everything else: deny framing to prevent clickjacking.
            {
                source: "/:path*",
                headers: [
                    ...baseSecurityHeaders,
                    { key: "X-Frame-Options", value: "SAMEORIGIN" },
                    { key: "Content-Security-Policy", value: [...cspBase, "frame-ancestors 'self'"].join("; ") },
                ],
            },
        ];
    },
};

export default nextConfig;
