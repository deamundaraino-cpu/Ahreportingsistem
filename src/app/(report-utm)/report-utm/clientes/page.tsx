import Link from 'next/link';
import { reportUtmClient } from '@/lib/report-utm/client';
import { createAdminClient } from '@/utils/supabase/server';
import type { ReportUtmCliente } from '@/lib/report-utm/types';
import { ExternalLink, Plus, AlertTriangle } from 'lucide-react';
import { StatusBadge } from '@/components/report-utm/StatusBadge';
import { formatDate } from '@/lib/report-utm/formatters';
import {
  ClienteUtmAcciones,
  SincronizarClientesBoton,
} from '@/components/report-utm/ClienteUtmAcciones';

export const dynamic = 'force-dynamic';

export default async function ClientesPage() {
  // Sin sincronización al renderizar: así era como un cliente borrado aquí
  // volvía a aparecer en la siguiente visita. Ahora es un botón explícito, y el
  // alta en el reporting ya crea el espejo enlazado.
  const supabase = await reportUtmClient();
  const admin = await createAdminClient();
  const [{ data: clientes, error }, { data: publicos }] = await Promise.all([
    supabase.from('clientes').select('*').order('nombre'),
    admin.from('clientes').select('id, nombre').order('nombre'),
  ]);

  const lista = (clientes ?? []) as ReportUtmCliente[];
  const enlazados = new Set(lista.map((c) => c.public_cliente_id).filter(Boolean));
  const opcionesEnlace = ((publicos ?? []) as { id: string; nombre: string }[]).filter(
    (p) => !enlazados.has(p.id)
  );
  const huerfanos = lista.filter((c) => !c.public_cliente_id);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
            Report-UTM · Workspace
          </p>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">Clientes</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Los mismos clientes que el reporting. Crear, archivar o eliminar en un lado lo hace en
            los dos.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <SincronizarClientesBoton />
          <Link
            href="/admin/settings"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white nav-active-emerald"
          >
            <Plus className="h-3.5 w-3.5" /> Nuevo cliente
          </Link>
        </div>
      </div>

      {huerfanos.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-300 flex gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            {huerfanos.length} cliente{huerfanos.length === 1 ? '' : 's'} sin enlace con el
            reporting ({huerfanos.map((h) => h.nombre.trim()).join(', ')}). Sin enlace no hay gasto
            con el que cruzar: cinco de las siete fuentes de sus informes salen en cero. Enlázalos
            con su cliente del reporting, o archívalos / elimínalos si ya no se trabajan.
          </p>
        </div>
      )}

      {/* Listado */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center gap-3">
          <h2 className="text-sm font-semibold text-foreground">Listado ({lista.length})</h2>
          {lista.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {lista.length - huerfanos.length} enlazados · {huerfanos.length} sin enlace
            </span>
          )}
        </div>

        {error && (
          <div className="px-6 py-4 text-xs text-amber-700 dark:text-amber-400 font-mono bg-amber-50 dark:bg-amber-500/5">
            {error.message}
          </div>
        )}

        {lista.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-muted/60">
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-6 py-3">Cliente</th>
                  <th className="px-6 py-3">Enlace</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Creado</th>
                  <th className="px-6 py-3 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lista.map((c) => (
                  <tr
                    key={c.id}
                    className={`hover:bg-accent align-top ${c.status === 'archived' ? 'opacity-60' : ''}`}
                  >
                    <td className="px-6 py-3">
                      <Link
                        href={`/report-utm/clientes/${c.id}`}
                        className="text-sm font-medium text-foreground hover:underline inline-flex items-center gap-1"
                      >
                        {c.nombre} <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </Link>
                      <p className="text-[11px] font-mono text-muted-foreground mt-0.5">{c.slug}</p>
                    </td>
                    <td className="px-6 py-3">
                      <OrigenBadge enlazado={!!c.public_cliente_id} />
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="px-6 py-3 text-xs text-muted-foreground">
                      {formatDate(c.created_at)}
                    </td>
                    <td className="px-6 py-3">
                      <ClienteUtmAcciones
                        id={c.id}
                        nombre={c.nombre}
                        status={c.status}
                        enlazado={!!c.public_cliente_id}
                        opcionesEnlace={opcionesEnlace}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            No hay clientes todavía. Créalos en Ajustes del reporting.
          </div>
        )}
      </div>
    </div>
  );
}

function OrigenBadge({ enlazado }: { enlazado: boolean }) {
  if (enlazado) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
        Enlazado
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
      Sin enlace
    </span>
  );
}
