'use client';

import React, { useMemo, useEffect, useState, useRef } from 'react';
import { ExternalLink, ChevronUp, ChevronDown, ChevronsUpDown, Layers, X } from 'lucide-react';
import type { RankingTableDef, TabCampaignFilter } from '@/lib/layout-types';
import { evaluateFormula, formatValue } from '@/lib/formula-engine';
import {
  aggregateRankingRows,
  dimensionSoportaRespuestas,
  leadsFueraDeRanking,
} from '@/lib/ranking-aggregation';
import { formulaUsaRespuestas } from '@/lib/dashboard/lead-answer-aggregation';

interface Props {
  def: RankingTableDef;
  metrics: any[];
  campaignGroups: any[];
  sourceMapping: Record<string, string>;
  customMetrics: Record<string, string>;
  clienteId: string;
  accountId?: string;
  effectiveKeyword?: string | TabCampaignFilter;
}

interface ConsolidateModal {
  name: string;
  count: number;
  colValues: (number | null)[];
}

export function RankingTableBlock({
  def,
  metrics,
  campaignGroups,
  sourceMapping,
  customMetrics,
  clienteId,
  accountId,
  effectiveKeyword,
}: Props) {
  const [adInfoMap, setAdInfoMap] = useState<
    Record<string, { thumbnail: string | null; previewUrl: string | null }>
  >({});
  const [sortColIdx, setSortColIdx] = useState(def.sortColumnIndex);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(def.sortOrder);
  const [hoverPreview, setHoverPreview] = useState<{ url: string; x: number; y: number } | null>(
    null
  );
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [consolidateModal, setConsolidateModal] = useState<ConsolidateModal | null>(null);
  const resizingRef = useRef<{ key: string; startX: number; startW: number } | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!resizingRef.current) return;
      const { key, startX, startW } = resizingRef.current;
      setColWidths((prev) => ({ ...prev, [key]: Math.max(40, startW + (e.clientX - startX)) }));
    }
    function onUp() {
      if (!resizingRef.current) return;
      resizingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  function startColResize(key: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).closest('th') as HTMLTableCellElement;
    resizingRef.current = { key, startX: e.clientX, startW: th?.offsetWidth ?? 100 };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function handleSortClick(idx: number) {
    if (sortColIdx === idx) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortColIdx(idx);
      setSortDir('desc');
    }
  }

  // All aggregated rows (no topN limit) — needed for consolidation by name
  const allAggregated = useMemo(() => {
    return aggregateRankingRows(
      metrics,
      def.dimension,
      def.campaignFilter,
      accountId,
      effectiveKeyword,
      campaignGroups
    );
  }, [metrics, def.dimension, def.campaignFilter, accountId, effectiveKeyword, campaignGroups]);

  // Count how many distinct entries share each name
  const nameCount = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const row of allAggregated) {
      counts[row._name] = (counts[row._name] || 0) + 1;
    }
    return counts;
  }, [allAggregated]);

  const isTikTok = def.dimension.startsWith('tiktok_');

  /**
   * Columnas que piden métricas de Report-UTM en una dimensión que no las sirve.
   *
   * El cubo resuelve cada lead hasta su CAMPAÑA: un formulario no sabe qué
   * anuncio concreto trajo al visitante. En anuncio y conjunto la celda dice
   * «n/a» — un 0 afirmaría que no hubo leads, que es falso.
   */
  const columnasNoAplican = useMemo(() => {
    if (dimensionSoportaRespuestas(def.dimension)) return new Set<number>();
    return new Set(
      def.columns.map((c, i) => (formulaUsaRespuestas(c.formula) ? i : -1)).filter((i) => i >= 0)
    );
  }, [def.dimension, def.columns]);

  const MOTIVO_NO_APLICA =
    'Los contactos de Report-UTM se resuelven a CAMPAÑA, no a anuncio ni a conjunto: ' +
    'un formulario no sabe qué anuncio trajo al visitante. Cambia la dimensión de la ' +
    'tabla a «Campañas» para ver esta columna.';

  /** Contactos que no cuelgan de ninguna fila de la tabla. Se declaran al pie. */
  const fueraDeTabla = useMemo(
    () => leadsFueraDeRanking(metrics, allAggregated, def.campaignFilter),
    [metrics, allAggregated, def.campaignFilter]
  );

  const rows = useMemo(() => {
    const platforms = isTikTok ? new Set(['tiktok']) : new Set(['meta']);
    const withValues = allAggregated.map((row) => {
      const colValues = def.columns.map((col) =>
        evaluateFormula(col.formula, row, {}, sourceMapping, platforms, customMetrics)
      );
      const sortVal = colValues[sortColIdx] ?? null;
      return { row, colValues, sortVal };
    });
    const sorted = withValues.sort((a, b) => {
      if (a.sortVal === null) return 1;
      if (b.sortVal === null) return -1;
      return sortDir === 'desc' ? b.sortVal - a.sortVal : a.sortVal - b.sortVal;
    });
    return sorted.slice(0, def.topN);
  }, [allAggregated, def, isTikTok, sourceMapping, customMetrics, sortColIdx, sortDir]);

  useEffect(() => {
    if (def.dimension !== 'ads') return; // only Meta ads have thumbnails
    const ids = rows.map((r) => r.row._id).filter(Boolean);
    if (ids.length === 0) return;
    fetch(`/api/v1/ad-thumbnails?clienteId=${clienteId}&adIds=${ids.join(',')}`)
      .then((r) => r.json())
      .then(setAdInfoMap)
      .catch(() => {});
  }, [def.dimension, rows, clienteId]);

  const heatmapRanges = useMemo(() => {
    return def.columns.map((col, i) => {
      if (!col.highlight) return null;
      const vals = rows
        .map((r) => r.colValues[i])
        .filter((v): v is number => v !== null && !isNaN(v));
      if (vals.length === 0) return null;
      return { min: Math.min(...vals), max: Math.max(...vals) };
    });
  }, [def.columns, rows]);

  function openConsolidate(name: string) {
    const matching = allAggregated.filter((r) => r._name === name);
    if (matching.length === 0) return;

    // Merge by summing all numeric fields across all entries with this name
    const merged: any = { _name: name, _id: '' };
    for (const row of matching) {
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number') {
          merged[k] = (merged[k] ?? 0) + v;
        }
      }
    }

    const platforms = isTikTok ? new Set(['tiktok']) : new Set(['meta']);
    const colValues = def.columns.map((col) =>
      evaluateFormula(col.formula, merged, {}, sourceMapping, platforms, customMetrics)
    );

    setConsolidateModal({ name, count: matching.length, colValues });
  }

  // Days that had spend but no ad-level data — genuine sync gap (excludes no-activity days)
  const { daysNeedingSync } = useMemo(() => {
    const arrayKey =
      def.dimension === 'campaigns'
        ? 'meta_campaigns'
        : def.dimension === 'ads'
          ? 'meta_ads'
          : def.dimension === 'adsets'
            ? 'meta_adsets'
            : def.dimension === 'tiktok_campaigns'
              ? 'tiktok_campaigns'
              : def.dimension === 'tiktok_ads'
                ? 'tiktok_ads'
                : 'tiktok_adgroups';
    const spendKey = isTikTok ? 'tiktok_spend' : 'meta_spend';
    let withData = 0;
    let needingSync = 0;
    for (const m of metrics) {
      const hasAdData = Array.isArray(m[arrayKey]) && m[arrayKey].length > 0;
      const hadSpend = (m[spendKey] || 0) > 0;
      if (hasAdData) withData++;
      else if (hadSpend) needingSync++; // spent money but no breakdown = real gap
    }
    return { daysWithData: withData, daysNeedingSync: needingSync };
  }, [metrics, def.dimension, isTikTok]);

  const totalDays = metrics.length;

  if (rows.length === 0) {
    const needsSync =
      def.dimension === 'ads' ||
      def.dimension === 'adsets' ||
      def.dimension === 'tiktok_ads' ||
      def.dimension === 'tiktok_adgroups';
    const dimLabel =
      def.dimension === 'ads'
        ? 'anuncios'
        : def.dimension === 'adsets'
          ? 'conjuntos de anuncios'
          : def.dimension === 'tiktok_ads'
            ? 'anuncios de TikTok'
            : def.dimension === 'tiktok_adgroups'
              ? 'grupos de anuncios de TikTok'
              : null;
    return (
      <div className="col-span-1 md:col-span-4 bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-background/40">
          <h3 className="text-sm font-semibold text-foreground">{def.title}</h3>
        </div>
        <div className="p-8 flex flex-col items-center gap-3 text-center">
          <div className="text-2xl">📅</div>
          {needsSync && dimLabel ? (
            <>
              <p className="text-sm text-foreground/90 font-medium">
                No hay datos de {dimLabel} para este rango de fechas
              </p>
              <p className="text-xs text-muted-foreground/70 max-w-xs">
                El desglose por {dimLabel} requiere sincronizar el rango seleccionado. Usa el botón{' '}
                <span className="text-blue-600 dark:text-blue-400 font-medium">
                  Sincronizar Datos
                </span>{' '}
                en la parte superior del dashboard para cargar los datos.
              </p>
              <div className="mt-1 text-[11px] text-muted-foreground/70 bg-muted/60 rounded-lg px-3 py-1.5">
                {totalDays} día{totalDays !== 1 ? 's' : ''} en el rango · {daysNeedingSync} con
                gasto sin sincronizar
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground/70">Sin datos para este rango de fechas</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="col-span-1 md:col-span-4 bg-card border border-border rounded-xl overflow-hidden">
      {/* Popup de preview en hover — posición fija para no ser cortado por overflow */}
      {hoverPreview && (
        <div
          className="pointer-events-none"
          style={{
            position: 'fixed',
            left: Math.min(hoverPreview.x, window.innerWidth - 320),
            top: Math.max(8, Math.min(hoverPreview.y, window.innerHeight - 420)),
            zIndex: 9999,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- URL firmada del CDN de Meta (host rotativo), no optimizable por next/image */}
          <img
            src={hoverPreview.url}
            alt=""
            className="w-72 rounded-2xl shadow-2xl border border-border object-cover"
          />
        </div>
      )}

      {/* Modal de métricas consolidadas por nombre */}
      {consolidateModal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9998] flex items-center justify-center"
          onClick={() => setConsolidateModal(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between px-5 py-4 border-b border-border bg-background/50">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                  <span className="text-foreground font-semibold text-sm">
                    Métricas consolidadas
                  </span>
                </div>
                <p
                  className="text-muted-foreground text-xs truncate max-w-[300px]"
                  title={consolidateModal.name}
                >
                  {consolidateModal.name}
                </p>
                <p className="text-muted-foreground/70 text-[11px] mt-0.5">
                  Suma de{' '}
                  <span className="text-indigo-600 dark:text-indigo-300 font-semibold">
                    {consolidateModal.count}
                  </span>{' '}
                  anuncio{consolidateModal.count !== 1 ? 's' : ''} con este nombre
                </p>
              </div>
              <button
                onClick={() => setConsolidateModal(null)}
                className="text-muted-foreground/70 hover:text-foreground transition mt-0.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 py-3 divide-y divide-border">
              {def.columns.map((col, i) => (
                <div key={col.label} className="flex items-center justify-between py-2.5">
                  <span className="text-muted-foreground text-xs">{col.label}</span>
                  <span className="text-foreground font-mono text-sm font-semibold">
                    {formatValue(consolidateModal.colValues[i], {
                      prefix: col.prefix,
                      suffix: col.suffix,
                      decimals: col.decimals,
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-b border-border bg-background/40">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">{def.title}</h3>
          {(def.dimension === 'ads' ||
            def.dimension === 'adsets' ||
            def.dimension === 'tiktok_ads' ||
            def.dimension === 'tiktok_adgroups') &&
            daysNeedingSync > 0 && (
              <span
                className="text-[10px] text-amber-600 dark:text-amber-400/80 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-0.5 cursor-help"
                title={`${daysNeedingSync} día(s) tuvieron gasto pero no tienen desglose. Sincroniza para completar.`}
              >
                ⚠ {daysNeedingSync} día{daysNeedingSync !== 1 ? 's' : ''} sin sincronizar ·
                Sincroniza para completar
              </span>
            )}
        </div>
      </div>
      <div className="overflow-x-auto custom-scrollbar">
        <table className="w-full text-xs whitespace-nowrap">
          <thead>
            <tr className="border-b border-border bg-background">
              {def.showRank !== false && (
                <th
                  style={{ width: colWidths['rank'] || undefined, position: 'relative' }}
                  className="px-3 py-2 text-left text-muted-foreground/70 font-medium"
                >
                  #
                  <div
                    onMouseDown={(e) => startColResize('rank', e)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400/30 transition-colors z-10"
                  />
                </th>
              )}
              {def.dimension === 'ads' && (
                <th
                  style={{ width: colWidths['thumb'] || 96, minWidth: 96, position: 'relative' }}
                  className="px-3 py-2 text-left text-muted-foreground/70 font-medium"
                >
                  <div
                    onMouseDown={(e) => startColResize('thumb', e)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400/30 transition-colors z-10"
                  />
                </th>
              )}
              <th
                style={{ width: colWidths['name'] || undefined, position: 'relative' }}
                className="px-3 py-2 text-left text-muted-foreground/70 font-medium"
              >
                Nombre
                <div
                  onMouseDown={(e) => startColResize('name', e)}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400/30 transition-colors z-10"
                />
              </th>
              {def.columns.map((col, i) => (
                <th
                  key={col.label}
                  style={{ width: colWidths[`col_${i}`] || undefined, position: 'relative' }}
                  className="px-3 py-2 text-right text-muted-foreground/70 font-medium cursor-pointer select-none hover:text-foreground/90 transition-colors"
                  onClick={() => handleSortClick(i)}
                >
                  <span className="inline-flex items-center justify-end gap-1">
                    {col.label}
                    {sortColIdx === i ? (
                      sortDir === 'desc' ? (
                        <ChevronDown className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />
                      ) : (
                        <ChevronUp className="w-3 h-3 text-indigo-600 dark:text-indigo-400" />
                      )
                    ) : (
                      <ChevronsUpDown className="w-3 h-3 opacity-30" />
                    )}
                  </span>
                  <div
                    onMouseDown={(e) => startColResize(`col_${i}`, e)}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-indigo-400/30 transition-colors z-10"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ row, colValues }, idx) => (
              <tr
                key={row._id || idx}
                className="border-b border-border hover:bg-accent transition"
              >
                {def.showRank !== false && (
                  <td className="px-3 py-2 text-muted-foreground/70 font-mono text-[10px]">
                    #{idx + 1}
                  </td>
                )}
                {def.dimension === 'ads' && (
                  <td className="px-2 py-1.5" style={{ minWidth: 96 }}>
                    {adInfoMap[row._id]?.thumbnail ? (
                      // eslint-disable-next-line @next/next/no-img-element -- URL firmada del CDN de Meta (host rotativo), no optimizable por next/image
                      <img
                        src={adInfoMap[row._id].thumbnail!}
                        alt=""
                        className="w-24 h-24 rounded-lg object-cover bg-muted flex-shrink-0 cursor-zoom-in"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                        }}
                        onMouseEnter={(e) => {
                          const rect = (
                            e.currentTarget as HTMLImageElement
                          ).getBoundingClientRect();
                          const x = rect.right + 12;
                          const y = rect.top;
                          setHoverPreview({ url: adInfoMap[row._id].thumbnail!, x, y });
                        }}
                        onMouseLeave={() => setHoverPreview(null)}
                      />
                    ) : (
                      <div className="w-24 h-24 rounded-lg bg-muted animate-pulse flex-shrink-0" />
                    )}
                  </td>
                )}
                <td className="px-3 py-2 text-foreground max-w-[220px]">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{row._name}</span>
                    {/* Consolidate button — only shown when multiple entries share this name */}
                    {nameCount[row._name] > 1 && (
                      <button
                        onClick={() => openConsolidate(row._name)}
                        title={`Consolidar ${nameCount[row._name]} anuncios con este nombre`}
                        className="flex-shrink-0 flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400/70 hover:text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded px-1 py-0.5 transition"
                      >
                        <Layers className="w-2.5 h-2.5" />
                        <span>{nameCount[row._name]}</span>
                      </button>
                    )}
                    {def.dimension === 'ads' && row._id && (
                      <a
                        href={
                          adInfoMap[row._id]?.previewUrl ||
                          `https://www.facebook.com/ads/library/?id=${row._id}`
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-shrink-0 text-muted-foreground/70 hover:text-blue-400 transition"
                        title={
                          adInfoMap[row._id]?.previewUrl
                            ? 'Ver preview del anuncio'
                            : 'Ver en Facebook Ad Library'
                        }
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </td>
                {def.columns.map((col, i) => {
                  if (columnasNoAplican.has(i)) {
                    return (
                      <td
                        key={col.label}
                        className="px-3 py-2 text-right font-mono text-muted-foreground/50"
                        title={MOTIVO_NO_APLICA}
                      >
                        n/a
                      </td>
                    );
                  }
                  const val = colValues[i];
                  const range = heatmapRanges[i];
                  let bgStyle: React.CSSProperties = {};
                  if (
                    col.highlight &&
                    range &&
                    val !== null &&
                    !isNaN(val) &&
                    range.max > range.min
                  ) {
                    const intensity = (val - range.min) / (range.max - range.min);
                    bgStyle = { background: `rgba(99,102,241,${intensity * 0.3})` };
                  }
                  return (
                    <td
                      key={col.label}
                      className="px-3 py-2 text-right font-mono text-foreground/90"
                      style={bgStyle}
                    >
                      {formatValue(val, {
                        prefix: col.prefix,
                        suffix: col.suffix,
                        decimals: col.decimals,
                      })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pies informativos: un total que no cuadra con la suma de la tabla
                parece un fallo si nadie lo explica. */}
      {columnasNoAplican.size > 0 && (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground/70">
          {columnasNoAplican.size === 1
            ? 'Una columna mide'
            : `${columnasNoAplican.size} columnas miden`}{' '}
          contactos de formulario, que solo se resuelven a campaña. Cambia la dimensión a «Campañas»
          para verlas.
        </p>
      )}
      {(fueraDeTabla.sinCampana > 0 || fueraDeTabla.fueraDeTabla > 0) && (
        <p className="px-3 pb-2 text-[11px] text-muted-foreground/70">
          {fueraDeTabla.sinCampana + fueraDeTabla.fueraDeTabla} contactos no aparecen en esta tabla
          {fueraDeTabla.sinCampana > 0 && `: ${fueraDeTabla.sinCampana} sin campaña identificada`}
          {fueraDeTabla.fueraDeTabla > 0 &&
            `${fueraDeTabla.sinCampana > 0 ? ' y ' : ': '}${fueraDeTabla.fueraDeTabla} de campañas sin gasto registrado en el período`}
          .
        </p>
      )}
    </div>
  );
}
