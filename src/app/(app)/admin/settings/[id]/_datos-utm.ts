import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { reportUtmClient } from '@/lib/report-utm/client';
import { createClient, createAdminClient } from '@/utils/supabase/server';
import type { ReportUtmIntegration } from '@/lib/report-utm/types';
import type { ClienteGoals } from '@/lib/report-utm/bi-metadata';
import { monedaDeClienteUtm, ultimasTasasGuardadas } from '@/lib/moneda-reporte';
import type { MonedaReporte, TasaGuardada } from '@/lib/moneda-reporte';
import {
  columnaExcluidoDisponible,
  leerRegla,
  type ReglaExclusion,
} from '@/lib/report-utm/lead-exclusion';

type Integ = Pick<ReportUtmIntegration, 'id' | 'status' | 'config' | 'last_sync_at' | 'last_error'>;
type IntegS2S = Pick<
  ReportUtmIntegration,
  'id' | 'cliente_id' | 'status' | 'last_sync_at' | 'last_error'
>;

export interface DatosUtm {
  metaLeads: Integ | null;
  metaCapi: Integ | null;
  googleAds: Integ | null;
  ghl: Integ | null;
  s2s: IntegS2S | null;
  hotmart: ReportUtmIntegration | null;
  outbound: unknown[];
  metaConnected: boolean;
  webhookOrigin: string;
  /** Slug del cliente en report_utm: es lo que se pega en el plugin de WordPress. */
  slug: string | null;
  moneda: MonedaReporte;
  ultimasTasas: Partial<Record<MonedaReporte, TasaGuardada>>;
  reglaExclusion: ReglaExclusion;
  migracionExclusion: boolean;
  goals: ClienteGoals;
  logoUrl?: string;
  accent?: string;
}

/**
 * Todo lo que la ficha del cliente necesita del lado de Report-UTM, en una sola
 * tanda.
 *
 * Antes estas consultas vivían repartidas entre `ConexionesCliente` y la ficha
 * de `/report-utm/clientes/[clienteId]`, que era la otra mitad de la misma
 * pantalla. Al quedar una sola ficha se cargan juntas: son siete integraciones,
 * la moneda, la regla de exclusión y las metas, y todas cuelgan del mismo
 * cliente espejo.
 *
 * `cache()` de React evita repetirlas si dos partes del árbol las piden en el
 * mismo render, igual que hace `lib/auth-session.ts`.
 */
export const cargarDatosUtm = cache(
  async (rtmClienteId: string, publicClienteId: string | null): Promise<DatosUtm> => {
    const supabase = await reportUtmClient();
    const admin = await createAdminClient();
    const sel = 'id, status, config, last_sync_at, last_error';
    const integ = (tipo: string, cols = sel) =>
      supabase
        .from('integrations')
        .select(cols)
        .eq('cliente_id', rtmClienteId)
        .eq('tipo', tipo)
        .maybeSingle();

    const [
      { data: cliente },
      { data: hotmart },
      { data: metaCapi },
      { data: googleAds },
      { data: s2s },
      { data: metaLeads },
      { data: ghl },
      { data: outbound },
      moneda,
      ultimasTasas,
      migracionExclusion,
    ] = await Promise.all([
      supabase.from('clientes').select('slug, config').eq('id', rtmClienteId).maybeSingle(),
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
      monedaDeClienteUtm(admin, rtmClienteId),
      // `fx_rates` vive en `public`: el cliente de arriba es el de report_utm.
      ultimasTasasGuardadas(admin),
      columnaExcluidoDisponible(supabase),
    ]);

    // ¿Meta conectado? Token + cuenta en `public.clientes.config_api`: es la
    // precondición de Meta Lead Ads, que se configura en la misma pantalla.
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

    const config = ((cliente as { config?: Record<string, unknown> } | null)?.config ??
      {}) as Record<string, unknown>;

    return {
      metaLeads: (metaLeads as Integ | null) ?? null,
      metaCapi: (metaCapi as Integ | null) ?? null,
      googleAds: (googleAds as Integ | null) ?? null,
      ghl: (ghl as Integ | null) ?? null,
      s2s: (s2s as IntegS2S | null) ?? null,
      hotmart: hotmart ?? null,
      outbound: outbound ?? [],
      metaConnected,
      webhookOrigin: `${proto}://${host}`,
      slug: (cliente as { slug?: string } | null)?.slug ?? null,
      moneda,
      ultimasTasas,
      reglaExclusion: leerRegla(config),
      migracionExclusion,
      goals: (config.goals ?? {}) as ClienteGoals,
      logoUrl: typeof config.logo_url === 'string' ? config.logo_url : undefined,
      accent: typeof config.accent === 'string' ? config.accent : undefined,
    };
  }
);
