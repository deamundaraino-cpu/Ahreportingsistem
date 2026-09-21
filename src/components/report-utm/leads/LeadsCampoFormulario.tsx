'use client';

// Filtro por lo que el lead RESPONDIÓ (`raw_fields`).
//
// ── Por qué la clave cruda y no el campo del catálogo ────────────────
// El catálogo (`lead_campos`) es más bonito: une las variantes de una misma
// pregunta y agrupa las respuestas equivalentes. Pero ese plegado —`valores_map`—
// se aplica en Node, sobre el conjunto ya traído (`bi-query.ts`), y /leads pagina
// en SQL. Resolverlo aquí en SQL daría para el mismo campo un número distinto del
// que el informe enseña, y dos pantallas que no cuadran es peor que una lista más
// larga.
//
// Además las claves se guardan tal cual llegaron (`Rango de renta`), mientras que
// `claves_origen` está normalizada (`rango_de_renta`): filtrar por la forma
// canónica no encontraría nada.
//
// Cuando el catálogo cubre una clave, se usa su nombre como ETIQUETA — así se
// lee igual de bien sin mentir sobre lo que se está filtrando.

import { useEffect, useState } from 'react';
import { ClipboardList, Loader2, AlertTriangle } from 'lucide-react';
import { SelectorDeValores } from '../bi/SelectorDeValores';
import { DEFAULT_BI_QUERY_BASE } from '../bi/BiQueryContext';
import { parseSeleccion } from '@/lib/report-utm/bi-valores';
import type { FilterOp } from '@/lib/report-utm/bi-metadata';

/** Solo los operadores que el filtro plano de `raw_fields->>clave` sabe aplicar. */
const OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'no es igual a' },
  { value: 'contains', label: 'contiene' },
  { value: 'ncontains', label: 'no contiene' },
];

type Campo = { key: string; label: string; coverage: number; distinctCount: number };

export interface LeadsCampoFormularioProps {
  campo: string | null;
  op: FilterOp;
  valor: string;
  clienteId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}

export function LeadsCampoFormulario({
  campo,
  op,
  valor,
  clienteId,
  dateFrom,
  dateTo,
}: LeadsCampoFormularioProps) {
  const [elegido, setElegido] = useState(campo ?? '');
  const [operador, setOperador] = useState<FilterOp>(op);
  const [sel, setSel] = useState(valor);
  const [campos, setCampos] = useState<Campo[]>([]);
  const [cargando, setCargando] = useState(false);
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    // Sin cliente no se consulta y tampoco se limpia el estado: la lista se
    // deriva abajo, que evita un setState dentro del efecto.
    if (!clienteId) return;
    const ctrl = new AbortController();

    // El estado se toca DENTRO de la función asíncrona, no en el cuerpo del
    // efecto: mismo patrón que `useValoresDistintos`, y así no se disparan
    // renders en cascada al montar.
    async function cargar(cliente: string) {
      setCargando(true);
      setFallo(false);
      const p = new URLSearchParams({ cliente_id: cliente });
      if (dateFrom) p.set('date_from', dateFrom);
      if (dateTo) p.set('date_to', dateTo);
      try {
        const r = await fetch(`/api/report-utm/bi/form-fields?${p}`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        setCampos(Array.isArray(j.data) ? j.data : []);
      } catch (e) {
        // Una lista vacía por un fallo es indistinguible de «este cliente no
        // tiene formularios». Se distingue, igual que hace `MotivoSinValores`.
        if ((e as Error).name !== 'AbortError') setFallo(true);
      } finally {
        if (!ctrl.signal.aborted) setCargando(false);
      }
    }
    void cargar(clienteId);

    return () => ctrl.abort();
  }, [clienteId, dateFrom, dateTo]);

  // La lista se deriva: sin cliente no hay preguntas que ofrecer, aunque el
  // estado conserve las del cliente anterior.
  const lista = clienteId ? campos : [];

  // Un solo valor: el filtro es plano a propósito (ver leads-filtros.ts).
  const unValor = parseSeleccion(sel)[0] ?? '';
  const valorURL = elegido && unValor ? `${operador}:${unValor}` : '';

  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3 space-y-2">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <ClipboardList className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        <span className="text-[10px] font-semibold uppercase tracking-wider">
          Respuesta del formulario
        </span>
        {cargando && <Loader2 className="h-3 w-3 animate-spin" />}
      </div>

      <input type="hidden" name="campo" value={elegido} />
      <input type="hidden" name="campo_valor" value={valorURL} />

      {!clienteId ? (
        <p className="text-[11px] text-muted-foreground">
          Elegí un cliente: las preguntas del formulario son distintas en cada uno.
        </p>
      ) : fallo ? (
        <p className="inline-flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-400">
          <AlertTriangle className="h-3 w-3" />
          No se pudieron cargar las preguntas. No es que no haya.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2 items-center">
          <select
            aria-label="Pregunta del formulario"
            value={elegido}
            onChange={(e) => {
              setElegido(e.target.value);
              setSel('');
            }}
            className="w-56 px-2 py-1 text-xs rounded-lg border border-border bg-muted text-foreground"
          >
            <option value="">Cualquier pregunta</option>
            {lista.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label || c.key} ({Math.round(c.coverage * 100)} %)
              </option>
            ))}
          </select>

          {elegido && (
            <>
              <select
                aria-label="Operador de la respuesta"
                value={operador}
                onChange={(e) => setOperador(e.target.value as FilterOp)}
                className="px-2 py-1 text-[11px] rounded-lg border border-border bg-muted text-foreground"
              >
                {OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              <div className="w-56">
                <SelectorDeValores
                  dimension={`field:${elegido}`}
                  value={sel}
                  onChange={setSel}
                  clienteId={clienteId}
                  dateFrom={dateFrom ?? undefined}
                  dateTo={dateTo ?? undefined}
                  source="leads"
                  queryBase={DEFAULT_BI_QUERY_BASE}
                  modo="popover"
                  placeholder="Elegí una respuesta"
                />
              </div>
              {parseSeleccion(sel).length > 1 && (
                // No se corta en silencio: se dice cuál se aplica.
                <span className="text-[10px] text-amber-600 dark:text-amber-400">
                  Solo se aplica «{unValor}»: este filtro admite una respuesta.
                </span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
