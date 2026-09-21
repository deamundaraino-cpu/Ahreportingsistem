'use client';

// Los filtros por columna de /leads: operador, valores y presencia.
//
// ── Por qué escribe en inputs ocultos y no navega ────────────────────
// La página es `force-dynamic` y lanza 4-5 consultas por render (la página, el
// `count` exacto, las tarjetas, los excluidos y los motivos). Si cada casilla
// marcada hiciera `router.replace`, marcar cinco valores serían ~25 consultas
// contra una instancia de 1 GB — el patrón que tumbó la base el 2026-09-20.
//
// Así que este componente NO navega: mantiene su estado en React y lo vuelca en
// los `<input type="hidden">` del `<form method="get">` que ya existía. Se sigue
// pulsando «Filtrar», que agrupa todos los cambios en UNA navegación, y la URL,
// la paginación y el enlace de «Exportar CSV» siguen funcionando igual que antes
// sin tocar una línea de ellos.

import { useState } from 'react';
import { Eraser } from 'lucide-react';
import { SelectorDeValores } from '../bi/SelectorDeValores';
import { DEFAULT_BI_QUERY_BASE } from '../bi/BiQueryContext';
import { esSeleccionPorCasillas, serializarSeleccion } from '@/lib/report-utm/bi-valores';
import { ETIQUETAS_CAMPO } from '@/lib/report-utm/leads-display';
import {
  CAMPOS_FILTRABLES,
  type CampoFiltrable,
  type CondicionCampo,
} from '@/lib/report-utm/leads-filtros';
import type { FilterOp } from '@/lib/report-utm/bi-metadata';

/** Las mismas etiquetas que el constructor de filtros del BI. */
const OPS: { value: FilterOp; label: string }[] = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'no es igual a' },
  { value: 'contains', label: 'contiene' },
  { value: 'ncontains', label: 'no contiene' },
  { value: 'starts', label: 'empieza con' },
  { value: 'ends', label: 'termina con' },
];

type Presencia = '' | 'con' | 'sin';

type EstadoCampo = { op: FilterOp; sel: string; presencia: Presencia };

export interface LeadsFiltrosBarProps {
  condiciones: Partial<Record<CampoFiltrable, CondicionCampo>>;
  con: CampoFiltrable[];
  sin: CampoFiltrable[];
  clienteId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  /** En las pestañas «Excluidos»/«Todos» las listas solo cuentan los incluidos. */
  avisoExcluidos: boolean;
}

