'use client';

import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Calculator, Pencil, Copy, Check } from 'lucide-react';
import type { CalculatedField } from './BiTypes';
import { evaluateExpression } from '@/lib/report-utm/bi-metadata';
import { BiFormulaInput } from './BiFormulaInput';
import { useBiClientFields } from './useBiClientFields';
import { HelpTip } from './HelpTip';

interface Props {
  fields: CalculatedField[];
  /** Cliente vigente (para ofrecer sus campos de formulario y la vista previa real). */
  clienteId?: string;
  dateFrom?: string;
  dateTo?: string;
  onSave: (fields: CalculatedField[]) => void;
  onClose: () => void;
}

type CalcFormat = 'number' | 'currency' | 'percent' | 'ratio';

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Valores de respaldo para previsualizar cuando no hay cliente seleccionado.
const SAMPLE: Record<string, number> = {
  leads_count: 100,
  sales_count: 12,
  revenue: 3600,
  spend: 900,
  clicks: 800,
  impressions: 40000,
  cpl: 9,
  cpa: 75,
  roas: 4,
  conversion_rate: 12,
  cpc: 1.12,
  cpm: 22.5,
};

const FORMAT_LABEL: Record<CalcFormat, string> = {
  number: 'Número',
  currency: 'Moneda',
  percent: 'Porcentaje',
  ratio: 'Ratio (x)',
};

