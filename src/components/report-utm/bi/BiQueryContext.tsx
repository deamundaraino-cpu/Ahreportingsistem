'use client';

// Endpoint de datos que usan los widgets del informe.
//
// En el builder (con sesión) es /api/report-utm/bi/query. En las vistas públicas
// (/report/bi/[token] y /report/bi/d/[token]) el visitante no tiene sesión, así
// que el canvas cambia la base a la variante por token. Va en un contexto para
// no enhebrar la prop por todos los componentes intermedios.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export const DEFAULT_BI_QUERY_BASE = '/api/report-utm/bi/query';

const BiQueryContext = createContext<string>(DEFAULT_BI_QUERY_BASE);

export function BiQueryProvider({ base, children }: { base: string; children: React.ReactNode }) {
  return (
    <BiQueryContext.Provider value={base}>
      <BiEtiquetasProvider>{children}</BiEtiquetasProvider>
    </BiQueryContext.Provider>
  );
}

/** URL base a la que los widgets deben pedir sus datos. */
export function useBiQueryBase(): string {
  return useContext(BiQueryContext);
}

/** URL base para un informe público servido por token. */
export function publicQueryBase(token: string): string {
  return `/api/report-utm/bi/public/${encodeURIComponent(token)}/query`;
}

// ── Nombres de preguntas, respuestas y segmentos ─────────────────────
// El motor devuelve en `meta.etiquetas` el nombre legible de cada token de lead
// que usó una consulta (ver `bi-dispatch.ts`). Cada widget lo registra aquí y lo
// leen los que no hacen consultas propias con `meta` —el slicer, los chips de
// filtro del canvas—, que antes mostraban el slug de la clave
// («Rango de ingresos» salía «Rango de ingresos» solo si el slug coincidía).

interface EtiquetasCtx {
  etiquetas: Record<string, string>;
  registrar: (nuevas: Record<string, string> | undefined | null) => void;
}

const BiEtiquetasContext = createContext<EtiquetasCtx>({
  etiquetas: {},
  registrar: () => {},
});

export function BiEtiquetasProvider({ children }: { children: React.ReactNode }) {
  const [etiquetas, setEtiquetas] = useState<Record<string, string>>({});
  const registrar = useCallback((nuevas: Record<string, string> | undefined | null) => {
    if (!nuevas || Object.keys(nuevas).length === 0) return;
    setEtiquetas((prev) => {
      // Sin cambios no se re-renderiza a todos los consumidores.
      if (Object.entries(nuevas).every(([k, v]) => prev[k] === v)) return prev;
      return { ...prev, ...nuevas };
    });
  }, []);
  const value = useMemo(() => ({ etiquetas, registrar }), [etiquetas, registrar]);
  return <BiEtiquetasContext.Provider value={value}>{children}</BiEtiquetasContext.Provider>;
}

export function useBiEtiquetas(): EtiquetasCtx {
  return useContext(BiEtiquetasContext);
}

/** Nombre legible de una clave de filtro o dimensión, con el que ya se registró. */
export function EtiquetaBi({ clave, fallback }: { clave: string; fallback: string }) {
  const { etiquetas } = useBiEtiquetas();
  return <>{etiquetas[clave] ?? fallback}</>;
}
