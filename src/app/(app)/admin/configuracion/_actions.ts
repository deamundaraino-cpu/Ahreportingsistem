'use server';

import { createClient, createAdminClient } from '@/utils/supabase/server';
import { revalidatePath, updateTag } from 'next/cache';
import { evaluateAlertRules, type RuleRow } from '@/lib/notifications/rules-engine';
import { colombiaToday, colombiaYesterday } from '@/lib/date-utils';
import { format, subDays, startOfMonth, endOfMonth, parseISO } from 'date-fns';
import {
  enrichMetaRow,
  enrichTikTokRow,
  parseTabFilter,
  type AnyCampaignFilter,
} from '@/lib/campaign-filter';
import { BRANDING_CACHE_TAG } from '@/lib/branding';
import { getSesionActual } from '@/lib/auth-session';

async function requireAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  // Sesión y rol memoizados por petición (`lib/auth-session.ts`). Antes cada
  // llamada a este guard hacía su propio getUser() + lectura de user_profiles,
  // así que una página que invoca 7 acciones pagaba 7 veces las dos consultas.
  const { userId, role } = await getSesionActual();
  if (!userId) return { ok: false, error: 'No autorizado' };
  if (!['superadmin', 'admin'].includes(role)) {
    return { ok: false, error: 'Sin permisos para configurar alertas' };
  }
  return { ok: true };
}

// ── Rules CRUD ──────────────────────────────────────────────────────────────

export async function getNotificationRules() {
  const guard = await requireAdmin();
  if (!guard.ok) throw new Error(guard.error);

  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('notification_rules')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return data as RuleRow[];
}

export async function createNotificationRule(
  payload: Omit<RuleRow, 'id' | 'created_at' | 'updated_at' | 'last_triggered_at'>
) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  const { error } = await supabase.from('notification_rules').insert({
    cliente_id: payload.cliente_id || null,
    tab_id: payload.tab_id || null,
    nombre: payload.nombre,
    metric: payload.metric,
    operator: payload.operator,
    value: payload.value,
    time_window: payload.time_window,
    channels: payload.channels,
    cooldown_hours: payload.cooldown_hours,
    enabled: payload.enabled,
  });

  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function updateNotificationRule(
  id: string,
  payload: Partial<Omit<RuleRow, 'id' | 'created_at' | 'updated_at'>>
) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  const { error } = await supabase.from('notification_rules').update(payload).eq('id', id);

  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

export async function deleteNotificationRule(id: string) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  const { error } = await supabase.from('notification_rules').delete().eq('id', id);

  if (error) return { error: error.message };

  revalidatePath('/admin/configuracion');
  return { success: true };
}

// ── Dropdowns Helpers ────────────────────────────────────────────────────────

export async function getClientesAndTabs() {
  const guard = await requireAdmin();
  if (!guard.ok) throw new Error(guard.error);

  const supabase = await createAdminClient();

  const { data: clientes } = await supabase.from('clientes').select('id, nombre').order('nombre');

  const { data: tabs } = await supabase
    .from('cliente_tabs')
    .select(
      'id, nombre, cliente_id, keyword_meta, presupuesto_objetivo, fecha_inicio, fecha_finalizacion'
    )
    .eq('archived', false)
    .order('nombre');

  return {
    clientes: clientes ?? [],
    tabs: tabs ?? [],
  };
}

// ── Manual Evaluation / Test Action ──────────────────────────────────────────

export async function triggerRulesEvaluation() {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  try {
    const supabase = await createAdminClient();
    // force: evalúa y envía notificaciones reales ignorando el cooldown (y sin
    // escribirlo), para verificar la entrega a los grupos sin afectar la
    // corrida automática nocturna.
    const result = await evaluateAlertRules(supabase, { force: true });
    revalidatePath('/admin/configuracion');
    return { success: true, ...result };
  } catch (err: any) {
    return { error: err.message || 'Error evaluando reglas' };
  }
}

