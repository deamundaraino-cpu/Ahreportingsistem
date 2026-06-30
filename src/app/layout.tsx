import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { createAdminClient } from "@/utils/supabase/server";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  let branding: { app_name?: string; app_tag?: string; utm_name?: string; utm_tag?: string; logo_url?: string; favicon_url?: string; colors?: { primary?: string; secondary?: string } } | null = null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      const supabase = await createAdminClient();
      const { data } = await supabase.from('system_settings').select('value').eq('key', 'branding').single();
      branding = data?.value;
    } catch (e) {
      console.error('Failed to load branding in generateMetadata:', e);
    }
  }
  const appName = branding?.app_name || "AdsHouse";
  const appTag = branding?.app_tag || "Reporting";
  // Favicon personalizado del branding; si no hay, se usa /favicon.ico (public).
  // Importante: ya NO existe src/app/favicon.ico porque la convención de archivo
  // tiene prioridad sobre este campo `icons` y bloquearía el favicon personalizado.
  const faviconUrl = branding?.favicon_url?.trim() || "/favicon.ico";
  return {
    title: `${appName} ${appTag}`,
    description: "Panel de Reportes de Meta Ads y Hotmart",
    icons: {
      icon: faviconUrl,
      shortcut: faviconUrl,
      apple: faviconUrl,
    },
  };
}


export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f8f8" },
    { media: "(prefers-color-scheme: dark)", color: "#151515" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let branding: { logo_url?: string; colors?: { primary?: string; secondary?: string } } | null = null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    try {
      const supabase = await createAdminClient();
      const { data } = await supabase.from('system_settings').select('value').eq('key', 'branding').single();
      branding = data?.value;
    } catch (e) {
      console.error('Failed to load branding from database:', e);
    }
  }

  const primaryColor = branding?.colors?.primary;
  const secondaryColor = branding?.colors?.secondary;
  const logoUrl = branding?.logo_url;
  const hasCustomLogo = !!logoUrl;

  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {branding && (
          <style dangerouslySetInnerHTML={{ __html: `
            :root {
              ${primaryColor ? `--brand-blue: ${primaryColor} !important;` : ''}
              ${primaryColor ? `--brand-blue-light: color-mix(in srgb, var(--brand-blue) 85%, white) !important;` : ''}
              ${primaryColor ? `--brand-blue-muted: color-mix(in srgb, var(--brand-blue) 12%, transparent) !important;` : ''}
              
              ${primaryColor ? `--brand-emerald: ${primaryColor} !important;` : ''}
              ${primaryColor ? `--brand-emerald-light: color-mix(in srgb, var(--brand-emerald) 85%, white) !important;` : ''}
              ${primaryColor ? `--brand-emerald-muted: color-mix(in srgb, var(--brand-emerald) 12%, transparent) !important;` : ''}
              
              ${secondaryColor ? `--brand-red: ${secondaryColor} !important;` : ''}
              ${secondaryColor ? `--brand-red-light: color-mix(in srgb, var(--brand-red) 85%, white) !important;` : ''}
              ${secondaryColor ? `--brand-red-muted: color-mix(in srgb, var(--brand-red) 12%, transparent) !important;` : ''}
              
              ${secondaryColor ? `--brand-violet: ${secondaryColor} !important;` : ''}
              ${secondaryColor ? `--brand-violet-light: color-mix(in srgb, var(--brand-violet) 85%, white) !important;` : ''}
              ${secondaryColor ? `--brand-violet-muted: color-mix(in srgb, var(--brand-violet) 12%, transparent) !important;` : ''}
              
              ${logoUrl ? `--brand-logo-url: url('${logoUrl}') !important;` : ''}
            }
          `}} />
        )}
      </head>
      <body
        className={`${geistSans.variable} ${jetbrainsMono.variable} antialiased ${hasCustomLogo ? 'has-custom-logo' : ''}`}
        suppressHydrationWarning
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

