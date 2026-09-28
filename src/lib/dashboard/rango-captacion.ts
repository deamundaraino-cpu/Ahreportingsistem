// ── Rango de captación de una pestaña ────────────────────────────────
//
// `cliente_tabs.fecha_inicio` / `fecha_finalizacion` describen la VENTANA DE LA
// CAMPAÑA: alimentan las tarjetas de presupuesto y ritmo (días faltantes,
// presupuesto restante, diario sugerido). NO recortan los datos: el calendario
// manda, igual que en los informes.
//
// Antes el dashboard descartaba en silencio los días fuera de la ventana. En
// Invest Brokers (sep-2026) el calendario decía «1–28 sep» pero la pestaña,
// con captación hasta el 23, pintaba 1–23 sep: 141 leads y CLP 334.619 frente a
// los 162 y CLP 372.179 del mismo rango en el informe. Y el «vs período
// anterior» sí iba completo, así que comparaba 23 días contra 28.
//
// Puro y sin dependencias: lo usa `DashboardClient` y lo comprueba
// `scripts/verify-rango-captacion.ts`.

/**
 * Días CON DATOS del calendario que quedan fuera de la ventana de captación.
 *
 * Sirve para avisar en la tarjeta «Rango de Captación» de que las cifras del
 * calendario incluyen días fuera de la campaña (y el presupuesto, no). Una
 * ventana abierta por un lado solo limita por el otro; sin ventana, 0.
 * Las fechas son `YYYY-MM-DD`, así que se comparan como texto.
 */
export function diasFueraDeCaptacion(
  fechas: readonly string[],
  inicio: string | null | undefined,
  fin: string | null | undefined
): number {
  if (!inicio && !fin) return 0;
  const vistos = new Set<string>();
  for (const f of fechas) {
    if (!f) continue;
    if ((inicio && f < inicio) || (fin && f > fin)) vistos.add(f);
  }
  return vistos.size;
}
