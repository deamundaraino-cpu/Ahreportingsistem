import { type SupabaseClient } from '@supabase/supabase-js';
import { parseISO, subDays, format, startOfMonth, endOfMonth } from 'date-fns';
import { colombiaToday, colombiaYesterday } from '@/lib/date-utils';
import { enrichMetaRow, enrichTikTokRow } from '@/lib/campaign-filter';
import { notifyUsers } from '@/lib/notifications/notify';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';

export interface RuleRow {
  id: string;
  cliente_id: string | null;
  tab_id: string | null;
  nombre: string;
  metric: 'budget_percentage' | 'roas' | 'cpl' | 'spend' | 'revenue' | 'leads';
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  time_window: 'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'current_tab_period' | 'custom_range';
  custom_start: string | null;
  custom_end: string | null;
  channels: ('in_app' | 'whatsapp')[];
  cooldown_hours: number;
  last_triggered_at: string | null;
  enabled: boolean;
}

interface TabInfo {
  id: string;
  nombre: string;
  keyword_meta: string | null;
  presupuesto_objetivo: number | null;
  fecha_inicio: string;
  fecha_finalizacion: string;
}

/**
 * Evaluates all enabled notification rules.
 *
 * For each rule, resolves ALL ACTIVE TABS of each target client:
 *   - Active tab = fecha_finalizacion > today (strictly future end date)
 *   - Evaluates the metric independently per tab (filtered by keyword_meta)
 *   - Cooldown is tracked per (rule, client, tab) in notification_rule_cooldowns
 *   - If a rule specifies a particular tab_id, only that tab is evaluated
 */
