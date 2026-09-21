'use client';

// Vistas de filtro guardadas.
//
// Todo el estado de /leads vive en la URL, así que «guardar una vista» es
// guardar una query string y nada más. Por eso esto no necesita backend, ni
// migración, ni tabla: `localStorage` y ya.
//
// Es por viewer y por navegador, como la preferencia de tabla/tarjetas que
// `LeadsView` ya guarda igual. No se comparte entre personas, y se dice: quien
// quiera compartir una vista copia el enlace, que para eso los filtros están en
// la URL.

import { useCallback, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Bookmark, BookmarkPlus, X } from 'lucide-react';

const CLAVE = 'report-utm:leads-vistas';
/** Tope para que una lista larga no se coma la barra de filtros. */
const MAX_VISTAS = 12;

type Vista = { nombre: string; qs: string };

function leer(): Vista[] {
  if (typeof window === 'undefined') return [];
  try {
    const crudo = window.localStorage.getItem(CLAVE);
    const v = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(v)
      ? v.filter((x) => x && typeof x.nombre === 'string' && typeof x.qs === 'string')
      : [];
  } catch {
    // Ventana privada, almacenamiento bloqueado o JSON corrupto: la página
    // funciona igual, simplemente sin vistas.
    return [];
  }
}

// Store externo sobre localStorage, igual que la preferencia tabla/tarjetas de
// `LeadsView`. Con `useSyncExternalStore` el snapshot del servidor es siempre la
// lista vacía —no hay `localStorage` ahí— y no hay mismatch de hidratación ni
// un setState dentro de un efecto.
const oyentes = new Set<() => void>();
// El JSON se cachea porque `getSnapshot` debe devolver la MISMA referencia
// mientras nada cambie: si parseara en cada llamada, React vería un array nuevo
// cada vez y volvería a renderizar sin parar.
let cache: { crudo: string | null; valor: Vista[] } = { crudo: null, valor: [] };
const VACIO: Vista[] = [];

function snapshot(): Vista[] {
  if (typeof window === 'undefined') return VACIO;
  let crudo: string | null = null;
  try {
    crudo = window.localStorage.getItem(CLAVE);
  } catch {
    return VACIO;
  }
  if (crudo !== cache.crudo) cache = { crudo, valor: leer() };
  return cache.valor;
}

function suscribir(cb: () => void) {
  oyentes.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    oyentes.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

function escribir(v: Vista[]) {
  try {
    window.localStorage.setItem(CLAVE, JSON.stringify(v.slice(0, MAX_VISTAS)));
  } catch {
    /* almacenamiento no disponible */
  }
  oyentes.forEach((l) => l());
}

export function LeadsVistasGuardadas({ qsActual }: { qsActual: string }) {
  const vistas = useSyncExternalStore(suscribir, snapshot, () => VACIO);

  const guardar = useCallback(() => {
    const nombre = prompt('Nombre de la vista:')?.trim();
    if (!nombre) return;
    // Mismo nombre = se reemplaza. Es lo que espera quien reajusta un filtro y
    // lo vuelve a guardar igual.
    const sinEse = snapshot().filter((v) => v.nombre !== nombre);
    escribir([{ nombre, qs: qsActual }, ...sinEse].slice(0, MAX_VISTAS));
  }, [qsActual]);

  const borrar = (nombre: string) => escribir(snapshot().filter((v) => v.nombre !== nombre));

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Bookmark className="h-3 w-3" />
        Vistas
      </span>

      {vistas.map((v) => (
        <span
          key={v.nombre}
          className="inline-flex items-center rounded-lg border border-border bg-muted overflow-hidden"
        >
          <Link
            href={`/leads${v.qs ? `?${v.qs}` : ''}`}
            className="px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent transition-colors"
          >
            {v.nombre}
          </Link>
          <button
            type="button"
            onClick={() => borrar(v.nombre)}
            title={`Borrar «${v.nombre}»`}
            className="px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {vistas.length === 0 && (
        <span className="text-[11px] text-muted-foreground">
          ninguna todavía — se guardan solo en este navegador
        </span>
      )}

      <button
        type="button"
        onClick={guardar}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border border-border text-muted-foreground hover:bg-accent transition-colors"
      >
        <BookmarkPlus className="h-3 w-3" />
        Guardar esta
      </button>
    </div>
  );
}
