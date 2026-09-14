import Link from 'next/link';
import { EyeOff, Users, ListFilter } from 'lucide-react';

export type EstadoLeads = 'incluidos' | 'excluidos' | 'todos';

/**
 * Pestañas de la página de leads: los que cuentan, los que la regla (o una
 * persona) dejó fuera, o todos. Por defecto se ve lo mismo que cuenta el
 * informe, para que el total de esta página y el del informe cuadren.
 */
export function LeadsExclusionBar({
  estado,
  excluidos,
  hrefDe,
}: {
  estado: EstadoLeads;
  /** Excluidos con los filtros actuales. `null` = sin migración 079. */
  excluidos: number | null;
  hrefDe: (estado: EstadoLeads) => string;
}) {
  if (excluidos === null) return null;

  const tabs: { id: EstadoLeads; label: string; icon: typeof Users }[] = [
    { id: 'incluidos', label: 'Cuentan', icon: Users },
    { id: 'excluidos', label: `Excluidos (${excluidos.toLocaleString()})`, icon: EyeOff },
    { id: 'todos', label: 'Todos', icon: ListFilter },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
        {tabs.map((t) => {
          const Icon = t.icon;
          const activo = estado === t.id;
          return (
            <Link
              key={t.id}
              href={hrefDe(t.id)}
              aria-current={activo ? 'page' : undefined}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activo ? 'bg-emerald-600 text-white' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </Link>
          );
        })}
      </div>
      {estado === 'incluidos' && excluidos > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {excluidos.toLocaleString()} lead{excluidos === 1 ? '' : 's'} no cuenta
          {excluidos === 1 ? '' : 'n'} en los informes (sin atribución o excluido
          {excluidos === 1 ? '' : 's'} por la regla del cliente).
        </p>
      )}
    </div>
  );
}