export async function evaluateAlertRules(
  db: SupabaseClient
): Promise<{ evaluated: number; triggered: number }> {
  let evaluated = 0;
  let triggered = 0;

  try {
    const today = colombiaToday();

    // 1. Fetch all enabled rules
    const { data: rules, error: rulesError } = await db
      .from('notification_rules')
      .select('*')
      .eq('enabled', true);

    if (rulesError || !rules || rules.length === 0) {
      if (rulesError) console.error('[rules-engine] Error fetching rules:', rulesError.message);
      return { evaluated: 0, triggered: 0 };
    }

    // 2. Fetch clients once
    const { data: clients } = await db.from('clientes').select('id, nombre');
    const clientMap = new Map<string, string>((clients ?? []).map((c: any) => [c.id, c.nombre]));

    // 3. Fetch all per-tab cooldowns for active rules
    const ruleIds = (rules as RuleRow[]).map((r) => r.id);
    const { data: cooldownRows } = await db
      .from('notification_rule_cooldowns')
      .select('rule_id, cliente_id, tab_id, last_triggered_at')
      .in('rule_id', ruleIds);

    // Build a Map keyed by "ruleId|clientId|tabId" for O(1) cooldown checks
    const cooldownMap = new Map<string, number>();
    for (const cd of (cooldownRows ?? [])) {
      const key = `${cd.rule_id}|${cd.cliente_id}|${cd.tab_id}`;
      cooldownMap.set(key, new Date(cd.last_triggered_at).getTime());
    }

    for (const rule of rules as RuleRow[]) {
      // A. Resolve target client IDs
      let targetClientIds: string[] = [];
      if (rule.cliente_id) {
        targetClientIds = [rule.cliente_id];
      } else {
        targetClientIds = Array.from(clientMap.keys());
      }

      for (const clientId of targetClientIds) {
        const clientName = clientMap.get(clientId) ?? 'Cliente';

        // B. Resolve active tabs for this client
        let activeTabs: TabInfo[] = [];

        if (rule.tab_id) {
          // A specific tab was configured – only use that one (and check it's not expired)
          const { data: tab } = await db
            .from('cliente_tabs')
            .select('id, nombre, keyword_meta, presupuesto_objetivo, fecha_inicio, fecha_finalizacion')
            .eq('id', rule.tab_id)
            .single();

          // Include the tab only if its end date is strictly after today
          if (tab && tab.fecha_finalizacion > today) {
            activeTabs = [tab as TabInfo];
          }
        } else {
          // No specific tab → iterate through ALL active tabs of this client
          // Active: fecha_finalizacion strictly > today (expired tabs are discarded)
          const { data: tabs } = await db
            .from('cliente_tabs')
            .select('id, nombre, keyword_meta, presupuesto_objetivo, fecha_inicio, fecha_finalizacion')
            .eq('cliente_id', clientId)
            .gt('fecha_finalizacion', today); // strictly after today

          activeTabs = (tabs ?? []) as TabInfo[];
        }

        // If no active tabs for this client, skip silently
        if (activeTabs.length === 0) continue;

        // C. Fetch campaign groups once per client (for enrichment/filtering)
        const { data: campaignGroups } = await db
          .from('campaign_groups')
          .select('id, nombre, campaign_group_mappings(campaign_id, campaign_name_pattern)')
          .eq('cliente_id', clientId);

        for (const tab of activeTabs) {
          evaluated++;

          try {
            // D. Check per-tab cooldown
            const cooldownKey = `${rule.id}|${clientId}|${tab.id}`;
            const lastTriggeredTs = cooldownMap.get(cooldownKey);
            if (lastTriggeredTs !== undefined) {
              const cooldownMs = rule.cooldown_hours * 60 * 60 * 1000;
              if (Date.now() - lastTriggeredTs < cooldownMs) {
                continue; // This tab is still in cooldown for this rule
              }
            }

            // E. Resolve date range (per-tab context: tab's own dates if current_tab_period)
            const { start, end } = resolveTabDateRange(rule, tab, today);

            // F. Query daily metrics for this client in the date range
            const { data: metricsRows, error: metricsError } = await db
              .from('metricas_diarias')
              .select(
                'fecha, meta_spend, tiktok_spend, meta_campaigns, tiktok_campaigns, ' +
                'ga_sessions, hotmart_pagos_iniciados, ventas_principal, ventas_bump, ' +
                'ventas_upsell, metricas_manuales'
              )
              .eq('cliente_id', clientId)
              .gte('fecha', start)
              .lte('fecha', end);

            if (metricsError) {
              console.error(`[rules-engine] Metrics query error for client ${clientId} tab ${tab.nombre}:`, metricsError.message);
              continue;
            }

            const keywordFilter = tab.keyword_meta || '';
            const tabBudget = tab.presupuesto_objetivo ? Number(tab.presupuesto_objetivo) : null;

            // G. Aggregate metrics filtered by this tab's keyword
            let totalSpend = 0;
            let totalRevenue = 0;
            let totalLeads = 0;

            for (const row of ((metricsRows ?? []) as any[])) {
              const enrichedRow = enrichTikTokRow(
                enrichMetaRow(row, keywordFilter || undefined, campaignGroups ?? []),
                keywordFilter || undefined,
                campaignGroups ?? []
              );
              totalSpend +=
                (Number(enrichedRow.meta_spend) || 0) +
                (Number(enrichedRow.tiktok_spend) || 0);

              const manuales = (row.metricas_manuales as Record<string, number>) ?? {};
              const ventasCerradas = Number(manuales['VENTAS_CERRADAS'] ?? 0);
              totalRevenue +=
                (Number(row.ventas_principal) || 0) +
                (Number(row.ventas_bump) || 0) +
                (Number(row.ventas_upsell) || 0) +
                ventasCerradas;

              totalLeads +=
                (Number(enrichedRow.meta_leads) || 0) +
                (Number(enrichedRow.tiktok_conversions) || 0);
            }

            // H. Calculate the target metric value
            let actualValue = 0;
            switch (rule.metric) {
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
                  // No budget configured for this tab – skip silently
                  continue;
                }
                break;
            }

            // I. Evaluate the condition
            let isTriggered = false;
            const threshold = Number(rule.value);
            switch (rule.operator) {
              case '>':  isTriggered = actualValue > threshold;  break;
              case '<':  isTriggered = actualValue < threshold;  break;
              case '>=': isTriggered = actualValue >= threshold; break;
              case '<=': isTriggered = actualValue <= threshold; break;
            }

            if (isTriggered) {
              triggered++;

              // J. Dispatch alert (in-app + WhatsApp based on rule.channels)
              await fireAlert(
                db, rule, clientId, clientName,
                tab.nombre, tab.id,
                actualValue, start, end,
                totalSpend, tabBudget
              );

              // K. Update per-tab cooldown in DB
              await db
                .from('notification_rule_cooldowns')
                .upsert(
                  {
                    rule_id: rule.id,
                    cliente_id: clientId,
                    tab_id: tab.id,
                    last_triggered_at: new Date().toISOString(),
                  },
                  { onConflict: 'rule_id,cliente_id,tab_id' }
                );

              // Update in-memory map to prevent double-firing in same evaluation pass
              cooldownMap.set(cooldownKey, Date.now());
            }
          } catch (err) {
            console.error(
              `[rules-engine] Error evaluating rule "${rule.nombre}" for client ${clientId}, tab "${tab.nombre}":`,
              err
            );
          }
        }
      }
    }
  } catch (e) {
    console.error('[rules-engine] Fatal evaluation error:', e);
  }

  return { evaluated, triggered };
}

