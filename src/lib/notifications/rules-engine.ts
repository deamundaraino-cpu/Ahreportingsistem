import { type SupabaseClient } from '@supabase/supabase-js';
import { parseISO, subDays, format, startOfMonth, endOfMonth } from 'date-fns';
import { colombiaToday, colombiaYesterday } from '@/lib/date-utils';
import {
  enrichMetaRow,
  enrichTikTokRow,
  parseTabFilter,
  type AnyCampaignFilter,
} from '@/lib/campaign-filter';
import { notifyUsers } from '@/lib/notifications/notify';
import { sendWhatsAppNotification } from '@/lib/whatsapp/notify';
import {
  cargarConversor,
  convertirFilasMetricas,
  monedaDeClientePublico,
  prefijoMoneda,
  simboloMoneda,
  type ConversorMoneda,
  type MonedaReporte,
} from '@/lib/moneda-reporte';

/**
 * Columnas de facturación neta de Hotmart que forman los ingresos. Es la misma
 * definición que `total_facturacion_neta` del motor de fórmulas: principal,
 * bump, upsell y downsell. Nada más — en particular NO `VENTAS_CERRADAS` de
 * `metricas_manuales`, que es un CONTEO de ventas y no dinero.
 */
export const COLUMNAS_INGRESOS = [
  'ventas_principal',
  'ventas_bump',
  'ventas_upsell',
  'ventas_downsell',
] as const;

/**
 * Ingresos de Hotmart de un conjunto de filas de `metricas_diarias`, en la
 * moneda de reporte del cliente.
 *
 * Hotmart se guarda en USD y el gasto en la moneda de la cuenta publicitaria:
 * comparar uno con otro sin convertir daba, en Cris (CLP), un ROAS ~900 veces
 * menor que el real. La conversión es la del dashboard (`convertirFilasMetricas`,
 * fila a fila con la tasa de su día), así que la alerta y la pantalla dan la
 * misma cifra. Cada fila necesita su `fecha` para elegir la tasa.
 */
export function ingresosEnMonedaReporte(
  filas: Array<Record<string, unknown>>,
  conv: ConversorMoneda
): number {
  let total = 0;
  for (const fila of convertirFilasMetricas(filas, conv)) {
    for (const col of COLUMNAS_INGRESOS) total += Number(fila[col]) || 0;
  }
  return total;
}

export interface RuleRow {
  id: string;
  cliente_id: string | null;
  tab_id: string | null;
  nombre: string;
  metric: 'budget_percentage' | 'roas' | 'cpl' | 'spend' | 'revenue' | 'leads';
  operator: '>' | '<' | '>=' | '<=';
  value: number;
  time_window:
    'today' | 'yesterday' | 'last_7_days' | 'last_30_days' | 'current_tab_period' | 'custom_range';
  custom_start: string | null;
  custom_end: string | null;
  channels: ('in_app' | 'whatsapp')[];
  cooldown_hours: number;
  last_triggered_at: string | null;
  enabled: boolean;
}

/** Lo que mide una regla sobre un cliente y una pestaña en un rango. */
export interface MedicionRegla {
  /** `null` = no se puede medir (`budget_percentage` sin presupuesto). */
  actualValue: number | null;
  totalSpend: number;
  totalRevenue: number;
  totalLeads: number;
  /** Moneda del gasto y de los ingresos (la de reporte del cliente). */
  moneda: MonedaReporte;
  /** Días cuyos ingresos quedaron en USD por no haber ninguna tasa. */
  diasSinTasa: number;
}

/**
 * Mide la métrica de una regla. Es la ÚNICA definición: la usan la evaluación
 * de verdad (`evaluateAlertRules`) y el botón «Probar regla» de ajustes. Antes
 * el botón tenía su propia copia, que sumaba los ingresos en USD contra un gasto
 * en pesos, olvidaba el downsell y sumaba `VENTAS_CERRADAS` (un conteo) como
 * dinero: la prueba decía una cosa y la alerta hacía otra.
 */
export async function medirRegla(
  db: SupabaseClient,
  p: {
    clientId: string;
    metric: RuleRow['metric'];
    start: string;
    end: string;
    keywordFilter: AnyCampaignFilter;
    campaignGroups: any[];
    tabBudget: number | null;
    /** Si ya se conoce (se resuelve una vez por cliente); si no, se busca. */
    moneda?: MonedaReporte;
    clientName?: string;
  }
): Promise<MedicionRegla> {
  const moneda = p.moneda ?? (await monedaDeClientePublico(db, p.clientId));
  const { data: metricsRows, error: metricsError } = await db
    .from('metricas_diarias')
    .select(
      'fecha, meta_spend, tiktok_spend, meta_campaigns, tiktok_campaigns, ' +
        'ga_sessions, hotmart_pagos_iniciados, ' +
        COLUMNAS_INGRESOS.join(', ')
    )
    .eq('cliente_id', p.clientId)
    .gte('fecha', p.start)
    .lte('fecha', p.end);
  if (metricsError) throw new Error(metricsError.message);

  let totalSpend = 0;
  let totalLeads = 0;
  const filas = (metricsRows ?? []) as unknown as Array<Record<string, any>>;
  for (const row of filas) {
    const enrichedRow = enrichTikTokRow(
      enrichMetaRow(row, p.keywordFilter, p.campaignGroups),
      p.keywordFilter,
      p.campaignGroups
    );
    totalSpend += (Number(enrichedRow.meta_spend) || 0) + (Number(enrichedRow.tiktok_spend) || 0);
    totalLeads +=
      (Number(enrichedRow.meta_leads) || 0) + (Number(enrichedRow.tiktok_conversions) || 0);
  }

  // Ingresos en la moneda del gasto. Solo se carga el conversor si la regla los
  // necesita: el resto de métricas no tocan dinero de Hotmart.
  let totalRevenue = 0;
  let diasSinTasa = 0;
  if (p.metric === 'revenue' || p.metric === 'roas') {
    const conv = await cargarConversor(db, moneda, p.start, p.end);
    totalRevenue = ingresosEnMonedaReporte(filas, conv);
    diasSinTasa = conv.sinTasa.size;
    if (diasSinTasa > 0) {
      console.warn(
        `[rules-engine] Sin tasa USD→${conv.moneda} en ${diasSinTasa} día(s) para ${p.clientName ?? p.clientId}: esos ingresos quedan en USD.`
      );
    }
  }

  let actualValue: number | null = 0;
  switch (p.metric) {
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
      actualValue = p.tabBudget && p.tabBudget > 0 ? (totalSpend / p.tabBudget) * 100 : null;
      break;
  }
  return { actualValue, totalSpend, totalRevenue, totalLeads, moneda, diasSinTasa };
}

