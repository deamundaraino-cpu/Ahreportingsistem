'use client';

/**
 * Botón de copiar pensado para ir encima de un bloque de código oscuro.
 *
 * Vivía dentro de `ApiTokensManager`, pero la documentación del MCP lo necesita
 * y está en otro archivo: dejarlo allí obligaba a que un componente importara al
 * otro en los dos sentidos.
 */

import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function CopyButton({ value, title = 'Copiar' }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={copy}
      className="p-1.5 rounded hover:bg-white/10 transition-colors"
      title={title}
    >
      {copied ? (
        <Check className="h-4 w-4 text-emerald-400" />
      ) : (
        <Copy className="h-4 w-4 text-zinc-400" />
      )}
    </button>
  );
}