export async function testRule(ruleId: string) {
  const guard = await requireAdmin();
  if (!guard.ok) return { error: guard.error };

  try {
    const db = await createAdminClient();

    // 1. Fetch the rule
    const { data: rule, error: ruleError } = await db
      .from('notification_rules')
      .select('*')
      .eq('id', ruleId)
      .single();

    if (ruleError || !rule) {
      return { error: ruleError?.message || 'Regla no encontrada' };
    }

    const { cliente_id, tab_id, metric, operator, value, time_window } = rule;

    // Get target client ID(s)
    let targetClientIds: string[] = [];
    if (cliente_id) {
      targetClientIds = [cliente_id];
    } else {
      const { data: clients } = await db.from('clientes').select('id');
      targetClientIds = (clients ?? []).map((c) => c.id);
    }

    if (targetClientIds.length === 0) {
      return { error: 'No hay clientes para evaluar' };
    }

    // Evaluate for the first client (in test we evaluate just one client as a sample)
    const testClientId = targetClientIds[0];

    const { data: clientObj } = await db
      .from('clientes')
      .select('nombre')
      .eq('id', testClientId)
      .single();
    const clientName = clientObj?.nombre || 'Cliente';

    // Date range
    const today = colombiaToday();
    const yesterday = colombiaYesterday();
    let start = today;
    let end = today;

    if (time_window === 'yesterday') {
      start = yesterday;
      end = yesterday;
    } else if (time_window === 'last_7_days') {
      start = format(subDays(parseISO(today), 6), 'yyyy-MM-dd');
    } else if (time_window === 'last_30_days') {
      start = format(subDays(parseISO(today), 29), 'yyyy-MM-dd');
    } else if (time_window === 'current_tab_period' && tab_id) {
      const { data: tab } = await db
        .from('cliente_tabs')
        .select('fecha_inicio, fecha_finalizacion')
        .eq('id', tab_id)
        .single();
      if (tab?.fecha_inicio && tab?.fecha_finalizacion) {
        start = tab.fecha_inicio;
        end = tab.fecha_finalizacion;
      } else {
        start = format(startOfMonth(new Date()), 'yyyy-MM-dd');
        end = format(endOfMonth(new Date()), 'yyyy-MM-dd');
      }
    } else if (time_window === 'custom_range') {
      start = (rule as any).custom_start || format(startOfMonth(new Date()), 'yyyy-MM-dd');
      end = (rule as any).custom_end || format(endOfMonth(new Date()), 'yyyy-MM-dd');
    }

    // Query daily metrics
    const { data: rows } = await db
      .from('metricas_diarias')
      .select(
        'fecha, meta_spend, tiktok_spend, meta_campaigns, tiktok_campaigns, ga_sessions, hotmart_pagos_iniciados, ventas_principal, ventas_bump, ventas_upsell, metricas_manuales'
      )
      .eq('cliente_id', testClientId)
      .gte('fecha', start)
      .lte('fecha', end);

    // Tab info
    let keywordFilter: AnyCampaignFilter = '';
    let tabBudget: number | null = null;
    let tabName = '';

    if (tab_id) {
      const { data: tab } = await db
        .from('cliente_tabs')
        .select('nombre, keyword_meta, presupuesto_objetivo')
        .eq('id', tab_id)
        .single();
      if (tab) {
        keywordFilter = parseTabFilter(tab.keyword_meta);
        tabBudget = tab.presupuesto_objetivo ? Number(tab.presupuesto_objetivo) : null;
        tabName = tab.nombre;
      }
    }

    // Groups
    const { data: campaignGroups } = await db
      .from('campaign_groups')
      .select('id, nombre, campaign_group_mappings(campaign_id, campaign_name_pattern)')
      .eq('cliente_id', testClientId);

    // Aggregate
    let totalSpend = 0;
    let totalRevenue = 0;
    let totalLeads = 0;

    (rows ?? []).forEach((row) => {
      const enrichedRow = enrichTikTokRow(
        enrichMetaRow(row, keywordFilter, campaignGroups ?? []),
        keywordFilter,
        campaignGroups ?? []
      );
      totalSpend += (Number(enrichedRow.meta_spend) || 0) + (Number(enrichedRow.tiktok_spend) || 0);

      const manuales = (row.metricas_manuales as Record<string, number>) ?? {};
      const ventasCerradas = Number(manuales['VENTAS_CERRADAS'] ?? 0);
      totalRevenue +=
        (Number(row.ventas_principal) || 0) +
        (Number(row.ventas_bump) || 0) +
        (Number(row.ventas_upsell) || 0) +
        ventasCerradas;

      totalLeads +=
        (Number(enrichedRow.meta_leads) || 0) + (Number(enrichedRow.tiktok_conversions) || 0);
    });

    let actualValue = 0;
    switch (metric) {
      case 'spend':
        actualValue = totalSpend;
        break;
      case 'revenue':
        actualValue = totalRevenue;
        break;
      case 'roas':
        actualValue = totalSpend > 0 ? totalRevenue / totalSpend : 0;
        break;
      case 'leads':
        actualValue = totalLeads;
        break;
      case 'cpl':
        actualValue = totalLeads > 0 ? totalSpend / totalLeads : 0;
        break;
      case 'budget_percentage':
        if (tabBudget && tabBudget > 0) {
          actualValue = (totalSpend / tabBudget) * 100;
        } else {
          // No budget set: show 0% but warn the user
          actualValue = 0;
        }
        break;
    }

    // Evaluate
    let isTriggered = false;
    const threshold = Number(value);
    switch (operator) {
      case '>':
        isTriggered = actualValue > threshold;
        break;
      case '<':
        isTriggered = actualValue < threshold;
        break;
      case '>=':
        isTriggered = actualValue >= threshold;
        break;
      case '<=':
        isTriggered = actualValue <= threshold;
        break;
    }

    return {
      success: true,
      clientName,
      tabName,
      metric,
      operator,
      threshold,
      actualValue,
      isTriggered,
      start,
      end,
      totalSpend,
      totalRevenue,
      totalLeads,
      tabBudget,
      budgetWarning:
        metric === 'budget_percentage' && (!tabBudget || tabBudget <= 0)
          ? 'Esta pestaña no tiene un Presupuesto Objetivo configurado. Ve a Ajustes de Sistema → Pestañas del cliente para configurarlo.'
          : null,
    };
  } catch (err: any) {
    return { error: err.message || 'Error al probar regla' };
  }
}

