'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, Columns3, Search } from 'lucide-react';
import type { CampoOrigen } from '@/lib/sheets/campos';
import type { FuenteColumnas } from '@/lib/sheets/campos-db';

export type Fuente = FuenteColumnas & { sheet_nombre: string };

/** Etiqueta de una pestaña en el desplegable. */
function etiquetaFuente(f: Fuente): string {
  const base = `${f.sheet_nombre} › ${f.tab_name || '(primera pestaña)'}`;
  // Se listan también las pestañas sin datos, marcadas: si desaparecieran del
  // desplegable parecería que la app no las ve.
  return f.columnas.length === 0 ? `${base} — sin datos` : base;
}

/**
 * Una fila del mapeo: una pestaña y las columnas suyas que contienen el dato.
 *
 * Va en su propia tarjeta a lo ancho, no en una celda estrecha: los nombres
 * sanitizados son largos (`cual_es_tu_rango_de_ingresos`) y una hoja de anuncios
 * trae decenas de columnas, así que verlos truncados a `ad_…` hace imposible
 * saber qué se está marcando.
 */
function OrigenRow({
  origen,
  fuentes,
  onChange,
  onRemove,
}: {
  origen: CampoOrigen;
  fuentes: Fuente[];
  onChange: (patch: Partial<CampoOrigen>) => void;
  onRemove: () => void;
}) {
  const [busqueda, setBusqueda] = useState('');

  const indiceActual = fuentes.findIndex(
    (f) => f.sheet_id === origen.sheet_id && f.tab_name === origen.tab_name
  );
  const fuente = indiceActual >= 0 ? fuentes[indiceActual] : undefined;

  const columnas = useMemo(() => {
    const todas = fuente?.columnas ?? [];
    const q = busqueda.trim().toLowerCase();
    const filtradas = q
      ? todas.filter(
          (c) =>
            c.toLowerCase().includes(q) ||
            (fuente?.muestras[c] ?? []).some((v) => v.toLowerCase().includes(q))
        )
      : todas;
    // Las marcadas primero: con cuarenta columnas, si no, hay que recordar
    // dónde estaban para comprobar lo que se eligió.
    const marcadas = origen.columnas;
    return filtradas.slice().sort((a, b) => {
      const ma = marcadas.includes(a) ? 0 : 1;
      const mb = marcadas.includes(b) ? 0 : 1;
      return ma - mb || a.localeCompare(b);
    });
  }, [fuente, busqueda, origen.columnas]);

  const totalColumnas = fuente?.columnas.length ?? 0;

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2.5">
      {/* Cabecera: qué pestaña y qué hacer si se marcan varias columnas */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px] space-y-1">
          <label className="block text-[11px] text-muted-foreground/70">Pestaña</label>
          <select
            // El valor es el índice: los nombres de pestaña llevan espacios
            // y cualquier separador acaba siendo ambiguo.
            value={indiceActual >= 0 ? String(indiceActual) : ''}
            onChange={(e) => {
              const f = fuentes[Number(e.target.value)];
              if (!f) return;
              // Las columnas pertenecen a la pestaña anterior: al cambiarla se
              // limpian en vez de quedar apuntando a algo que no existe ahí.
              onChange({ sheet_id: f.sheet_id, tab_name: f.tab_name, columnas: [] });
              setBusqueda('');
            }}
            className="h-9 w-full text-sm rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {indiceActual < 0 && <option value="">— Pestaña no encontrada —</option>}
            {fuentes.map((f, i) => (
              <option key={`${f.sheet_id}|${f.tab_name}`} value={String(i)}>
                {etiquetaFuente(f)}
              </option>
            ))}
          </select>
        </div>

        {/* Solo aparece cuando de verdad hay varias columnas: si no, es un
                    ajuste que no hace nada y que induce a dejarlo en "Sumarlas". */}
        {origen.columnas.length > 1 && (
          <div className="w-[190px] space-y-1">
            <label className="block text-[11px] text-muted-foreground/70">
              Con {origen.columnas.length} columnas…
            </label>
            <select
              value={origen.combinar ?? 'primero'}
              onChange={(e) => onChange({ combinar: e.target.value as CampoOrigen['combinar'] })}
              className="h-9 w-full text-sm rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="primero">Usar la 1ª con dato</option>
              <option value="suma">Sumarlas (solo números)</option>
              <option value="concat">Contar cada una</option>
            </select>
          </div>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRemove}
          className="h-9 w-9 p-0 text-muted-foreground hover:text-red-500 shrink-0"
          title="Quitar esta pestaña del campo"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>

      {/* Columnas de la pestaña */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/50" />
            <Input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="Buscar columna o valor de ejemplo..."
              className="h-8 pl-7 text-xs bg-background border-input"
            />
          </div>
          <span className="text-[11px] text-muted-foreground/70 shrink-0">
            {origen.columnas.length} de {totalColumnas} marcadas
          </span>
        </div>

        <div className="rounded-md border border-input bg-background max-h-72 overflow-y-auto divide-y divide-border/50">
          {columnas.length === 0 && (
            <div className="px-3 py-3 text-center space-y-1">
              <p className="text-xs text-muted-foreground/70">
                {totalColumnas === 0
                  ? 'Esta pestaña no tiene columnas sincronizadas.'
                  : 'Ninguna columna coincide con la búsqueda.'}
              </p>
              {totalColumnas === 0 && fuente?.aviso && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">{fuente.aviso}</p>
              )}
            </div>
          )}
          {columnas.map((col) => {
            const marcada = origen.columnas.includes(col);
            const muestra = (fuente?.muestras[col] ?? []).join('  ·  ');
            return (
              <label
                key={col}
                className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer transition-colors ${
                  marcada ? 'bg-indigo-500/10' : 'hover:bg-muted/60'
                }`}
              >
                <input
                  type="checkbox"
                  checked={marcada}
                  onChange={(e) =>
                    onChange({
                      columnas: e.target.checked
                        ? [...origen.columnas, col]
                        : origen.columnas.filter((c) => c !== col),
                    })
                  }
                  className="mt-0.5 shrink-0 rounded border-input bg-background text-indigo-500 focus:ring-indigo-500"
                />
                <span className="min-w-0 flex-1">
                  {/* break-all y sin truncar: el nombre completo es lo
                                        único que distingue una columna de otra. */}
                  <span className="block text-xs font-mono text-foreground break-all leading-snug">
                    {col}
                  </span>
                  {muestra && (
                    <span className="block text-[11px] text-muted-foreground/70 mt-0.5 line-clamp-2 break-words">
                      {muestra}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Mapeo "esta pestaña → esta columna", que es lo que hace que un campo funcione
 * cuando el mismo dato se llama distinto en cada formulario.
 *
 * Las pestañas y columnas salen de los datos YA sincronizados (`sheet_filas`),
 * no de Google: el desplegable abre al instante y muestra valores de ejemplo,
 * que es como se reconoce una columna cuando su nombre no ayuda.
 */
export function OrigenesEditor({
  origenes,
  fuentes,
  onChange,
}: {
  origenes: CampoOrigen[];
  fuentes: Fuente[];
  onChange: (origenes: CampoOrigen[]) => void;
}) {
  if (fuentes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-center">
        <p className="text-xs text-muted-foreground">
          Todavía no hay datos sincronizados de ninguna pestaña.
        </p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Sincroniza el Sheet una vez y aquí aparecerán sus columnas para poder mapearlas.
        </p>
      </div>
    );
  }

  const totalColumnas = origenes.reduce((s, o) => s + o.columnas.length, 0);

  return (
    <div className="space-y-3">
      {origenes.map((origen, i) => (
        <OrigenRow
          key={i}
          origen={origen}
          fuentes={fuentes}
          onChange={(patch) =>
            onChange(origenes.map((o, idx) => (idx === i ? { ...o, ...patch } : o)))
          }
          onRemove={() => onChange(origenes.filter((_, idx) => idx !== i))}
        />
      ))}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            // Se propone la primera pestaña que aún no esté mapeada: lo normal es
            // que el campo esté en varias y así no hay que elegirla a mano.
            const usadas = new Set(origenes.map((o) => `${o.sheet_id}|${o.tab_name}`));
            const libre =
              fuentes.find((f) => !usadas.has(`${f.sheet_id}|${f.tab_name}`)) ?? fuentes[0];
            onChange([
              ...origenes,
              {
                sheet_id: libre.sheet_id,
                tab_name: libre.tab_name,
                columnas: [],
                combinar: 'primero',
              },
            ]);
          }}
          className="h-8 text-xs gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Añadir pestaña
        </Button>

        {origenes.length > 0 && (
          <span className="text-xs text-muted-foreground/70 flex items-center gap-1.5">
            <Columns3 className="w-3.5 h-3.5" />
            {totalColumnas} {totalColumnas === 1 ? 'columna' : 'columnas'} en {origenes.length}{' '}
            {origenes.length === 1 ? 'pestaña' : 'pestañas'}
          </span>
        )}
        <span className="text-xs text-muted-foreground/50 ml-auto">
          {fuentes.length} {fuentes.length === 1 ? 'pestaña disponible' : 'pestañas disponibles'}
        </span>
      </div>
    </div>
  );
}
