'use client';

import React, { useState, useMemo, useEffect } from 'react';
import {
  Area,
  Bar,
  Line,
  PieChart,
  Pie,
  Cell,
  PolarGrid,
  ScatterChart,
  Scatter,
  ZAxis,
  ComposedChart,
  RadialBarChart,
  RadialBar,
  FunnelChart,
  Funnel,
  LabelList,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { evaluateFormula, aggregateFormula } from '@/lib/formula-engine';
import { format, parseISO, isValid, startOfWeek, startOfMonth, startOfYear } from 'date-fns';
import { es } from 'date-fns/locale';
import type { ChartDef, TabCampaignFilter } from '@/lib/layout-types';
import { enrichMetaRow } from '@/lib/campaign-filter';
import { enrichOfflineRow } from '@/lib/offline-filter';
import { aggregateRankingRows, dimensionSoportaRespuestas } from '@/lib/ranking-aggregation';
import { reDerivarRespuestas } from '@/lib/dashboard/lead-answer-row';
import { formulaUsaRespuestas } from '@/lib/dashboard/lead-answer-aggregation';

// ─── Palette ──────────────────────────────────────────────────────────────────
const PALETTE: Record<string, string> = {
  amber: '#f59e0b',
  cyan: '#22d3ee',
  blue: '#60a5fa',
  violet: '#a78bfa',
  emerald: '#34d399',
  rose: '#fb7185',
  orange: '#fb923c',
  red: '#f87171',
  green: '#4ade80',
  indigo: '#818cf8',
  pink: '#f472b6',
  teal: '#2dd4bf',
  lime: '#a3e635',
  sky: '#38bdf8',
  purple: '#c084fc',
};
const DEFAULT_COLORS = [
  'amber',
  'cyan',
  'violet',
  'emerald',
  'rose',
  'blue',
  'orange',
  'pink',
  'teal',
  'lime',
];

function hex(name: string) {
  return PALETTE[name] ?? '#94a3b8';
}

// ─── Labels ───────────────────────────────────────────────────────────────────
const FORMULA_LABELS: Record<string, string> = {
  meta_spend: 'Gasto Meta',
  meta_leads: 'Leads Meta',
  meta_clicks: 'Clics',
  meta_impressions: 'Impresiones',
  meta_reach: 'Alcance',
  meta_results: 'Resultados',
  meta_purchases: 'Compras',
  meta_link_clicks: 'Clics Enlace',
  meta_landing_page_views: 'Landing Views',
  meta_video_views: 'Video Views',
  hotmart_pagos_iniciados: 'Pagos Iniciados',
  ventas_principal: 'Ventas Principal',
  ventas_bump: 'Ventas Bump',
  ventas_upsell: 'Ventas Upsell',
  ga_sessions: 'Sesiones GA4',
  ga_bounce_rate: 'Rebote GA4',
  ga_avg_session_duration: 'Duración GA4',
};
function getLabel(f: string) {
  return FORMULA_LABELS[f] || f;
}

// ─── Formatters ───────────────────────────────────────────────────────────────
function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n % 1 === 0 ? String(Math.round(n)) : n.toFixed(1);
}

