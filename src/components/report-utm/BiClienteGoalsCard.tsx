'use client';

import { useState } from 'react';
import { Target, Check, Loader2 } from 'lucide-react';
import type { ClienteGoals } from '@/lib/report-utm/bi-metadata';
import { clearClienteGoalsCache } from '@/lib/report-utm/client-goals';

interface Props {
  clienteId: string;
  initialGoals?: ClienteGoals;
}

// Cada meta con su etiqueta, sentido y ayuda para el trafficker.
const FIELDS: Array<{
  key: keyof ClienteGoals;
  label: string;
  hint: string;
  prefix?: string;
  suffix?: string;
}> = [
  { key: 'cpl_max', label: 'CPL objetivo', hint: 'No superar este costo por lead', prefix: '$' },
  { key: 'cpa_max', label: 'CPA objetivo', hint: 'No superar este costo por venta', prefix: '$' },
  { key: 'roas_min', label: 'ROAS mínimo', hint: 'Retorno mínimo aceptable', suffix: 'x' },
  { key: 'leads_target', label: 'Leads objetivo', hint: 'Leads esperados por período' },
  { key: 'budget', label: 'Presupuesto', hint: 'Inversión máxima por período', prefix: '$' },
];

/**
 * Metas del cliente. Alimentan los semáforos (verde/amarillo/rojo) de los
 * scorecards en los informes, incluido el link público.
 */
export function BiClienteGoalsCard({ clienteId, initialGoals = {} }: Props) {
  const [goals, setGoals] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      FIELDS.map((f) => [f.key, initialGoals[f.key] != null ? String(initialGoals[f.key]) : ''])
    )
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, number> = {};
      for (const f of FIELDS) {
        const n = Number(goals[f.key]);
        if (Number.isFinite(n) && n > 0) payload[f.key] = n;
      }
      const res = await fetch(`/api/report-utm/clientes/${clienteId}/goals`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goals: payload }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json?.error ?? 'No se pudieron guardar las metas.');
        return;
      }
      clearClienteGoalsCache(clienteId);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Target className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Metas del cliente</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Los indicadores de los informes se pintan en verde, amarillo o rojo según estas metas. Deja
        un campo vacío para no evaluarlo.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-[10px] font-medium text-muted-foreground mb-1">
              {f.label}
            </label>
            <div className="flex items-center gap-1">
              {f.prefix && <span className="text-xs text-muted-foreground">{f.prefix}</span>}
              <input
                type="number"
                min="0"
                step="any"
                value={goals[f.key] ?? ''}
                onChange={(e) => {
                  setGoals((prev) => ({ ...prev, [f.key]: e.target.value }));
                  setSaved(false);
                }}
                placeholder="—"
                className="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
              />
              {f.suffix && <span className="text-xs text-muted-foreground">{f.suffix}</span>}
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1">{f.hint}</p>
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-red-500 mt-3">{error}</p>}

      <div className="flex justify-end mt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {saving ? 'Guardando…' : saved ? '¡Guardado!' : 'Guardar metas'}
        </button>
      </div>
    </div>
  );
}
