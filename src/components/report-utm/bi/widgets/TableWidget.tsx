'use client';

import { useEffect, useState } from 'react';
import { ArrowUpDown } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import type { BiFilters, WidgetConfig, CalculatedField } from '../BiTypes';
import type { BiMetric, BiDimension, BiQueryRow } from '@/lib/report-utm/bi-metadata';
import {
  METRIC_META,
  DIMENSION_META,
  applyValueFilters,
  unifiedTarget,
  fieldMetricLabel,
  fieldMetricFormat,
  fieldDimLabel,
  leadFieldLabel,
  isFieldMetric,
  isOfflineFieldMetric,
  offlineFieldLabel,
  offlineFieldFormat,
  isSheetToken,
  sheetFieldLabel,
  sheetFieldFormat,
  isLeadSegMetric,
  leadSegLabel,
  isLeadAnsMetric,
  basesAditivasDeFormula,
} from '@/lib/report-utm/bi-metadata';
import {
  calcularTotalesTabla,
  basesOcultasDeRatios,
  rotuloFilaTotal,
} from '@/lib/report-utm/bi-table-totals';
import { useBiQueryBase, useBiEtiquetas } from '../BiQueryContext';
import { appendWidgetFilters, widgetFilterSignature } from '../widgetQuery';
import {
  AvisosConsultaNote,
  readAvisosConsulta,
  readTasas,
  readUnavailable,
  TasasNote,
  UnavailableNote,
} from '../widgetDiagnostics';
import type { WidgetUnavailable } from '../widgetDiagnostics';
import {
  decimalesDe,
  monedaDeMetrica,
  prefijoMoneda,
  simboloMoneda,
  type AvisoTasas,
} from '@/lib/moneda-reporte';

interface Props {
  title: string;
  config: WidgetConfig;
  filters: BiFilters;
  calculatedFields?: CalculatedField[];
  /** Alto del widget (1x/2x/3x): escala la altura visible de la tabla antes de scroll. */
  h?: number;
}

// Altura visible (px) de la tabla según el "Alto" del widget. Más allá, scroll interno.
const TABLE_MAX_H: Record<number, number> = { 1: 320, 2: 540, 3: 760 };

type ColFormat = 'number' | 'currency' | 'percent' | 'ratio' | 'decimal';

/**
 * `decimals` (campos calculados) fija los decimales y desactiva el abreviado k/M.
 * `prefijo`/`decMoneda`: símbolo y decimales de la moneda del importe.
 */
