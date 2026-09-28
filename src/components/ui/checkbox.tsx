'use client';

import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { CheckIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Casilla de verificación. Sustituye a los `<input type="checkbox">` sueltos.
 *
 * En Tailwind 4 la variante `dark:` va DESPUÉS de `data-*` en la hoja: sin
 * `dark:data-[state=checked]:bg-primary`, en modo oscuro el fondo de la casilla
 * marcada seguía siendo el translúcido de `dark:bg-input/30` y el ✓ (oscuro) no
 * se veía. El borde sin marcar también era casi invisible sobre fondo oscuro.
 */
function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer border-input dark:border-muted-foreground/50 dark:bg-input/30 dark:data-[state=checked]:bg-primary dark:data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