async function requireSuperAdmin(): Promise<{ ok: true } | { ok: false; error: string }> {
  // Sesión y rol memoizados por petición (`lib/auth-session.ts`). Antes cada
  // llamada a este guard hacía su propio getUser() + lectura de user_profiles,
  // así que una página que invoca 7 acciones pagaba 7 veces las dos consultas.
  const { userId, role } = await getSesionActual();
  if (!userId) return { ok: false, error: 'No autorizado' };
  if (!['superadmin'].includes(role)) {
    return { ok: false, error: 'Sin permisos de súper administrador' };
  }
  return { ok: true };
}

export async function getBrandingSettings() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('system_settings')
    .select('value')
    .eq('key', 'branding')
    .maybeSingle();

  if (error) {
    console.error('Error fetching branding settings:', error);
    return null;
  }
  return data?.value || null;
}

export async function updateBrandingSettings(brandingValue: {
  logo_url: string;
  favicon_url?: string;
  app_name?: string;
  app_tag?: string;
  utm_name?: string;
  utm_tag?: string;
  colors: { primary: string; secondary: string };
}) {
  const guard = await requireSuperAdmin();
  if (!guard.ok) return { error: guard.error };

  const supabase = await createAdminClient();
  const { error } = await supabase.from('system_settings').upsert({
    key: 'branding',
    value: brandingValue,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.error('Error updating branding settings:', error);
    return { error: error.message };
  }

  // El branding va cacheado (`lib/branding.ts`): sin invalidar la etiqueta, el
  // cambio no se vería hasta que expirase el revalidate de 5 min. `updateTag`
  // y no `revalidateTag` porque esto es una server action y el admin tiene que
  // ver su propio cambio en la siguiente petición, sin stale-while-revalidate.
  updateTag(BRANDING_CACHE_TAG);
  revalidatePath('/', 'layout');
  return { success: true };
}
