'use client';

import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { BiFilters, WidgetConfig } from '../BiTypes';
import { useBiQueryBase } from '../BiQueryContext';
import { appendWidgetFilters, widgetFilterSignature } from '../widgetQuery';
import { buildSummarySentences, SUMMARY_METRICS, type Totals } from '@/lib/report-utm/bi/resumen';

interface Props {
  title: string;
  config: WidgetConfig;
  filters: BiFilters;
}

/**
 * Resumen ejecutivo: traduce las métricas del período a 2-4 frases en lenguaje
 * simple. El trafficker puede sobreescribir el texto con `config.text` antes de
 * enviar el informe al cliente.
 */
export function SummaryWidget({ title, config, filters }: Props) {
  const queryBase = useBiQueryBase();
  // Una sola firma para todo lo que obliga a recargar: filtros del informe +
  // filtro propio del widget. Ver widgetQuery.ts.
  const filterSig = widgetFilterSignature(filters, config);
  // Texto manual: no se consulta nada (y no hay estado de carga).
  const manual = config.text?.trim();

  const [sentences, setSentences] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(!manual);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (manual) return;
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      metrics: SUMMARY_METRICS.join(','),
      dimension: 'none',
      type: 'compare',
    });
    if (filters.cliente_id) params.set('cliente_id', filters.cliente_id);
    if (filters.date_from) params.set('date_from', filters.date_from);
    if (filters.date_to) params.set('date_to', filters.date_to);
    appendWidgetFilters(params, filters, config);

    fetch(`${queryBase}?${params}`)
      .then((r) => r.json())
      .then((json) => {
        const cur = (json.data?.current?.[0] ?? {}) as Totals;
        const prev = (json.data?.previous?.[0] ?? {}) as Totals;
        // La moneda de reporte del cliente viaja en `meta` (también en el
        // enlace público): sin ella las cifras en pesos salían con «$».
        setSentences(buildSummarySentences(cur, prev, json.meta?.moneda ?? 'USD'));
      })
      .catch(() => setError('Error al cargar'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryBase, manual, filterSig]);

  const accent = config.accent || '#10b981';

  return (
    <div
      className="rounded-2xl border border-border bg-card p-5 h-full"
      style={{ borderLeft: `3px solid ${accent}` }}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-3">
        <Sparkles className="h-3.5 w-3.5" style={{ color: accent }} />
        {title || 'Resumen del período'}
      </p>

      {manual ? (
        <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
          {manual}
        </p>
      ) : loading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Analizando…</span>
        </div>
      ) : error ? (
        <p className="text-xs text-red-500">{error}</p>
      ) : (
        <ul className="space-y-1.5">
          {(sentences ?? []).map((s, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-muted-foreground">
              <span style={{ color: accent }}>•</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
