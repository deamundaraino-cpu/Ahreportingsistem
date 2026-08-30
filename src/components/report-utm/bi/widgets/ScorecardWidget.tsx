'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, TrendingDown, Minus, Loader2, Target } from 'lucide-react';
import type { BiFilters, WidgetConfig, CalculatedField, ScorecardThreshold } from '../BiTypes';
import { WIDGET_FORMULA_KEY } from '../BiTypes';
import type { BiMetric, ClienteGoals, GoalStatus } from '@/lib/report-utm/bi-metadata';
import {
  METRIC_META,
  fieldMetricLabel,
  fieldMetricFormat,
  offlineFieldLabel,
  offlineFieldFormat,
  sheetFieldLabel,
  sheetFieldFormat,
  leadSegLabel,
  metricGlossary,
  isLowerBetter,
  evaluateGoal,
} from '@/lib/report-utm/bi-metadata';
import { fetchClienteGoals } from '@/lib/report-utm/client-goals';
import { useBiQueryBase } from '../BiQueryContext';
import { appendWidgetFilters, widgetFilterSignature } from '../widgetQuery';
import { HelpTip } from '../HelpTip';
import { readUnavailable, readValue, UnavailableNote } from '../widgetDiagnostics';
import type { WidgetUnavailable } from '../widgetDiagnostics';

interface Props {
  title: string;
  config: WidgetConfig;
  filters: BiFilters;
  calculatedFields?: CalculatedField[];
}

type ValFormat = 'number' | 'currency' | 'percent' | 'ratio';

