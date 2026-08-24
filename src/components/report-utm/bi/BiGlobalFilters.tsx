'use client';

import { useState, useEffect } from 'react';
import {
  Filter,
  RefreshCw,
  SlidersHorizontal,
  ChevronDown,
  X,
  Lock,
  Plus,
  Save,
  Check,
} from 'lucide-react';
import type { BiFilters } from './BiTypes';
import type {
  AdvancedFilter,
  FilterCondition,
  FilterOp,
  FormFieldMeta,
  SheetFieldMeta,
  LeadFieldMeta,
} from '@/lib/report-utm/bi-metadata';
import {
  FILTER_OPS,
  FILTERABLE_BASE_DIMS,
  makeFieldDim,
  humanizeFieldKey,
  ADVANCED_FILTER_KEY,
  makeSheetDim,
  makeLeadFieldDim,
} from '@/lib/report-utm/bi-metadata';
import { HelpTip } from './HelpTip';
import { esSeleccionPorCasillas } from '@/lib/report-utm/bi-valores';
import { SelectorDeValores } from './SelectorDeValores';
import { DEFAULT_BI_QUERY_BASE } from './BiQueryContext';

interface Cliente {
  id: string;
  nombre: string;
}

interface Props {
  initialFilters: BiFilters;
  onChange: (filters: BiFilters) => void;
  /** Si true, el selector de cliente queda bloqueado (no editable por el lector). */
  clienteLocked?: boolean;
  /** Notifica cuando se cambia el cliente (solo en modo edición) para reasignar el informe. */
  onClienteChange?: (id: string) => void;
  // ── Filtro avanzado guardado (Y de O) ──
  advancedFilter: AdvancedFilter;
  onAdvancedChange: (af: AdvancedFilter) => void;
  onAdvancedSave: () => void;
  savingAdvanced?: boolean;
  advancedSaved?: boolean;
  /** Vista de solo lectura (link público): muestra el filtro sin editarlo. */
  readonly?: boolean;
  /** Rango de fechas congelado (link de una entrega): oculta presets y bloquea el rango. */
  datesLocked?: boolean;
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  return toISODate(new Date(Date.now() - n * 86400_000));
}

// Fecha de calendario LOCAL (evita corrimiento de día por zona horaria en
// los atajos de calendario: hoy/ayer/este mes).
function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rollingRange(days: number): { from: string; to: string } {
  return { from: daysAgo(days), to: toISODate(new Date()) };
}

interface Preset {
  key: string;
  label: string;
  range: () => { from: string; to: string };
}

const PRESETS: Preset[] = [
  {
    key: 'today',
    label: 'Hoy',
    range: () => {
      const t = isoLocal(new Date());
      return { from: t, to: t };
    },
  },
  {
    key: 'yesterday',
    label: 'Ayer',
    range: () => {
      const y = isoLocal(new Date(Date.now() - 86400_000));
      return { from: y, to: y };
    },
  },
  {
    key: 'month',
    label: 'Este mes',
    range: () => {
      const n = new Date();
      return { from: isoLocal(new Date(n.getFullYear(), n.getMonth(), 1)), to: isoLocal(n) };
    },
  },
  { key: '7d', label: '7d', range: () => rollingRange(7) },
  { key: '14d', label: '14d', range: () => rollingRange(14) },
  { key: '30d', label: '30d', range: () => rollingRange(30) },
  { key: '90d', label: '90d', range: () => rollingRange(90) },
];

// Detecta si un rango coincide exactamente con un preset (para resaltarlo).
function detectPreset(from: string, to: string): string | null {
  for (const p of PRESETS) {
    const r = p.range();
    if (r.from === from && r.to === to) return p.key;
  }
  return null;
}

const MONTH_RANGE = PRESETS.find((p) => p.key === 'month')!.range();

const FILTER_OP_SHORT: Record<string, string> = Object.fromEntries(
  FILTER_OPS.map((o) => [o.value, o.short])
);

/** Claves que gestiona esta barra directamente (no son "filtros fijos"). */
// 'days' sigue en la lista para que un informe guardado que lo arrastre no lo
// muestre como un chip de filtro suelto: nunca se leyó como filtro real.
const MANAGED_KEYS = new Set(['cliente_id', 'date_from', 'date_to', 'days', ADVANCED_FILTER_KEY]);

