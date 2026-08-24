'use client';

// Carga los valores de una dimensión, con su recuento.
//
// Vive aparte del componente porque lo usan dos cosas distintas: el selector de
// casillas de los filtros y el widget `slicer`. Antes cada uno tenía su propio
// `fetch`, y así fue como el del slicer acabó mandando parámetros que el
// servidor ignoraba sin que nadie lo notara.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ValorConConteo, MotivoSinValores } from '@/lib/report-utm/bi-valores';

export interface EstadoValores {
  valores: ValorConConteo[];
  /** Valores distintos totales; puede superar a `valores.length`. */
  total: number;
  truncado: boolean;
  cargando: boolean;
  /** Presente solo si la lista está vacía por una causa concreta. */
  motivo: MotivoSinValores | null;
  recargar: () => void;
}

export interface OpcionesValores {
  queryBase: string;
  dimension?: string;
  clienteId?: string;
  dateFrom?: string;
  dateTo?: string;
  source?: 'leads' | 'sales';
  busqueda?: string;
  limite?: number;
  /**
   * No consulta hasta que valga `true`.
   *
   * Es lo que evita que abrir un informe con varios filtros dispare todas sus
   * consultas de golpe: la lista solo hace falta cuando el usuario despliega
   * el panel.
   */
  activo?: boolean;
}

/** Milisegundos de espera antes de consultar por una búsqueda tecleada. */
const DEBOUNCE_MS = 300;

export function useValoresDistintos(opts: OpcionesValores): EstadoValores {
  const {
    queryBase,
    dimension,
    clienteId,
    dateFrom,
    dateTo,
    source,
    busqueda,
    limite,
    activo = true,
  } = opts;

  const [valores, setValores] = useState<ValorConConteo[]>([]);
  const [total, setTotal] = useState(0);
  const [truncado, setTruncado] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [motivo, setMotivo] = useState<MotivoSinValores | null>(null);
  const [tick, setTick] = useState(0);

  const recargar = useCallback(() => setTick((t) => t + 1), []);

  // La petición en vuelo se cancela al cambiar cualquier entrada: sin esto,
  // teclear rápido deja respuestas viejas llegando después de las nuevas y la
  // lista parpadea con resultados que ya no corresponden.
  const abortRef = useRef<AbortController | null>(null);

  // Enumerable = tiene sentido pedir sus valores. «Total» no tiene ninguno y
  // «Fecha» los tiene todos.
  const enumerable = Boolean(dimension) && dimension !== 'none' && dimension !== 'date';
  const inactivo = !activo || !enumerable;

  useEffect(() => {
    // Sin `setState` en la rama inactiva: el estado vacío se DERIVA al
    // devolver, que evita el ciclo de renders que provoca actualizar estado
    // dentro de un efecto solo para dejarlo como ya estaba.
    if (inactivo || !dimension) return;
    const dim = dimension;

    const q = (busqueda ?? '').trim();
    // Una búsqueda de un carácter devolvería casi todo: no compensa el viaje.
    const buscarRemoto = q.length >= 2;

    const lanzar = () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setCargando(true);

      const params = new URLSearchParams({ type: 'valores', dimension: dim });
      if (clienteId) params.set('cliente_id', clienteId);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (source) params.set('source', source);
      if (limite) params.set('limit', String(limite));
      if (buscarRemoto) params.set('search', q);

      fetch(`${queryBase}?${params}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((json) => {
          const d = json?.data;
          if (!d || !Array.isArray(d.valores)) {
            // Una respuesta que no tiene la forma esperada es un
            // fallo, no una lista vacía. Decirlo evita que el panel
            // afirme «no hay valores» cuando no ha podido saberlo.
            setValores([]);
            setTotal(0);
            setTruncado(false);
            setMotivo('error_consulta');
            return;
          }
          setValores(d.valores);
          setTotal(Number(d.total ?? d.valores.length));
          setTruncado(Boolean(d.truncado));
          setMotivo((d.motivo as MotivoSinValores | undefined) ?? null);
        })
        .catch((e: unknown) => {
          // Cancelar no es fallar: no se toca el estado o se pintaría
          // un error cada vez que el usuario teclea una letra.
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setValores([]);
          setTotal(0);
          setTruncado(false);
          setMotivo('error_consulta');
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setCargando(false);
        });
    };

    // Solo la búsqueda se debouncea. Abrir el panel debe responder ya.
    if (buscarRemoto) {
      const t = setTimeout(lanzar, DEBOUNCE_MS);
      return () => clearTimeout(t);
    }
    lanzar();
    return () => abortRef.current?.abort();
  }, [queryBase, dimension, clienteId, dateFrom, dateTo, source, busqueda, limite, inactivo, tick]);

  if (inactivo) {
    return { valores: [], total: 0, truncado: false, cargando: false, motivo: null, recargar };
  }
  return { valores, total, truncado, cargando, motivo, recargar };
}
