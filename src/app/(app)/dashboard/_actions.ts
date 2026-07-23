'use server';

import { createAdminClient, createClient } from '@/utils/supabase/server';
import { notifyUsers } from '@/lib/notifications/notify';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import { getWeeksInRange } from '@/lib/date-utils';
import { revalidatePath } from 'next/cache';
import { format, addDays } from 'date-fns';
import { headers } from 'next/headers';
import { after } from 'next/server';

/** Días por debajo de los cuales el sync se ejecuta al momento en vez de encolarse. */
const SYNC_DIRECTO_MAX_DIAS = 7;

/**
 * Lanza la sincronización de un cliente para un rango.
 *
 * Rangos cortos van directos al worker (el usuario ve el resultado al instante).
 * Los largos se encolan en `sync_jobs`: Hotmart y GA4 se consultan día a día, así
 * que un rango de meses no cabe en los 60s de una función de Vercel — antes la
 * petición simplemente moría y el usuario no se enteraba de que faltaban datos.
 */
export async function triggerWorkerSync(clientId: string, from: string, to: string) {
  if (!clientId || !from || !to) {
    return { ok: false, error: 'Parámetros inválidos', platform_status: null };
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return { ok: false, error: 'CRON_SECRET no configurado en el servidor', platform_status: null };
  }

  const h = await headers();
  const host = h.get('host');
  const proto = h.get('x-forwarded-proto') || (host?.startsWith('localhost') ? 'http' : 'https');
  if (!host) {
    return { ok: false, error: 'No se pudo determinar el host', platform_status: null };
  }
  const base = `${proto}://${host}`;

  const dias = Math.floor(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000
  ) + 1;

  // ─── Rango largo: a la cola ───
  if (!Number.isFinite(dias) || dias > SYNC_DIRECTO_MAX_DIAS) {
    try {
      const res = await fetch(`${base}/api/worker/enqueue`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo: 'metricas',
          cliente_id: clientId,
          start: from,
          end: to,
          prioridad: 1,
          triggered_by: 'dashboard',
        }),
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data?.error || `HTTP ${res.status}`, platform_status: null };
      }

      // Empujón inmediato al ejecutor de respaldo para no esperar al poll del VPS.
      after(async () => {
        await fetch(`${base}/api/worker/run-jobs`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}` },
          cache: 'no-store',
        }).catch((e) => console.error('[sync] run-jobs push failed', e));
      });

      return {
        ok: true,
        queued: true,
        jobs: data?.encolados ?? 0,
        platform_status: null,
        message: `${data?.encolados ?? 0} tarea(s) en cola — el sync continúa en segundo plano.`,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Error de red', platform_status: null };
    }
  }

  // ─── Rango corto: directo ───
  const url = `${base}/api/worker?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&client_id=${encodeURIComponent(clientId)}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      cache: 'no-store',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error || `HTTP ${res.status}`, platform_status: null };
    }
    const firstResult = Array.isArray(data?.results) ? data.results[0] : null;
    return {
      ok: true,
      queued: false,
      partial: !!data?.partial,
      platform_status: firstResult?.platform_status ?? null,
      message: data?.partial ? 'Sincronización parcial: el resto continúa en segundo plano.' : undefined,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Error de red', platform_status: null };
  }
}

