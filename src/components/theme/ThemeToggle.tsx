'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { Monitor, Moon, Sun } from 'lucide-react';

const OPTIONS = [
  { value: 'light', icon: Sun, label: 'Tema claro' },
  { value: 'dark', icon: Moon, label: 'Tema oscuro' },
  { value: 'system', icon: Monitor, label: 'Tema del sistema' },
] as const;

/** Store inmutable: nunca notifica, solo sirve para distinguir servidor de cliente. */
const subscribeNada = () => () => {};

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  // En el servidor no hay tema resuelto todavía; hasta que hidrata no se
  // marca ninguna opción como activa para no provocar un mismatch.
  const mounted = useSyncExternalStore(
    subscribeNada,
    () => true,
    () => false
  );

  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5 ${className}`}
      role="radiogroup"
      aria-label="Tema de la interfaz"
    >
      {OPTIONS.map(({ value, icon: Icon, label }) => {
        const active = mounted && theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={label}
            onClick={() => setTheme(value)}
            className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${
              active
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
