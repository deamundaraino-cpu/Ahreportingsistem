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
import { agruparPorProveedor } from './fuentesPorProveedor';

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
  /** Texto propio bajo la fuente (las carpetas por proveedor lo traen). */
  nota?: string;
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
  /**
   * Fuentes propias del cliente y del informe (preguntas, respuestas y
   * segmentos de formulario, campos de Sheet, campos calculados…). El catálogo
   * del servidor solo trae las métricas fijas: ver `fuentesDelCliente.ts`.
   */
  extraSources?: CatalogSource[];
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
  extraSources = [],
}: Props) {
  const [sources, setSources] = useState<CatalogSource[] | null>(null);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [q, setQ] = useState('');
  /** Campo bajo el ratón: su ficha se enseña en el pie en vez de en un `title`
   *  que nadie descubre. Sin hover, la ficha es la del campo elegido. */
  const [hover, setHover] = useState<{ field: CatalogField; sourceLabel: string } | null>(null);

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
    // Las del cliente van PRIMERO: son las que este informe tiene de propio y
    // las que más cuesta encontrar en una lista larga.
    // GA4 y Hotmart se juntan en una carpeta por proveedor cada uno: sus
    // campos vienen de varias tablas y nadie sabe en cuál vive cada uno.
    return agruparPorProveedor([...extraSources, ...sources])
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
  }, [sources, extraSources, kind, onlyFunnelStages, onlyPivotable]);

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

  const elegido = (() => {
    if (!value) return null;
    for (const s of fuentesUtiles) {
      const field = s.fields.find((f) => f.id === value);
      if (field) return { field, sourceLabel: s.label };
    }
    return null;
  })();
  const ficha = hover ?? elegido;

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
        <div className="max-h-80 overflow-y-auto" onMouseLeave={() => setHover(null)}>
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
              onHover={() => setHover({ field, sourceLabel: source.label })}
              onPick={() => source.available && onChange(field.id, field)}
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,12rem)_1fr] divide-x divide-border">
          {/* ── Paso 1: la fuente ── */}
          {/* Los nombres de fuente se parten en dos líneas en vez de cortarse:
              «Anuncios (Meta / Ti…» no dice qué fuente es. */}
          <ul className="max-h-80 overflow-y-auto py-1">
            {fuentesUtiles.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setActiveSource(s.id)}
                  title={s.label}
                  className={`w-full text-left px-3 py-2 text-xs flex items-center gap-1.5 ${
                    s.id === activa.id
                      ? 'bg-muted font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/50'
                  }`}
                >
                  {!s.available && <Lock className="h-3 w-3 shrink-0 text-amber-500" />}
                  <span className="flex-1 min-w-0 leading-snug break-words">{s.label}</span>
                  <span className="text-[10px] tabular-nums opacity-60">{s.fields.length}</span>
                  {s.id === activa.id && <ChevronRight className="h-3 w-3 shrink-0" />}
                </button>
              </li>
            ))}
          </ul>

          {/* ── Paso 2: el campo ── */}
          <div className="max-h-80 overflow-y-auto" onMouseLeave={() => setHover(null)}>
            <div className="px-3 py-2 border-b border-border bg-muted/30">
              <p className="text-[10px] text-muted-foreground leading-snug">
                {activa.nota ?? GRAIN_TEXT[activa.grain]}
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
            {(() => {
              // Por grupo en el orden en que llegan y, dentro, las recomendadas
              // primero: ordenar solo por recomendadas partía un grupo en dos y
              // repetía su cabecera.
              const ordenGrupo = new Map<string, number>();
              for (const f of activa.fields) {
                if (!ordenGrupo.has(f.group)) ordenGrupo.set(f.group, ordenGrupo.size);
              }
              const campos = [...activa.fields].sort(
                (a, b) =>
                  ordenGrupo.get(a.group)! - ordenGrupo.get(b.group)! ||
                  Number(!!b.recommended) - Number(!!a.recommended)
              );
              // Con varios grupos (una pregunta con sus respuestas, otra con
              // las suyas…) se enseña la cabecera de cada uno: sin ella, veinte
              // respuestas seguidas no dicen a qué pregunta pertenecen.
              const conGrupos = new Set(campos.map((f) => f.group)).size > 1;
              return campos.map((f, i) => (
                <div key={f.id}>
                  {conGrupos && (i === 0 || campos[i - 1].group !== f.group) && (
                    <p className="sticky top-0 z-10 px-3 pt-2 pb-1 bg-card border-b border-border text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {f.group}
                    </p>
                  )}
                  <FieldRow
                    field={f}
                    // Bajo la cabecera de su pregunta, «Número de propiedades: 1-2»
                    // se lee «1-2»: repetir la pregunta es lo que cortaba la
                    // respuesta y dejaba veinte filas idénticas.
                    shortLabel={conGrupos ? sinPrefijo(f.label, f.group) : undefined}
                    disabled={!activa.available}
                    selected={f.id === value}
                    overlaps={solapaCon(f)}
                    onHover={() => setHover({ field: f, sourceLabel: activa.label })}
                    onPick={() => activa.available && onChange(f.id, f)}
                  />
                </div>
              ));
            })()}
          </div>
        </div>
      )}

      {/* ── Ficha del campo: qué es y cómo se usa ── */}
      <div className="border-t border-border bg-muted/30 px-3 py-2 min-h-[3.25rem]">
        {ficha ? (
          <>
            <p className="text-[11px] font-medium text-foreground leading-snug break-words">
              {ficha.field.label}
              <span className="font-normal text-muted-foreground"> · {ficha.sourceLabel}</span>
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground leading-snug">
              {ficha.field.help || descripcionPorDefecto(ficha.field)}
            </p>
          </>
        ) : (
          <p className="text-[10px] text-muted-foreground leading-snug">
            Pasa el ratón por un campo para ver qué mide y cómo usarlo.
          </p>
        )}
      </div>
    </div>
  );
}

/** «Pregunta: respuesta» → «respuesta» cuando la pregunta ya es la cabecera. */
function sinPrefijo(label: string, group: string): string {
  const prefijo = `${group}: `;
  return label.startsWith(prefijo) ? label.slice(prefijo.length) : label;
}

/** Para los campos sin `help` (Sheet, conversiones, GA4…): al menos qué tipo de
 *  dato es y si se puede sumar, que es lo que decide cómo usarlo. */
function descripcionPorDefecto(f: CatalogField): string {
  if (f.kind === 'dimension')
    return 'Agrupa los datos: una fila o barra por cada valor de este campo.';
  if (f.additive === true) return 'Recuento o suma: se puede sumar entre días y campañas.';
  if (f.additive === false)
    return 'Valor calculado (media, ratio, mínimo o máximo): no lo sumes con otros.';
  return 'Métrica de esta fuente.';
}

function FieldRow({
  field,
  shortLabel,
  sourceLabel,
  disabled,
  selected,
  overlaps,
  onHover,
  onPick,
}: {
  field: CatalogField;
  /** Etiqueta sin la parte que ya dice la cabecera del grupo. */
  shortLabel?: string;
  sourceLabel?: string;
  disabled?: boolean;
  selected?: boolean;
  overlaps: string[];
  onHover?: () => void;
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
      onMouseEnter={onHover}
      onFocus={onHover}
      disabled={disabled}
      title={field.label}
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
        <span className="flex items-start gap-1.5">
          {/* Se parte en líneas en vez de cortarse: la parte que distingue un
              campo de otro suele estar al final del nombre. */}
          <span className="min-w-0 break-words leading-snug text-foreground">
            {shortLabel ?? field.label}
          </span>
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
