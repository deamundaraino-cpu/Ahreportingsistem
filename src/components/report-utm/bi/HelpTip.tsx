'use client';

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

interface Props {
  text: string;
  /** Tamaño del icono en px (default 13). */
  size?: number;
  className?: string;
}

/**
 * Icono de ayuda con tooltip. Renderiza el tooltip en un portal a
 * document.body con posición fija calculada desde el icono, para que
 * nunca se recorte dentro de contenedores con overflow (modales, etc.).
 */
export function HelpTip({ text, size = 13, className }: Props) {
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  const open = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const TIP_WIDTH = 260;
      let left = r.left;
      // Mantener dentro del viewport por la derecha
      if (left + TIP_WIDTH > window.innerWidth - 12) {
        left = window.innerWidth - TIP_WIDTH - 12;
      }
      setCoords({ top: r.bottom + 6, left: Math.max(12, left) });
    }
    setShow(true);
  }, []);

  const close = useCallback(() => setShow(false), []);

  return (
    <>
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (show) close();
          else open();
        }}
        aria-label="Ayuda"
        className={`inline-flex items-center justify-center text-muted-foreground/60 hover:text-emerald-500 transition-colors cursor-help align-middle ${className ?? ''}`}
      >
        <HelpCircle style={{ width: size, height: size }} />
      </span>
      {show &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: 260,
              zIndex: 100,
            }}
            className="rounded-lg border border-border bg-card text-foreground shadow-xl px-3 py-2 text-[11px] leading-relaxed pointer-events-none"
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