/**
 * Resolves the start/end dates for a rule evaluation in the context of a specific tab.
 * When time_window is 'current_tab_period', uses the tab's own fecha_inicio/fecha_finalizacion.
 */
function resolveTabDateRange(
  rule: RuleRow,
  tab: TabInfo,
  today: string
): { start: string; end: string } {
  const yesterday = colombiaYesterday();

  switch (rule.time_window) {
    case 'today':
      return { start: today, end: today };
    case 'yesterday':
      return { start: yesterday, end: yesterday };
    case 'last_7_days': {
      const start = format(subDays(parseISO(today), 6), 'yyyy-MM-dd');
      return { start, end: today };
    }
    case 'last_30_days': {
      const start = format(subDays(parseISO(today), 29), 'yyyy-MM-dd');
      return { start, end: today };
    }
    case 'current_tab_period':
      // Use the tab's own configured period dates
      return { start: tab.fecha_inicio, end: tab.fecha_finalizacion };
    case 'custom_range': {
      const start = rule.custom_start ?? format(startOfMonth(new Date()), 'yyyy-MM-dd');
      const end = rule.custom_end ?? format(endOfMonth(new Date()), 'yyyy-MM-dd');
      return { start, end };
    }
    default:
      return { start: today, end: today };
  }
}

/**
 * Dispatches the alert notification through configured channels (in-app and/or WhatsApp).
 * Does NOT update the cooldown (caller is responsible for that).
 */
async function fireAlert(
  db: SupabaseClient,
  rule: RuleRow,
  clientId: string,
  clientName: string,
  tabName: string,
  tabId: string,
  actualValue: number,
  start: string,
  end: string,
  totalSpend?: number,
  tabBudget?: number | null
) {
  const metricLabels: Record<string, string> = {
    budget_percentage: 'Porcentaje de Presupuesto',
    roas: 'ROAS',
    cpl: 'CPL',
    spend: 'Gasto Total',
    revenue: 'Ingresos Totales',
    leads: 'Leads Totales',
  };

  const windowLabels: Record<string, string> = {
    today: 'Hoy',
    yesterday: 'Ayer',
    last_7_days: 'Últimos 7 días',
    last_30_days: 'Últimos 30 días',
    current_tab_period: 'Periodo de pestaña',
    custom_range: `${start} al ${end}`,
  };

  const fmtVal = actualValue.toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });

  const fmtThreshold = rule.value.toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });

  let title = '';
  let message = '';

  if (rule.metric === 'budget_percentage') {
    title = `Alerta: Presupuesto al ${fmtVal}%`;
    const spendStr = totalSpend
      ? `$${totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : '—';
    const budgetStr = tabBudget
      ? `$${tabBudget.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : '—';
    message = `Cliente: ${clientName} — pestaña "${tabName}" alcanzó el ${fmtVal}% del presupuesto (${spendStr} de un objetivo de ${budgetStr}).`;
  } else {
    title = `Alerta: ${metricLabels[rule.metric] || rule.metric}`;
    const periodStr = windowLabels[rule.time_window] ?? `${start} al ${end}`;
    message = `Cliente: ${clientName} — pestaña "${tabName}" tiene ${metricLabels[rule.metric] || rule.metric} de ${fmtVal}, que es ${rule.operator} al límite de ${fmtThreshold} (Periodo: ${periodStr}).`;
  }

  // In-App Notification
  if (rule.channels.includes('in_app')) {
    await notifyUsers({
      db,
      type: rule.metric === 'budget_percentage' ? 'alert_threshold' : 'alert_metric',
      severity: rule.operator === '<' || rule.operator === '<=' ? 'error' : 'warning',
      clienteId: clientId,
      title,
      message,
      link: `/dashboard/${clientId}?tab=${tabId}`,
    });
  }

  // WhatsApp Notification
  if (rule.channels.includes('whatsapp')) {
    await sendWhatsAppNotification({
      db,
      clienteId: clientId,
      notificationType: 'alert_threshold',
      message: `🚨 *${title}*\n\n${message}`,
      // Alertas: notifica SIEMPRE al grupo general del equipo y además al
      // grupo del cliente si lo tiene (unión deduplicada).
      includeTeamAlertGroup: true,
    });
  }
}