/** `decimals` (campos calculados) fija los decimales y desactiva el abreviado k/M. */
function formatVal(value: number, format: ValFormat, decimals?: number): string {
  if (decimals !== undefined) {
    const n = value.toLocaleString('es-AR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    if (format === 'percent') return `${n}%`;
    if (format === 'ratio') return `${n}x`;
    return n;
  }
  if (format === 'currency') {
    return value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (format === 'percent') return `${value.toFixed(1)}%`;
  if (format === 'ratio') return `${value.toFixed(2)}x`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('es-AR');
}

export function ScorecardWidget({ title, config, filters, calculatedFields = [] }: Props) {
  const queryBase = useBiQueryBase();
  // Una sola firma para todo lo que obliga a recargar: filtros del informe +
  // filtro propio del widget. Ver widgetQuery.ts.
  const filterSig = widgetFilterSignature(filters, config);
  const [value, setValue] = useState<number | null>(null);
  const [prev, setPrev] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [goals, setGoals] = useState<ClienteGoals | null>(null);
  /** Motivo por el que esta métrica no se pudo medir, si es el caso. */
  const [naInfo, setNaInfo] = useState<WidgetUnavailable | null>(null);

  const compare = !!config.compare_period;
  // Fórmula propia del widget: manda sobre `metric` y viaja bajo una clave fija.
  const formula = config.formula?.trim();
  const metric = formula ? WIDGET_FORMULA_KEY : String(config.metric ?? 'leads_count');

  // El metric puede ser una métrica base, un campo calculado o una métrica de campo.
  const calcField = calculatedFields.find((c) => c.name === metric);
  const format: ValFormat = formula
    ? (config.formula_format ?? 'number')
    : ((calcField?.format ??
        METRIC_META[metric as BiMetric]?.format ??
        fieldMetricFormat(metric) ??
        offlineFieldFormat(metric) ??
        sheetFieldFormat(metric) ??
        'number') as ValFormat);
  const decimals = formula ? config.formula_decimals : calcField?.decimals;
  const label = formula
    ? formula
    : (METRIC_META[metric as BiMetric]?.label ??
      fieldMetricLabel(metric) ??
      offlineFieldLabel(metric) ??
      sheetFieldLabel(metric) ??
      leadSegLabel(metric) ??
      calcField?.name ??
      metric);

  useEffect(() => {
    setLoading(true);
    setError(null);

    // Con fórmula no se piden métricas: el motor deduce qué traer leyendo los
    // identificadores de la expresión.
    const params = new URLSearchParams({ metrics: formula ? '' : metric, dimension: 'none' });
    if (formula) params.set(`calc[${WIDGET_FORMULA_KEY}]`, formula);
    if (compare) params.set('type', 'compare');
    if (filters.cliente_id) params.set('cliente_id', filters.cliente_id);
    if (filters.date_from) params.set('date_from', filters.date_from);
    if (filters.date_to) params.set('date_to', filters.date_to);
    appendWidgetFilters(params, filters, config);
    if (calcField) params.set(`calc[${calcField.name}]`, calcField.expression);

    fetch(`${queryBase}?${params}`)
      .then((r) => r.json())
      .then((json) => {
        // Un hueco NO es un cero: `readValue` conserva el null y el
        // render lo pinta como «—» con su explicación. Antes esto era
        // `Number(row[metric] ?? 0)`, así que "no se pudo medir" y
        // "salió cero" se veían igual.
        const na = readUnavailable(json.meta, metric);
        setNaInfo(na);
        if (compare) {
          setValue(readValue(json.data?.current?.[0], metric, na));
          setPrev(readValue(json.data?.previous?.[0], metric, na));
        } else {
          setValue(readValue(json.data?.[0], metric, na));
          setPrev(null);
        }
      })
      .catch(() => setError('Error al cargar'))
      .finally(() => setLoading(false));
  }, [queryBase, metric, formula, calcField?.expression, compare, filterSig]);

  // Metas del cliente para el semáforo (una sola petición por cliente).
  const clienteId = filters.cliente_id;
  useEffect(() => {
    let cancelled = false;
    const load = clienteId
      ? fetchClienteGoals(clienteId)
      : Promise.resolve<ClienteGoals | null>(null);
    load.then((g) => {
      if (!cancelled) setGoals(g);
    });
    return () => {
      cancelled = true;
    };
  }, [clienteId]);

  const delta =
    compare && prev !== null && prev !== 0 && value !== null ? ((value - prev) / prev) * 100 : null;

  const variant = config.variant ?? 'default';
  // Semáforo por umbrales propios del widget. Cuando está configurado manda
  // sobre el semáforo por metas del cliente (que sigue siendo el default).
  const thresholdStatus =
    variant === 'threshold' && value !== null ? evalThreshold(value, config.threshold) : null;
  const goal =
    thresholdStatus === null && value !== null ? evaluateGoal(metric, value, goals) : null;
  const accentStatus = thresholdStatus ?? goal?.status ?? null;
  const glossary = metricGlossary(metric);

  // Progreso hacia el objetivo del widget (0-100, tolera superarlo).
  const target = config.target;
  const progressPct =
    variant === 'progress' && value !== null && target && target > 0
      ? Math.min(100, Math.max(0, (value / target) * 100))
      : null;

  return (
    <div
      className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-3 h-full"
      style={accentStatus ? { borderLeft: `3px solid ${GOAL_COLOR[accentStatus]}` } : undefined}
    >
      <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground min-w-0">
        <span className="truncate" title={title}>
          {title}
        </span>
        {glossary && <HelpTip text={glossary} size={12} />}
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Cargando…</span>
        </div>
      ) : error ? (
        <p className="text-xs text-red-500">{error}</p>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-end gap-1">
            {format === 'currency' && (
              <span className="text-base font-medium text-muted-foreground pb-0.5">$ </span>
            )}
            <p
              className="text-3xl font-bold font-mono tabular-nums leading-none text-foreground"
              style={thresholdStatus ? { color: GOAL_COLOR[thresholdStatus] } : undefined}
            >
              {value !== null ? formatVal(value, format, decimals) : '—'}
            </p>
          </div>
          {progressPct !== null && (
            <div className="space-y-1 pt-0.5">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${progressPct}%`, background: '#10b981' }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {progressPct.toFixed(0)}% del objetivo ({formatVal(target as number, format)})
              </p>
            </div>
          )}
          {compare && delta !== null && (
            <div className="flex items-center gap-1.5">
              <DeltaBadge delta={delta} lowerIsBetter={isLowerBetter(metric)} />
              <span className="text-[10px] text-muted-foreground">vs período anterior</span>
            </div>
          )}
          {goal && (
            <div className="flex items-center gap-1" style={{ color: GOAL_COLOR[goal.status] }}>
              <Target className="h-3 w-3" />
              <span className="text-[10px] font-medium">
                Meta: {goal.mustNotExceed ? '≤' : '≥'} {formatVal(goal.target, format)}
                {' · '}
                {GOAL_TEXT[goal.status]}
              </span>
            </div>
          )}
          {/* El «—» de arriba dice QUE no se pudo medir; esto dice POR QUÉ. */}
          <UnavailableNote info={naInfo} />
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">{label}</p>
    </div>
  );
}

/**
 * Semáforo por umbrales del widget: verde si cumple el umbral verde, ámbar si
 * cumple el ámbar, rojo si no cumple ninguno. Sin umbrales configurados no pinta
 * nada (devuelve null) y el scorecard cae al semáforo por metas del cliente.
 */
function evalThreshold(value: number, t: ScorecardThreshold | undefined): GoalStatus | null {
  if (!t || !Number.isFinite(t.green) || !Number.isFinite(t.yellow)) return null;
  const ok = (op: 'gte' | 'lte', ref: number) => (op === 'gte' ? value >= ref : value <= ref);
  if (ok(t.greenOp, t.green)) return 'good';
  if (ok(t.yellowOp, t.yellow)) return 'warn';
  return 'bad';
}

const GOAL_COLOR: Record<GoalStatus, string> = {
  good: '#10b981',
  warn: '#f59e0b',
  bad: '#ef4444',
};

const GOAL_TEXT: Record<GoalStatus, string> = {
  good: 'cumplida',
  warn: 'cerca',
  bad: 'sin cumplir',
};

/**
 * Badge de variación. El color depende del SENTIDO de la métrica: en costos
 * (CPL, CPA, CPC) que el número baje es una buena noticia, así que un delta
 * negativo se pinta en verde.
 */
function DeltaBadge({ delta, lowerIsBetter }: { delta: number; lowerIsBetter?: boolean }) {
  if (Math.abs(delta) <= 0.05) {
    return (
      <span className="flex items-center gap-0.5 text-muted-foreground text-xs">
        <Minus className="h-3 w-3" />
        0%
      </span>
    );
  }
  const rising = delta > 0;
  const isGood = lowerIsBetter ? !rising : rising;
  const Icon = rising ? TrendingUp : TrendingDown;
  const cls = isGood ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500';
  return (
    <span className={`flex items-center gap-0.5 text-xs font-medium ${cls}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(delta).toFixed(1)}%
    </span>
  );
}
