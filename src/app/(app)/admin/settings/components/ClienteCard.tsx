'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Settings, Layers, Archive, ArchiveRestore, Trash2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { ConfirmarBorradoCliente } from '@/components/clientes/ConfirmarBorradoCliente';
import type { ResumenBorrado } from '@/lib/clientes/ciclo-de-vida';
import { deleteCliente, resumenBorradoCliente, setClienteArchivado } from '../_actions';

interface ClienteCardProps {
  cliente: any;
}

export function ClienteCard({ cliente }: ClienteCardProps) {
  const router = useRouter();
  const [pendiente, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [errorBorrado, setErrorBorrado] = useState<string | null>(null);
  const [resumen, setResumen] = useState<ResumenBorrado | null>(null);
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
    setErrorBorrado(null);
    startTransition(async () => {
      const r = await resumenBorradoCliente(cliente.id);
      if (r.error || !r.resumen) setError(r.error ?? 'No se pudo preparar el borrado.');
      else setResumen(r.resumen);
    });
  }

  function borrar() {
    startTransition(async () => {
      const r = await deleteCliente(cliente.id);
      if (r.error) {
        setErrorBorrado(r.error);
        return;
      }
      setResumen(null);
      for (const aviso of r.avisos ?? []) toast.warning(aviso);
      router.refresh();
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
        <ConfirmarBorradoCliente
          resumen={resumen}
          pendiente={pendiente}
          error={errorBorrado}
          onCancelar={() => setResumen(null)}
          onConfirmar={borrar}
        />
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
