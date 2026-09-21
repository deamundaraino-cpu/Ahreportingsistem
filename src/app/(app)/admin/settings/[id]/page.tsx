import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getCliente, getLayouts, getGoogleConnectionStatus } from '../_actions';
import { ClientConfigForm } from '../components/ClientConfigForm';
import { createAdminClient } from '@/utils/supabase/server';
import { asegurarEspejoUtm } from '@/lib/clientes/ciclo-de-vida';
import { cargarDatosUtm } from './_datos-utm';
import { MetaLeadsCard } from '@/components/report-utm/MetaLeadsCard';
import { MetaCAPICard } from '@/components/report-utm/MetaCAPICard';
import { GhlLeadsCard } from '@/components/report-utm/GhlLeadsCard';
import { HotmartIntegrationCard } from '@/components/report-utm/HotmartIntegrationCard';
import { GoogleAdsCard } from '@/components/report-utm/GoogleAdsCard';
import { S2SIntegrationCard } from '@/components/report-utm/S2SIntegrationCard';
import { OutboundWebhooksCard } from '@/components/report-utm/OutboundWebhooksCard';
import { MonedaReporteCard } from '@/components/report-utm/MonedaReporteCard';
import { FiltroAtribucionCard } from '@/components/report-utm/FiltroAtribucionCard';
import { LeadCamposCard } from '@/components/report-utm/LeadCamposCard';
import { BiClienteGoalsCard } from '@/components/report-utm/BiClienteGoalsCard';
import { BiClienteBrandingCard } from '@/components/report-utm/BiClienteBrandingCard';

/**
 * La ficha del cliente: una sola pantalla, con una pestaña por plataforma.
 *
 * Configurar un cliente eran dos sitios —aquí las credenciales de Meta, GA4,
 * Hotmart y TikTok; en Report-UTM la captación de leads, la moneda, las metas y
 * el branding—, y para activar Meta Lead Ads en uno había que haber conectado
 * Meta en el otro. Ahora todo cuelga de esta página.
 *
 * Las tarjetas de captación son componentes de cliente, así que se construyen
 * aquí, con sus datos ya resueltos, y bajan al formulario como `slots`. Pasarlas
 * como props y no por `import` es lo que evita arrastrarlas al bundle del
 * navegador a través de un componente `'use client'`.
 */
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

  // El cliente de Report-UTM es el espejo de este; si por algo no existe, se crea.
  const espejo = await asegurarEspejoUtm(await createAdminClient(), cliente.id, cliente.nombre);
  const rtmId = espejo.id;
  const datos = rtmId ? await cargarDatosUtm(rtmId, cliente.id) : null;

  const slots =
    rtmId && datos
      ? {
          general: (
            <>
              <MonedaReporteCard
                rtmClienteId={rtmId}
                inicial={datos.moneda}
                ultimasTasas={datos.ultimasTasas}
              />
              <BiClienteGoalsCard clienteId={rtmId} initialGoals={datos.goals} />
              <BiClienteBrandingCard
                clienteId={rtmId}
                initialLogoUrl={datos.logoUrl}
                initialAccent={datos.accent}
              />
            </>
          ),
          meta: (
            <>
              <MetaLeadsCard
                clienteId={rtmId}
                integration={datos.metaLeads}
                metaConnected={datos.metaConnected}
              />
              <MetaCAPICard clienteId={rtmId} integration={datos.metaCapi} />
            </>
          ),
          google: <GoogleAdsCard clienteId={rtmId} integration={datos.googleAds} />,
          hotmart: (
            <HotmartIntegrationCard
              clienteId={rtmId}
              integration={datos.hotmart}
              webhookOrigin={datos.webhookOrigin}
            />
          ),
          crm: (
            <>
              <GhlLeadsCard
                clienteId={rtmId}
                integration={datos.ghl}
                webhookOrigin={datos.webhookOrigin}
              />
              <S2SIntegrationCard
                clienteId={rtmId}
                integration={datos.s2s}
                slug={datos.slug}
                baseUrl={datos.webhookOrigin}
              />
              <OutboundWebhooksCard
                clienteId={rtmId}
                webhooks={datos.outbound as Parameters<typeof OutboundWebhooksCard>[0]['webhooks']}
              />
              {/* Qué leads cuentan y cómo se nombran sus campos: son las reglas
                  que aplican a todo lo que entra por las conexiones de arriba. */}
              <FiltroAtribucionCard
                clienteId={rtmId}
                inicial={datos.reglaExclusion}
                migracionAplicada={datos.migracionExclusion}
              />
              <LeadCamposCard clienteId={rtmId} />
            </>
          ),
        }
      : undefined;

  return (
    <div className="max-w-4xl mx-auto py-6">
      {!rtmId && (
        <p className="mb-6 text-xs text-amber-600">
          No se pudo preparar el cliente en Report-UTM: {espejo.error}. Las conexiones de captación
          no estarán disponibles.
        </p>
      )}
      {/* `useSearchParams` del formulario (lee el resultado del OAuth y la
          pestaña activa) necesita un límite de Suspense para que el build no
          dependa de que esta ruta siga siendo dinámica. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">Cargando configuración…</p>}>
        <ClientConfigForm
          cliente={cliente}
          layouts={layouts}
          isAdmin={true}
          googleConnected={google.connected}
          googleEmail={google.email}
          slots={slots}
        />
      </Suspense>
    </div>
  );
}
