'use client';

import { useState, useTransition } from 'react';
import { Coins, Check, Loader2 } from 'lucide-react';
import { MONEDAS_REPORTE, type MonedaReporte } from '@/lib/moneda-reporte';
import { guardarMonedaReporteAction } from '@/app/(report-utm)/report-utm/clientes/_moneda';

const NOMBRE: Record<MonedaReporte, string> = {
  USD: 'Dólar (USD)',
  CLP: 'Peso chileno (CLP)',
  COP: 'Peso colombiano (COP)',
  MXN: 'Peso mexicano (MXN)',
  PEN: 'Sol peruano (PEN)',
  ARS: 'Peso argentino (ARS)',
  BRL: 'Real brasileño (BRL)',
  EUR: 'Euro (EUR)',
};

/**
 * Moneda en la que se reportan las ventas de Hotmart de este cliente.
 *
 * Tiene que coincidir con la moneda de su cuenta publicitaria: es lo que hace
 * que el ROAS divida dos cifras en la misma moneda. Cada venta se convierte con
 * la tasa del día en que se hizo, así que cambiar la moneda no reescribe nada:
 * solo cambia cómo se lee.
 */
export function MonedaReporteCard({
  rtmClienteId,
  inicial,
}: {
  rtmClienteId: string;
  inicial: MonedaReporte;
}) {
  const [moneda, setMoneda] = useState<MonedaReporte>(inicial);
  const [pendiente, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);

  function guardar() {
    setMsg(null);
    start(async () => {
      const r = await guardarMonedaReporteAction(rtmClienteId, moneda);
      setMsg(
        r.ok
          ? { ok: true, texto: 'Guardado. Los informes ya muestran Hotmart en esta moneda.' }
          : { ok: false, texto: r.error ?? 'No se pudo guardar.' }
      );
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-3">
      <div className="flex items-center gap-2">
        <Coins className="h-4 w-4 text-emerald-500" />
        <h2 className="text-sm font-semibold text-foreground">Moneda de reporte</h2>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Hotmart cobra en dólares y la cuenta publicitaria gasta en su propia moneda. Elige la moneda
        del cliente —la de su cuenta de Meta— y las ventas se convierten con la tasa del día de cada
        venta, que queda fija. Así el ROAS y el ROI comparan lo mismo con lo mismo.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={moneda}
          onChange={(e) => setMoneda(e.target.value as MonedaReporte)}
          className="px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground"
        >
          {MONEDAS_REPORTE.map((m) => (
            <option key={m} value={m}>
              {NOMBRE[m]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={guardar}
          disabled={pendiente || moneda === inicial}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-40"
        >
          {pendiente ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Guardar
        </button>
        {msg && (
          <span className={`text-[11px] ${msg.ok ? 'text-emerald-600' : 'text-red-500'}`}>
            {msg.texto}
          </span>
        )}
      </div>
    </div>
  );
}
