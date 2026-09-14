'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Trash2, Link2, Loader2, RefreshCw } from 'lucide-react';
import { ConfirmarBorradoCliente } from '@/components/clientes/ConfirmarBorradoCliente';
import type { ResumenBorrado } from '@/lib/clientes/ciclo-de-vida';
import {
  updateClienteStatusAction,
  deleteClienteAction,
  enlazarClienteAction,
  resumenBorradoClienteAction,
  syncPlatformClientesAction,
} from '@/app/(report-utm)/report-utm/clientes/_actions';

/** Archivar, eliminar y (si es huérfano) enlazar, en la fila del listado. */
export function ClienteUtmAcciones({
  id,
  status,
  enlazado,
  opcionesEnlace,
}: {
  id: string;
  nombre: string;
  status: string;
  enlazado: boolean;
  opcionesEnlace: { id: string; nombre: string }[];
}) {
  const router = useRouter();
  const [pendiente, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errorBorrado, setErrorBorrado] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ResumenBorrado | null>(null);
  const [destino, setDestino] = useState('');
  const archivado = status === 'archived';

  const correr = (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error ?? 'Error');
      else router.refresh();
    });
  };

  // La misma confirmación que en Ajustes: con lo que se pierde y lo que queda
  // por desconectar a mano.
  function pedirBorrado() {
    setError(null);
    setErrorBorrado(null);
    start(async () => {
      const r = await resumenBorradoClienteAction(id);
      if (!r.ok || !r.resumen) setError(r.error ?? 'No se pudo preparar el borrado.');
      else setResumen(r.resumen);
    });
  }

  function borrar() {
    start(async () => {
      const r = await deleteClienteAction(id);
      if (!r.ok) {
        setErrorBorrado(r.error ?? 'Error');
        return;
      }
      setResumen(null);
      for (const aviso of r.avisos ?? []) toast.warning(aviso);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {!enlazado && opcionesEnlace.length > 0 && (
        <>
          <select
            value={destino}
            onChange={(e) => setDestino(e.target.value)}
            className="px-2 py-1 text-[11px] rounded-md bg-muted border border-border text-foreground max-w-[160px]"
            aria-label="Cliente del reporting"
          >
            <option value="">Enlazar con…</option>
            {opcionesEnlace.map((o) => (
              <option key={o.id} value={o.id}>
                {o.nombre}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!destino || pendiente}
            onClick={() => correr(() => enlazarClienteAction(id, destino))}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-border hover:bg-accent disabled:opacity-40"
          >
            <Link2 className="h-3 w-3" /> Enlazar
          </button>
        </>
      )}
      <button
        type="button"
        disabled={pendiente}
        onClick={() =>
          correr(() => updateClienteStatusAction(id, archivado ? 'active' : 'archived'))
        }
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-border hover:bg-accent disabled:opacity-40"
      >
        {archivado ? <ArchiveRestore className="h-3 w-3" /> : <Archive className="h-3 w-3" />}
        {archivado ? 'Reactivar' : 'Archivar'}
      </button>
      <button
        type="button"
        disabled={pendiente}
        onClick={pedirBorrado}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border border-border text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40"
      >
        {pendiente && !resumen ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Trash2 className="h-3 w-3" />
        )}
        Eliminar
      </button>
      {error && <span className="w-full text-right text-[11px] text-red-500">{error}</span>}

      {resumen && (
        <ConfirmarBorradoCliente
          resumen={resumen}
          pendiente={pendiente}
          error={errorBorrado}
          onCancelar={() => setResumen(null)}
          onConfirmar={borrar}
        />
      )}
    </div>
  );
}

/** Botón explícito de sincronización (antes corría solo en cada visita). */
export function SincronizarClientesBoton() {
  const router = useRouter();
  const [pendiente, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pendiente}
        onClick={() =>
          start(async () => {
            const r = await syncPlatformClientesAction();
            setMsg(
              !r.ok
                ? (r.error ?? 'Error')
                : r.created > 0
                  ? `${r.created} cliente(s) traído(s) del reporting.`
                  : 'Todo al día.'
            );
            router.refresh();
          })
        }
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border hover:bg-accent disabled:opacity-40"
      >
        {pendiente ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Sincronizar con el reporting
      </button>
      {msg && <span className="text-[11px] text-muted-foreground">{msg}</span>}
    </div>
  );
}
