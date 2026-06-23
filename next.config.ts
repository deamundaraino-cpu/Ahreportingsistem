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
    // Supabase REST + realtime, plus the external APIs the dashboard talks to.
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https:",
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