/** Estado de la cola para un cliente — alimenta el indicador de progreso del dashboard. */
export async function getSyncJobsStatus(clienteId: string) {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('sync_jobs')
    .select('id, tipo, fecha_inicio, fecha_fin, estado, intentos, last_error, updated_at')
    .eq('cliente_id', clienteId)
    .in('estado', ['pending', 'running', 'error'])
    .order('created_at', { ascending: true })
    .limit(50);

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

/** Frescura de los datos de un cliente: última verificación global y por fuente. */
export async function getDataFreshness(clienteId: string) {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('metricas_diarias')
    .select('fecha, synced_at, source_synced_at, is_partial')
    .eq('cliente_id', clienteId)
    .order('synced_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function getLeadsDiarios(clientId: string) {
  const supabase = await createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('leads_diarios')
    .select('*')
    .eq('client_id', clientId)
    .gte('date', thirtyDaysAgo)
    .lte('date', today)
    .order('date', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function getConversionesOfflineDiarias(clientId: string) {
  const supabase = await createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('conversiones_offline_diarias')
    .select('*')
    .eq('cliente_id', clientId)
    .gte('fecha', thirtyDaysAgo)
    .lte('fecha', today)
    .order('fecha', { ascending: true });

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function getDashboardData(clientId: string, startStr: string, endStr: string) {
  const supabase = await createAdminClient();

  // Fetch client + global assigned layout + client tabs + conversions catalog + campaign groups + all layout templates
  const [clienteRes, clienteLayoutRes, tabsRes, conversionesRes, campaignGroupsRes, allLayoutsRes, tabTemplatesRes] =
    await Promise.all([
      supabase
        .from('clientes')
        .select('*, global_layout:layouts_reporte(*)')
        .eq('id', clientId)
        .limit(1),
      supabase.from('clientes_layouts').select('*').eq('cliente_id', clientId).maybeSingle(),
      supabase
        .from('cliente_tabs')
        .select('*')
        .eq('cliente_id', clientId)
        .order('orden', { ascending: true }),
      supabase
        .from('meta_conversiones_catalogo')
        .select('conversion_key, label, field_id')
        .eq('cliente_id', clientId)
        .order('label', { ascending: true }),
      supabase
        .from('campaign_groups')
        .select(
          `
                *,
                campaign_group_mappings (
                    id,
                    campaign_id,
                    campaign_name_pattern
                )
            `
        )
        .eq('cliente_id', clientId)
        .order('nombre', { ascending: true }),
      supabase.from('layouts_reporte').select('*').order('nombre'),
      supabase.from('tab_templates').select('*').order('nombre'),
    ]);

  const cliente = clienteRes.data?.[0];
  if (!cliente) return null;

  // Compute available platforms from client API config (used for attribution fallback)
  const cfg = (cliente.config_api as any) || {};
  const availablePlatforms = new Set<string>(['meta']);
  // Basta el property id: la autenticación puede venir del OAuth de agencia
  // (sin ga_client_email). Mismo criterio que el worker y que getReportData.
  if (cfg.ga_property_id) availablePlatforms.add('ga4');
  if (cfg.hotmart_basic || cfg.hotmart_token) availablePlatforms.add('hotmart');
  if (cfg.tiktok_advertiser_id && cfg.tiktok_access_token) availablePlatforms.add('tiktok');

  // Priority: client-specific layout → global assigned layout → null (classic)
  const layout = clienteLayoutRes.data || cliente.global_layout || null;

  // Fetch all metrics + leads for that range
  let metricsQuery = supabase.from('metricas_diarias').select('*').eq('cliente_id', cliente.id);
  if (startStr !== 'all') metricsQuery = metricsQuery.gte('fecha', startStr);
  metricsQuery = metricsQuery.lte('fecha', endStr).order('fecha', { ascending: true });

  let leadsQuery = supabase.from('leads_diarios').select('*').eq('client_id', cliente.id);
  if (startStr !== 'all') leadsQuery = leadsQuery.gte('date', startStr);
  leadsQuery = leadsQuery.lte('date', endStr);

  let convOfflineQuery = supabase.from('conversiones_offline').select('*').eq('cliente_id', cliente.id);
  if (startStr !== 'all') convOfflineQuery = convOfflineQuery.gte('fecha', startStr);
  convOfflineQuery = convOfflineQuery.lte('fecha', endStr);

  // Previous period for delta calculation (same duration, ending one day before startStr)
  const prevMetricsPromise: Promise<{ data: any[] | null; error: any }> = startStr !== 'all'
    ? (() => {
        const startMs  = new Date(startStr + 'T00:00:00').getTime()
        const endMs    = new Date(endStr   + 'T00:00:00').getTime()
        const prevEndMs   = startMs - 86400000
        const prevStartMs = prevEndMs - (endMs - startMs)
        const prevStartStr = new Date(prevStartMs).toISOString().split('T')[0]
        const prevEndStr   = new Date(prevEndMs).toISOString().split('T')[0]
        return supabase
          .from('metricas_diarias').select('*')
          .eq('cliente_id', cliente.id)
          .gte('fecha', prevStartStr)
          .lte('fecha', prevEndStr)
          .order('fecha', { ascending: true }) as unknown as Promise<{ data: any[] | null; error: any }>
      })()
    : Promise.resolve({ data: [] as any[], error: null })

  const [metricsRes, leadsRes, convOfflineRes, prevMetricsRes] = await Promise.all([
    metricsQuery,
    leadsQuery,
    convOfflineQuery,
    prevMetricsPromise,
  ]);

  // Aggregate individual conversiones_offline rows by date
  const convOfflineByDate = new Map<string, { summary: Record<string, number>; rows: any[] }>();
  for (const row of convOfflineRes.data || []) {
    const dayData = convOfflineByDate.get(row.fecha) || {
      summary: { offline_leads: 0, offline_ventas: 0, offline_revenue: 0, offline_total: 0 },
      rows: []
    };
    const cantidad = row.cantidad || 0;
    const valor    = Number(row.valor) || 0;
    if (row.tipo === 'lead')  dayData.summary.offline_leads  += cantidad;
    if (row.tipo === 'venta') dayData.summary.offline_ventas += cantidad;
    dayData.summary.offline_revenue += valor;
    dayData.summary.offline_total   += cantidad;
    // Flatten numeric custom_fields into summary with prefix sheet_
    for (const [k, v] of Object.entries((row.custom_fields as Record<string, any>) || {})) {
      if (typeof v === 'number') {
        const key = `sheet_${k}`;
        dayData.summary[key] = (dayData.summary[key] ?? 0) + Number(v);
      }
    }
    dayData.rows.push(row);
    convOfflineByDate.set(row.fecha, dayData);
  }

  // Merge leads data into metrics by date
  const leadsMap = new Map((leadsRes.data || []).map((l: any) => [l.date, l]));
  const metrics = (metricsRes.data || []).map((m: any) => {
    const leadDay = leadsMap.get(m.fecha);
    const offlineDay = convOfflineByDate.get(m.fecha);
    return {
      ...m,
      ...(leadDay ? {
        leads_totales: leadDay.leads_totales,
        leads_calificados: leadDay.leads_calificados,
        leads_no_calificados: leadDay.leads_no_calificados,
        tasa_calificacion: leadDay.tasa_calificacion,
      } : {}),
      ...(offlineDay ? {
        ...offlineDay.summary,
        offline_rows: offlineDay.rows,
      } : { offline_rows: [] }),
    };
  });

  const effectiveStart = startStr === 'all' ? '2020-01-01' : startStr;
  const weeks = getWeeksInRange(effectiveStart, endStr);

  return {
    cliente,
    metrics: metrics || [],
    prevMetrics: (prevMetricsRes.data || []) as any[],
    leadsRaw: leadsRes.data || [],
    conversionesOfflineRaw: convOfflineRes.data || [],
    weeks,
    layout,
    allLayouts: allLayoutsRes.data || [],
    tabTemplates: tabTemplatesRes.data || [],
    clienteLayoutId: clienteLayoutRes.data?.id || null,
    tabs: tabsRes.data || [],
    conversionesCatalogo: conversionesRes.data || [],
    layoutPublico: cliente.layout_publico || null,
    availablePlatforms: Array.from(availablePlatforms),
    campaignGroups: campaignGroupsRes.data || [],
  };
}

// ─── Client layout mutation actions ─────────────────────────────────────────

/**
 * Clone a global layout template into clientes_layouts for a specific client.
 * If the client already has a custom layout, it gets replaced.
 */
export async function cloneLayoutForCliente(clienteId: string, globalLayoutId: string) {
  const supabase = await createAdminClient();

  // Fetch the global template
  const { data: template, error: tErr } = await supabase
    .from('layouts_reporte')
    .select('*')
    .eq('id', globalLayoutId)
    .single();

  if (tErr || !template) return { error: 'Plantilla no encontrada' };

  // Upsert into clientes_layouts (one row per client)
  const { data, error } = await supabase
    .from('clientes_layouts')
    .upsert(
      {
        cliente_id: clienteId,
        base_layout_id: globalLayoutId,
        nombre: template.nombre,
        columnas: template.columnas,
        tarjetas: template.tarjetas,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'cliente_id' }
    )
    .select()
    .single();

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true, data };
}

/**
 * Save updated columns/cards for a client's personal layout.
 */
export async function saveClienteLayout(
  clienteId: string,
  payload: {
    columnas: any[];
    tarjetas: any[];
    graficos?: any[];
    text_blocks?: any[];
    custom_metrics?: any[];
    blocks_order?: string[];
    ranking_tables?: any[];
  }
) {
  const supabase = await createAdminClient();

  const { error } = await supabase
    .from('clientes_layouts')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('cliente_id', clienteId);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Remove the client-specific layout so it falls back to global/classic.
 */
export async function resetClienteLayout(clienteId: string) {
  const supabase = await createAdminClient();
  await supabase.from('clientes_layouts').delete().eq('cliente_id', clienteId);
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Save or update a client tab.
 */
export async function saveClienteTab(
  clienteId: string,
  payload: {
    id?: string;
    nombre: string;
    keyword_meta: string;
    plantilla_id?: string;
    orden?: number;
    fecha_inicio?: string;
    fecha_finalizacion?: string;
    presupuesto_objetivo?: number;
    /** Solo al crear: copia la visualización de esta plantilla de pestaña (tab_templates). */
    template_id?: string;
    hotmart_funnel?: {
      enabled?: boolean;
      principal_names?: string[];
      bump_names?: string[];
      upsell_names?: string[];
      payment_page_url?: string;
      upsell_page_url?: string;
    } | null;
  }
) {
  const supabase = await createAdminClient();

  // hotmart_funnel: undefined = no tocar (solo en edición); null o objeto = setear (incluyendo "deshabilitar")
  const baseFields: Record<string, any> = {
    nombre: payload.nombre,
    keyword_meta: payload.keyword_meta,
    plantilla_id: payload.plantilla_id || null,
    fecha_inicio: payload.fecha_inicio || null,
    fecha_finalizacion: payload.fecha_finalizacion || null,
    presupuesto_objetivo: payload.presupuesto_objetivo || null,
  };
  if (payload.hotmart_funnel !== undefined) {
    baseFields.hotmart_funnel = payload.hotmart_funnel;
  }

  if (payload.id) {
    const { error } = await supabase
      .from('cliente_tabs')
      .update({ ...baseFields, updated_at: new Date().toISOString() })
      .eq('id', payload.id)
      .eq('cliente_id', clienteId);
    if (error) return { error: error.message };
  } else {
    // Al crear desde plantilla, copiamos su visualización (solo layout).
    const vizFields: Record<string, any> = {};
    if (payload.template_id) {
      const { data: template } = await supabase
        .from('tab_templates')
        .select('*')
        .eq('id', payload.template_id)
        .single();
      if (template) {
        for (const f of TAB_VIZ_FIELDS) vizFields[f] = (template as any)[f] ?? null;
      }
    }
    const { error } = await supabase.from('cliente_tabs').insert({
      cliente_id: clienteId,
      ...baseFields,
      ...vizFields,
      orden: payload.orden || 0,
    });
    if (error) return { error: error.message };
  }

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Delete a client tab.
 */
export async function deleteClienteTab(clienteId: string, tabId: string) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('cliente_tabs')
    .delete()
    .eq('id', tabId)
    .eq('cliente_id', clienteId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Toggle the archived status of a client tab.
 */
export async function toggleTabArchived(clienteId: string, tabId: string, archived: boolean) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('cliente_tabs')
    .update({ archived })
    .eq('id', tabId)
    .eq('cliente_id', clienteId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Duplicate a client tab.
 */
export async function duplicateClienteTab(clienteId: string, tabId: string) {
  const supabase = await createAdminClient();

  const { data: source, error: fetchError } = await supabase
    .from('cliente_tabs')
    .select('*')
    .eq('id', tabId)
    .eq('cliente_id', clienteId)
    .single();

  if (fetchError || !source) return { error: fetchError?.message || 'Tab no encontrada' };

  const { data: allTabs } = await supabase
    .from('cliente_tabs')
    .select('orden')
    .eq('cliente_id', clienteId)
    .order('orden', { ascending: false })
    .limit(1);

  const maxOrden = (allTabs?.[0]?.orden ?? 0) as number;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id, created_at, updated_at, public_token, ...rest } = source;

  const { error: insertError } = await supabase.from('cliente_tabs').insert({
    ...rest,
    nombre: `${source.nombre} (copia)`,
    orden: maxOrden + 1,
  });

  if (insertError) return { error: insertError.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

// ─── Tab templates (plantillas de pestañas, globales) ───────────────────────
// Guardan SOLO la visualización de una pestaña para reutilizarla en otras
// campañas. No incluyen keyword_meta / fechas / presupuesto.

const TAB_VIZ_FIELDS = [
  'columnas',
  'tarjetas',
  'graficos',
  'text_blocks',
  'custom_metrics',
  'ranking_tables',
  'blocks_order',
] as const;

/**
 * List all global tab templates (for the "new tab" selector).
 */
export async function listTabTemplates() {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('tab_templates')
    .select('*')
    .order('nombre', { ascending: true });
  if (error) return { data: [], error: error.message };
  return { data: data || [], error: null };
}

/**
 * Save the visualization of an existing tab as a reusable global template.
 * Falls back to the tab's associated layout (plantilla_id) when the tab has
 * no per-tab overrides of its own.
 */
export async function saveTabAsTemplate(
  clienteId: string,
  tabId: string,
  nombre: string,
  descripcion?: string
) {
  if (!nombre?.trim()) return { error: 'El nombre de la plantilla es obligatorio' };
  const supabase = await createAdminClient();

  const { data: tab, error: fetchError } = await supabase
    .from('cliente_tabs')
    .select('*')
    .eq('id', tabId)
    .eq('cliente_id', clienteId)
    .single();
  if (fetchError || !tab) return { error: fetchError?.message || 'Pestaña no encontrada' };

  const viz: Record<string, any> = {};
  for (const f of TAB_VIZ_FIELDS) viz[f] = (tab as any)[f] ?? null;

  // Fallback: si la pestaña no tiene overrides propios pero referencia una
  // plantilla de layout, copiamos la visualización desde ahí.
  const hasOwnViz = TAB_VIZ_FIELDS.some((f) => {
    const v = (tab as any)[f];
    return Array.isArray(v) ? v.length > 0 : v != null;
  });
  if (!hasOwnViz && tab.plantilla_id) {
    const { data: layout } = await supabase
      .from('layouts_reporte')
      .select('*')
      .eq('id', tab.plantilla_id)
      .single();
    if (layout) for (const f of TAB_VIZ_FIELDS) viz[f] = (layout as any)[f] ?? viz[f];
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from('tab_templates').insert({
    nombre: nombre.trim(),
    descripcion: descripcion?.trim() || null,
    ...viz,
    created_by: user?.id || null,
  });
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Apply a template's visualization onto an existing tab (replaces its layout).
 */
export async function applyTemplateToTab(clienteId: string, tabId: string, templateId: string) {
  const supabase = await createAdminClient();

  const { data: template, error: tErr } = await supabase
    .from('tab_templates')
    .select('*')
    .eq('id', templateId)
    .single();
  if (tErr || !template) return { error: tErr?.message || 'Plantilla no encontrada' };

  const viz: Record<string, any> = {};
  for (const f of TAB_VIZ_FIELDS) viz[f] = (template as any)[f] ?? null;

  const { error } = await supabase
    .from('cliente_tabs')
    .update({ ...viz, updated_at: new Date().toISOString() })
    .eq('id', tabId)
    .eq('cliente_id', clienteId);
  if (error) return { error: error.message };

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Rename / re-describe a global tab template.
 */
export async function renameTabTemplate(templateId: string, nombre: string, descripcion?: string) {
  if (!nombre?.trim()) return { error: 'El nombre es obligatorio' };
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('tab_templates')
    .update({
      nombre: nombre.trim(),
      descripcion: descripcion?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId);
  if (error) return { error: error.message };
  revalidatePath('/admin/layouts');
  return { success: true };
}

/**
 * Delete a global tab template.
 */
export async function deleteTabTemplate(templateId: string) {
  const supabase = await createAdminClient();
  const { error } = await supabase.from('tab_templates').delete().eq('id', templateId);
  if (error) return { error: error.message };
  revalidatePath('/admin/layouts');
  return { success: true };
}

/**
 * Save layout overrides (columns, cards) strictly for one tab.
 */
export async function saveTabOverrides(
  clienteId: string,
  tabId: string,
  payload: {
    columnas: any[] | null;
    tarjetas: any[] | null;
    graficos?: any[] | null;
    text_blocks?: any[] | null;
    custom_metrics?: any[] | null;
    blocks_order?: string[] | null;
    ranking_tables?: any[] | null;
  }
) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('cliente_tabs')
    .update({
      columnas: payload.columnas,
      tarjetas: payload.tarjetas,
      graficos: payload.graficos,
      text_blocks: payload.text_blocks,
      custom_metrics: payload.custom_metrics,
      blocks_order: payload.blocks_order,
      ranking_tables: payload.ranking_tables,
      updated_at: new Date().toISOString(),
    })
    .eq('id', tabId)
    .eq('cliente_id', clienteId);

  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

export async function updateLayoutPuzzleState(
  clienteId: string,
  tabId: string,
  payload: {
    blocks_order: string[];
    text_blocks: any[];
    tarjetas?: any[];
    graficos?: any[];
    ranking_tables?: any[];
    full_layout?: {
      nombre: string;
      columnas: any[];
      tarjetas: any[];
      graficos?: any[];
      custom_metrics?: any[];
      attribution_strategy?: string;
    };
  }
) {
  const supabase = await createAdminClient();

  if (tabId && tabId !== 'general') {
    // Tab específico: actualizar puzzle state y arrays de bloques
    const { error } = await supabase
      .from('cliente_tabs')
      .update({
        blocks_order: payload.blocks_order,
        text_blocks: payload.text_blocks,
        ...(payload.tarjetas !== undefined && { tarjetas: payload.tarjetas }),
        ...(payload.graficos !== undefined && { graficos: payload.graficos }),
        ...(payload.ranking_tables !== undefined && { ranking_tables: payload.ranking_tables }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', tabId)
      .eq('cliente_id', clienteId);
    if (error) return { error: error.message };
    revalidatePath(`/dashboard/${clienteId}`);
    return { success: true };
  } else {
    // General tab: verificar si ya existe fila en clientes_layouts
    const { data: existing } = await supabase
      .from('clientes_layouts')
      .select('id')
      .eq('cliente_id', clienteId)
      .maybeSingle();

    if (existing) {
      // Fila existe: actualizar puzzle state y arrays de bloques
      const { error } = await supabase
        .from('clientes_layouts')
        .update({
          blocks_order: payload.blocks_order,
          text_blocks: payload.text_blocks,
          ...(payload.tarjetas !== undefined && { tarjetas: payload.tarjetas }),
          ...(payload.graficos !== undefined && { graficos: payload.graficos }),
          ...(payload.ranking_tables !== undefined && { ranking_tables: payload.ranking_tables }),
          updated_at: new Date().toISOString(),
        })
        .eq('cliente_id', clienteId);
      if (error) return { error: error.message };
    } else if (payload.full_layout) {
      // No existe fila: crear una copiando el layout activo + puzzle state
      const { error } = await supabase.from('clientes_layouts').insert({
        cliente_id: clienteId,
        nombre: payload.full_layout.nombre || 'Dashboard',
        columnas: payload.full_layout.columnas || [],
        tarjetas: payload.full_layout.tarjetas || [],
        graficos: payload.full_layout.graficos || null,
        custom_metrics: payload.full_layout.custom_metrics || null,
        attribution_strategy: payload.full_layout.attribution_strategy || null,
        blocks_order: payload.blocks_order,
        text_blocks: payload.text_blocks,
      });
      if (error) return { error: error.message };
    } else {
      return { error: 'No se pudo guardar: layout base no disponible' };
    }

    revalidatePath(`/dashboard/${clienteId}`);
    return { success: true };
  }
}

/**
 * Update a manual metric value in metricas_diarias.
 */
export async function updateManualMetric(
  clienteId: string,
  fecha: string,
  key: string,
  value: number
) {
  const supabase = await createAdminClient();

  // Retrieve existing metric row for this date
  const { data: existing } = await supabase
    .from('metricas_diarias')
    .select('id, metricas_manuales')
    .eq('cliente_id', clienteId)
    .eq('fecha', fecha)
    .maybeSingle();

  const currentManuales = existing?.metricas_manuales || {};
  currentManuales[key] = value;

  if (existing) {
    await supabase
      .from('metricas_diarias')
      .update({ metricas_manuales: currentManuales })
      .eq('id', existing.id);
  } else {
    await supabase.from('metricas_diarias').insert({
      cliente_id: clienteId,
      fecha,
      metricas_manuales: currentManuales,
    });
  }

  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/**
 * Get total historical spend for a specific keyword filter (for budget calculations)
 */
/**
 * Gasto acumulado de una pestaña: Meta + TikTok.
 *
 * Antes solo leía `meta_campaigns`/`meta_spend`, así que en un cliente que
 * invierte en las dos plataformas la tarjeta "Gasto Acumulado" ignoraba el 100%
 * de lo gastado en TikTok. No era un desfase intermitente: era un faltante
 * sistemático en toda pestaña con keyword, y además inflaba cualquier cálculo
 * que usara esta cifra como denominador (% de presupuesto consumido).
 *
 * El criterio de filtrado es el mismo que aplica el dashboard en el resto de
 * métricas: se suman las campañas cuyo nombre contiene el keyword (ver
 * `filterCampaignList` en src/lib/campaign-filter.ts). Sin keyword se usa la
 * columna agregada.
 */
export async function getTabTotalSpend(
  clienteId: string,
  keywordFilter: string,
  fechaInicio?: string,
  fechaFin?: string
) {
  const supabase = await createAdminClient();
  let query = supabase
    .from('metricas_diarias')
    .select('meta_campaigns, meta_spend, tiktok_campaigns, tiktok_spend')
    .eq('cliente_id', clienteId);
  if (fechaInicio) query = query.gte('fecha', fechaInicio);
  if (fechaFin) query = query.lte('fecha', fechaFin);
  const { data: metrics } = await query;

  if (!metrics) return 0;

  const kw = keywordFilter?.toLowerCase() ?? '';
  /** Gasto de una plataforma en una fila, filtrado por keyword si lo hay. */
  const spendDe = (columna: any, campanas: any) => {
    if (!kw || !Array.isArray(campanas)) return parseFloat(columna || '0') || 0;
    return campanas
      .filter((c: any) => c.name?.toLowerCase().includes(kw))
      .reduce((s: number, c: any) => s + (parseFloat(c.spend || '0') || 0), 0);
  };

  let totalSpent = 0;
  metrics.forEach((row) => {
    totalSpent += spendDe(row.meta_spend, row.meta_campaigns);
    totalSpent += spendDe(row.tiktok_spend, row.tiktok_campaigns);
  });
  return totalSpent;
}

/**
 * Support Tickets Actions
 */

async function getCurrentRole(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 'viewer';
  const { data } = await supabase.from('user_profiles').select('role').eq('id', user.id).single();
  return data?.role ?? 'viewer';
}

async function isTeamMember(): Promise<boolean> {
  return ['superadmin', 'admin', 'trafficker'].includes(await getCurrentRole());
}

export async function getAllSoporteTickets() {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('soporte_tickets')
    .select('*, cliente:clientes(nombre)')
    .order('fecha_solicitud', { ascending: false })
    .limit(100);

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function getSoporteTickets(clienteId: string) {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('soporte_tickets')
    .select('*')
    .eq('cliente_id', clienteId)
    .order('fecha_solicitud', { ascending: false });

  if (error) return { data: null, error: error.message };
  return { data, error: null };
}

export async function createSoporteTicket(payload: {
  cliente_id?: string | null;
  tipo: 'bug' | 'feature' | 'mejora' | 'tarea';
  nombre_solicitante: string;
  requerimiento: string;
  observaciones?: string;
  prioridad: number;
  fecha_entrega?: string;
}) {
  if (!(await isTeamMember())) return { error: 'No autorizado' };

  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('soporte_tickets')
    .insert({
      ...payload,
      cliente_id: payload.cliente_id || null,
      estado: 'abierto',
    })
    .select()
    .single();

  if (error) return { error: error.message };

  // Notificaciones tras responder; after() evita que Vercel congele la
  // función antes de completar los inserts. In-app (campanita) + WhatsApp.
  after(async () => {
    await notifyUsers({
      db: supabase,
      type: 'ticket_created',
      severity: 'info',
      clienteId: payload.cliente_id || null,
      title: `Nuevo ticket: ${payload.requerimiento.slice(0, 80)}`,
      message: `${payload.tipo} · solicitado por ${payload.nombre_solicitante}`,
      link: '/soporte',
      metadata: { ticket_id: data.id },
    });
    await sendWhatsAppNotification({
      db: supabase,
      clienteId: payload.cliente_id || null,
      notificationType: 'roadmap_created',
      message:
        `🗺️ *Roadmap — nuevo ${payload.tipo}*\n` +
        `${payload.requerimiento}\n` +
        `Solicitante: ${payload.nombre_solicitante} · Prioridad: ${payload.prioridad}`,
    }).catch((e) => console.error('[roadmap whatsapp] create failed', e));
  });

  if (payload.cliente_id) revalidatePath(`/dashboard/${payload.cliente_id}`);
  revalidatePath('/soporte');
  return { success: true, data };
}

export async function updateSoporteTicket(
  ticketId: string,
  clienteId: string | null,
  payload: {
    responsable?: string;
    fecha_entrega?: string;
    prioridad?: number;
    estado?: string;
    observaciones?: string;
    nombre_solicitante?: string;
    requerimiento?: string;
    tipo?: 'bug' | 'feature' | 'mejora' | 'tarea';
    cliente_id?: string | null;
  }
) {
  if (!(await isTeamMember())) return { error: 'No autorizado' };

  const supabase = await createAdminClient();

  // Estado previo: solo notificamos si el estado realmente cambió
  let previousEstado: string | null = null;
  let previousRequerimiento: string | null = null;
  if (payload.estado) {
    const { data: prev } = await supabase
      .from('soporte_tickets')
      .select('estado, requerimiento')
      .eq('id', ticketId)
      .maybeSingle();
    previousEstado = prev?.estado ?? null;
    previousRequerimiento = prev?.requerimiento ?? null;
  }

  const { error } = await supabase
    .from('soporte_tickets')
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq('id', ticketId);

  if (error) return { error: error.message };

  if (payload.estado && previousEstado && payload.estado !== previousEstado) {
    const requerimiento = payload.requerimiento ?? previousRequerimiento;
    const nuevoEstado = payload.estado;
    after(async () => {
      await notifyUsers({
        db: supabase,
        type: 'ticket_updated',
        severity: nuevoEstado === 'completado' ? 'success' : 'info',
        clienteId: clienteId,
        title: `Ticket actualizado: ${previousEstado} → ${nuevoEstado}`,
        message: requerimiento ? requerimiento.slice(0, 120) : undefined,
        link: '/soporte',
        metadata: { ticket_id: ticketId, estado: nuevoEstado },
      });
      await sendWhatsAppNotification({
        db: supabase,
        clienteId: clienteId,
        notificationType: 'roadmap_updated',
        message:
          `🗺️ *Roadmap actualizado* — ${previousEstado} → ${nuevoEstado}\n` +
          `${requerimiento ? requerimiento.slice(0, 160) : ''}`,
      }).catch((e) => console.error('[roadmap whatsapp] update failed', e));
    });
  }

  if (clienteId) revalidatePath(`/dashboard/${clienteId}`);
  revalidatePath('/soporte');
  return { success: true };
}

/**
 * Public Mirror Dashboard data retrieval
 */
export async function getMirrorDashboardData(token: string, from?: string, to?: string) {
  const supabase = await createAdminClient();

  // 1. Resolve token: is it a tab-specific token?
  const { data: tab } = await supabase
    .from('cliente_tabs')
    .select('*, cliente:clientes(*, global_layout:layouts_reporte(*))')
    .eq('public_token', token)
    .maybeSingle();

  let cliente: any = null;
  let activeTabObj: any = null;
  let layout: any = null;

  if (tab) {
    cliente = tab.cliente;
    activeTabObj = tab;
    // Use tab override if available
    if (tab.columnas && tab.tarjetas) {
      layout = {
        nombre: tab.nombre,
        columnas: tab.columnas,
        tarjetas: tab.tarjetas,
        graficos: tab.graficos,
        blocks_order: tab.blocks_order,
        text_blocks: tab.text_blocks,
        custom_metrics: tab.custom_metrics,
      };
    } else if (tab.plantilla_id) {
      const { data: global } = await supabase
        .from('layouts_reporte')
        .select('*')
        .eq('id', tab.plantilla_id)
        .single();
      layout = global;
    }
  } else {
    // 2. Resolve token: is it a client-specific (general tab) token?
    const { data: c } = await supabase
      .from('clientes')
      .select('*, global_layout:layouts_reporte(*)')
      .eq('public_token', token)
      .maybeSingle();

    if (!c) return { error: 'Enlace no válido o expirado' };

    cliente = c;
    // Fetch client-specific layout
    const { data: cl } = await supabase
      .from('clientes_layouts')
      .select('*')
      .eq('cliente_id', cliente.id)
      .maybeSingle();
    layout = cl || cliente.global_layout || null;
  }

  if (!cliente) return { error: 'Cliente no encontrado' };

  // Use tab dates only if not provided in URL
  const startStr =
    from || activeTabObj?.fecha_inicio || format(addDays(new Date(), -30), 'yyyy-MM-dd');
  const endStr = to || activeTabObj?.fecha_finalizacion || format(new Date(), 'yyyy-MM-dd');

  // Fetch all metrics + leads for that range (identical to getDashboardData)
  let mirrorMetricsQuery = supabase
    .from('metricas_diarias')
    .select('*')
    .eq('cliente_id', cliente.id);
  if (startStr !== 'all') mirrorMetricsQuery = mirrorMetricsQuery.gte('fecha', startStr);
  mirrorMetricsQuery = mirrorMetricsQuery.lte('fecha', endStr).order('fecha', { ascending: true });

  let mirrorLeadsQuery = supabase.from('leads_diarios').select('*').eq('client_id', cliente.id);
  if (startStr !== 'all') mirrorLeadsQuery = mirrorLeadsQuery.gte('date', startStr);
  mirrorLeadsQuery = mirrorLeadsQuery.lte('date', endStr);

  let mirrorConvOfflineQuery = supabase.from('conversiones_offline').select('*').eq('cliente_id', cliente.id);
  if (startStr !== 'all') mirrorConvOfflineQuery = mirrorConvOfflineQuery.gte('fecha', startStr);
  mirrorConvOfflineQuery = mirrorConvOfflineQuery.lte('fecha', endStr);

  const [metricsRes, leadsRes, conversionesRes, campaignGroupsRes, tabsRes, allLayoutsRes, mirrorConvOfflineRes] =
    await Promise.all([
      mirrorMetricsQuery,
      mirrorLeadsQuery,
      supabase
        .from('meta_conversiones_catalogo')
        .select('conversion_key, label, field_id')
        .eq('cliente_id', cliente.id)
        .order('label', { ascending: true }),
      supabase
        .from('campaign_groups')
        .select(
          `
                *,
                campaign_group_mappings (id, campaign_id, campaign_name_pattern)
            `
        )
        .eq('cliente_id', cliente.id)
        .order('nombre', { ascending: true }),
      supabase
        .from('cliente_tabs')
        .select('*')
        .eq('cliente_id', cliente.id)
        .order('position', { ascending: true }),
      supabase.from('layouts_reporte').select('*').order('nombre'),
      mirrorConvOfflineQuery,
    ]);

  const mirrorConvOfflineByDate = new Map<string, { summary: Record<string, number>; rows: any[] }>();
  for (const row of mirrorConvOfflineRes.data || []) {
    const dayData = mirrorConvOfflineByDate.get(row.fecha) || {
      summary: { offline_leads: 0, offline_ventas: 0, offline_revenue: 0, offline_total: 0 },
      rows: []
    };
    const cantidad = row.cantidad || 0;
    const valor    = Number(row.valor) || 0;
    if (row.tipo === 'lead')  dayData.summary.offline_leads  += cantidad;
    if (row.tipo === 'venta') dayData.summary.offline_ventas += cantidad;
    dayData.summary.offline_revenue += valor;
    dayData.summary.offline_total   += cantidad;
    for (const [k, v] of Object.entries((row.custom_fields as Record<string, any>) || {})) {
      if (typeof v === 'number') {
        const key = `sheet_${k}`;
        dayData.summary[key] = (dayData.summary[key] ?? 0) + Number(v);
      }
    }
    dayData.rows.push(row);
    mirrorConvOfflineByDate.set(row.fecha, dayData);
  }

  const leadsMap = new Map((leadsRes.data || []).map((l: any) => [l.date, l]));
  const metrics = (metricsRes.data || []).map((m: any) => {
    const leadDay = leadsMap.get(m.fecha);
    const offlineDay = mirrorConvOfflineByDate.get(m.fecha);
    return {
      ...(leadDay ? { ...m, ...leadDay } : m),
      ...(offlineDay ? {
        ...offlineDay.summary,
        offline_rows: offlineDay.rows,
      } : { offline_rows: [] }),
    };
  });

  const effectiveStart = startStr === 'all' ? '2020-01-01' : startStr;
  const weeks = getWeeksInRange(effectiveStart, endStr);
  const availablePlatforms = new Set<string>(['meta']);
  const cfg = (cliente.config_api as any) || {};
  if (cfg.ga_property_id) availablePlatforms.add('ga4');
  if (cfg.hotmart_token) availablePlatforms.add('hotmart');
  if (cfg.tiktok_access_token) availablePlatforms.add('tiktok');

  // Filter tabs by public_tab_ids if configured on client token
  let allTabs = tabsRes.data || [];
  let defaultActiveTabId: string = activeTabObj?.id || 'general';
  if (!activeTabObj) {
    const publicConfig = cliente.layout_publico as any;
    if (
      publicConfig?.type === 'tab_mirror' &&
      Array.isArray(publicConfig?.tab_ids) &&
      publicConfig.tab_ids.length > 0
    ) {
      allTabs = allTabs.filter((t: any) => publicConfig.tab_ids.includes(t.id));
      if (allTabs.length > 0) defaultActiveTabId = allTabs[0].id;
    }
  }

  return {
    data: {
      cliente,
      metrics: metrics || [],
      weeks,
      layout,
      tabs: allTabs,
      activeTabId: defaultActiveTabId,
      allLayouts: allLayoutsRes.data || [],
      conversionesCatalogo: conversionesRes.data || [],
      availablePlatforms: Array.from(availablePlatforms),
      campaignGroups: campaignGroupsRes.data || [],
      isMirror: true,
    },
    error: null,
  };
}

/** Personalización del link público de un cliente (logo, acento, textos). */
export interface PublicBranding {
  logo_url?: string;
  accent?: string;
  title?: string;
  welcome_text?: string;
}

/**
 * Guarda la configuración del link público, preservando lo que no se toca.
 * Todo vive en `clientes.layout_publico` (JSONB), que ya se usaba para las
 * pestañas visibles — así no hace falta una columna nueva.
 */
export async function savePublicConfig(
  clienteId: string,
  patch: { tabIds?: string[]; branding?: PublicBranding }
) {
  const supabase = await createAdminClient();

  const { data: current } = await supabase
    .from('clientes')
    .select('layout_publico')
    .eq('id', clienteId)
    .maybeSingle();

  const existing = (current?.layout_publico ?? {}) as {
    tab_ids?: string[];
    branding?: PublicBranding;
  };
  const tabIds = patch.tabIds ?? (Array.isArray(existing.tab_ids) ? existing.tab_ids : []);
  const branding: PublicBranding = { ...(existing.branding ?? {}), ...(patch.branding ?? {}) };

  // Se limpian los strings vacíos para no persistir ruido.
  for (const k of Object.keys(branding) as (keyof PublicBranding)[]) {
    if (!branding[k]) delete branding[k];
  }

  const hasBranding = Object.keys(branding).length > 0;
  const payload =
    tabIds.length > 0 || hasBranding
      ? { type: 'tab_mirror', tab_ids: tabIds, ...(hasBranding ? { branding } : {}) }
      : null;

  const { error } = await supabase
    .from('clientes')
    .update({ layout_publico: payload })
    .eq('id', clienteId);
  if (error) return { error: error.message };
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

/** Compat: guarda solo las pestañas visibles, conservando el branding. */
export async function savePublicTabConfig(clienteId: string, tabIds: string[]) {
  return savePublicConfig(clienteId, { tabIds });
}

export async function getOrCreatePublicToken(id: string, type: 'client' | 'tab') {
  const supabase = await createAdminClient();
  const table = type === 'client' ? 'clientes' : 'cliente_tabs';

  // 1. Try to fetch existing
  const { data: existing } = await supabase
    .from(table)
    .select('public_token')
    .eq('id', id)
    .maybeSingle();

  if (existing?.public_token) return { token: existing.public_token };

  // 2. Generate new one
  const newToken = crypto.randomUUID();
  const { error } = await supabase.from(table).update({ public_token: newToken }).eq('id', id);

  if (error) return { error: error.message };
  return { token: newToken };
}

export async function getArchiveMetrics(clientId: string): Promise<{ metrics: any[] } | null> {
  const supabase = await createAdminClient();

  const [metricsRes, leadsRes] = await Promise.all([
    supabase
      .from('metricas_diarias')
      .select('*')
      .eq('cliente_id', clientId)
      .gte('fecha', '2020-01-01')
      .order('fecha', { ascending: true })
      .range(0, 9999),
    supabase
      .from('leads_diarios')
      .select('*')
      .eq('client_id', clientId)
      .gte('date', '2020-01-01')
      .range(0, 9999),
  ]);

  if (metricsRes.error || leadsRes.error) return null;

  const leadsMap = new Map((leadsRes.data || []).map((l: any) => [l.date, l]));
  const metrics = (metricsRes.data || []).map((m: any) => {
    const leadDay = leadsMap.get(m.fecha);
    if (leadDay) {
      return {
        ...m,
        leads_totales: leadDay.leads_totales,
        leads_calificados: leadDay.leads_calificados,
        leads_no_calificados: leadDay.leads_no_calificados,
        tasa_calificacion: leadDay.tasa_calificacion,
      };
    }
    return m;
  });

  return { metrics };
}
