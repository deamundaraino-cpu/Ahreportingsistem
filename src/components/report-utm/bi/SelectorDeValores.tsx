'use client';

// Selector de valores de una columna, con casillas y recuento.
//
// Es lo que sustituye a escribir el valor a mano. Para filtrar por la campaña
// `[ÑUÑOA][CAPTACIÓN LEADS][FORM][ABO][NOV]` había que acordarse de los acentos
// y los corchetes; si fallabas, el widget salía vacío y no había forma de
// distinguir «lo escribí mal» de «no hay datos».
//
// El recuento no es decoración: es lo que convierte la lista en información.
// Ver «(sin campaña) · 47» junto a «[ÑUÑOA] · 1.284» dice de un vistazo si el
// etiquetado va bien, sin abrir el diagnóstico de cruce.

import { useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Search, AlertTriangle, X } from 'lucide-react';
import { useValoresDistintos } from './useValoresDistintos';
import {
  parseSeleccion,
  alternarValor,
  componerFilas,
  tieneComa,
} from '@/lib/report-utm/bi-valores';

interface Props {
  dimension: string;
  /** Selección actual, en el formato guardado (`"a,b,c"`). */
  value: string;
  onChange: (value: string) => void;
  clienteId?: string;
  dateFrom?: string;
  dateTo?: string;
  source?: 'leads' | 'sales';
  queryBase: string;
  /** `inline` para el slicer (siempre abierto); `popover` para los filtros. */
  modo?: 'popover' | 'inline';
  disabled?: boolean;
  placeholder?: string;
}

/** Cuántos valores se pintan antes de pedir «ver los demás». */
const VISIBLES = 50;

