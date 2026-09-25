'use client';

import { useState, useTransition } from 'react';
import { Coins, Check, Loader2, AlertTriangle } from 'lucide-react';
import {
  MONEDAS_REPORTE,
  type MonedaReporte,
  type MonedaResuelta,
  type TasaGuardada,
} from '@/lib/moneda-reporte';
import { addDaysISO, colombiaToday } from '@/lib/colombia-date';
import { guardarMonedaReporteAction } from '@/app/(app)/admin/settings/[id]/_moneda';

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
 *
 * Sin ajuste («Automática») se usa la moneda de sus cuentas de Meta, que es la
 * del gasto; solo si no se conoce, USD. La tarjeta avisa cuando el ajuste no
 * coincide con Meta o cuando las cuentas de Meta mezclan monedas: el gasto no se
 * convierte, así que en esos casos el ROAS dividiría dos monedas distintas.
 *
 * Muestra la última tasa guardada de la moneda elegida: es la forma de ver, sin
 * abrir la base, que el worker sigue guardando la tasa de cada día.
 */
export function MonedaReporteCard({
  rtmClienteId,
  resuelta,
  ultimasTasas = {},
}: {
  rtmClienteId: string;
  /** Moneda efectiva y su origen (ver `resolverMonedaDeClienteUtm`). */
  resuelta: MonedaResuelta;
  /** Última tasa guardada en `fx_rates` por moneda (ver `ultimasTasasGuardadas`). */
  ultimasTasas?: Partial<Record<MonedaReporte, TasaGuardada>>;
}) {
  // '' = sin ajuste: se sigue la moneda de Meta.
  const inicial: MonedaReporte | '' = resuelta.origen === 'ajuste' ? resuelta.moneda : '';
  const [eleccion, setEleccion] = useState<MonedaReporte | ''>(inicial);
  const monedaMeta = resuelta.monedasMeta.length === 1 ? resuelta.monedasMeta[0] : null;
  const automatica: MonedaReporte =
    monedaMeta && (MONEDAS_REPORTE as readonly string[]).includes(monedaMeta)
      ? (monedaMeta as MonedaReporte)
      : 'USD';
  const moneda: MonedaReporte = eleccion || automatica;
  const [pendiente, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);

  function guardar() {
    setMsg(null);
    start(async () => {
      const r = await guardarMonedaReporteAction(rtmClienteId, eleccion);
      setMsg(
        r.ok
          ? { ok: true, texto: 'Guardado. Los informes ya muestran Hotmart en esta moneda.' }
          : { ok: false, texto: r.error ?? 'No se pudo guardar.' }
      );
    });
  }

  const tasa = moneda === 'USD' ? undefined : ultimasTasas[moneda];
  const aviso =
    resuelta.monedasMeta.length > 1
      ? `Las cuentas de Meta de este cliente gastan en monedas distintas (${resuelta.monedasMeta.join(', ')}). El gasto no se convierte: el ROAS mezclaría monedas.`
      : monedaMeta && eleccion && eleccion !== monedaMeta
        ? `La cuenta de Meta gasta en ${monedaMeta}, pero se reporta en ${eleccion}. El gasto no se convierte: el ROAS y el CPA dividirían ${eleccion} entre ${monedaMeta}.`
        : null;
  // Más de 2 días sin tasa nueva = el worker no la está guardando.
  const vieja = !!tasa && tasa.fecha < addDaysISO(colombiaToday(), -2);

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-3">
      <div className="flex items-center gap-2">
        <Coins className="h-4 w-4 text-blue-500" />
        <h2 className="text-sm font-semibold text-foreground">Moneda de reporte</h2>
      </div>
      <p className="text-xs text-muted-foreground max-w-2xl">
        Hotmart guarda las ventas en dólares y la cuenta publicitaria gasta en su propia moneda.
        Elige la moneda del cliente —la de su cuenta de Meta— y las ventas se convierten con la tasa
        del día de cada venta, que queda fija. Así el ROAS y el ROI comparan lo mismo con lo mismo.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={eleccion}
          onChange={(e) => setEleccion(e.target.value as MonedaReporte | '')}
          className="px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground"
        >
          <option value="">Automática — {monedaMeta ? `la de Meta (${automatica})` : 'USD'}</option>
          {MONEDAS_REPORTE.map((m) => (
            <option key={m} value={m}>
              {NOMBRE[m]}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={guardar}
          disabled={pendiente || eleccion === inicial}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-40"
        >
          {pendiente ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Guardar
        </button>
        {msg && (
          <span className={`text-[11px] ${msg.ok ? 'text-blue-600' : 'text-red-500'}`}>
            {msg.texto}
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Se reporta en <strong className="text-foreground">{moneda}</strong>
        {eleccion
          ? ', elegida a mano.'
          : monedaMeta
            ? ', tomada de la cuenta de Meta.'
            : ': no se conoce la moneda de la cuenta de Meta.'}
      </p>
      {aviso && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-600">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          {aviso}
        </p>
      )}
      {moneda !== 'USD' && (
        <p className={`text-[11px] ${vieja ? 'text-amber-600' : 'text-muted-foreground'}`}>
          {tasa ? (
            <>
              Última tasa guardada: 1 USD ={' '}
              {tasa.porUsd.toLocaleString('es-AR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              {moneda} ({fechaCorta(tasa.fecha)})
              {vieja &&
                ' — lleva más de 2 días sin actualizarse: revisa que el worker esté corriendo.'}
            </>
          ) : (
            `Todavía no hay ninguna tasa ${moneda} guardada: las ventas se quedan en dólares hasta que el worker guarde la primera.`
          )}
        </p>
      )}
    </div>
  );
}

/** `yyyy-MM-dd` → `dd-MM-yyyy`. */
function fechaCorta(fecha: string): string {
  const [y, m, d] = fecha.split('-');
  return d && m && y ? `${d}-${m}-${y}` : fecha;
}
