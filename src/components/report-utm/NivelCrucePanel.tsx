'use client';

import { useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle, Hash, Plus, Sparkles, Layers, Film } from 'lucide-react';

export type NivelCruce = 'adset' | 'ad';

export interface NivelRowUI {
  field: 'utm_term' | 'utm_content';
  value: string;
  count: number;
  resolved: string | null;
  via: 'automatico' | 'manual' | null;
  es_id: boolean;
  suggestion: { id: string; name: string; confidence: number } | null;
}

export interface NivelCoberturaUI {
  total: number;
  resueltos: number;
  conId: number;
  manual: number;
}

export interface EntidadOpcionUI {
  id: string;
  name: string;
  campaign_name: string | null;
  adset_name: string | null;
  activo: boolean;
}

export interface NivelesUI {
  adset: { cobertura: NivelCoberturaUI; rows: NivelRowUI[] };
  ad: { cobertura: NivelCoberturaUI; rows: NivelRowUI[] };
}

const TITULO: Record<NivelCruce, string> = {
  adset: 'Conjuntos de anuncios',
  ad: 'Anuncios',
};
const CAMPO: Record<NivelCruce, string> = { adset: 'utm_term', ad: 'utm_content' };

/**
 * Cruce por NIVEL: conjunto (`utm_term`) y anuncio (`utm_content`).
 *
 * Es la pantalla que faltaba en la reunión del 2026-09-08: GoHighLevel mandaba el
 * ID del conjunto y del anuncio en vez del nombre, el informe mostraba `120212…`
 * y no había dónde corregirlo. Lo que el índice reconoce ya sale resuelto solo;
 * lo que no, se corrige aquí eligiendo la entidad real.
 */
export function NivelCrucePanel({
  niveles,
  entidades,
  habilitado,
  onMapear,
}: {
  niveles: NivelesUI;
  entidades: Record<NivelCruce, EntidadOpcionUI[]>;
  /** La migración 079 está aplicada: se pueden guardar correcciones por nivel. */
  habilitado: boolean;
  onMapear: (nivel: NivelCruce, row: NivelRowUI, entidad: EntidadOpcionUI) => Promise<void>;
}) {
  const [nivel, setNivel] = useState<NivelCruce>('ad');
  const [soloSinResolver, setSoloSinResolver] = useState(true);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [ocupado, setOcupado] = useState<string | null>(null);

  const datos = niveles[nivel];
  const opciones = entidades[nivel];
  const pct =
    datos.cobertura.total > 0
      ? Math.round((datos.cobertura.resueltos / datos.cobertura.total) * 100)
      : null;

  const filas = useMemo(
    () => (soloSinResolver ? datos.rows.filter((r) => !r.resolved) : datos.rows),
    [datos.rows, soloSinResolver]
  );

  async function guardar(row: NivelRowUI) {
    const id = picks[`${nivel}|${row.value}`] ?? row.suggestion?.id;
    const entidad = opciones.find((o) => o.id === id);
    if (!entidad) return;
    setOcupado(row.value);
    try {
      await onMapear(nivel, row, entidad);
    } finally {
      setOcupado(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="px-6 py-4 border-b border-border flex flex-wrap items-center gap-3">
        <Layers className="h-4 w-4 text-emerald-500" />
        <h2 className="text-sm font-semibold text-foreground">Conjunto y anuncio</h2>
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-muted p-0.5">
          {(['ad', 'adset'] as NivelCruce[]).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setNivel(n)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium ${
                nivel === n ? 'bg-emerald-600 text-white' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {n === 'ad' ? <Film className="h-3 w-3" /> : <Layers className="h-3 w-3" />}
              {TITULO[n]}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={soloSinResolver}
            onChange={(e) => setSoloSinResolver(e.target.checked)}
            className="accent-emerald-500"
          />
          Solo sin resolver
        </label>
      </div>

      <div className="px-6 py-3 border-b border-border grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <Dato label={`Leads con ${CAMPO[nivel]}`} valor={datos.cobertura.total.toLocaleString()} />
        <Dato label="Resueltos a nombre real" valor={pct === null ? '—' : `${pct}%`} />
        <Dato label="Llegaron como ID" valor={datos.cobertura.conId.toLocaleString()} />
        <Dato label="Por corrección manual" valor={datos.cobertura.manual.toLocaleString()} />
      </div>

      {!habilitado && (
        <p className="px-6 py-2 text-[11px] text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 border-b border-border">
          La corrección manual por conjunto y anuncio se activa al instalar la migración 079. Lo que
          se resuelve solo (IDs y nombres conocidos) ya funciona.
        </p>
      )}

      {filas.length === 0 ? (
        <div className="px-6 py-8 text-center text-xs text-muted-foreground">
          {datos.rows.length === 0
            ? `Los leads del rango no traen ${CAMPO[nivel]}.`
            : 'Todo resuelto en este nivel.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-muted/60">
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-3">Valor en {CAMPO[nivel]}</th>
                <th className="px-6 py-3 text-right">Leads</th>
                <th className="px-6 py-3">Estado</th>
                <th className="px-6 py-3">Corregir</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filas.map((row) => {
                const key = `${nivel}|${row.value}`;
                const elegido = picks[key] ?? row.suggestion?.id ?? '';
                return (
                  <tr key={key} className="hover:bg-accent align-top">
                    <td
                      className="px-6 py-3 text-xs font-mono text-foreground max-w-[300px] truncate"
                      title={row.value}
                    >
                      {row.es_id && (
                        <Hash
                          className="inline h-3 w-3 mr-1 text-muted-foreground"
                          aria-label="ID"
                        />
                      )}
                      {row.value}
                    </td>
                    <td className="px-6 py-3 text-right text-xs font-mono tabular-nums">
                      {row.count}
                    </td>
                    <td className="px-6 py-3">
                      {row.resolved ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                          <span className="max-w-[240px] truncate" title={row.resolved}>
                            {row.resolved}
                          </span>
                          <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10">
                            {row.via === 'manual' ? 'Manual' : row.es_id ? 'Por ID' : 'Nombre'}
                          </span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {row.es_id ? 'ID que no está en la cuenta' : 'Sin resolver'}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3">
                      {!row.resolved && opciones.length > 0 ? (
                        <div className="flex items-center gap-2">
                          <select
                            value={elegido}
                            onChange={(e) => setPicks((p) => ({ ...p, [key]: e.target.value }))}
                            disabled={!habilitado}
                            className="w-full max-w-[260px] px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground disabled:opacity-50"
                          >
                            <option value="">
                              Elegir {nivel === 'ad' ? 'anuncio' : 'conjunto'}…
                            </option>
                            {opciones.map((o) => (
                              <option key={o.id} value={o.id}>
                                {o.name}
                                {o.campaign_name ? ` — ${o.campaign_name}` : ''}
                                {o.activo ? '' : ' (sin gasto en el rango)'}
                              </option>
                            ))}
                          </select>
                          {row.suggestion && (
                            <span
                              title={`Sugerido: ${row.suggestion.name}`}
                              className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10"
                            >
                              <Sparkles className="h-3 w-3" /> {row.suggestion.confidence}%
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => guardar(row)}
                            disabled={!habilitado || !elegido || ocupado === row.value}
                            className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white nav-active-emerald disabled:opacity-40"
                          >
                            <Plus className="h-3 w-3" /> Mapear
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">
                          {row.resolved ? '—' : 'Sin entidades en el rango para elegir.'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Dato({ label, valor }: { label: string; valor: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold font-mono tabular-nums text-foreground">{valor}</p>
    </div>
  );
}
