'use client';

// Selector de campo en dos pasos: FUENTE → CAMPO.
//
// ── Qué sustituye ────────────────────────────────────────────────────────
// Un `<select>` plano con 72 métricas fijas repartidas en 9 optgroups, más los
// campos dinámicos del cliente, más un buscador, más un botón
// «Ver todas (60 más)» para que la lista por defecto fuera manejable. El propio
// código lo admitía: «con 72 métricas fijas + las dinámicas del cliente en una
// lista plana, encontrar "CPL" costaba más que calcularlo a mano».
//
// La cascada `fuente → campo` es lo que hace que las herramientas del mercado se
// sientan fáciles: primero decides DE DÓNDE sale el dato (Anuncios, Leads,
// Ventas, GA4, Hotmart, Sheet…) y solo entonces eliges el campo, entre los pocos
// que esa fuente tiene. Y una fuente que no se puede leer se atenúa ENTERA con
// su motivo, en vez de listar 40 campos que van a dar 0.
//
// ── Compatibilidad ───────────────────────────────────────────────────────
// Devuelve el id HISTÓRICO (`spend`, `leads_count`, `sheetagg:sum:ticket`), así
// que los informes se siguen guardando exactamente igual que hoy. No hay
// migración de datos detrás de este cambio.

import { useEffect, useMemo, useState } from 'react';
import { Search, ChevronRight, AlertCircle, Lock, Check, Info } from 'lucide-react';

export interface CatalogField {
  id: string;
  canonicalId: string;
  label: string;
  help: string;
  kind: 'measure' | 'dimension';
  format?: string;
  group: string;
  recommended?: boolean;
  additive?: boolean;
  pivotable?: boolean;
  funnelStage?: number;
  conflictsWith?: string[];
  direction?: 'up' | 'down';
  /** Presente solo si se pidió el catálogo con una dimensión. */
  crossesDimension?: boolean;
}

export interface CatalogSource {
  id: string;
  label: string;
  grain: 'row' | 'daily' | 'snapshot';
  grainText: string;
  joinAxes: string[];
  available: boolean;
  unavailableReason?: string;
  fields: CatalogField[];
}

interface Props {
  /** Qué se está eligiendo. */
  kind: 'measure' | 'dimension';
  /** Id (histórico) seleccionado. */
  value?: string;
  onChange: (id: string, field: CatalogField) => void;
  clienteId?: string;
  /** Dimensión actual del widget: marca los campos que no cruzan con ella. */
  dimension?: string;
  /** Ids ya elegidos en el widget, para avisar de solapamientos. */
  alreadyChosen?: string[];
  /** Solo campos válidos como etapa de embudo. */
  onlyFunnelStages?: boolean;
  /** Solo campos válidos como eje de tabla dinámica. */
  onlyPivotable?: boolean;
}

/** Qué puede hacer una fuente, en una frase. Se muestra bajo su nombre. */
const GRAIN_TEXT: Record<CatalogSource['grain'], string> = {
  row: 'Una fila por hecho: se puede contar y cruzar por cualquier campo suyo.',
  daily: 'Agregada por día: cruza por fecha y campaña, no por país ni formulario.',
  snapshot: 'Es una foto del momento: solo tiene sentido en el total del período.',
};

