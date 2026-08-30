'use client';

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * Tooltip. Mismo patrón que `popover.tsx` (radix-ui unificado, `data-slot`, `cn`).
 *
 * `Tooltip` monta su PROPIO `TooltipProvider`. Radix normalmente quiere uno solo
 * en la raíz de la app, pero anidarlos es válido y aquí evita que usar un tooltip
 * suelto en un widget obligue a tocar el layout — que es justo la fricción que
 * hace que la gente acabe poniendo `title=` y dejando texto sin recuperar.
 */

function TooltipProvider({
  delayDuration = 200,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Tokens de tema, cero hex: `docs/DESIGN.md` lo exige para todo el
          // chrome de gráfico, y este tooltip es parte de él.
          'bg-popover text-popover-foreground border-border data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 max-w-[320px] rounded-md border px-2.5 py-1.5 text-[11px] break-words shadow-md',
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/**
 * Texto que se corta con «…» y devuelve el completo al pasar el ratón.
 *
 * El patrón que sustituye: `className="truncate"` a secas, que dejaba el nombre
 * de una campaña irrecuperable, y `title=` nativo, que funciona pero tarda un
 * segundo y no se puede estilar.
 *
 * **Dónde NO usarlo:** celdas de tabla y rankings. Ahí puede haber cincuenta
 * filas por ocho columnas, y eso serían cientos de `Tooltip.Root` con su portal.
 * En ese caso el `title=` nativo cumple igual —el nombre se recupera— a coste
 * cero. Radix se reserva para lo que hay una vez por tarjeta: títulos, leyendas,
 * etiquetas de barra.
 */
export function TextoTruncado({
  text,
  className,
  as: As = 'span',
  side = 'top',
}: {
  text: string;
  className?: string;
  as?: 'span' | 'p' | 'div' | 'h3';
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* `min-w-0` va aquí y no en el padre porque `truncate` no hace nada
            dentro de un flex si el elemento no puede encogerse. */}
        <As className={cn('block min-w-0 truncate', className)}>{text}</As>
      </TooltipTrigger>
      <TooltipContent side={side}>{text}</TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
