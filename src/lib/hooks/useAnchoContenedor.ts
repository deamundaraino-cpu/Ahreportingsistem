'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Ancho medido de un contenedor, en píxeles.
 *
 * Hace falta para calcular el ancho del eje de categorías a partir del sitio que
 * hay de verdad. Las dos alternativas se descartaron por motivos concretos:
 *
 *  · **El `w` del widget** (1..4 columnas) es barato pero MIENTE: el grid es
 *    responsive, así que un widget `w:1` ocupa el ancho completo en móvil, la
 *    mitad en `sm` y un cuarto en `lg`. Daría el ancho equivocado en dos de cada
 *    tres tamaños de pantalla, y encima no se entera al redimensionar.
 *  · **El render-prop de `ResponsiveContainer`** no existe en recharts 2.x, que
 *    es la versión de este proyecto.
 *
 * El umbral de 8 px no es una micro-optimización: `ResponsiveContainer` también
 * observa su contenedor, y sin histéresis un cambio de 1 px —la aparición de una
 * barra de scroll, por ejemplo— puede realimentarse en un bucle de renders.
 */
export function useAnchoContenedor<T extends HTMLElement = HTMLDivElement>(
  anchoInicial = 320
): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  // Valor de arranque realista (un widget de un cuarto de ancho en 1440 px) para
  // que el primer pintado no salga con un eje absurdo y luego salte.
  const [ancho, setAncho] = useState(anchoInicial);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;

    const medir = (w: number) => {
      const nuevo = Math.round(w);
      setAncho((actual) => (Math.abs(nuevo - actual) > 8 ? nuevo : actual));
    };

    medir(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entradas) => {
      for (const e of entradas) medir(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, ancho];
}
