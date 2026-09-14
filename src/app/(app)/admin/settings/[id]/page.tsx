import { getCliente, getLayouts, getGoogleConnectionStatus } from '../_actions';
import { ClientConfigForm } from '../components/ClientConfigForm';
import { redirect } from 'next/navigation';
import { PlugZap } from 'lucide-react';
import { createAdminClient } from '@/utils/supabase/server';
import { asegurarEspejoUtm } from '@/lib/clientes/ciclo-de-vida';
import { ConexionesCliente } from '@/components/report-utm/ConexionesCliente';
import { MonedaReporteCard } from '@/components/report-utm/MonedaReporteCard';
import { monedaDeClienteUtm, ultimasTasasGuardadas } from '@/lib/moneda-reporte';

export default async function ClientDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;

  const [cliente, layouts, google] = await Promise.all([
    getCliente(params.id),
    getLayouts(),
    // Determina si GA4/Sheets pueden usar el OAuth de agencia (sin Service Account).
    getGoogleConnectionStatus(),
  ]);

  if (!cliente) {
    redirect('/admin/settings');
  }

  // Una sola casa (reunión del 2026-09-08): las conexiones de captación y
  // atribución se configuran AQUÍ, junto a Meta, GA4, Hotmart y TikTok. El
  // cliente de Report-UTM es el espejo de este; si por algo no existe, se crea.
  const utmActivo = process.env.NEXT_PUBLIC_REPORT_UTM_ENABLED === 'true';
  const espejo = utmActivo
    ? await asegurarEspejoUtm(await createAdminClient(), cliente.id, cliente.nombre)
    : null;

  return (
    <div className="max-w-3xl mx-auto py-6 space-y-10">
      <ClientConfigForm
        cliente={cliente}
        layouts={layouts}
        isAdmin={true}
        googleConnected={google.connected}
        googleEmail={google.email}
      />

      {espejo?.id && (
        <section id="conexiones" className="space-y-4 scroll-mt-6">
          <div>
            <div className="flex items-center gap-2">
              <PlugZap className="h-5 w-5 text-emerald-500" />
              <h2 className="text-xl font-bold text-foreground">Captación y atribución de leads</h2>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Formularios instantáneos de Meta, GoHighLevel, webhook de Hotmart, conversiones (CAPI
              / Google Ads) y formulario web. Lo que conectes aquí alimenta los leads, el cruce con
              campañas y los informes de Report-UTM.
            </p>
          </div>
          <MonedaReporteCard
            rtmClienteId={espejo.id}
            inicial={await monedaDeClienteUtm(await createAdminClient(), espejo.id)}
            ultimasTasas={await ultimasTasasGuardadas(await createAdminClient())}
          />
          <ConexionesCliente rtmClienteId={espejo.id} publicClienteId={cliente.id} />
        </section>
      )}
      {espejo && !espejo.id && (
        <p className="text-xs text-amber-600">
          No se pudo preparar el cliente en Report-UTM: {espejo.error}
        </p>
      )}
    </div>
  );
}
