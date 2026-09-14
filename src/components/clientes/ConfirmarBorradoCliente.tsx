'use client';

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import type { ResumenBorrado } from '@/lib/clientes/ciclo-de-vida';

/**
 * Confirmación del borrado de un cliente: la misma en Ajustes y en Report-UTM,
 * para que ninguno de los dos lados borre a ciegas.
 *
 * Se monta al abrirse, así que el nombre tecleado empieza vacío cada vez.
 */
export function ConfirmarBorradoCliente({
  resumen,
  pendiente,
  error,
  onCancelar,
  onConfirmar,
}: {
  resumen: ResumenBorrado;
  pendiente: boolean;
  error?: string | null;
  onCancelar: () => void;
  onConfirmar: () => void;
}) {
  const [confirmacion, setConfirmacion] = useState('');
  const n = (v: number) => v.toLocaleString();

  const datos: Array<[number, string]> = [
    [resumen.diasMetricas, 'días de métricas'],
    [resumen.leadsAprox, 'leads (aprox.)'],
    [resumen.ventasHotmart, 'ventas de Hotmart'],
    [resumen.ventas, 'ventas de webhook'],
    [resumen.informesBi, 'informes BI'],
    [resumen.bitacoras, 'bitácoras (con sus imágenes)'],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      onClick={() => !pendiente && onCancelar()}
    >
      <div
        className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-border bg-card p-6 space-y-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-base font-semibold text-foreground">Eliminar «{resumen.nombre}»</h3>
          <button
            type="button"
            onClick={onCancelar}
            disabled={pendiente}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="text-sm text-muted-foreground">
          {resumen.enlazado ? (
            <>
              Se elimina en el reporting <strong>y</strong> en Report-UTM, con todos sus datos.
            </>
          ) : (
            <>Se elimina de Report-UTM (no está enlazado al reporting), con todos sus datos.</>
          )}{' '}
          No se puede deshacer. Si solo quieres que deje de aparecer, archívalo.
        </p>

        <ul className="text-sm text-foreground space-y-1">
          {datos
            .filter(([v]) => v > 0)
            .map(([v, que]) => (
              <li key={que}>
                · {n(v)} {que}
              </li>
            ))}
          <li>
            · Sus pestañas, integraciones, notificaciones, mensajes, canales y propuestas del
            agente, y su logo
          </li>
        </ul>

        {resumen.automatico.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-foreground">Se desconecta solo</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              {resumen.automatico.map((t) => (
                <li key={t}>· {t}</li>
              ))}
            </ul>
          </div>
        )}

        {resumen.manual.length > 0 && (
          <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
              Tienes que hacerlo tú, fuera de la plataforma
            </p>
            <ul className="text-xs text-amber-800 dark:text-amber-300 space-y-1">
              {resumen.manual.map((t) => (
                <li key={t}>☐ {t}</li>
              ))}
            </ul>
          </div>
        )}

        <label className="block text-xs text-muted-foreground">
          Escribe el nombre del cliente para confirmar
          <input
            value={confirmacion}
            onChange={(e) => setConfirmacion(e.target.value)}
            className="mt-1 w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground"
            autoFocus
          />
        </label>

        {error && <p className="text-xs text-red-500">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancelar}
            disabled={pendiente}
            className="px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-accent disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirmar}
            disabled={pendiente || confirmacion.trim() !== resumen.nombre.trim()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-40"
          >
            {pendiente && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Eliminar definitivamente
          </button>
        </div>
      </div>
    </div>
  );
}