export function LeadsFiltrosBar({
  condiciones,
  con,
  sin,
  clienteId,
  dateFrom,
  dateTo,
  avisoExcluidos,
}: LeadsFiltrosBarProps) {
  const [estado, setEstado] = useState<Record<string, EstadoCampo>>(() => {
    const inicial: Record<string, EstadoCampo> = {};
    for (const campo of CAMPOS_FILTRABLES) {
      const c = condiciones[campo];
      inicial[campo] = {
        op: c?.op ?? 'contains',
        sel: c ? serializarSeleccion(c.valores) : '',
        presencia: sin.includes(campo) ? 'sin' : con.includes(campo) ? 'con' : '',
      };
    }
    return inicial;
  });

  const cambiar = (campo: string, parcial: Partial<EstadoCampo>) =>
    setEstado((prev) => ({ ...prev, [campo]: { ...prev[campo], ...parcial } }));

  const limpiar = () =>
    setEstado(() => {
      const vacio: Record<string, EstadoCampo> = {};
      for (const campo of CAMPOS_FILTRABLES) {
        vacio[campo] = { op: 'contains', sel: '', presencia: '' };
      }
      return vacio;
    });

  const listaPresencia = (cual: Presencia) =>
    CAMPOS_FILTRABLES.filter((c) => estado[c]?.presencia === cual).join(',');

  const algo = CAMPOS_FILTRABLES.some((c) => estado[c]?.sel || estado[c]?.presencia);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3 items-start">
        {CAMPOS_FILTRABLES.map((campo) => {
          const e = estado[campo];
          const porPresencia = e.presencia !== '';
          // El valor solo viaja si NO se está filtrando por presencia: «está
          // vacío» y «contiene X» a la vez es un filtro que no dice nada.
          const valorURL = porPresencia || !e.sel ? '' : `${e.op}:${e.sel}`;

          return (
            <div key={campo} className="w-52">
              <label className="block text-[11px] font-medium text-muted-foreground mb-1">
                {ETIQUETAS_CAMPO[campo] ?? campo}
              </label>

              <input type="hidden" name={campo} value={valorURL} />

              <div className="flex gap-1 mb-1">
                <select
                  aria-label={`Operador de ${ETIQUETAS_CAMPO[campo] ?? campo}`}
                  value={e.op}
                  disabled={porPresencia}
                  onChange={(ev) => cambiar(campo, { op: ev.target.value as FilterOp, sel: '' })}
                  className="grow min-w-0 px-2 py-1 text-[11px] rounded-lg border border-border bg-muted text-foreground disabled:opacity-40"
                >
                  {OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Presencia de ${ETIQUETAS_CAMPO[campo] ?? campo}`}
                  value={e.presencia}
                  onChange={(ev) => cambiar(campo, { presencia: ev.target.value as Presencia })}
                  className="w-20 shrink-0 px-1 py-1 text-[11px] rounded-lg border border-border bg-muted text-foreground"
                >
                  <option value="">cualquiera</option>
                  <option value="con">tiene dato</option>
                  <option value="sin">está vacío</option>
                </select>
              </div>

              {porPresencia ? (
                <p className="text-[10px] text-muted-foreground italic px-1 py-1">
                  {e.presencia === 'sin'
                    ? 'Solo los que NO traen este dato'
                    : 'Solo los que sí lo traen'}
                </p>
              ) : esSeleccionPorCasillas(e.op) && clienteId ? (
                // Con `eq`/`neq` se elige de una lista con recuento. Con los
                // operadores de subcadena no: «contiene ∈ {a,b,c}» no significa
                // nada, y ofrecerlo invitaría a construir un filtro que no hace
                // lo que parece (misma regla que el constructor del BI).
                <SelectorDeValores
                  dimension={campo}
                  value={e.sel}
                  onChange={(v) => cambiar(campo, { sel: v })}
                  clienteId={clienteId}
                  dateFrom={dateFrom ?? undefined}
                  dateTo={dateTo ?? undefined}
                  source="leads"
                  queryBase={DEFAULT_BI_QUERY_BASE}
                  modo="popover"
                  incluirExcluidos={avisoExcluidos}
                />
              ) : (
                <input
                  type="text"
                  value={e.sel}
                  onChange={(ev) => cambiar(campo, { sel: ev.target.value })}
                  placeholder={
                    esSeleccionPorCasillas(e.op) ? 'elegí un cliente para la lista' : 'texto…'
                  }
                  className="w-full px-2 py-1 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Acumuladores de presencia: un solo parámetro por lado, en forma canónica. */}
      <input type="hidden" name="con" value={listaPresencia('con')} />
      <input type="hidden" name="sin" value={listaPresencia('sin')} />

      <div className="flex flex-wrap items-center gap-3">
        {!clienteId && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Elegí un cliente para elegir los valores de una lista en vez de escribirlos, y para
            poder filtrar por «tiene dato» / «está vacío».
          </p>
        )}
        {avisoExcluidos && clienteId && (
          // `bi_valores_conteo` añadía siempre `AND NOT e.excluido` (migración
          // 079), así que en estas pestañas la lista ofrecía justo los valores
          // que NO se están mirando. La 087 añadió el interruptor; aquí se pide
          // encendido y se dice, porque los recuentos dejan de cuadrar con los
          // del informe y eso hay que explicarlo, no esconderlo.
          <p className="text-[11px] text-muted-foreground">
            En esta pestaña las listas cuentan también los leads excluidos, así que sus recuentos no
            coinciden con los del informe.
          </p>
        )}
        {algo && (
          <button
            type="button"
            onClick={limpiar}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <Eraser className="h-3 w-3" />
            Vaciar estos filtros
          </button>
        )}
      </div>
    </div>
  );
}
