'use client'

// Endpoint de datos que usan los widgets del informe.
//
// En el builder (con sesión) es /api/report-utm/bi/query. En las vistas públicas
// (/report/bi/[token] y /report/bi/d/[token]) el visitante no tiene sesión, así
// que el canvas cambia la base a la variante por token. Va en un contexto para
// no enhebrar la prop por todos los componentes intermedios.

import { createContext, useContext } from 'react'

export const DEFAULT_BI_QUERY_BASE = '/api/report-utm/bi/query'

const BiQueryContext = createContext<string>(DEFAULT_BI_QUERY_BASE)

export function BiQueryProvider({ base, children }: { base: string; children: React.ReactNode }) {
    return <BiQueryContext.Provider value={base}>{children}</BiQueryContext.Provider>
}

/** URL base a la que los widgets deben pedir sus datos. */
export function useBiQueryBase(): string {
    return useContext(BiQueryContext)
}

/** URL base para un informe público servido por token. */
export function publicQueryBase(token: string): string {
    return `/api/report-utm/bi/public/${encodeURIComponent(token)}/query`
}
