'use client';

import { LineChart, Line, ResponsiveContainer } from 'recharts';

/**
 * Mini-gráfico de una sola serie para las tarjetas en variante `sparkline`.
 *
 * Vive en su propio archivo para que `recharts` no entre en el bundle inicial
 * del dashboard: `PuzzleComponents` lo importaba directamente y, al ser un
 * import estático desde `DashboardClient`, arrastraba los ~375 KB de la
 * librería aunque ninguna tarjeta fuese sparkline. Aquí se carga bajo demanda.
 */
export function Sparkline({
  data,
  stroke,
}: {
  // `v` puede ser null: recharts corta la línea en esos puntos, que es lo que se quiere.
  data: { v: number | null }[];
  stroke: string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data}>
        <Line type="monotone" dataKey="v" dot={false} strokeWidth={1.5} stroke={stroke} />
      </LineChart>
    </ResponsiveContainer>
  );
}
