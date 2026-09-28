import 'server-only';

/**
 * Operaciones sobre el layout de un informe: localizar, insertar, mover,
 * reemplazar y quitar widgets, también dentro de una sección.
 *
 * El layout es una lista plana de widgets de primer nivel; una `section` guarda
 * los suyos en `children`, con un solo nivel (igual que el canvas). La versión
 * anterior solo miraba el primer nivel, así que quitar un widget de una sección
 * no hacía nada y respondía que sí.
 *
 * Todo es puro y no muta la entrada.
 */

import { ApiError } from '@/lib/error-handler';
import type { BiWidget } from '@/components/report-utm/bi/BiTypes';

export type Ubicacion = { widget: BiWidget; seccionId: string | null; indice: number };

/** El layout guardado, tolerando basura: lo que no es una lista cuenta como vacío. */
export function layoutDe(valor: unknown): BiWidget[] {
  return Array.isArray(valor) ? (valor as BiWidget[]) : [];
}

export function buscarWidget(layout: BiWidget[], id: string): Ubicacion | null {
  for (let i = 0; i < layout.length; i++) {
    const w = layout[i];
    if (w.id === id) return { widget: w, seccionId: null, indice: i };
    if (w.type === 'section') {
      const j = (w.children ?? []).findIndex((c) => c.id === id);
      if (j >= 0) return { widget: w.children![j], seccionId: w.id, indice: j };
    }
  }
  return null;
}

/** Todos los widgets, incluidos los de dentro de las secciones. */
export function todosLosWidgets(layout: BiWidget[]): BiWidget[] {
  return layout.flatMap((w) => [w, ...(w.type === 'section' ? (w.children ?? []) : [])]);
}

/** Ids en uso, para no repetir uno al insertar. */
export function idsEnUso(layout: BiWidget[]): Set<string> {
  return new Set(todosLosWidgets(layout).map((w) => w.id));
}

function exigirSeccion(layout: BiWidget[], seccionId: string): number {
  const i = layout.findIndex((w) => w.id === seccionId);
  if (i < 0) {
    throw new ApiError(
      'NOT_FOUND',
      `No hay ninguna sección ${seccionId} en el primer nivel del informe.`,
      404
    );
  }
  if (layout[i].type !== 'section') {
    throw new ApiError(
      'VALIDATION_ERROR',
      `El widget ${seccionId} es '${layout[i].type}', no una sección.`,
      400
    );
  }
  return i;
}

function insertarEn<T>(lista: T[], item: T, posicion?: number): T[] {
  const out = [...lista];
  const pos = posicion === undefined ? out.length : Math.max(0, Math.min(posicion, out.length));
  out.splice(pos, 0, item);
  return out;
}

/** Inserta un widget en el primer nivel o dentro de una sección. */
export function insertarWidget(
  layout: BiWidget[],
  widget: BiWidget,
  destino: { seccionId?: string | null; posicion?: number } = {}
): BiWidget[] {
  if (idsEnUso(layout).has(widget.id)) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Ya hay un widget con id ${widget.id}. Omite el id y se genera uno.`,
      400
    );
  }
  if (!destino.seccionId) return insertarEn(layout, widget, destino.posicion);

  if (widget.type === 'section') {
    throw new ApiError('VALIDATION_ERROR', 'Una sección no puede ir dentro de otra.', 400);
  }
  const i = exigirSeccion(layout, destino.seccionId);
  const seccion = layout[i];
  const out = [...layout];
  out[i] = { ...seccion, children: insertarEn(seccion.children ?? [], widget, destino.posicion) };
  return out;
}

/** Quita un widget esté donde esté. Lanza NOT_FOUND si no existe. */
export function quitarWidget(layout: BiWidget[], id: string): BiWidget[] {
  const u = buscarWidget(layout, id);
  if (!u) throw new ApiError('NOT_FOUND', `No hay ningún widget ${id} en el informe.`, 404);
  if (u.seccionId === null) return layout.filter((w) => w.id !== id);
  return layout.map((w) =>
    w.id === u.seccionId ? { ...w, children: (w.children ?? []).filter((c) => c.id !== id) } : w
  );
}

/** Sustituye un widget en su sitio. */
export function reemplazarWidget(layout: BiWidget[], id: string, nuevo: BiWidget): BiWidget[] {
  const u = buscarWidget(layout, id);
  if (!u) throw new ApiError('NOT_FOUND', `No hay ningún widget ${id} en el informe.`, 404);
  if (u.seccionId === null) return layout.map((w) => (w.id === id ? nuevo : w));
  if (nuevo.type === 'section') {
    throw new ApiError('VALIDATION_ERROR', 'Una sección no puede ir dentro de otra.', 400);
  }
  return layout.map((w) =>
    w.id === u.seccionId
      ? { ...w, children: (w.children ?? []).map((c) => (c.id === id ? nuevo : c)) }
      : w
  );
}

/** Mueve un widget a otra posición, dentro o fuera de una sección. */
export function moverWidget(
  layout: BiWidget[],
  id: string,
  destino: { seccionId: string | null; posicion?: number }
): BiWidget[] {
  const u = buscarWidget(layout, id);
  if (!u) throw new ApiError('NOT_FOUND', `No hay ningún widget ${id} en el informe.`, 404);
  if (destino.seccionId === id) {
    throw new ApiError('VALIDATION_ERROR', 'Una sección no puede ir dentro de sí misma.', 400);
  }
  return insertarWidget(quitarWidget(layout, id), u.widget, destino);
}