export function BiCalcFieldsModal({
  fields: initial,
  clienteId,
  dateFrom,
  dateTo,
  onSave,
  onClose,
}: Props) {
  const [fields, setFields] = useState<CalculatedField[]>(initial);
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [fmt, setFmt] = useState<CalcFormat>('number');
  const [decimals, setDecimals] = useState<string>('');
  /** id del campo que se está editando; null = alta de uno nuevo. */
  const [editingId, setEditingId] = useState<string | null>(null);
  // Antes este modal solo pedía `/bi/form-fields` y pasaba `formFields` al
  // input, así que los alias `sf__`, `sv__`, `off__` y `lseg__` no salían en
  // ninguna lista: solo funcionaban si te los sabías de memoria. El hook es el
  // mismo que usa el editor de widgets, de modo que las dos pantallas no pueden
  // volver a ofrecer catálogos distintos.
  const { formFields, leadSegments, offlineFields, sheetFields, sheetViews } = useBiClientFields(
    clienteId,
    dateFrom,
    dateTo
  );
  // Vista previa con datos reales del cliente/rango.
  const [realPreview, setRealPreview] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);

  // Previsualización con los datos REALES del cliente y rango (debounced), en
  // vez de números de ejemplo: así se ve si la fórmula da un valor plausible.
  const sampleValue = expr ? evaluateExpression(expr, SAMPLE) : null;
  useEffect(() => {
    if (!clienteId || !expr.trim() || sampleValue === null) {
      setRealPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams({ metrics: '', dimension: 'none', cliente_id: clienteId });
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      params.set('calc[__preview]', expr.trim());
      fetch(`/api/report-utm/bi/query?${params}`)
        .then((r) => r.json())
        .then((json) => {
          if (cancelled) return;
          const row = Array.isArray(json.data) ? json.data[0] : null;
          const v = row?.__preview;
          setRealPreview(typeof v === 'number' ? v : null);
        })
        .catch(() => {
          if (!cancelled) setRealPreview(null);
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [expr, clienteId, dateFrom, dateTo, sampleValue]);

  const validName = /^[a-z_][a-z0-9_]*$/i.test(name);
  // Al editar, el propio campo no cuenta como nombre duplicado.
  const nameTaken = fields.some((f) => f.name === name && f.id !== editingId);
  const canSubmit = validName && !nameTaken && expr.trim() && sampleValue !== null;

  function resetForm() {
    setName('');
    setExpr('');
    setFmt('number');
    setDecimals('');
    setEditingId(null);
  }

  function submit() {
    if (!canSubmit) return;
    const dec =
      decimals.trim() === '' ? undefined : Math.max(0, Math.min(4, Number(decimals) || 0));
    const next: CalculatedField = {
      id: editingId ?? genId(),
      name: name.trim(),
      expression: expr.trim(),
      format: fmt,
      ...(dec !== undefined ? { decimals: dec } : {}),
    };
    setFields((prev) =>
      editingId ? prev.map((f) => (f.id === editingId ? next : f)) : [...prev, next]
    );
    resetForm();
  }

  function startEdit(f: CalculatedField) {
    setEditingId(f.id);
    setName(f.name);
    setExpr(f.expression);
    setFmt((f.format ?? 'number') as CalcFormat);
    setDecimals(f.decimals === undefined ? '' : String(f.decimals));
  }

  function duplicate(f: CalculatedField) {
    // Nombre libre: _copia, _copia_2, … (el nombre es el identificador).
    let candidate = `${f.name}_copia`;
    let n = 2;
    while (fields.some((x) => x.name === candidate)) candidate = `${f.name}_copia_${n++}`;
    setFields((prev) => [...prev, { ...f, id: genId(), name: candidate }]);
  }

  function remove(id: string) {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (editingId === id) resetForm();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-3xl mx-4 rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Calculator className="h-4 w-4 text-emerald-500" />
            <p className="text-sm font-semibold text-foreground">Campos calculados</p>
            <HelpTip text="Crea tus propias métricas combinando las existentes con + - * / y paréntesis. Ej: 'revenue / sales_count' = ticket promedio. Usa el botón Métrica para insertarlas sin escribirlas de memoria. Luego las eliges como métrica en cualquier widget (aparecen con ∑)." />
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent text-muted-foreground transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 max-h-[80vh] overflow-y-auto">
          {/* Cómo se usan: sin esto no es evidente dónde aparecen luego. */}
          <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
            <p className="text-[11px] text-emerald-700 dark:text-emerald-300 leading-relaxed">
              <strong>Cómo usarlos:</strong> un campo calculado es una métrica tuya, guardada en
              este informe. Al crearlo aparece como <strong>∑ nombre</strong> en el selector de
              métrica de cualquier widget (scorecard, gráfica o columna de tabla). Se recalcula solo
              con los filtros y el rango de fechas que tenga el informe.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
            {/* Lista existente */}
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Tus campos ({fields.length})
              </p>
              {fields.length === 0 ? (
                <p className="text-[11px] text-muted-foreground rounded-lg border border-dashed border-border px-3 py-4 text-center">
                  Aún no has creado ninguno. Crea el primero con el formulario de la derecha.
                </p>
              ) : (
                fields.map((f) => (
                  <div
                    key={f.id}
                    className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border transition-colors ${
                      editingId === f.id
                        ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-500/50'
                        : 'bg-muted/40 border-border'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate">
                        {f.name}
                        <span className="ml-1.5 font-normal text-[10px] text-muted-foreground">
                          {FORMAT_LABEL[(f.format ?? 'number') as CalcFormat]}
                          {f.decimals !== undefined ? ` · ${f.decimals} dec` : ''}
                        </span>
                      </p>
                      <p className="text-[10px] font-mono text-muted-foreground truncate">
                        {f.expression}
                      </p>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={() => startEdit(f)}
                        title="Editar"
                        className="p-1 rounded text-muted-foreground hover:text-emerald-600 transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => duplicate(f)}
                        title="Duplicar"
                        className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => remove(f.id)}
                        title="Eliminar"
                        className="p-1 rounded text-muted-foreground hover:text-red-500 transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Alta / edición */}
            <div
              className={`rounded-xl border p-4 space-y-3 ${editingId ? 'border-emerald-500/50' : 'border-dashed border-border'}`}
            >
              {editingId && (
                <div className="flex items-center justify-between">
                  <p className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    Editando campo
                  </p>
                  <button
                    onClick={resetForm}
                    className="text-[10px] text-muted-foreground hover:text-foreground"
                  >
                    Cancelar edición
                  </button>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                    Nombre
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="ticket_promedio"
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                    Formato
                  </label>
                  <select
                    value={fmt}
                    onChange={(e) => setFmt(e.target.value as CalcFormat)}
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  >
                    {(Object.keys(FORMAT_LABEL) as CalcFormat[]).map((k) => (
                      <option key={k} value={k}>
                        {FORMAT_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                    Decimales
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={4}
                    value={decimals}
                    onChange={(e) => setDecimals(e.target.value)}
                    placeholder="auto"
                    className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                  />
                </div>
              </div>
              {!validName && name && (
                <p className="text-[10px] text-red-500">
                  El nombre solo admite letras, números y guion bajo, y no puede empezar por número.
                </p>
              )}
              {nameTaken && (
                <p className="text-[10px] text-red-500">Ya existe un campo con ese nombre.</p>
              )}
              <div>
                <label className="block text-[10px] font-medium text-muted-foreground mb-1">
                  Expresión
                </label>
                <BiFormulaInput
                  value={expr}
                  onChange={setExpr}
                  formFields={formFields}
                  offlineFields={offlineFields}
                  sheetFields={sheetFields}
                  sheetViews={sheetViews}
                  leadSegments={leadSegments}
                />
                <div className="flex items-center justify-between mt-1.5 gap-2">
                  <p className="text-[10px] text-muted-foreground min-w-0 truncate">
                    {sampleValue === null && expr ? (
                      <span className="text-red-500">Expresión inválida</span>
                    ) : clienteId ? (
                      previewing ? (
                        'Calculando…'
                      ) : realPreview !== null ? (
                        <>
                          En este período:{' '}
                          <span className="font-mono text-emerald-600 dark:text-emerald-400">
                            {realPreview}
                          </span>
                        </>
                      ) : expr ? (
                        'Sin datos en el período'
                      ) : (
                        ''
                      )
                    ) : expr ? (
                      <>
                        Ejemplo:{' '}
                        <span className="font-mono text-emerald-600 dark:text-emerald-400">
                          {sampleValue}
                        </span>
                      </>
                    ) : (
                      ''
                    )}
                  </p>
                  <button
                    onClick={submit}
                    disabled={!canSubmit}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-white nav-active-emerald disabled:opacity-40 shrink-0"
                  >
                    {editingId ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                    {editingId ? 'Guardar cambios' : 'Agregar'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:bg-accent transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => onSave(fields)}
            className="px-4 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald"
          >
            Guardar campos
          </button>
        </div>
      </div>
    </div>
  );
}