export function BiFieldPicker({
  kind,
  value,
  onChange,
  clienteId,
  dimension,
  alreadyChosen = [],
  onlyFunnelStages,
  onlyPivotable,
}: Props) {
  const [sources, setSources] = useState<CatalogSource[] | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const params = new URLSearchParams();
    if (clienteId) params.set('cliente_id', clienteId);
    if (dimension) params.set('dimension', dimension);
    let cancelled = false;
    fetch(`/api/report-utm/bi/catalog?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        setSources(json?.data?.sources ?? []);
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, [clienteId, dimension]);

  /** Campos que aplican a este selector, ya filtrados por tipo y por uso. */
  const fuentesUtiles = useMemo(() => {
    if (!sources) return [];
    return sources
      .map((s) => ({
        ...s,
        fields: s.fields.filter((f) => {
          if (f.kind !== kind) return false;
          if (onlyFunnelStages && f.funnelStage === undefined) return false;
          if (onlyPivotable && !f.pivotable) return false;
          return true;
        }),
      }))
      .filter((s) => s.fields.length > 0);
  }, [sources, kind, onlyFunnelStages, onlyPivotable]);

  /** Búsqueda: atraviesa todas las fuentes, porque quien sabe el nombre no
   *  quiere navegar. Es el escape de la cascada, no su sustituto. */
  const resultados = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return null;
    const out: Array<{ source: CatalogSource; field: CatalogField }> = [];
    for (const s of fuentesUtiles) {
      for (const f of s.fields) {
        if (f.label.toLowerCase().includes(term) || f.id.toLowerCase().includes(term)) {
          out.push({ source: s, field: f });
        }
      }
    }
    return out.slice(0, 40);
  }, [q, fuentesUtiles]);

  if (!sources) {
    return <p className="text-xs text-muted-foreground py-3">Cargando campos…</p>;
  }
  if (!fuentesUtiles.length) {
    return <p className="text-xs text-muted-foreground py-3">No hay campos disponibles.</p>;
  }

  // La fuente activa se DERIVA en vez de fijarse con un efecto: `activeSource`
  // guarda solo la elección explícita del usuario, y si no hay ninguna se cae
  // a la fuente del valor ya seleccionado, luego a la primera disponible.
  // Así no hay setState en el cuerpo de un efecto ni el render en cascada.
  const activa =
    fuentesUtiles.find((s) => s.id === activeSource) ??
    (value ? fuentesUtiles.find((s) => s.fields.some((f) => f.id === value)) : undefined) ??
    fuentesUtiles.find((s) => s.available) ??
    fuentesUtiles[0];
  const yaElegidos = new Set(alreadyChosen);

  /** Aviso de solapamiento: mide lo mismo que algo ya elegido. */
  const solapaCon = (f: CatalogField) => (f.conflictsWith ?? []).filter((id) => yaElegidos.has(id));

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar en todas las fuentes…"
          className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>

      {resultados ? (
        <div className="max-h-72 overflow-y-auto">
          {resultados.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-4">Sin resultados.</p>
          )}
          {resultados.map(({ source, field }) => (
            <FieldRow
              key={`${source.id}.${field.id}`}
              field={field}
              sourceLabel={source.label}
              disabled={!source.available}
              selected={field.id === value}
              overlaps={solapaCon(field)}
              onPick={() => source.available && onChange(field.id, field)}
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,11rem)_1fr] divide-x divide-border">
          {/* ── Paso 1: la fuente ── */}
          <ul className="max-h-72 overflow-y-auto py-1">
            {fuentesUtiles.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setActiveSource(s.id)}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-1.5 ${
                    s.id === activa.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  {!s.available && <Lock className="h-3 w-3 shrink-0 text-amber-500" />}
                  <span className="truncate flex-1">{s.label}</span>
                  <span className="text-[10px] tabular-nums opacity-60">{s.fields.length}</span>
                  {s.id === activa.id && <ChevronRight className="h-3 w-3 shrink-0" />}
                </button>
              </li>
            ))}
          </ul>

          {/* ── Paso 2: el campo ── */}
          <div className="max-h-72 overflow-y-auto">
            <div className="px-3 py-2 border-b border-border bg-muted/30">
              <p className="text-[10px] text-muted-foreground leading-snug">
                {GRAIN_TEXT[activa.grain]}
              </p>
              {!activa.available && (
                <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-500">
                  <AlertCircle className="h-3 w-3 shrink-0 mt-[1px]" />
                  {activa.unavailableReason}
                </p>
              )}
            </div>
            {/* Las recomendadas primero: son las que sirven para el 90%
                            de los informes y cruzan bien entre sí. */}
            {[...activa.fields]
              .sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended))
              .map((f) => (
                <FieldRow
                  key={f.id}
                  field={f}
                  disabled={!activa.available}
                  selected={f.id === value}
                  overlaps={solapaCon(f)}
                  onPick={() => activa.available && onChange(f.id, f)}
                />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  field,
  sourceLabel,
  disabled,
  selected,
  overlaps,
  onPick,
}: {
  field: CatalogField;
  sourceLabel?: string;
  disabled?: boolean;
  selected?: boolean;
  overlaps: string[];
  onPick: () => void;
}) {
  // `crossesDimension === false` significa que con la dimensión actual este
  // campo caería en la fila total. Se avisa ANTES de elegirlo, que es la
  // diferencia entre una advertencia útil y descubrir un 0 en el informe.
  const noCruza = field.crossesDimension === false;

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={disabled}
      title={field.help || undefined}
      className={`w-full text-left px-3 py-2 flex items-start gap-2 text-xs ${
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : selected
            ? 'bg-primary/10'
            : 'hover:bg-muted/50'
      }`}
    >
      <span className="w-3 shrink-0 pt-0.5">
        {selected && <Check className="h-3 w-3 text-primary" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-foreground">{field.label}</span>
          {field.recommended && (
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              recomendada
            </span>
          )}
        </span>
        {sourceLabel && (
          <span className="block text-[10px] text-muted-foreground truncate">{sourceLabel}</span>
        )}
        {noCruza && (
          <span className="mt-0.5 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-500">
            <Info className="h-2.5 w-2.5 shrink-0 mt-[2px]" />
            No se desglosa por la dimensión elegida: saldría en el total.
          </span>
        )}
        {overlaps.length > 0 && (
          <span className="mt-0.5 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-500">
            <Info className="h-2.5 w-2.5 shrink-0 mt-[2px]" />
            Mide lo mismo que {overlaps.join(', ')}: no las sumes juntas.
          </span>
        )}
      </span>
    </button>
  );
}