function fmtVal(n: number, unit?: string): string {
  if (unit === 'currency') {
    return `$${n.toLocaleString('es-ES', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  if (unit === 'percent') {
    return `${n.toFixed(1)}%`;
  }
  return fmt(n);
}

function fmtAxis(
  val: number,
  axisId: 'left' | 'right',
  yAxes?: ('left' | 'right')[],
  units?: string[]
): string {
  const seriesIndex = yAxes
    ? yAxes.findIndex((ax) => {
        const thisAxis = ax === 'right' ? 'right' : 'left';
        return thisAxis === axisId;
      })
    : axisId === 'left'
      ? 0
      : -1;

  const unit = seriesIndex !== -1 && units ? units[seriesIndex] : undefined;

  if (unit === 'currency') {
    if (Math.abs(val) >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
    if (Math.abs(val) >= 1_000) return `$${(val / 1_000).toFixed(1)}k`;
    return `$${val}`;
  }
  if (unit === 'percent') {
    return `${val}%`;
  }
  return fmt(val);
}

// ─── Grouped and Daily Data Builder ───────────────────────────────────────────
function buildGroupedData(
  metrics: any[],
  formulas: string[],
  periodicity: 'day' | 'week' | 'month' | 'year',
  varContext: Record<string, number> = {},
  sourceMapping: Record<string, string> = {},
  availablePlatforms?: Set<string>,
  customMetrics: Record<string, string> = {},
  campaignFilter?: import('@/lib/layout-types').CampaignFilterSpec,
  campaignGroups: any[] = [],
  sheetFilter?: import('@/lib/layout-types').SheetFilterSpec
): Array<Record<string, any>> {
  const validRows = metrics.filter((r: any) => {
    if (!r.fecha) return false;
    const d = parseISO(r.fecha);
    return isValid(d);
  });

  // Aplica filtro de campaña y de sheets a cada fila individualmente si están configurados
  const hasFilter =
    campaignFilter &&
    (Array.isArray(campaignFilter.value)
      ? campaignFilter.value.length > 0
      : campaignFilter.value !== '');
  const prepareRow = (row: any) => {
    let r = row;
    if (hasFilter) {
      r = enrichMetaRow(r, campaignFilter!, campaignGroups);
      // Igual que en `applyCompoundFilter`: `enrichMetaRow` solo recalcula
      // las claves `meta_*`, así que sin esto una gráfica con filtro propio
      // pintaba los contactos de todo el cliente contra un gasto recortado.
      const leads = reDerivarRespuestas(r, campaignFilter!);
      if (leads) r = { ...r, ...leads };
    }
    if (sheetFilter) {
      r = enrichOfflineRow(r, sheetFilter);
    }
    return r;
  };

  if (periodicity === 'day') {
    return validRows.map((row: any) => {
      const filteredRow = prepareRow(row);
      const pt: Record<string, any> = {
        date: format(parseISO(row.fecha), 'dd MMM', { locale: es }),
        rawDate: row.fecha,
      };
      formulas.forEach((f) => {
        const v = evaluateFormula(
          f,
          filteredRow,
          varContext,
          sourceMapping,
          availablePlatforms,
          customMetrics
        );
        pt[getLabel(f)] = v === null || isNaN(v as number) ? 0 : (v as number);
      });
      return pt;
    });
  }

  // Group rows by interval
  const groups: Record<string, { label: string; dateObj: Date; rows: any[] }> = {};

  validRows.forEach((row) => {
    const filteredRow = prepareRow(row);
    const d = parseISO(row.fecha);
    let key = '';
    let label = '';
    let dateObj = d;

    if (periodicity === 'week') {
      const start = startOfWeek(d, { weekStartsOn: 1 });
      key = format(start, 'yyyy-MM-dd');
      label = `Sem ${format(start, 'dd/MM', { locale: es })}`;
      dateObj = start;
    } else if (periodicity === 'month') {
      const start = startOfMonth(d);
      key = format(start, 'yyyy-MM');
      label = format(start, 'MMM yy', { locale: es });
      dateObj = start;
    } else if (periodicity === 'year') {
      const start = startOfYear(d);
      key = format(start, 'yyyy');
      label = format(start, 'yyyy', { locale: es });
      dateObj = start;
    }

    if (!groups[key]) {
      groups[key] = { label, dateObj, rows: [] };
    }
    groups[key].rows.push(filteredRow);
  });

  // Sort group keys to ensure chronological order
  const sortedKeys = Object.keys(groups).sort();

  return sortedKeys.map((key) => {
    const group = groups[key];
    const pt: Record<string, any> = {
      date: group.label,
      rawDate: key,
    };
    formulas.forEach((f) => {
      const v = aggregateFormula(
        f,
        group.rows,
        varContext,
        sourceMapping,
        availablePlatforms,
        customMetrics
      );
      pt[getLabel(f)] = v === null || isNaN(v as number) ? 0 : (v as number);
    });
    return pt;
  });
}

function buildDimensionData(
  metrics: any[],
  formulas: string[],
  dimension: 'campaigns' | 'ads' | 'adsets' | 'tiktok_campaigns' | 'tiktok_ads' | 'tiktok_adgroups',
  varContext: Record<string, number> = {},
  sourceMapping: Record<string, string> = {},
  availablePlatforms?: Set<string>,
  customMetrics: Record<string, string> = {},
  campaignFilter?: import('@/lib/layout-types').CampaignFilterSpec,
  campaignGroups: any[] = [],
  accountId?: string,
  effectiveKeyword?: string | TabCampaignFilter,
  topN: number = 10
): Array<Record<string, any>> {
  const isTikTok = dimension.startsWith('tiktok_');
  const platforms = isTikTok ? new Set(['tiktok']) : new Set(['meta']);

  // Aggregate ranking rows using the same logic as RankingTableBlock
  const aggregated = aggregateRankingRows(
    metrics,
    dimension,
    campaignFilter,
    accountId,
    effectiveKeyword,
    campaignGroups
  );

  const withValues = aggregated.map((row) => {
    const pt: Record<string, any> = {
      date: row._name, // using "date" as the key so Recharts' existing setup works with minimal changes
      rawName: row._name,
      id: row._id,
    };
    formulas.forEach((f) => {
      const v = evaluateFormula(f, row, varContext, sourceMapping, platforms, customMetrics);
      pt[getLabel(f)] = v === null || isNaN(v as number) ? 0 : (v as number);
    });
    return pt;
  });

  // Sort by the first formula descending to show the top items
  const firstMetric = getLabel(formulas[0]);
  const sorted = withValues.sort((a, b) => (b[firstMetric] || 0) - (a[firstMetric] || 0));

  return sorted.slice(0, topN);
}

// ─── Shared axis / grid styles ────────────────────────────────────────────────
const TICK = { fill: '#71717a', fontSize: 11 };
const GRID = { stroke: 'rgba(255,255,255,0.05)', strokeDasharray: '3 3' };
const CURVE = 'monotone' as const;

// ─── Custom tooltip ───────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label, categories, localUnits }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: '#09090b',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        padding: '10px 14px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.8)',
        minWidth: 140,
      }}
    >
      {label && (
        <p
          style={{
            color: '#52525b',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            fontWeight: 700,
            marginBottom: 8,
          }}
        >
          {label}
        </p>
      )}
      {payload.map((e: any, i: number) => {
        const val = e.value;
        const catIdx = categories ? categories.indexOf(e.name) : -1;
        const unit = catIdx !== -1 && localUnits ? localUnits[catIdx] : e.unit || e.payload?.unit;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: e.color || e.fill,
                flexShrink: 0,
              }}
            />
            <span style={{ color: '#a1a1aa', fontSize: 11, flex: 1 }}>{e.name}</span>
            <span
              style={{ color: '#f4f4f5', fontSize: 12, fontWeight: 600, fontFamily: 'monospace' }}
            >
              {fmtVal(val, unit)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Chart type badge labels ──────────────────────────────────────────────────
const TYPE_LABELS: Record<string, string> = {
  area: '📉 Área',
  stacked_area: '📈 Área Apilada',
  bar: '📊 Barras',
  stacked_bar: '📋 Apiladas',
  line: '— Líneas',
  donut: '🍢 Rosquilla',
  pie: '🥧 Torta',
  composed: '📹 Compuesto',
  radial: '🎯 Radial',
  scatter: '⭐ Dispersión',
  funnel: '🔻 Embudo',
};

// ─── Props ────────────────────────────────────────────────────────────────────
interface MetricChartsProps {
  charts: ChartDef[];
  metrics: any[];
  weeks?: any[];
  varContext?: Record<string, number>;
  rawMetrics?: any[];
  campaignGroups?: any[];
  effectiveKeyword?: string | TabCampaignFilter;
  sourceMapping?: Record<string, string>;
  platformSet?: Set<string>;
  layoutCustomMetrics?: Record<string, string>;
  onUpdateChart?: (chartId: string, updatedChart: ChartDef) => void;
}

// ─── Main Orchestrator ────────────────────────────────────────────────────────
export function MetricCharts({
  charts,
  metrics,
  varContext = {},
  rawMetrics,
  campaignGroups = [],
  effectiveKeyword = '',
  sourceMapping = {},
  platformSet = new Set(['meta']),
  layoutCustomMetrics = {},
  onUpdateChart,
}: MetricChartsProps) {
  if (!charts?.length) return null;

  return (
    <div className="space-y-4 mb-6">
      {charts.map((chart) => (
        <SingleMetricChart
          key={chart.id}
          chart={chart}
          metrics={metrics}
          varContext={varContext}
          rawMetrics={rawMetrics}
          campaignGroups={campaignGroups}
          effectiveKeyword={effectiveKeyword}
          sourceMapping={sourceMapping}
          platformSet={platformSet}
          layoutCustomMetrics={layoutCustomMetrics}
          onUpdateChart={onUpdateChart}
        />
      ))}
    </div>
  );
}

// ─── Single Metric Chart Component ───────────────────────────────────────────
function SingleMetricChart({
  chart,
  metrics,
  varContext,
  rawMetrics,
  campaignGroups,
  effectiveKeyword,
  sourceMapping,
  platformSet,
  layoutCustomMetrics,
  onUpdateChart,
}: {
  chart: ChartDef;
  metrics: any[];
  varContext: Record<string, number>;
  rawMetrics?: any[];
  campaignGroups: any[];
  effectiveKeyword: string | TabCampaignFilter;
  sourceMapping: Record<string, string>;
  platformSet: Set<string>;
  layoutCustomMetrics: Record<string, string>;
  onUpdateChart?: (chartId: string, updatedChart: ChartDef) => void;
}) {
  // Local state for interactive periodicity selector
  const [periodicity, setPeriodicity] = useState<'day' | 'week' | 'month' | 'year'>(
    chart.periodicity || 'day'
  );

  // Local state for series visualization overrides
  const [localTypes, setLocalTypes] = useState<('line' | 'bar' | 'area' | '')[]>(chart.types || []);

  // Keep localTypes in sync when chart.types changes externally
  useEffect(() => {
    setLocalTypes(chart.types || []);
  }, [chart.types]);

  // Local state for series units
  const [localUnits, setLocalUnits] = useState<('number' | 'currency' | 'percent')[]>(
    chart.units || []
  );

  // Keep localUnits in sync when chart.units changes externally
  useEffect(() => {
    setLocalUnits(chart.units || []);
  }, [chart.units]);

  // Si la gráfica tiene campaignFilter propio, usamos rawMetrics (datos sin keyword) como base
  // y el filtro se aplica dentro de buildGroupedData por cada fila/métrica individualmente.
  // Si no tiene filtro, usamos metrics (ya filtrado por keyword global).
  const hasOwnFilter =
    chart.campaignFilter &&
    (Array.isArray(chart.campaignFilter.value)
      ? chart.campaignFilter.value.length > 0
      : chart.campaignFilter.value !== '');
  const sourceMetrics = hasOwnFilter && rawMetrics ? rawMetrics : metrics;

  // Formulas
  const todasLasFormulas = useMemo(
    () => chart.valueFormulas.filter(Boolean),
    [chart.valueFormulas]
  );

  /**
   * Series que piden contactos de formulario en una dimensión que no los sirve.
   *
   * Se apartan ANTES de construir los datos. La alternativa —dejarlas pasar—
   * las pinta en 0 por la coerción de `null → 0` de más abajo, y una línea
   * plana en cero afirma que no hubo leads, que es falso: el cubo resuelve el
   * lead a campaña, no a anuncio.
   */
  const formulasNoAplicables = useMemo(
    () =>
      chart.dimension && !dimensionSoportaRespuestas(chart.dimension)
        ? todasLasFormulas.filter(formulaUsaRespuestas)
        : [],
    [chart.dimension, todasLasFormulas]
  );
  const formulas = useMemo(
    () => todasLasFormulas.filter((f) => !formulasNoAplicables.includes(f)),
    [todasLasFormulas, formulasNoAplicables]
  );

  // Build grouped data — el campaignFilter se aplica por fila dentro de buildGroupedData
  // Build grouped data or dimension data
  const data = useMemo(() => {
    if (chart.dimension) {
      return buildDimensionData(
        sourceMetrics,
        formulas,
        chart.dimension,
        varContext,
        sourceMapping,
        platformSet,
        layoutCustomMetrics,
        hasOwnFilter ? chart.campaignFilter : undefined,
        campaignGroups,
        chart.account_id,
        effectiveKeyword,
        chart.topN || 10
      );
    }
    return buildGroupedData(
      sourceMetrics,
      formulas,
      periodicity,
      varContext,
      sourceMapping,
      platformSet,
      layoutCustomMetrics,
      hasOwnFilter ? chart.campaignFilter : undefined,
      campaignGroups,
      chart.sheetFilter
    );
  }, [
    sourceMetrics,
    formulas,
    periodicity,
    chart.dimension,
    chart.topN,
    chart.account_id,
    varContext,
    sourceMapping,
    platformSet,
    layoutCustomMetrics,
    chart.campaignFilter,
    campaignGroups,
    hasOwnFilter,
    chart.sheetFilter,
    effectiveKeyword,
  ]);

  // categories/colors se memoizan y viven ANTES del early return: `dimensionTotals`
  // es un hook y depende de ellos, así que todos deben ejecutarse en cada render.
  const categories = useMemo(() => formulas.map(getLabel), [formulas]);
  const colors = useMemo(
    () =>
      (chart.colors?.length ? chart.colors : DEFAULT_COLORS).slice(0, categories.length).map(hex),
    [chart.colors, categories.length]
  );

  // Slices for dimension-based circular charts
  const dimensionTotals = useMemo(() => {
    if (!chart.dimension) return [];
    const firstCat = categories[0];
    return data.map((row, i) => ({
      name: row.date,
      value: row[firstCat] || 0,
      color: colors[i % colors.length],
      unit: localUnits[0] || 'number',
    }));
  }, [chart.dimension, categories, data, colors, localUnits]);

  if (!formulas.length) return null;

  // Pie / donut / funnel / radial totals
  const totalByCategory = categories.map((cat, i) => ({
    name: cat,
    value: data.reduce((s, r) => s + (r[cat] ?? 0), 0),
    color: colors[i],
    unit: localUnits[i] || 'number',
  }));

  const isCartesian = ['area', 'stacked_area', 'bar', 'stacked_bar', 'line', 'composed'].includes(
    chart.type
  );

  return (
    <div className="rounded-xl border border-border bg-card/80 p-5 shadow-lg relative group/chart">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{chart.title}</h3>
          {formulasNoAplicables.length > 0 && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
              {formulasNoAplicables.length === 1
                ? 'Serie omitida'
                : `${formulasNoAplicables.length} series omitidas`}
              : los contactos de formulario solo se resuelven a campaña, no a anuncio ni a conjunto.
            </p>
          )}
          <div className="flex flex-wrap gap-2.5 mt-2">
            {categories.map((cat, i) => {
              if (!isCartesian) {
                return (
                  <span
                    key={cat}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: colors[i],
                        display: 'inline-block',
                        flexShrink: 0,
                      }}
                    />
                    {cat}
                  </span>
                );
              }
              const currentType = localTypes[i] || '';
              return (
                <div
                  key={cat}
                  className="flex items-center gap-1.5 bg-background/40 border border-border px-2 py-0.5 rounded-lg text-[10px] text-muted-foreground hover:border-muted-foreground/30 transition"
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: colors[i],
                      display: 'inline-block',
                      flexShrink: 0,
                    }}
                  />
                  <span className="font-medium text-foreground/90">{cat}</span>
                  <select
                    value={currentType}
                    onChange={(e) => {
                      const val = e.target.value as 'line' | 'bar' | 'area' | '';
                      const newTypes = [...localTypes];
                      while (newTypes.length < categories.length) newTypes.push('');
                      newTypes[i] = val;
                      setLocalTypes(newTypes);
                      if (onUpdateChart) {
                        onUpdateChart(chart.id, { ...chart, types: newTypes });
                      }
                    }}
                    className="bg-card/60 border-none text-[9px] text-muted-foreground rounded px-1.5 py-0.5 outline-none hover:text-foreground cursor-pointer transition font-medium"
                  >
                    <option value="">Defecto</option>
                    <option value="line">Línea</option>
                    <option value="bar">Barra</option>
                    <option value="area">Área</option>
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        {/* Periodicity Selector & Info Badge */}
        <div className="flex items-center gap-3 self-end sm:self-start">
          {isCartesian && !chart.dimension && (
            <div className="inline-flex bg-background p-0.5 rounded-lg border border-border">
              {(['day', 'week', 'month', 'year'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriodicity(p)}
                  className={`px-2.5 py-1 text-[10px] font-medium rounded-md transition ${periodicity === p ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {p === 'day' ? 'Día' : p === 'week' ? 'Semana' : p === 'month' ? 'Mes' : 'Año'}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 text-[10px] text-muted-foreground/70">
            <span className="border border-border px-2 py-0.5 rounded font-mono">
              {TYPE_LABELS[chart.type] ?? chart.type}
            </span>
            <span>
              {data.length} {data.length === 1 ? 'punto' : 'puntos'}
            </span>
          </div>
        </div>
      </div>

      {/* Chart Body */}
      <div className="chart-wrapper">
        <ChartBody
          chart={chart}
          data={data}
          categories={categories}
          colors={colors}
          totals={totalByCategory}
          dimensionTotals={dimensionTotals}
          chartId={chart.id}
          localTypes={localTypes}
          localUnits={localUnits}
        />
      </div>
    </div>
  );
}

const formatXAxis = (val: string) => {
  if (!val) return '';
  if (val.length > 15) return val.slice(0, 15) + '...';
  return val;
};

// ─── Chart Body Switcher ──────────────────────────────────────────────────────
function ChartBody({
  chart,
  data,
  categories,
  colors,
  totals,
  dimensionTotals,
  chartId,
  localTypes,
  localUnits,
}: {
  chart: ChartDef;
  data: Array<Record<string, any>>;
  categories: string[];
  colors: string[];
  totals: { name: string; value: number; color: string; unit?: string }[];
  dimensionTotals?: { name: string; value: number; color: string; unit?: string }[];
  chartId: string;
  localTypes: string[];
  localUnits: string[];
}) {
  const H = chart.height || 240;
  const type = chart.type;
  const circularData =
    chart.dimension && dimensionTotals && dimensionTotals.length > 0 ? dimensionTotals : totals;

  // Helper to get series visualization type
  const getSeriesType = (index: number, chartType: string, customTypes?: string[]) => {
    if (customTypes?.[index]) return customTypes[index];
    if (chartType === 'composed') {
      return index === 0 ? 'bar' : 'line';
    }
    if (chartType === 'stacked_area') return 'area';
    if (chartType === 'stacked_bar') return 'bar';
    return chartType; // 'area' | 'bar' | 'line'
  };

  const isCartesian = ['area', 'stacked_area', 'bar', 'stacked_bar', 'line', 'composed'].includes(
    type
  );

  if (isCartesian) {
    const hasLeft = categories.some((_, i) => !chart.yAxes || chart.yAxes[i] !== 'right');
    const hasRight = categories.some((_, i) => chart.yAxes?.[i] === 'right');

    return (
      <ResponsiveContainer width="100%" height={H}>
        <ComposedChart
          data={data}
          margin={{ top: 12, right: hasRight ? 8 : 12, left: hasLeft ? -10 : 8, bottom: 0 }}
        >
          <defs>
            {categories.map((_, i) => {
              const sType = getSeriesType(i, type, localTypes);
              if (sType !== 'area') return null;
              return (
                <linearGradient key={i} id={`ag-${chartId}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="5%"
                    stopColor={colors[i]}
                    stopOpacity={type === 'stacked_area' ? 0.5 : 0.3}
                  />
                  <stop
                    offset="95%"
                    stopColor={colors[i]}
                    stopOpacity={type === 'stacked_area' ? 0.1 : 0.02}
                  />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid {...GRID} vertical={false} />
          <XAxis
            dataKey="date"
            tick={TICK}
            axisLine={false}
            tickLine={false}
            tickFormatter={chart.dimension ? formatXAxis : undefined}
          />
          {hasLeft && (
            <YAxis
              yAxisId="left"
              orientation="left"
              tickFormatter={(val) => fmtAxis(val, 'left', chart.yAxes, localUnits)}
              tick={TICK}
              axisLine={false}
              tickLine={false}
              width={52}
            />
          )}
          {hasRight && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={(val) => fmtAxis(val, 'right', chart.yAxes, localUnits)}
              tick={TICK}
              axisLine={false}
              tickLine={false}
              width={52}
            />
          )}
          <Tooltip
            content={<CustomTooltip categories={categories} localUnits={localUnits} />}
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          />
          {categories.map((cat, i) => {
            const sType = getSeriesType(i, type, localTypes);
            const yAxisId = chart.yAxes?.[i] === 'right' ? 'right' : 'left';
            const strokeWidth = chart.strokeWidths?.[i] ?? 2;
            const color = colors[i];
            const unitVal = localUnits[i] || 'number';

            const labelListElement = chart.showDataLabels && (
              <LabelList
                dataKey={cat}
                position="top"
                offset={10}
                style={{ fill: '#a1a1aa', fontSize: 9, fontFamily: 'monospace' }}
                formatter={(val: any) => (typeof val === 'number' ? fmtVal(val, unitVal) : val)}
              />
            );

            if (sType === 'area') {
              return (
                <Area
                  key={cat}
                  type={CURVE}
                  dataKey={cat}
                  yAxisId={yAxisId}
                  stackId={type === 'stacked_area' ? 's' : undefined}
                  stroke={color}
                  strokeWidth={strokeWidth}
                  fill={`url(#ag-${chartId}-${i})`}
                  dot={false}
                  activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
                  unit={unitVal}
                >
                  {labelListElement}
                </Area>
              );
            }

            if (sType === 'bar') {
              return (
                <Bar
                  key={cat}
                  dataKey={cat}
                  yAxisId={yAxisId}
                  stackId={type === 'stacked_bar' ? 's' : undefined}
                  fill={color}
                  opacity={0.85}
                  radius={
                    type === 'stacked_bar'
                      ? i === categories.length - 1
                        ? [3, 3, 0, 0]
                        : [0, 0, 0, 0]
                      : [3, 3, 0, 0]
                  }
                  maxBarSize={type === 'stacked_bar' ? 48 : 36}
                  unit={unitVal}
                >
                  {labelListElement}
                </Bar>
              );
            }

            // default to line
            return (
              <Line
                key={cat}
                type={CURVE}
                dataKey={cat}
                yAxisId={yAxisId}
                stroke={color}
                strokeWidth={strokeWidth}
                dot={false}
                activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
                unit={unitVal}
              >
                {labelListElement}
              </Line>
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'donut' || type === 'pie')
    return (
      <ResponsiveContainer width="100%" height={H}>
        <PieChart>
          <Pie
            data={circularData}
            cx="50%"
            cy="50%"
            innerRadius={type === 'donut' ? '52%' : 0}
            outerRadius="78%"
            dataKey="value"
            nameKey="name"
            paddingAngle={type === 'donut' ? 3 : 1}
            label={
              chart.showDataLabels
                ? ({ name, value }) => {
                    const item = circularData.find((t) => t.name === name);
                    return `${name}: ${fmtVal(value, item?.unit)}`;
                  }
                : false
            }
          >
            {circularData.map((t) => (
              <Cell key={t.name} fill={t.color} stroke="transparent" />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip categories={categories} localUnits={localUnits} />} />
          <Legend
            formatter={(v) => <span style={{ color: '#a1a1aa', fontSize: 11 }}>{v}</span>}
            iconType="circle"
            iconSize={8}
          />
        </PieChart>
      </ResponsiveContainer>
    );

  if (type === 'radial')
    return (
      <ResponsiveContainer width="100%" height={H}>
        <RadialBarChart
          cx="50%"
          cy="50%"
          innerRadius="20%"
          outerRadius="90%"
          data={circularData.map((t) => ({ ...t, fill: t.color }))}
          startAngle={90}
          endAngle={-270}
        >
          <PolarGrid gridType="circle" stroke="rgba(255,255,255,0.05)" />
          <RadialBar
            dataKey="value"
            background={{ fill: 'rgba(255,255,255,0.03)' }}
            cornerRadius={4}
            label={
              chart.showDataLabels
                ? {
                    fill: '#a1a1aa',
                    fontSize: 10,
                    formatter: (val: any, index: number) => fmtVal(val, circularData[index]?.unit),
                  }
                : false
            }
          />
          <Tooltip content={<CustomTooltip categories={categories} localUnits={localUnits} />} />
          <Legend
            formatter={(v) => <span style={{ color: '#a1a1aa', fontSize: 11 }}>{v}</span>}
            iconType="circle"
            iconSize={8}
          />
        </RadialBarChart>
      </ResponsiveContainer>
    );

  if (type === 'scatter') {
    const [catX, catY] = categories;
    const colX = colors[0];
    const scatterData = data.map((d) => ({ x: d[catX] ?? 0, y: d[catY] ?? 0, date: d.date }));
    return (
      <ResponsiveContainer width="100%" height={H}>
        <ScatterChart margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid {...GRID} />
          <XAxis
            dataKey="x"
            type="number"
            name={catX ?? 'X'}
            tickFormatter={(val) => fmtVal(val, localUnits[0])}
            tick={TICK}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <YAxis
            dataKey="y"
            type="number"
            name={catY ?? 'Y'}
            tickFormatter={(val) => fmtVal(val, localUnits[1])}
            tick={TICK}
            axisLine={false}
            tickLine={false}
            width={52}
          />
          <ZAxis range={[40, 40]} />
          <Tooltip
            content={<CustomTooltip categories={categories} localUnits={localUnits} />}
            cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.1)' }}
          />
          <Scatter data={scatterData} fill={colX} opacity={0.8} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  if (type === 'funnel') {
    const funnelData = circularData.map((t) => ({
      name: t.name,
      value: t.value,
      fill: t.color,
    }));
    return (
      <ResponsiveContainer width="100%" height={H}>
        <FunnelChart>
          <Tooltip content={<CustomTooltip categories={categories} localUnits={localUnits} />} />
          <Funnel dataKey="value" data={funnelData} isAnimationActive>
            {funnelData.map((d) => (
              <Cell key={d.name} fill={d.fill} stroke="transparent" />
            ))}
            {chart.showDataLabels && (
              <LabelList
                position="center"
                content={({ value, x, y, width, height, index }: any) => (
                  <text
                    x={x + (width ?? 0) / 2}
                    y={y + (height ?? 0) / 2 + 1}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    style={{ fill: '#fff', fontSize: 11, fontWeight: 600 }}
                  >
                    {fmtVal(value, circularData[index]?.unit)}
                  </text>
                )}
              />
            )}
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    );
  }

  return (
    <div className="h-40 flex items-center justify-center text-muted-foreground/70 text-sm">
      Tipo &quot;{type}&quot; no reconocido
    </div>
  );
}