export function SelectorDeValores({
  dimension,
  value,
  onChange,
  clienteId,
  dateFrom,
  dateTo,
  source,
  queryBase,
  modo = 'popover',
  disabled,
  placeholder,
}: Props) {
  const [abierto, setAbierto] = useState(modo === 'inline');
  const [busqueda, setBusqueda] = useState('');
  const [verTodos, setVerTodos] = useState(false);
  const contenedor = useRef<HTMLDivElement>(null);

  const seleccion = useMemo(() => parseSeleccion(value), [value]);

  // La búsqueda va SIEMPRE al servidor (con espera de 300 ms), no solo cuando
  // la lista viene truncada.
  //
  // Filtrar en memoria parecía más rápido, pero solo puede mirar los valores
  // ya cargados: en una columna con más valores de los que caben, buscar uno
  // de la cola no lo habría encontrado nunca y el panel habría dicho «ningún
  // valor coincide» sobre un valor que sí existe. Preguntar siempre es más
  // simple y es correcto en los dos casos.
  const {
    valores: listados,
    total,
    truncado,
    cargando,
    motivo,
    recargar,
  } = useValoresDistintos({
    queryBase,
    dimension,
    clienteId,
    dateFrom,
    dateTo,
    source,
    busqueda,
    activo: abierto,
  });

  // Los seleccionados que no están en la lista van arriba. Sin esto, abrir el
  // panel de un filtro guardado sobre un valor poco frecuente y tocar
  // cualquier cosa lo borraría en silencio.
  const filas = useMemo(() => componerFilas(listados, seleccion), [listados, seleccion]);
  const visibles = verTodos ? filas : filas.slice(0, VISIBLES);

  const alternar = (valor: string) => onChange(alternarValor(value, valor));
  const limpiar = () => onChange('');

  const resumen =
    seleccion.length === 0
      ? (placeholder ?? 'Todos los valores')
      : seleccion.length === 1
        ? seleccion[0]
        : `${seleccion.length} seleccionados`;

  const cuerpo = (
    <div className="flex flex-col gap-2">
      {/* Buscador */}
      <div className="relative">
        <Search
          className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
          aria-hidden
        />
        <input
          type="text"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder={
            truncado ? `Buscar entre ${total.toLocaleString('es-CO')} valores…` : 'Buscar…'
          }
          className="w-full rounded-md border border-border bg-background pl-7 pr-2 py-1.5 text-xs
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {/* Estados. Cada uno dice algo distinto: no se colapsan en «vacío». */}
      {cargando && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3 justify-center">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          Cargando valores…
        </div>
      )}

      {!cargando && !clienteId && (
        <p className="text-xs text-muted-foreground py-3 text-center">
          Selecciona un cliente para ver los valores.
        </p>
      )}

      {!cargando && motivo === 'dimension_no_listable' && clienteId && (
        <p className="text-xs text-muted-foreground py-3 text-center">
          Este campo no tiene valores enumerables en la fuente elegida.
        </p>
      )}

      {!cargando && (motivo === 'error_consulta' || motivo === 'timeout') && (
        <div className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-950/40 p-2 text-xs">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1">
              <p>No se pudieron listar los valores.</p>
              <button
                type="button"
                onClick={recargar}
                className="mt-1 underline underline-offset-2 focus-visible:outline-none
                                           focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                Reintentar
              </button>
            </div>
          </div>
        </div>
      )}

      {!cargando && !motivo && filas.length === 0 && clienteId && (
        <p className="text-xs text-muted-foreground py-3 text-center">
          {busqueda.trim()
            ? 'Ningún valor coincide con la búsqueda.'
            : 'Ningún registro del período tiene valor en este campo.'}
        </p>
      )}

      {/* Lista */}
      {visibles.length > 0 && (
        <ul className="max-h-64 overflow-y-auto flex flex-col gap-0.5 -mx-1 px-1">
          {visibles.map((f) => (
            <li key={f.valor}>
              <button
                type="button"
                onClick={() => alternar(f.valor)}
                className="w-full flex items-start gap-2 rounded px-1.5 py-1 text-left text-xs
                                           hover:bg-accent focus-visible:outline-none focus-visible:ring-2
                                           focus-visible:ring-ring"
              >
                <span
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded border flex items-center justify-center
                                        ${f.marcado ? 'bg-emerald-500 border-emerald-500' : 'border-border'}`}
                  aria-hidden
                >
                  {f.marcado && <Check className="h-2.5 w-2.5 text-white" />}
                </span>
                {/* Sin truncar: dos rangos de ingresos solo se
                                    distinguen por el final del texto. */}
                <span className="flex-1 break-words">{f.valor}</span>
                <span
                  className="shrink-0 tabular-nums text-muted-foreground"
                  title={
                    f.n === null
                      ? 'Seleccionado; no está entre los valores más frecuentes de este rango'
                      : undefined
                  }
                >
                  {f.n === null ? '·' : f.n.toLocaleString('es-CO')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {filas.length > VISIBLES && !verTodos && (
        <button
          type="button"
          onClick={() => setVerTodos(true)}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          Ver los {filas.length - VISIBLES} restantes
        </button>
      )}

      {truncado && (
        <p className="text-[11px] text-muted-foreground border-t border-border pt-1.5">
          Se muestran los más frecuentes de {total.toLocaleString('es-CO')}. Busca para encontrar el
          resto.
        </p>
      )}

      {/* Un valor con coma no cabe en el formato guardado, que separa por
                comas. Se avisa en vez de guardarlo partido en dos silenciosamente. */}
      {seleccion.some(tieneComa) && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400 border-t border-border pt-1.5">
          Algún valor contiene una coma; se guarda escapado para no partirse.
        </p>
      )}

      {seleccion.length > 0 && (
        <button
          type="button"
          onClick={limpiar}
          className="self-start text-xs text-muted-foreground hover:text-foreground
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          Limpiar ({seleccion.length})
        </button>
      )}
    </div>
  );

  if (modo === 'inline') {
    return <div className="flex flex-col gap-2">{cuerpo}</div>;
  }

  return (
    <div className="relative" ref={contenedor}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setAbierto((a) => !a)}
        className="w-full flex items-center gap-1.5 rounded-md border border-border bg-background
                           px-2 py-1.5 text-xs text-left disabled:opacity-50
                           focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className={`flex-1 truncate ${seleccion.length ? '' : 'text-muted-foreground'}`}>
          {resumen}
        </span>
        {seleccion.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            aria-label="Limpiar selección"
            onClick={(e) => {
              e.stopPropagation();
              limpiar();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                limpiar();
              }
            }}
            className="shrink-0 rounded hover:bg-accent p-0.5"
          >
            <X className="h-3 w-3" aria-hidden />
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {abierto && (
        <>
          {/* Capa de cierre: un clic fuera cierra el panel sin
                        necesitar un listener global sobre el documento. */}
          <div className="fixed inset-0 z-40" onClick={() => setAbierto(false)} aria-hidden />
          <div
            className="absolute z-50 mt-1 w-full min-w-64 rounded-md border border-border
                                    bg-popover shadow-lg p-2"
          >
            {cuerpo}
          </div>
        </>
      )}
    </div>
  );
}
