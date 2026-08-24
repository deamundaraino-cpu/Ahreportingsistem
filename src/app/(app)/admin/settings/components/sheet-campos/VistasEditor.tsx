'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { bucketDeValor } from '@/lib/sheets/campos';
import type {
  SheetCampoDef,
  SheetCampoVistaDef,
  CampoValorCrudo,
  CampoAgg,
} from '@/lib/sheets/campos';

/**
 * Vistas guardadas de un campo: "Leads 20-100" = contar las filas cuyo valor
 * caiga en (20-100). Una vista se comporta como una métrica más — se puede poner
 * en una tarjeta, graficar día a día y usar en fórmulas.
 *
 * No hace falta recalcular al crearlas: se evalúan sobre el desglose diario que
 * el campo ya dejó guardado.
 */
export function VistasEditor({
  campo,
  vistas,
  valores,
  guardando,
  onGuardar,
  onBorrar,
}: {
  campo: SheetCampoDef;
  vistas: SheetCampoVistaDef[];
  valores: CampoValorCrudo[];
  guardando: boolean;
  onGuardar: (vista: Partial<SheetCampoVistaDef>) => void;
  onBorrar: (vistaId: string) => void;
}) {
  const [nueva, setNueva] = useState<Partial<SheetCampoVistaDef> | null>(null);

  // Los buckets disponibles se derivan de los valores reales con la misma
  // función del motor: no se puede elegir un valor que el campo nunca produce.
  const buckets = useMemo(() => {
    const set = new Set<string>();
    for (const v of valores) {
      const b = bucketDeValor(campo, v.valor_crudo);
      if (b !== null) set.add(b);
    }
    return Array.from(set).sort();
  }, [campo, valores]);

  const propias = vistas.filter((v) => v.campo_id === campo.id);

  return (
    <div className="space-y-2">
      {propias.map((v) => (
        <div
          key={v.id}
          className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-xs text-foreground truncate">{v.nombre}</span>
            <span className="block text-[10px] text-muted-foreground/60 truncate">
              {v.agregacion === 'count' ? 'contar filas' : v.agregacion}
              {' · '}
              {v.operador === 'not_in' ? 'excepto' : 'donde'} {v.valores.join(', ')}
              {' · '}
              <span className="font-mono">sv_{v.clave}</span>
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onBorrar(v.id)}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500 shrink-0"
            title="Borrar vista"
          >
            <Trash2 className="w-3 h-3" />
          </Button>
        </div>
      ))}

      {nueva ? (
        <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-2.5 space-y-2">
          <div className="grid grid-cols-[1fr_110px_100px] gap-2">
            <Input
              value={nueva.nombre ?? ''}
              onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })}
              placeholder="Nombre visible (ej. Leads 20-100)"
              className="h-7 text-xs bg-background border-input"
            />
            <select
              value={nueva.agregacion ?? 'count'}
              onChange={(e) => setNueva({ ...nueva, agregacion: e.target.value as CampoAgg })}
              className="h-7 text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="count">Contar filas</option>
              <option value="sum">Sumar</option>
              <option value="avg">Promediar</option>
              <option value="min">Mínimo</option>
              <option value="max">Máximo</option>
            </select>
            <select
              value={nueva.operador ?? 'in'}
              onChange={(e) => setNueva({ ...nueva, operador: e.target.value as 'in' | 'not_in' })}
              className="h-7 text-xs rounded-md border border-input bg-background px-2 text-foreground focus:outline-none focus:ring-1 focus:ring-indigo-500"
            >
              <option value="in">Donde sea</option>
              <option value="not_in">Excepto</option>
            </select>
          </div>

          <div className="rounded-md border border-input bg-background max-h-32 overflow-y-auto p-1.5 space-y-0.5">
            {buckets.length === 0 && (
              <p className="text-xs text-muted-foreground/60 px-1 py-0.5">
                Calcula el campo primero para ver sus valores.
              </p>
            )}
            {buckets.map((b) => (
              <label
                key={b}
                className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-muted/60 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={(nueva.valores ?? []).includes(b)}
                  onChange={(e) =>
                    setNueva({
                      ...nueva,
                      valores: e.target.checked
                        ? [...(nueva.valores ?? []), b]
                        : (nueva.valores ?? []).filter((x) => x !== b),
                    })
                  }
                  className="rounded border-input bg-background text-indigo-500 focus:ring-indigo-500"
                />
                <span className="text-xs text-foreground truncate">{b}</span>
              </label>
            ))}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setNueva(null)}
              className="h-7 text-xs"
            >
              Cancelar
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={guardando || !nueva.nombre?.trim() || (nueva.valores ?? []).length === 0}
              onClick={() => {
                onGuardar({ ...nueva, campo_id: campo.id });
                setNueva(null);
              }}
              className="h-7 text-xs gap-1"
            >
              {guardando && <Loader2 className="w-3 h-3 animate-spin" />}
              Crear vista
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            setNueva({ agregacion: 'count', operador: 'in', valores: [], formato: 'number' })
          }
          className="h-7 text-xs gap-1"
        >
          <Plus className="w-3 h-3" /> Añadir vista
        </Button>
      )}
    </div>
  );
}
