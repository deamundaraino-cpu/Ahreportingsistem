import { AppSidebar } from '@/components/layout/AppSidebar';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { ReactNode } from 'react';
import { Toaster } from 'sonner';
import { getBranding } from '@/lib/branding';
import { getSesionActual } from '@/lib/auth-session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Sesión y rol resueltos una sola vez por petición (`lib/auth-session.ts`).
  const { userId, role } = await getSesionActual();

  // Una sola lectura cacheada en vez de repetir la consulta al service role
  // en cada layout (`lib/branding.ts`).
  const branding = await getBranding();

  const appName = branding?.app_name || 'AdsHouse';
  const appTag = branding?.app_tag || 'Reporting';

  return (
    <div className="flex min-h-screen bg-background text-foreground font-sans selection:bg-brand-blue/20">
      {/* Ambient background glows — brand colors, very subtle */}
      <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] ambient-glow-red" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] ambient-glow-blue" />
      </div>

      <AppSidebar initialRole={role} appName={appName} appTag={appTag} />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col relative w-full transition-all duration-300 ease-in-out lg:ml-64">
        {/*
                  Un solo topbar responsive. Antes eran dos headers (uno
                  `hidden lg:flex`, otro `lg:hidden`) y cada uno montaba su
                  propia <NotificationBell>: las dos instancias hidrataban,
                  las dos lanzaban sus dos server actions y las dos abrían un
                  canal de Realtime. Cuatro round-trips y dos websockets por
                  carga de página autenticada, para pintar una campana.
                */}
        <header className="h-14 border-b border-border flex items-center justify-between lg:justify-end px-4 lg:px-6 bg-background/80 backdrop-blur-md sticky top-0 z-30">
          {/* Marca: solo en móvil (en escritorio la lleva el sidebar).
                        El hueco de la izquierda mantiene el título centrado. */}
          <span className="w-9 lg:hidden" aria-hidden />
          <span className="text-base font-bold tracking-tight text-foreground default-logo-element lg:hidden">
            {appName}
          </span>
          {/* Custom logo container */}
          <div
            className="custom-logo-container hidden h-8 w-32 lg:!hidden"
            style={{
              backgroundImage: 'var(--brand-logo-url)',
              backgroundSize: 'contain',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
            }}
          />
          {userId ? <NotificationBell userId={userId} /> : <span className="w-9" aria-hidden />}
        </header>

        {/* Dynamic Page Content Wrapper */}
        <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 pt-6 pb-24 lg:pb-8 animate-in fade-in duration-300">
          {children}
        </main>
      </div>

      <Toaster richColors position="top-right" />
    </div>
  );
}
