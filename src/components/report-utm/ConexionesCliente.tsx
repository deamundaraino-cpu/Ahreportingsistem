import { headers } from 'next/headers';
import { reportUtmClient } from '@/lib/report-utm/client';
import { createClient } from '@/utils/supabase/server';
import type { ReportUtmIntegration } from '@/lib/report-utm/types';
import { HotmartIntegrationCard } from '@/components/report-utm/HotmartIntegrationCard';
import { GoogleAdsCard } from '@/components/report-utm/GoogleAdsCard';
import { MetaCAPICard } from '@/components/report-utm/MetaCAPICard';
import { MetaLeadsCard } from '@/components/report-utm/MetaLeadsCard';
import { GhlLeadsCard } from '@/components/report-utm/GhlLeadsCard';
import { S2SIntegrationCard } from '@/components/report-utm/S2SIntegrationCard';
import { OutboundWebhooksCard } from '@/components/report-utm/OutboundWebhooksCard';

type Integ = Pick<ReportUtmIntegration, 'id' | 'status' | 'config' | 'last_sync_at' | 'last_error'>;

/**
 * Las conexiones de captación y atribución de un cliente, en un solo bloque.
 *
 * Antes vivían solo en la ficha de Report-UTM, y las de reporting solo en
 * `/admin/settings/[id]`: dar de alta un cliente eran dos pantallas, y para
 * activar Meta Lead Ads en una había que haber conectado Meta en la otra
 * (reunión del 2026-09-08, «configurar el mismo cliente en dos lugares»).
 *
 * Este componente es el MISMO en los dos sitios. En la ficha del reporting va
 * justo después de Meta, GA4, Hotmart y TikTok, y la ficha de Report-UTM lo
 * enlaza. Las tarjetas son las de siempre: cada una guarda con sus propias
 * acciones de servidor, así que no hay una segunda copia de ninguna lógica.
 *
 * El orden sigue el flujo real de un alta: primero lo que depende de Meta
 * (formularios instantáneos, CAPI), luego el CRM, las ventas y el resto.
 */
export async function ConexionesCliente({
  rtmClienteId,
  publicClienteId,
}: {
  /** Cliente de `report_utm.clientes`. */
  rtmClienteId: string;
  /** Cliente de `public.clientes`, si está enlazado. Solo para saber si Meta está conectado. */
  publicClienteId: string | null;
}) {
  const supabase = await reportUtmClient();
  const sel = 'id, status, config, last_sync_at, last_error';
  const integ = (tipo: string, cols = sel) =>
    supabase
      .from('integrations')
      .select(cols)
      .eq('cliente_id', rtmClienteId)
      .eq('tipo', tipo)
      .maybeSingle();

  const [
    { data: hotmart },
    { data: meta },
    { data: google },
    { data: s2s },
    { data: metaLeads },
    { data: ghl },
    { data: outbound },
  ] = await Promise.all([
    supabase
      .from('integrations')
      .select('*')
      .eq('cliente_id', rtmClienteId)
      .eq('tipo', 'hotmart')
      .maybeSingle<ReportUtmIntegration>(),
    integ('meta'),
    integ('google'),
    integ('s2s', 'id, cliente_id, status, last_sync_at, last_error'),
    integ('meta_lead_ads'),
    integ('gohighlevel'),
    supabase
      .from('outbound_webhooks')
      .select(
        'id, nombre, url, event_types, enabled, last_fired_at, last_status, last_error, success_count, failure_count'
      )
      .eq('cliente_id', rtmClienteId)
      .order('created_at', { ascending: false }),
  ]);

  // ¿Meta conectado? Token + cuenta en `public.clientes.config_api`: es la
  // precondición de Meta Lead Ads, que ahora se ve en la misma pantalla.
  let metaConnected = false;
  if (publicClienteId) {
    const base = await createClient();
    const { data: pub } = await base
      .from('clientes')
      .select('config_api')
      .eq('id', publicClienteId)
      .maybeSingle();
    const cfg = (pub?.config_api ?? {}) as Record<string, unknown>;
    const metaAccounts = cfg.meta_accounts;
    const hasAccounts =
      Array.isArray(metaAccounts) &&
      (metaAccounts as Array<Record<string, unknown>>).some(
        (a) => a?.account_id && (a.token || cfg.meta_token)
      );
    metaConnected = hasAccounts || Boolean(cfg.meta_token && cfg.meta_account_id);
  }

  const hdrs = await headers();
  const proto = hdrs.get('x-forwarded-proto') ?? 'http';
  const host = hdrs.get('x-forwarded-host') ?? hdrs.get('host') ?? 'localhost:3000';
  const webhookOrigin = `${proto}://${host}`;

  return (
    <div className="space-y-6">
      <MetaLeadsCard
        clienteId={rtmClienteId}
        integration={(metaLeads as Integ | null) ?? null}
        metaConnected={metaConnected}
      />
      <MetaCAPICard clienteId={rtmClienteId} integration={(meta as Integ | null) ?? null} />
      <GhlLeadsCard
        clienteId={rtmClienteId}
        integration={(ghl as Integ | null) ?? null}
        webhookOrigin={webhookOrigin}
      />
      <HotmartIntegrationCard
        clienteId={rtmClienteId}
        integration={hotmart}
        webhookOrigin={webhookOrigin}
      />
      <GoogleAdsCard clienteId={rtmClienteId} integration={(google as Integ | null) ?? null} />
      <S2SIntegrationCard
        clienteId={rtmClienteId}
        integration={
          (s2s as Pick<
            ReportUtmIntegration,
            'id' | 'cliente_id' | 'status' | 'last_sync_at' | 'last_error'
          > | null) ?? null
        }
      />
      <OutboundWebhooksCard
        clienteId={rtmClienteId}
        webhooks={(outbound ?? []) as Parameters<typeof OutboundWebhooksCard>[0]['webhooks']}
      />
    </div>
  );
}