/** Condición con al menos campo + valor. */
function validCond(c: FilterCondition): boolean {
  return !!(c.field && c.value && c.value.trim());
}

const SIN_CAMPOS_LEAD: LeadFieldMeta[] = [];
const SIN_CAMPOS_FORM: FormFieldMeta[] = [];

export function BiGlobalFilters({
  initialFilters,
  onChange,
  clienteLocked,
  onClienteChange,
  advancedFilter,
  onAdvancedChange,
  onAdvancedSave,
  savingAdvanced,
  advancedSaved,
  readonly,
  datesLocked,
}: Props) {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [clienteId, setClienteId] = useState(initialFilters.cliente_id ?? '');
  const [dateFrom, setDateFrom] = useState(initialFilters.date_from ?? MONTH_RANGE.from);
  const [dateTo, setDateTo] = useState(initialFilters.date_to ?? MONTH_RANGE.to);
  const [activePreset, setActivePreset] = useState<string | null>(() =>
    detectPreset(
      initialFilters.date_from ?? MONTH_RANGE.from,
      initialFilters.date_to ?? MONTH_RANGE.to
    )
  );

  // Claves de filtro que gestiona esta barra; el resto (ej. utm_campaign de un
  // informe anclado a una campaña) se conserva tal cual entre cambios.
  //
  // Se recalcula en cada render a partir del prop: si se congelara al montar,
  // un filtro que el usuario quita desde el chip volvería a colarse en el
  // siguiente "Aplicar" (o cambio de fecha/cliente) y sería imposible sacarlo.
  const pinnedFilters = Object.fromEntries(
    Object.entries(initialFilters).filter(
      ([k, v]) => !MANAGED_KEYS.has(k) && v !== undefined && v !== ''
    )
  ) as BiFilters;
  const pinnedCampaign =
    typeof pinnedFilters.utm_campaign === 'string' ? pinnedFilters.utm_campaign : '';

  const condCount = (advancedFilter.groups ?? []).reduce(
    (n, g) => n + (g.conditions ?? []).filter(validCond).length,
    0
  );
  const [showFilters, setShowFilters] = useState(() => condCount > 0);

  // Campos de lead del catálogo del cliente: la opción buena del constructor —
  // traen los valores ya unificados y ordenados, así que se pueden ofrecer.
  const [fetchedLeadFields, setLeadFields] = useState<LeadFieldMeta[]>([]);
  // Sin cliente o en solo lectura no se pide nada, así que la lista vacía se
  // deriva en vez de escribirse desde el efecto.
  const leadFields = readonly || !clienteId ? SIN_CAMPOS_LEAD : fetchedLeadFields;
  useEffect(() => {
    if (readonly || !clienteId) return;
    const params = new URLSearchParams({
      cliente_id: clienteId,
      date_from: dateFrom,
      date_to: dateTo,
    });
    let cancelled = false;
    fetch(`/api/report-utm/bi/lead-fields?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setLeadFields(json.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setLeadFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [readonly, clienteId, dateFrom, dateTo]);

  // `valoresDe()` vivía aquí: devolvía los valores conocidos de un campo para
  // ofrecerlos en un `<datalist>`, y solo sabía hacerlo con los campos de lead
  // y de Sheet. Lo sustituye `SelectorDeValores`, que los lista para CUALQUIER
  // dimensión, con su recuento y permitiendo marcar varios.
  //
  // `leadFields` y `sheetFields` siguen cargándose: alimentan las opciones de
  // CAMPO del desplegable de la izquierda, que es otra cosa.

  // Campos de formulario del cliente → opciones extra del constructor.
  const [fetchedFormFields, setFormFields] = useState<FormFieldMeta[]>([]);
  const formFields = readonly || !clienteId ? SIN_CAMPOS_FORM : fetchedFormFields;
  useEffect(() => {
    // En la vista pública el visitante no tiene sesión: este endpoint daría 401
    // y además el constructor de filtros no se puede editar, así que no se pide.
    if (readonly || !clienteId) return;
    const params = new URLSearchParams({
      cliente_id: clienteId,
      date_from: dateFrom,
      date_to: dateTo,
    });
    let cancelled = false;
    fetch(`/api/report-utm/bi/form-fields?${params}`)
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled) setFormFields(json.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setFormFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [readonly, clienteId, dateFrom, dateTo]);

  // Campos de Sheet del cliente → también filtrables desde el informe.
  const [sheetFields, setSheetFields] = useState<SheetFieldMeta[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // En la vista pública el visitante no tiene sesión (el endpoint daría
      // 401) y además el constructor de filtros no se puede editar.
      if (readonly || !clienteId) {
        if (!cancelled) setSheetFields([]);
        return;
      }
      try {
        const res = await fetch(
          `/api/report-utm/bi/sheet-fields?cliente_id=${encodeURIComponent(clienteId)}`
        );
        const json = await res.json();
        if (!cancelled) setSheetFields(json.data?.fields ?? []);
      } catch {
        if (!cancelled) setSheetFields([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [readonly, clienteId]);

  const fieldOptions: { value: string; label: string }[] = [
    ...FILTERABLE_BASE_DIMS,
    ...leadFields.map((f) => ({ value: makeLeadFieldDim(f.clave), label: f.nombre })),
    ...formFields.map((f) => ({ value: makeFieldDim(f.key), label: humanizeFieldKey(f.label) })),
    ...sheetFields
      .filter((f) => f.rol !== 'metrica' && !f.alta_cardinalidad)
      .map((f) => ({ value: makeSheetDim(f.clave), label: f.nombre })),
  ];
  const labelOf = (field: string) => fieldOptions.find((o) => o.value === field)?.label ?? field;

  useEffect(() => {
    // Igual que form-fields: sin sesión da 401, y en la vista pública el
    // selector de cliente está bloqueado (el informe ya trae el suyo).
    if (readonly) return;
    fetch('/api/report-utm/clientes')
      .then((r) => r.json())
      .then((json) => setClientes(json.data ?? []))
      .catch(() => {});
  }, [readonly]);

  function buildFilters(): BiFilters {
    return {
      // Filtros fijos del informe (ej. la campaña anclada): se conservan al
      // cambiar cliente/fechas, si no se perderían en cada interacción.
      ...pinnedFilters,
      cliente_id: clienteId || undefined,
      date_from: dateFrom,
      date_to: dateTo,
    };
  }

  /** Quita un filtro fijo (chip). Se consolida al guardar el informe. */
  function removePinned(key: string) {
    const next = buildFilters();
    delete next[key];
    onChange(next);
  }

  function applyPreset(p: Preset) {
    const { from, to } = p.range();
    setDateFrom(from);
    setDateTo(to);
    setActivePreset(p.key);
    onChange({ ...buildFilters(), date_from: from, date_to: to });
  }

  // ── Mutadores del filtro avanzado ──
  const groups = advancedFilter.groups ?? [];
  function emit(next: AdvancedFilter['groups']) {
    onAdvancedChange({ groups: next });
  }
  function addGroup() {
    emit([...groups, { conditions: [{ field: 'utm_source', op: 'eq', value: '' }] }]);
  }
  function addCondition(gi: number) {
    emit(
      groups.map((g, i) =>
        i === gi
          ? { conditions: [...g.conditions, { field: 'utm_source', op: 'eq', value: '' }] }
          : g
      )
    );
  }
  function setCondition(gi: number, ci: number, patch: Partial<FilterCondition>) {
    emit(
      groups.map((g, i) =>
        i === gi
          ? { conditions: g.conditions.map((c, j) => (j === ci ? { ...c, ...patch } : c)) }
          : g
      )
    );
  }
  function removeCondition(gi: number, ci: number) {
    const next = groups
      .map((g, i) => (i === gi ? { conditions: g.conditions.filter((_, j) => j !== ci) } : g))
      .filter((g) => g.conditions.length > 0);
    emit(next);
  }
  function removeGroup(gi: number) {
    emit(groups.filter((_, i) => i !== gi));
  }
  function clearAll() {
    emit([]);
  }

  // Descripción textual (para la vista de solo lectura).
  const describe = groups
    .map(
      (g) =>
        '(' +
        g.conditions
          .filter(validCond)
          .map((c) => `${labelOf(c.field)} ${FILTER_OP_SHORT[c.op] ?? c.op} ${c.value}`)
          .join(' O ') +
        ')'
    )
    .filter((s) => s !== '()')
    .join('  Y  ');

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Filter className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Filtros globales</span>
        <HelpTip text="Estos filtros afectan a TODOS los widgets del informe a la vez. Elige cliente y rango de fechas, o usa los atajos Hoy/Ayer/Este mes/7d/14d/30d/90d. Pulsa Aplicar para refrescar." />
        {pinnedCampaign && (
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px] font-medium">
            <Lock className="h-2.5 w-2.5" />
            Campaña: {pinnedCampaign}
            {!readonly && (
              <button
                onClick={() => removePinned('utm_campaign')}
                title="Quitar el filtro de campaña (guarda el informe para que no vuelva)"
                className="ml-0.5 hover:text-red-500"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            )}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex flex-wrap gap-1 justify-end">
          {!datesLocked &&
            PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => applyPreset(p)}
                className={`px-2 py-1 rounded-md text-[10px] font-medium transition-colors ${
                  activePreset === p.key
                    ? 'bg-emerald-500 text-white'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                {p.label}
              </button>
            ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <div>
          <label className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground mb-1">
            Cliente
            {clienteLocked && <Lock className="h-2.5 w-2.5 text-emerald-500" />}
          </label>
          {clienteLocked ? (
            <div className="w-full px-3 py-2 text-xs rounded-lg bg-muted/60 border border-border text-foreground flex items-center gap-1.5 cursor-not-allowed">
              <Lock className="h-3 w-3 text-muted-foreground flex-shrink-0" />
              <span className="truncate">
                {clientes.find((c) => c.id === clienteId)?.nombre ??
                  (clienteId ? 'Cliente fijo' : 'Todos')}
              </span>
            </div>
          ) : (
            <select
              value={clienteId}
              onChange={(e) => {
                const val = e.target.value;
                setClienteId(val);
                onClienteChange?.(val);
                onChange({ ...buildFilters(), cliente_id: val || undefined });
              }}
              className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            >
              <option value="">Todos</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
          )}
          {!clienteLocked && onClienteChange && (
            <p className="text-[9px] text-emerald-600 dark:text-emerald-400 mt-1">
              Queda fijo al informe
            </p>
          )}
        </div>

        <div>
          <label className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground mb-1">
            Desde
            {datesLocked && <Lock className="h-2.5 w-2.5 text-emerald-500" />}
          </label>
          {datesLocked ? (
            <div className="w-full px-3 py-2 text-xs rounded-lg bg-muted/60 border border-border text-foreground cursor-not-allowed">
              {dateFrom}
            </div>
          ) : (
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => {
                const val = e.target.value;
                if (!val) return;
                setDateFrom(val);
                setActivePreset(null);
                onChange({ ...buildFilters(), date_from: val });
              }}
              className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          )}
        </div>

        <div>
          <label className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground mb-1">
            Hasta
            {datesLocked && <Lock className="h-2.5 w-2.5 text-emerald-500" />}
          </label>
          {datesLocked ? (
            <div className="w-full px-3 py-2 text-xs rounded-lg bg-muted/60 border border-border text-foreground cursor-not-allowed">
              {dateTo}
            </div>
          ) : (
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => {
                const val = e.target.value;
                if (!val) return;
                setDateTo(val);
                setActivePreset(null);
                onChange({ ...buildFilters(), date_to: val });
              }}
              className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          )}
        </div>

        <div className="flex items-end">
          <button
            onClick={() => onChange(buildFilters())}
            className="flex items-center gap-1.5 w-full px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald justify-center"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Aplicar
          </button>
        </div>
      </div>

      {/* ── Constructor de filtros guardados (Y de O) ── */}
      <div className="border-t border-border pt-3">
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filtros del informe
          <HelpTip text="Define condiciones sobre las variables (UTMs, país, formulario, campos…). Dentro de un grupo se unen con O (cualquiera); los grupos entre sí con Y (todas). Ej: (Source = facebook O Source = instagram) Y (Campaña contiene verano). Guarda para que se apliquen siempre al abrir el informe." />
          {condCount > 0 && (
            <span className="px-1.5 py-0.5 rounded-full bg-emerald-500 text-white text-[9px] font-semibold">
              {condCount}
            </span>
          )}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${showFilters ? 'rotate-180' : ''}`}
          />
        </button>

        {showFilters &&
          (readonly ? (
            <div className="mt-3 text-[11px] text-muted-foreground">
              {condCount > 0 ? (
                <p className="font-mono leading-relaxed">{describe}</p>
              ) : (
                <p>Sin filtros guardados.</p>
              )}
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {groups.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Sin condiciones. Agrega un grupo para empezar a filtrar.
                </p>
              )}

              {groups.map((g, gi) => (
                <div key={gi}>
                  {gi > 0 && (
                    <div className="flex items-center gap-2 my-1.5">
                      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-bold tracking-wider">
                        Y
                      </span>
                      <div className="flex-1 h-px bg-border" />
                    </div>
                  )}
                  <div className="rounded-xl border border-border bg-muted/20 p-2.5 space-y-1.5">
                    {g.conditions.map((c, ci) => (
                      <div key={ci} className="flex items-center gap-1.5 flex-wrap">
                        {ci > 0 && (
                          <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 w-4 text-center">
                            O
                          </span>
                        )}
                        {ci === 0 && <span className="w-4" />}
                        <select
                          value={c.field}
                          onChange={(e) => setCondition(gi, ci, { field: e.target.value })}
                          className="px-2 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 max-w-[150px]"
                        >
                          {fieldOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={c.op}
                          title="Operador"
                          onChange={(e) => setCondition(gi, ci, { op: e.target.value as FilterOp })}
                          className="px-1.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        >
                          {FILTER_OPS.map((o) => (
                            <option key={o.value} value={o.value} title={o.label}>
                              {o.short}
                            </option>
                          ))}
                        </select>
                        {/* Los valores se eligen de una lista con su recuento, en
                                                    vez de escribirse de memoria. Antes solo los campos de
                                                    lead y de Sheet traían sugerencias (y como `datalist`,
                                                    que no deja ver cuántos hay ni marcar varios); para
                                                    campaña, país o formulario había que acertar el texto
                                                    exacto y un fallo daba un widget vacío sin explicación.

                                                    Con «contiene», «empieza con» y «termina con» se
                                                    conserva el texto libre: son operadores de subcadena y
                                                    una lista de valores exactos no significa nada ahí. */}
                        {esSeleccionPorCasillas(c.op) ? (
                          <div className="flex-1 min-w-[140px]">
                            <SelectorDeValores
                              dimension={c.field}
                              value={c.value}
                              onChange={(v) => setCondition(gi, ci, { value: v })}
                              clienteId={clienteId}
                              dateFrom={dateFrom}
                              dateTo={dateTo}
                              queryBase={DEFAULT_BI_QUERY_BASE}
                            />
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={c.value}
                            onChange={(e) => setCondition(gi, ci, { value: e.target.value })}
                            placeholder="valor (coma = varios)"
                            className="flex-1 min-w-[120px] px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                          />
                        )}
                        <button
                          onClick={() => removeCondition(gi, ci)}
                          title="Quitar condición"
                          className="p-1 text-muted-foreground hover:text-red-500"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    <div className="flex items-center gap-3 pl-5 pt-0.5">
                      <button
                        onClick={() => addCondition(gi)}
                        className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                      >
                        <Plus className="h-3 w-3" /> Condición (O)
                      </button>
                      <button
                        onClick={() => removeGroup(gi)}
                        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-red-500"
                      >
                        <X className="h-3 w-3" /> Eliminar grupo
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              <div className="flex items-center gap-2 flex-wrap pt-1">
                <button
                  onClick={addGroup}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-muted text-foreground hover:bg-accent transition-colors"
                >
                  <Plus className="h-3 w-3" /> Agregar grupo (Y)
                </button>
                <button
                  onClick={onAdvancedSave}
                  disabled={savingAdvanced}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-white nav-active-emerald disabled:opacity-50"
                >
                  {advancedSaved ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                  {savingAdvanced ? 'Guardando…' : advancedSaved ? 'Guardado' : 'Guardar filtros'}
                </button>
                {condCount > 0 && (
                  <button
                    onClick={clearAll}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-muted-foreground hover:bg-accent transition-colors"
                  >
                    <X className="h-3 w-3" /> Limpiar
                  </button>
                )}
                <p className="text-[10px] text-muted-foreground ml-auto">
                  Se aplican en vivo. Guarda para que queden fijos al informe.
                </p>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
