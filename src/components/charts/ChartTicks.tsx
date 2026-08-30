'use client';

import { truncarAAncho } from '@/lib/chart-labels';

/**
 * Ticks de eje de categorías, compartidos por el BI y el dashboard.
 *
 * Dos cosas que los ticks por defecto de recharts no hacen:
 *
 * 1. **Cortan al ancho real**, no a un número fijo de caracteres. El eje X del
 *    dashboard cortaba a 15 a pelo, que es agresivísimo para un nombre de
 *    campaña y demasiado poco para una fecha.
 * 2. **Dejan recuperar el nombre completo.** Un `<text>` de SVG no acepta el
 *    `title=` de HTML, pero sí acepta un `<title>` SVG como hijo: es el
 *    equivalente nativo, no necesita librería ni portal, y ningún
 *    `overflow: hidden` lo recorta.
 *
 * Se descartó envolver cada tick en un tooltip de Radix: son quince por gráfico
 * y varios gráficos por informe, o sea decenas de portales que se remontan en
 * cada resize, y encima recharts CLONA el elemento del tick inyectándole props,
 * lo que complica el `asChild`. Todo eso para ganar solo estética.
 *
 * El `<title>` se emite **solo si el texto se cortó**. Ponerlo siempre convierte
 * en ruido lo que debe ser una señal: si todas las filas tienen tooltip, ninguna
 * dice «aquí falta texto».
 */

export interface TickEjeProps {
  /** Inyectadas por recharts al clonar el elemento; opcionales para que TS deje pasarlo. */
  x?: number;
  y?: number;
  payload?: { value?: unknown };
  /** Ancho disponible para el texto, en píxeles. */
  ancho: number;
  fontSize: number;
  /**
   * `true` en el BI, que NO está dentro de `.chart-wrapper` y pinta su chrome con
   * `currentColor` + clases de Tailwind. `false` en el dashboard, donde manda
   * `globals.css` y poner un `fill` aquí lo pisaría (y sería un color de chrome
   * cableado, que `docs/DESIGN.md` prohíbe).
   */
  temaPropio?: boolean;
}

function colorProps(temaPropio: boolean) {
  return temaPropio ? { fill: 'currentColor' as const, className: 'text-muted-foreground' } : {};
}

/** Tick del eje Y de categorías (barras horizontales). Texto alineado a la derecha. */
export function TickCategoriaY({
  x = 0,
  y = 0,
  payload,
  ancho,
  fontSize,
  temaPropio = false,
}: TickEjeProps) {
  const completo = String(payload?.value ?? '');
  const visible = truncarAAncho(completo, ancho, fontSize);
  return (
    <text x={x} y={y} dy={3} textAnchor="end" fontSize={fontSize} {...colorProps(temaPropio)}>
      {visible !== completo && <title>{completo}</title>}
      {visible}
    </text>
  );
}

/** Tick del eje X de categorías. Texto centrado bajo su punto. */
export function TickCategoriaX({
  x = 0,
  y = 0,
  payload,
  ancho,
  fontSize,
  temaPropio = false,
}: TickEjeProps) {
  const completo = String(payload?.value ?? '');
  const visible = truncarAAncho(completo, ancho, fontSize);
  return (
    <text x={x} y={y} dy={10} textAnchor="middle" fontSize={fontSize} {...colorProps(temaPropio)}>
      {visible !== completo && <title>{completo}</title>}
      {visible}
    </text>
  );
}
