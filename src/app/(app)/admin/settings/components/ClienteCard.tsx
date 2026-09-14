'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Settings, Layers, Archive, ArchiveRestore, Trash2, Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { deleteCliente, resumenBorradoCliente, setClienteArchivado } from '../_actions';

interface ClienteCardProps {
  cliente: any;
}

type Resumen = {
  nombre: string;
  diasMetricas: number;
  ventasHotmart: number;
  leadsAprox: number;
  ventas: number;
  informesBi: number;
  espejos: number;
};

export function ClienteCard({ cliente }: ClienteCardProps) {
  const router = useRouter();
  const [pendiente, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [confirmacion, setConfirmacion] = useState('');
  const archivado = cliente.archivado === true;

  function archivar(e: React.MouseEvent) {
    e.stopPropagation();
    setError(null);
    startTransition(async () => {
      const r = await setClienteArchivado(cliente.id, !archivado);
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  function pedirBorrado(e: React.MouseEvent) {
    e.stopPropagation();
    setError(null);
    startTransition(async () => {
      const r = await resumenBorradoCliente(cliente.id);
      if (r.error || !r.resumen) setError(r.error ?? 'No se pudo preparar el borrado.');
      else setResumen(r.resumen);
    });
  }

  function borrar() {
    startTransition(async () => {
      const r = await deleteCliente(cliente.id);
      if (r.error) setError(r.error);
      else {
        setResumen(null);
        router.refresh();
      }
    });
  }

  return (
    <>
      <div
        className={`block group cursor-pointer ${archivado ? 'opacity-60' : ''}`}
        onClick={() => router.push(`/admin/settings/${cliente.id}`)}
      >
        <Card className="bg-card border-border group-hover:border-ring transition h-full flex flex-col">
          <CardHeader>
            <CardTitle className="flex justify-between items-start">
              <span className="truncate text-foreground group-hover:text-foreground/90 transition-colors">
                {cliente.nombre}
                {archivado && (
                  <span className="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                    Archivado
                  </span>
                )}
              </span>
              <div className="p-2 -mr-2 -mt-2 text-muted-foreground bg-muted/50 rounded-md group-hover:bg-accent group-hover:text-foreground transition-colors shadow flex items-center gap-2 text-sm">
                <Settings className="h-4 w-4" />{' '}
                <span className="hidden sm:inline">Configurar</span>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1">
            <div className="text-sm text-muted-foreground flex flex-col gap-2">
              <Conexion label="Meta Ads" ok={cliente.conexiones?.meta} />
              <Conexion label="Hotmart API" ok={cliente.conexiones?.hotmart} />
              <Conexion label="TikTok Ads" ok={cliente.conexiones?.tiktok} />
              <Conexion label="Google Analytics" ok={cliente.conexiones?.ga} />
            </div>
            {error && <p className="text-[11px] text-red-500 mt-2">{error}</p>}
          </CardContent>
          <CardFooter className="pt-2 border-t border-border mt-2 flex justify-between items-center gap-2">
            <span className="text-muted-foreground/70 text-xs uppercase flex-1">
              {new Date(cliente.created_at).toLocaleDateString()}
            </span>
            <button
              type="button"
              onClick={archivar}
              disabled={pendiente}
              title={
                archivado ? 'Reactivar cliente' : 'Archivar cliente (se oculta en los dos lados)'
              }
              className="text-muted-foreground hover:text-foreground transition text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-accent disabled:opacity-40"
            >
              {archivado ? <ArchiveRestore className="w-3 h-3" /> : <Archive className="w-3 h-3" />}
              {archivado ? 'Reactivar' : 'Archivar'}
            </button>
            <button
              type="button"
              onClick={pedirBorrado}
              disabled={pendiente}
              title="Eliminar cliente en reporting y Report-UTM"
              className="text-muted-foreground hover:text-red-600 transition text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-accent disabled:opacity-40"
            >
              {pendiente && !resumen ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Trash2 className="w-3 h-3" />
              )}
              Eliminar
            </button>
            <Link
              href={`/admin/campaign-groups/${cliente.id}`}
              className="text-muted-foreground hover:text-indigo-600 dark:hover:text-indigo-400 transition text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-accent"
              title="Gestionar grupos de campañas"
              onClick={(e) => e.stopPropagation()}
            >
              <Layers className="w-3 h-3" />
              Grupos
            </Link>
          </CardFooter>
        </Card>
      </div>

      {resumen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => !pendiente && setResumen(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-card p-6 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <h3 className="text-base font-semibold text-foreground">
                Eliminar «{resumen.nombre}»
              </h3>
              <button
                type="button"
                onClick={() => setResumen(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Cerrar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground">
              Se elimina en el reporting <strong>y</strong> en Report-UTM. No se puede deshacer. Si
              solo quieres que deje de aparecer, archívalo.
            </p>
            <ul className="text-sm text-foreground space-y-1">
              <li>· {resumen.diasMetricas.toLocaleString()} días de métricas</li>
              <li>· ~{resumen.leadsAprox.toLocaleString()} leads</li>
              <li>· {resumen.ventasHotmart.toLocaleString()} ventas de Hotmart</li>
              <li>· {resumen.ventas.toLocaleString()} ventas de webhook</li>
              <li>· {resumen.informesBi.toLocaleString()} informes BI</li>
              <li>· Sus notificaciones, mensajes y canales del agente</li>
            </ul>
            <label className="block text-xs text-muted-foreground">
              Escribe el nombre del cliente para confirmar
              <input
                value={confirmacion}
                onChange={(e) => setConfirmacion(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-sm rounded-lg bg-muted border border-border text-foreground"
                autoFocus
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResumen(null)}
                className="px-3 py-1.5 rounded-lg text-sm border border-border hover:bg-accent"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={borrar}
                disabled={pendiente || confirmacion.trim() !== resumen.nombre.trim()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-40"
              >
                {pendiente && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Eliminar definitivamente
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Conexion({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <div className="flex justify-between items-center bg-muted/60 p-2 rounded">
      <span className="text-foreground/90">{label}</span>
      {ok ? (
        <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 text-xs font-medium">
          ● Conectado
        </span>
      ) : (
        <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 text-xs">
          ● Pendiente
        </span>
      )}
    </div>
  );
}