/** ¿El valor cumple la condición de la regla? */
export function cumpleCondicion(
  actual: number,
  operator: RuleRow['operator'],
  threshold: number
): boolean {
  switch (operator) {
    case '>':
      return actual > threshold;
    case '<':
      return actual < threshold;
    case '>=':
      return actual >= threshold;
    case '<=':
      return actual <= threshold;
    default:
      return false;
  }
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
  db: SupabaseClient,
  options: { force?: boolean } = {}
): Promise<{ evaluated: number; triggered: number }> {
  // force = true → ejecución manual de prueba ("Evaluar Ahora"): ignora el
  // cooldown (reenvía aunque ya se haya disparado) y NO lo escribe, para no
  // suprimir la corrida automática de la madrugada. El worker llama sin force.
  const { force = false } = options;
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
    for (const cd of cooldownRows ?? []) {
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
            .select(
              'id, nombre, keyword_meta, presupuesto_objetivo, fecha_inicio, fecha_finalizacion'
            )
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
            .select(
              'id, nombre, keyword_meta, presupuesto_objetivo, fecha_inicio, fecha_finalizacion'
            )
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

        // Moneda de reporte del cliente: la del gasto, y a la que se convierten
        // los ingresos de Hotmart (guardados en USD) antes de compararlos.
        const moneda = await monedaDeClientePublico(db, clientId);

        for (const tab of activeTabs) {
          evaluated++;

          try {
            // D. Check per-tab cooldown (skipped on forced manual evaluation)
            const cooldownKey = `${rule.id}|${clientId}|${tab.id}`;
            if (!force) {
              const lastTriggeredTs = cooldownMap.get(cooldownKey);
              if (lastTriggeredTs !== undefined) {
                const cooldownMs = rule.cooldown_hours * 60 * 60 * 1000;
                if (Date.now() - lastTriggeredTs < cooldownMs) {
                  continue; // This tab is still in cooldown for this rule
                }
              }
            }

            // E. Resolve date range (per-tab context: tab's own dates if current_tab_period)
            const { start, end } = resolveTabDateRange(rule, tab, today);

            // F-H. Medir la métrica en esta pestaña (misma función que «Probar regla»).
            const tabBudget = tab.presupuesto_objetivo ? Number(tab.presupuesto_objetivo) : null;
            const medida = await medirRegla(db, {
              clientId,
              metric: rule.metric,
              start,
              end,
              keywordFilter: parseTabFilter(tab.keyword_meta),
              campaignGroups: campaignGroups ?? [],
              tabBudget,
              moneda,
              clientName,
            });
            // Sin presupuesto configurado, el % de presupuesto no se puede medir.
            if (medida.actualValue === null) continue;
            const { actualValue, totalSpend } = medida;

            // I. Evaluate the condition
            const isTriggered = cumpleCondicion(actualValue, rule.operator, Number(rule.value));

            if (isTriggered) {
              triggered++;

              // J. Dispatch alert (in-app + WhatsApp based on rule.channels)
              await fireAlert(
                db,
                rule,
                clientId,
                clientName,
                tab.nombre,
                tab.id,
                actualValue,
                start,
                end,
                moneda,
                totalSpend,
                tabBudget
              );

              // K. Update per-tab cooldown in DB (skipped on forced manual
              // evaluation so it doesn't suppress the scheduled nightly run)
              if (!force) {
                await db.from('notification_rule_cooldowns').upsert(
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
  moneda: string,
  totalSpend?: number,
  tabBudget?: number | null
) {
  // Los importes llevan su moneda: «$» mientras el cliente reporte en dólares,
  // el código ISO («CLP 233,487») en cuanto reporta en otra.
  const prefijo = prefijoMoneda(simboloMoneda(moneda, moneda));
  const esDinero = rule.metric === 'spend' || rule.metric === 'revenue' || rule.metric === 'cpl';
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
      ? `${prefijo}${totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : '—';
    const budgetStr = tabBudget
      ? `${prefijo}${tabBudget.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
      : '—';
    message = `Cliente: ${clientName} — pestaña "${tabName}" alcanzó el ${fmtVal}% del presupuesto (${spendStr} de un objetivo de ${budgetStr}).`;
  } else {
    title = `Alerta: ${metricLabels[rule.metric] || rule.metric}`;
    const periodStr = windowLabels[rule.time_window] ?? `${start} al ${end}`;
    const valor = esDinero ? `${prefijo}${fmtVal}` : fmtVal;
    const limite = esDinero ? `${prefijo}${fmtThreshold}` : fmtThreshold;
    message = `Cliente: ${clientName} — pestaña "${tabName}" tiene ${metricLabels[rule.metric] || rule.metric} de ${valor}, que es ${rule.operator} al límite de ${limite} (Periodo: ${periodStr}).`;
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
