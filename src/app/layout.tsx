import type { Metadata, Viewport } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { getBranding, colorSeguro, urlLogoSegura } from "@/lib/branding";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getBranding();
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
  const branding = await getBranding();

  // Los tres valores se validan antes de entrar en el `<style>`: son texto
  // editable por un admin y acaban dentro de una hoja de estilos inline, así
  // que un valor con `;` o `)` podría reescribir el CSS de toda la app.
  const primaryColor = colorSeguro(branding?.colors?.primary);
  const secondaryColor = colorSeguro(branding?.colors?.secondary);
  const logoUrl = urlLogoSegura(branding?.logo_url);
  const hasCustomLogo = !!logoUrl;
  const hasBrandingCss = !!(primaryColor || secondaryColor || logoUrl);

  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        {hasBrandingCss && (
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
