import { getMirrorDashboardData } from '@/app/(app)/dashboard/_actions';
import { getPublicBitacoras } from '@/app/(app)/admin/settings/[id]/_actions';
import { DashboardClient } from '@/app/(app)/dashboard/components/DashboardClient';
import { DateRangeSelector } from '@/app/(app)/dashboard/components/DateRangeSelector';
import { BitacorasPublicas } from './components/BitacorasPublicas';
import { notFound } from 'next/navigation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

export const dynamic = 'force-dynamic';

export default async function PublicMirrorPage({ params, searchParams }: any) {
  const { token } = await params;
  const { from, to, search } = await searchParams;

  const [{ data, error }, bitacoras] = await Promise.all([
    getMirrorDashboardData(token, from, to),
    getPublicBitacoras(token),
  ]);

  if (error || !data) {
    return notFound();
  }

  const keyword = typeof search === 'string' ? search : '';

  // Personalización por cliente (clientes.layout_publico.branding): logo,
  // color de acento y textos. Sin configurar, cae al encabezado por defecto.
  const publicConfig = (data.cliente.layout_publico ?? {}) as {
    branding?: { logo_url?: string; accent?: string; title?: string; welcome_text?: string };
  };
  const branding = publicConfig.branding ?? {};
  const accent = branding.accent || '#3b82f6';

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Public Mirror View - No sidebar, just the dashboard */}
      <header
        className="border-b border-border bg-background/50 backdrop-blur-md sticky top-0 z-50"
        style={{ borderTop: `3px solid ${accent}` }}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {branding.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={branding.logo_url}
                alt={data.cliente.nombre}
                className="h-9 w-auto max-w-[160px] object-contain"
              />
            )}
            <div>
              <h1 className="text-xl font-bold text-foreground">
                {branding.title ? (
                  branding.title
                ) : (
                  <span className="flex items-center gap-2">
                    AdsHouse <span className="text-muted-foreground/70 font-normal">|</span>{' '}
                    <span style={{ color: accent }}>Mirror</span>
                  </span>
                )}
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Reporte de: {data.cliente.nombre}
              </p>
            </div>
          </div>

          <div className="flex flex-1 items-center justify-end gap-4">
            <DateRangeSelector basePath="/p" isPublic={true} />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 sm:p-6 lg:p-8">
        {branding.welcome_text && (
          <div
            className="mb-6 rounded-2xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground whitespace-pre-line"
            style={{ borderLeft: `3px solid ${accent}` }}
          >
            {branding.welcome_text}
          </div>
        )}
        <DashboardClient
          data={data}
          isPublic={true}
          initialTabId={data.activeTabId}
          initialKeyword={keyword}
        />
        {bitacoras.length > 0 && <BitacorasPublicas entries={bitacoras} />}
      </main>
    </div>
  );
}
