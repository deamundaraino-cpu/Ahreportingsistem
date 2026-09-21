import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import { MOTIVOS_EXCLUSION, type MotivoExclusion } from '@/lib/report-utm/lead-exclusion';

/**
 * Por qué no cuenta cada lead excluido.
 *
 * La migración 079 decidió MARCAR los leads en vez de borrarlos justamente para
 * que la exclusión fuera auditable, y guarda el motivo en `excluido_motivo`. Pero
 * ese dato no se enseñaba en ningún sitio: la pestaña «Excluidos» daba un número
 * y nada más, así que no había forma de saber si sobran 1.500 leads porque la
 * regla del cliente filtra un formulario o porque llegan sin atribución — que son
 * dos problemas distintos con dos arreglos distintos.
 *
 * Solo se pinta en la pestaña «Excluidos». Los conteos se calculan con los mismos
 * filtros que el resto de la página, pero SIN el motivo seleccionado: si no, al
 * elegir uno los demás se irían a cero y no se podría cambiar de opinión.
 */
export function LeadsMotivosBar({
  conteos,
  activo,
  total,
  hrefDe,
  hrefRegla,
}: {
  /** Leads excluidos por cada motivo, con los filtros actuales. */
  conteos: Record<MotivoExclusion, number>;
  activo: MotivoExclusion | null;
  total: number;
  hrefDe: (motivo: MotivoExclusion | null) => string;
  /** Ajustes del cliente, si hay uno elegido. */
  hrefRegla: string | null;
}) {
  const motivos = Object.keys(MOTIVOS_EXCLUSION) as MotivoExclusion[];

  return (
    <div className="rounded-2xl border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
          Motivo
        </span>

        <Chip href={hrefDe(null)} activo={activo === null} etiqueta="Todos" n={total} />

        {motivos.map((m) => (
          <Chip
            key={m}
            href={hrefDe(m)}
            activo={activo === m}
            etiqueta={ETIQUETAS[m]}
            n={conteos[m] ?? 0}
            title={MOTIVOS_EXCLUSION[m]}
          />
        ))}

        {hrefRegla && (
          <Link
            href={hrefRegla}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium text-muted-foreground hover:bg-accent transition-colors"
          >
            <Settings2 className="h-3 w-3" />
            Ajustar la regla del cliente
          </Link>
        )}
      </div>

      {activo && (
        <p className="text-[11px] text-muted-foreground mt-2">{MOTIVOS_EXCLUSION[activo]}</p>
      )}
    </div>
  );
}

/** Nombres cortos para los chips; el texto largo va en el `title`. */
const ETIQUETAS: Record<MotivoExclusion, string> = {
  sin_atribucion: 'Sin atribución',
  source_excluida: 'Fuente excluida',
  formulario_excluido: 'Formulario excluido',
  manual: 'A mano',
};

function Chip({
  href,
  activo,
  etiqueta,
  n,
  title,
}: {
  href: string;
  activo: boolean;
  etiqueta: string;
  n: number;
  title?: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-current={activo ? 'true' : undefined}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
        activo
          ? 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
          : n === 0
            ? 'border-border text-muted-foreground/50 hover:bg-accent'
            : 'border-border text-foreground hover:bg-accent'
      }`}
    >
      {etiqueta}
      <span className="tabular-nums opacity-70">{n.toLocaleString()}</span>
    </Link>
  );
}
