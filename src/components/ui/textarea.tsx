import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Campo de texto multilínea.
 *
 * Mismas clases que `Input` salvo la altura: hasta ahora cada pantalla que
 * necesitaba un texto largo repetía el `<textarea>` crudo con sus clases a
 * mano, y ya iban cuatro copias ligeramente distintas.
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
