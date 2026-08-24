'use client';

import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Tags,
} from 'lucide-react';
import {
  listSheetCampos,
  saveSheetCampo,
  deleteSheetCampo,
  saveSheetVista,
  deleteSheetVista,
  listCampoValores,
  recalcularSheetCampos,
  listSheetColumnas,
} from '../../_actions';
import type { SheetCampoDef, SheetCampoVistaDef, CampoValorCrudo } from '@/lib/sheets/campos';
import { CampoEditorDialog } from './CampoEditorDialog';
import type { Fuente } from './OrigenesEditor';

const CAMPO_NUEVO: Partial<SheetCampoDef> = {
  nombre: '',
  rol: 'dimension',
  formato: 'number',
  agregacion: 'count',
  origenes: [],
  valores_map: {},
  valores_orden: [],
  sin_mapear: 'crudo',
  max_valores: 200,
  activo: true,
};

/**
 * Sección "Campos de Sheet" del formulario de un cliente.
 *
 * Va debajo de la card de Google Sheets a propósito: esa configura la CONEXIÓN
 * (qué documento, qué pestañas, qué columna de fecha) y esta define QUÉ SE MIDE.
 * Un campo cruza varias pestañas —y puede cruzar varios documentos—, así que no
 * cabe dentro de la tarjeta de un sheet concreto.
 */
