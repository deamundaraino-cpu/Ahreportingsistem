'use client';

import { createContext, useContext } from 'react';

/**
 * Moneda de reporte del cliente del dashboard (`lib/moneda-reporte.ts`).
 *
 * Va por contexto porque la leen todos los bloques que formatean importes
 * (tarjetas, tablas, ranking, archivo) y pasarla prop a prop atravesaría media
 * docena de componentes. Por defecto USD: un bloque fuera del proveedor se pinta
 * exactamente como siempre, con «$».
 */
const MonedaReporteContext = createContext<string>('USD');

export const MonedaReporteProvider = MonedaReporteContext.Provider;

export function useMonedaReporte(): string {
  return useContext(MonedaReporteContext);
}
