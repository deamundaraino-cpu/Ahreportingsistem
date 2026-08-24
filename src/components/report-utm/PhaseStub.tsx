import { LucideIcon } from 'lucide-react';

export function PhaseStub({
  icon: Icon,
  title,
  phase,
  description,
  bullets,
}: {
  icon: LucideIcon;
  title: string;
  phase: string;
  description: string;
  bullets?: string[];
}) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-500 dark:text-emerald-400">
          Report-UTM · {phase}
        </p>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mt-1">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground max-w-2xl">{description}</p>
      </div>

      <div className="rounded-2xl border border-dashed border-emerald-200 dark:border-emerald-500/20 bg-emerald-50/40 dark:bg-emerald-500/5 p-8">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-xl flex items-center justify-center bg-background shadow-sm">
            <Icon className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">
              {phase} · pendiente de implementar
            </p>
            {bullets && bullets.length > 0 && (
              <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                {bullets.map((b, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-emerald-500 dark:text-emerald-400">›</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