function fmtVal(
  value: number | null | undefined,
  format: ColFormat,
  decimals?: number,
  prefijo = '$',
  decMoneda = 2
): string {
  if (value === null || value === undefined) return '—';
  if (decimals !== undefined) {
    const n = value.toLocaleString('es-AR', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    if (format === 'currency') return `${prefijo}${n}`;
    if (format === 'percent') return `${n}%`;
    if (format === 'ratio') return `${n}x`;
    return n;
  }
  if (format === 'currency')
    return `${prefijo}${value.toLocaleString('es-AR', { minimumFractionDigits: decMoneda, maximumFractionDigits: decMoneda })}`;
  if (format === 'decimal')
    return value.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (format === 'percent') return `${value.toFixed(1)}%`;
  if (format === 'ratio') return `${value.toFixed(2)}x`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString('es-AR');
}

export function TableWidget({ title, config, filters, calculatedFields = [], h = 1 }: Props) {
  const queryBase = useBiQueryBase();
  const { registrar: registrarEtiquetas } = useBiEtiquetas();
  // Una sola firma para todo lo que obliga a recargar: filtros del informe +
  // filtro propio del widget. Ver widgetQuery.ts.
  const filterSig = widgetFilterSignature(filters, config);
  const [rows, setRows] = useState<BiQueryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(config.sort === 'asc' ? 'asc' : 'desc');
  /** Motivo de la primera columna que no se pudo medir, si hay alguna. */
  const [naInfo, setNaInfo] = useState<WidgetUnavailable | null>(null);
  const [avisoTasas, setAvisoTasas] = useState<AvisoTasas | null>(null);
  const [avisosConsulta, setAvisosConsulta] = useState<string[]>([]);
  /** Moneda de reporte del cliente (viaja en `meta` de la respuesta). */
  const [monedaCliente, setMonedaCliente] = useState<string | null>(null);
  /** Nombres de preguntas, respuestas y segmentos (viajan en `meta.etiquetas`). */
  const [etiquetas, setEtiquetas] = useState<Record<string, string>>({});

  const rawMetrics = config.metric ?? 'leads_count';
  const colKeys = rawMetrics
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dimension = config.dimension ?? 'utm_source';
  const rowLimit = config.limit ?? 100;
  const showTotals = config.show_totals !== false; // por defecto sí
  const conditional = config.conditional ?? [];

  // separa métricas base, campos calculados y métricas de campo (fieldagg:)
  const calcMap = new Map(calculatedFields.map((c) => [c.name, c]));
  const baseMetrics = colKeys.filter((k) => METRIC_META[k as BiMetric]) as BiMetric[];
  const fieldMetricCols = colKeys.filter(isFieldMetric);
  // Columnas adicionales de Sheets offline (offfield:<tipo>:<clave>).
  const offlineFieldCols = colKeys.filter(isOfflineFieldMetric);
  // Campos y vistas de Sheet (sheetagg:/sheetview:).
  const sheetCols = colKeys.filter(isSheetToken);
  // Segmentos y respuestas de campo de lead (leadseg:<clave>, leadans:<campo>:<resp>).
  const leadSegCols = colKeys.filter((k) => isLeadSegMetric(k) || isLeadAnsMetric(k));
  const usedCalc = colKeys.filter((k) => calcMap.has(k)).map((k) => calcMap.get(k)!);
  // Para totalizar un campo calculado hacen falta sus bases SUMADAS, que no
  // siempre son columnas visibles (`spend / lf__rango__2m` no enseña ni el gasto
  // ni la respuesta). Se piden aparte, ocultas. Solo si todas son aditivas: el
  // total de una fórmula sobre un ratio no se puede reconstruir fila a fila.
  const basesDeCalc = new Map<string, Map<string, string>>(); // calc → (id → token)
  for (const c of usedCalc) {
    const bases = basesAditivasDeFormula(c.expression);
    if (bases) basesDeCalc.set(c.name, bases);
  }
  // Lo mismo para los ratios del catálogo (CPL, ROAS, CTR…): una tabla de solo
  // CPL necesita gasto y leads para su fila Total.
  const ocultas = [
    ...new Set([
      ...[...basesDeCalc.values()].flatMap((m) => [...m.values()]),
      ...basesOcultasDeRatios(colKeys),
    ]),
  ].filter((t) => !colKeys.includes(t));

  function colLabel(key: string): string {
    return (
      etiquetas[key] ??
      METRIC_META[key as BiMetric]?.label ??
      fieldMetricLabel(key) ??
      offlineFieldLabel(key) ??
      sheetFieldLabel(key) ??
      leadSegLabel(key) ??
      calcMap.get(key)?.name ??
      key
    );
  }
  function colFormat(key: string): ColFormat {
    return (METRIC_META[key as BiMetric]?.format ??
      calcMap.get(key)?.format ??
      fieldMetricFormat(key) ??
      offlineFieldFormat(key) ??
      sheetFieldFormat(key) ??
      'number') as ColFormat;
  }
  /** Prefijo y decimales del importe de una columna: moneda del cliente o USD. */
  function monedaCol(key: string): { prefijo: string; dec: number } {
    const simbolo = simboloMoneda(monedaDeMetrica(key, monedaCliente), monedaCliente);
    return { prefijo: prefijoMoneda(simbolo), dec: simbolo === '$' ? 2 : decimalesDe(simbolo) };
  }

  useEffect(() => {
    setLoading(true);
    setError(null);

    // Las dimensiones que cruzan con el reporting (campaña / anuncio /
    // conjunto) resuelven los UTM contra las campañas reales del cliente. Sin
    // cliente no hay contra qué resolver: el motor devolvería los UTM crudos y
    // el gasto en 0, que es justo la confusión que hay que evitar.
    if (unifiedTarget(dimension) !== null && !filters.cliente_id) {
      setRows([]);
      setLoading(false);
      setError('Selecciona un cliente en los filtros para cruzar con las campañas.');
      return;
    }

    const params = new URLSearchParams({
      // `sheetCols` faltaba aquí: se calculaba arriba y se leía abajo, pero
      // nunca se PEDÍA al motor, así que una columna de campo de Sheet
      // llegaba siempre vacía. Los segmentos de lead caerían en el mismo
      // agujero, así que entran los dos.
      metrics: [
        ...baseMetrics,
        ...fieldMetricCols,
        ...offlineFieldCols,
        ...sheetCols,
        ...leadSegCols,
        ...ocultas,
      ].join(','),
      dimension,
      limit: String(rowLimit),
      sort: config.sort === 'asc' ? 'asc' : 'desc',
    });
    if (filters.cliente_id) params.set('cliente_id', filters.cliente_id);
    if (filters.date_from) params.set('date_from', filters.date_from);
    if (filters.date_to) params.set('date_to', filters.date_to);
    appendWidgetFilters(params, filters, config);
    for (const c of usedCalc) params.set(`calc[${c.name}]`, c.expression);

    fetch(`${queryBase}?${params}`)
      .then((r) => r.json())
      .then((json) => {
        setRows(Array.isArray(json.data) ? json.data : []);
        setMonedaCliente(json.meta?.moneda ?? null);
        setEtiquetas(json.meta?.etiquetas ?? {});
        registrarEtiquetas(json.meta?.etiquetas);
        setAvisoTasas(readTasas(json.meta));
        setAvisosConsulta(readAvisosConsulta(json.meta));
        // Una tabla mezcla columnas de varias fuentes, así que es donde
        // más se nota: se explica la primera columna que no se pudo
        // medir en vez de dejar una columna entera de ceros.
        setNaInfo(readUnavailable(json.meta, colKeys));
      })
      .catch(() => setError('Error al cargar'))
      .finally(() => setLoading(false));
  }, [queryBase, rawMetrics, dimension, rowLimit, config.sort, filterSig]);

  // Filtros por valor: oculta filas que no cumplan (ej. spend > 0)
  const filteredRows = applyValueFilters(rows, config.value_filters);

  const sorted = [...filteredRows].sort((a, b) => {
    if (!sortKey) return 0;
    const av = Number(a[sortKey] ?? 0);
    const bv = Number(b[sortKey] ?? 0);
    return sortDir === 'desc' ? bv - av : av - bv;
  });

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  // Totales: suma las aditivas y recalcula los ratios sobre sus bases sumadas
  // (ver `bi-table-totals.ts`: por qué se piden las bases ocultas y cuándo el
  // total es «—»).
  const totals = showTotals
    ? calcularTotalesTabla({ rows: filteredRows, colKeys, calculados: usedCalc })
    : null;
  const rotuloTotal = rotuloFilaTotal({
    filasRecibidas: rows.length,
    filasVisibles: filteredRows.length,
    limite: rowLimit,
  });

  function cellColor(key: string, value: number | null | undefined): string {
    if (value === null || value === undefined) return '';
    const rule = conditional.find((c) => c.metric === key);
    if (!rule) return '';
    const hit = rule.op === 'gt' ? value > rule.value : value < rule.value;
    if (!hit) return '';
    if (rule.color === 'green') return 'text-emerald-600 dark:text-emerald-400 font-semibold';
    if (rule.color === 'red') return 'text-red-600 dark:text-red-400 font-semibold';
    return 'text-amber-600 dark:text-amber-400 font-semibold';
  }

  const dimLabel =
    etiquetas[dimension] ??
    DIMENSION_META[dimension as BiDimension]?.label ??
    leadFieldLabel(dimension) ??
    fieldDimLabel(dimension) ??
    dimension;

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden flex flex-col h-full">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground truncate" title={title}>
            {title}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5 truncate">Por {dimLabel}</p>
          {/* Va en la cabecera y no al pie: en una tabla larga el
                        motivo tiene que verse sin hacer scroll hasta el final. */}
          {!loading && !error && (
            <div className="mt-1">
              <UnavailableNote info={naInfo} />
              <TasasNote aviso={avisoTasas} />
              <AvisosConsultaNote avisos={avisosConsulta} />
            </div>
          )}
        </div>
        {(config.value_filters?.length ?? 0) > 0 && !loading && !error && (
          <span className="shrink-0 text-[10px] font-mono text-muted-foreground bg-muted/60 px-2 py-1 rounded-md">
            {filteredRows.length} de {rows.length} filas
          </span>
        )}
      </div>

      {loading ? (
        <div className="flex-1 p-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 rounded" />
          ))}
        </div>
      ) : error ? (
        <p className="text-xs text-red-500 p-5">{error}</p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8">Sin datos</p>
      ) : (
        <div className="overflow-auto" style={{ maxHeight: TABLE_MAX_H[h] ?? TABLE_MAX_H[1] }}>
          <table className="w-full">
            <thead className="bg-muted/60 sticky top-0">
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-5 py-3">{dimLabel}</th>
                {colKeys.map((key) => (
                  <th
                    key={key}
                    className="px-5 py-3 text-right cursor-pointer hover:text-foreground"
                    onClick={() => toggleSort(key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {colLabel(key)}
                      <ArrowUpDown className="h-3 w-3 opacity-50" />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sorted.map((row, i) => (
                <tr key={i} className="hover:bg-accent">
                  {/* Tope de ancho + `truncate`: un valor de dimensión largo
                      (un nombre de campaña) estiraba la tabla entera y obligaba
                      a hacer scroll horizontal para ver las métricas, que es lo
                      que se viene a mirar. El `title` devuelve el valor entero. */}
                  <td className="px-5 py-2.5 text-xs font-mono text-emerald-600 dark:text-emerald-400 max-w-[240px]">
                    <span
                      className="inline-flex items-center gap-1.5 max-w-full"
                      title={String(row.dimension_value ?? '(total)')}
                    >
                      <span className="truncate">{row.dimension_value ?? '(total)'}</span>
                      {/* Sin cruce: este UTM no resolvió a ninguna campaña/anuncio real,
                                                así que su gasto en 0 es un mapeo pendiente, no un dato. */}
                      {row.__nocross === 1 && (
                        <span
                          title="Este valor no cruza con ninguna campaña del reporting, así que no tiene gasto asociado. Mapéalo en Cruce de campañas."
                          className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0"
                          aria-label="sin cruce con campañas"
                        />
                      )}
                    </span>
                  </td>
                  {colKeys.map((key) => {
                    const v = row[key] as number | null | undefined;
                    return (
                      <td
                        key={key}
                        className={`px-5 py-2.5 text-right text-xs font-mono tabular-nums text-foreground/90 ${cellColor(key, v)}`}
                      >
                        {fmtVal(
                          v,
                          colFormat(key),
                          calcMap.get(key)?.decimals,
                          monedaCol(key).prefijo,
                          monedaCol(key).dec
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot className="bg-muted/40 sticky bottom-0 border-t-2 border-border">
                <tr className="text-xs font-semibold">
                  <td className="px-5 py-2.5 text-foreground">{rotuloTotal}</td>
                  {colKeys.map((key) => (
                    <td
                      key={key}
                      className="px-5 py-2.5 text-right font-mono tabular-nums text-foreground"
                    >
                      {key in totals
                        ? fmtVal(
                            totals[key],
                            colFormat(key),
                            calcMap.get(key)?.decimals,
                            monedaCol(key).prefijo,
                            monedaCol(key).dec
                          )
                        : '—'}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