export function SheetCamposSection({ clienteId }: { clienteId: string }) {
  const [campos, setCampos] = useState<SheetCampoDef[]>([]);
  const [vistas, setVistas] = useState<SheetCampoVistaDef[]>([]);
  const [fuentes, setFuentes] = useState<Fuente[]>([]);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [recalculando, setRecalculando] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  const [editando, setEditando] = useState<Partial<SheetCampoDef> | null>(null);
  const [valores, setValores] = useState<CampoValorCrudo[]>([]);
  const [totalDistintos, setTotalDistintos] = useState(0);

  /** Recarga manual (tras borrar o recalcular), con indicador. */
  const cargar = useCallback(async () => {
    setCargando(true);
    const [res, cols] = await Promise.all([
      listSheetCampos(clienteId),
      listSheetColumnas(clienteId),
    ]);
    if ('error' in res) setError(res.error);
    else {
      setCampos(res.campos ?? []);
      setVistas(res.vistas ?? []);
    }
    // Sin columnas todavía la sección sigue siendo usable (lo explica abajo):
    // un fallo aquí no debe tapar los campos que ya existen.
    if (!('error' in cols)) setFuentes(cols.fuentes ?? []);
    setCargando(false);
  }, [clienteId]);

  // Carga inicial. Va aparte de `cargar` para no tocar el estado de forma
  // síncrona dentro del efecto, y el testigo `vivo` evita que la respuesta de
  // un cliente anterior pise la del actual al cambiar de cliente.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const [res, cols] = await Promise.all([
        listSheetCampos(clienteId),
        listSheetColumnas(clienteId),
      ]);
      if (!vivo) return;
      if ('error' in res) setError(res.error);
      else {
        setCampos(res.campos ?? []);
        setVistas(res.vistas ?? []);
      }
      if (!('error' in cols)) setFuentes(cols.fuentes ?? []);
      setCargando(false);
    })();
    return () => {
      vivo = false;
    };
  }, [clienteId]);

  /** Valores crudos del campo, para el agrupador y el selector de vistas. */
  const cargarValores = useCallback(
    async (campoId: string) => {
      const res = await listCampoValores(clienteId, campoId);
      if ('error' in res) {
        setValores([]);
        setTotalDistintos(0);
        return;
      }
      setValores(res.valores ?? []);
      setTotalDistintos(res.totalDistintos ?? 0);
    },
    [clienteId]
  );

  const abrir = async (campo: Partial<SheetCampoDef>) => {
    setError('');
    setAviso('');
    setValores([]);
    setTotalDistintos(0);
    setEditando(campo);
    if (campo.id) await cargarValores(campo.id);
  };

  const guardar = async (campo: Partial<SheetCampoDef>) => {
    setGuardando(true);
    setError('');
    const res = await saveSheetCampo(clienteId, campo);
    setGuardando(false);

    if ('error' in res) {
      setError(res.error);
      return;
    }

    setCampos(res.campos ?? []);
    setVistas(res.vistas ?? []);

    const dias = res.recalculo?.dias ?? 0;
    const vals = res.recalculo?.valores ?? 0;
    setAviso(
      dias > 0
        ? `Calculado: ${vals} valores distintos en ${dias} días.`
        : 'Campo guardado. Todavía no hay datos: sincroniza el Sheet para calcularlo.'
    );
    if (res.recalculo?.avisos?.length) setAviso(res.recalculo.avisos.join(' '));

    // Se sigue en el editor con el campo ya calculado: es cuando aparecen los
    // valores reales y se pueden agrupar, que es el paso que de verdad importa.
    const guardado = res.campo ?? (res.campos ?? []).find((c) => c.id === campo.id);
    if (guardado) {
      setEditando(guardado);
      await cargarValores(guardado.id);
    }
  };

  const borrar = async (campo: SheetCampoDef) => {
    const usadas = vistas.filter((v) => v.campo_id === campo.id).length;
    const detalle = usadas > 0 ? ` y sus ${usadas} vistas` : '';
    if (
      !confirm(
        `¿Borrar el campo "${campo.nombre}"${detalle}? Los informes que lo usen dejarán de mostrarlo.`
      )
    )
      return;

    setError('');
    const res = await deleteSheetCampo(clienteId, campo.id);
    if ('error' in res) {
      setError(res.error);
      return;
    }
    await cargar();
  };

  const recalcular = async () => {
    setRecalculando(true);
    setError('');
    const res = await recalcularSheetCampos(clienteId);
    setRecalculando(false);
    if ('error' in res) {
      setError(res.error);
      return;
    }
    setAviso(`Recalculados ${res.campos} campos · ${res.valores} valores en ${res.dias} días.`);
    await cargar();
  };

  const guardarVista = async (vista: Partial<SheetCampoVistaDef>) => {
    setGuardando(true);
    const res = await saveSheetVista(clienteId, vista);
    setGuardando(false);
    if ('error' in res) {
      setError(res.error);
      return;
    }
    setVistas(res.vistas ?? []);
  };

  const borrarVista = async (vistaId: string) => {
    const res = await deleteSheetVista(clienteId, vistaId);
    if ('error' in res) {
      setError(res.error);
      return;
    }
    setVistas(res.vistas ?? []);
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Tags className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <CardTitle className="text-foreground">Campos de Sheet</CardTitle>
              <CardDescription className="mt-1">
                Une columnas que miden lo mismo en distintas pestañas bajo un nombre propio, agrupa
                sus valores y úsalas como métrica en informes y dashboards.
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {campos.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={recalcular}
                disabled={recalculando}
                className="h-8 text-xs gap-1"
                title="Recalcula desde los datos ya sincronizados. No llama a Google."
              >
                {recalculando ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Recalcular
              </Button>
            )}
            <Button size="sm" onClick={() => abrir(CAMPO_NUEVO)} className="h-8 text-xs gap-1">
              <Plus className="w-3 h-3" /> Agregar campo
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {error && (
          <p className="text-xs text-red-500 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" /> {error}
          </p>
        )}
        {aviso && !error && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" /> {aviso}
          </p>
        )}

        {cargando ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
            <Loader2 className="w-3 h-3 animate-spin" /> Cargando campos...
          </div>
        ) : campos.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-1">
            <p className="text-sm text-muted-foreground">Todavía no hay campos definidos.</p>
            <p className="text-xs text-muted-foreground/70">
              Un campo une, por ejemplo, la columna “rango de ingresos” de un formulario con “cuál
              es tu rango de ingresos” de otro, y agrupa “20 a 100” y “20-100” en un solo valor por
              el que puedes filtrar.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {campos.map((campo) => {
              const suyas = vistas.filter((v) => v.campo_id === campo.id);
              const pestanas = (campo.origenes ?? []).length;
              const columnas = (campo.origenes ?? []).reduce((s, o) => s + o.columnas.length, 0);
              return (
                <div
                  key={campo.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-foreground truncate">{campo.nombre}</span>
                      {!campo.activo && (
                        <span className="text-[10px] text-muted-foreground/60 border border-border rounded px-1">
                          inactivo
                        </span>
                      )}
                      {campo.alta_cardinalidad && (
                        <span
                          className="text-[10px] text-amber-600 dark:text-amber-400 border border-amber-500/30 rounded px-1"
                          title="Demasiados valores distintos: no se ofrece como categoría"
                        >
                          muchos valores
                        </span>
                      )}
                    </span>
                    <span className="block text-[11px] text-muted-foreground/70 truncate">
                      {columnas} columnas en {pestanas} {pestanas === 1 ? 'pestaña' : 'pestañas'}
                      {suyas.length > 0 &&
                        ` · ${suyas.length} ${suyas.length === 1 ? 'vista' : 'vistas'}`}
                      {' · '}
                      <span className="font-mono">sf_{campo.clave}</span>
                      {!campo.recalculado_at && (
                        <span className="text-amber-500"> · sin calcular</span>
                      )}
                    </span>
                  </span>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => abrir(campo)}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground shrink-0"
                    title="Editar campo"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => borrar(campo)}
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500 shrink-0"
                    title="Borrar campo"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {!cargando && fuentes.length === 0 && (
          <p className="text-xs text-muted-foreground/60">
            Aún no hay pestañas sincronizadas. Configura y sincroniza un Google Sheet arriba para
            poder mapear sus columnas.
          </p>
        )}
      </CardContent>

      {/* La key siembra el borrador: al pasar de "nuevo" al campo ya
                creado, el diálogo se remonta con sus valores reales. */}
      <CampoEditorDialog
        key={editando?.id ?? 'nuevo'}
        open={editando !== null}
        campo={editando}
        vistas={vistas}
        fuentes={fuentes}
        valores={valores}
        totalDistintos={totalDistintos}
        guardando={guardando}
        error={error}
        onClose={() => {
          setEditando(null);
          setError('');
        }}
        onGuardar={guardar}
        onGuardarVista={guardarVista}
        onBorrarVista={borrarVista}
      />
    </Card>
  );
}
