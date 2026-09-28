'use client';

/**
 * Conversiones personalizadas de Meta de un cliente.
 *
 * Lista lo que el sync descubrió (conversiones personalizadas de Events Manager
 * y eventos personalizados del píxel) y deja decidir lo que el sync nunca toca:
 * el nombre que se muestra, el tipo, si cuenta como «resultado principal» del
 * cliente (métricas «Resultados (personalizados)» en informes y reportes) y si
 * se archiva. Las que llevan 90 días sin actividad se ocultan salvo con
 * «Ver antiguas».
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Archive, ArchiveRestore, DownloadCloud, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  actualizarConversionMeta,
  listarConversionesMeta,
  referenciasConversionMeta,
  refreshMetaCustomConversions,
  type ConversionMetaFila,
} from '../_actions';
import {
  DIAS_ANTIGUA,
  ETIQUETA_TIPO,
  TIPOS_CONVERSION,
  claveValidaEnFormula,
  dobleConteo,
} from '@/lib/meta/conversiones-personalizadas';

interface Props {
  clienteId: string;
  /** El cliente tiene alguna cuenta de Meta configurada. */
  habilitado: boolean;
}

export function MetaConversionesCard({ clienteId, habilitado }: Props) {
  const [filas, setFilas] = useState<ConversionMetaFila[]>([]);
  const [migrada, setMigrada] = useState(true);
  const [cargando, setCargando] = useState(true);
  const [sincronizando, setSincronizando] = useState(false);
  const [verAntiguas, setVerAntiguas] = useState(false);
  const [mensaje, setMensaje] = useState<{ ok: boolean; texto: string } | null>(null);

  const aplicar = useCallback((r: Awaited<ReturnType<typeof listarConversionesMeta>>) => {
    if (r.error) setMensaje({ ok: false, texto: r.error });
    setFilas(r.data ?? []);
    setMigrada(r.migrada ?? true);
    setCargando(false);
  }, []);

  const cargar = useCallback(async () => {
    aplicar(await listarConversionesMeta(clienteId));
  }, [clienteId, aplicar]);

  useEffect(() => {
    let vivo = true;
    listarConversionesMeta(clienteId).then((r) => {
      if (vivo) aplicar(r);
    });
    return () => {
      vivo = false;
    };
  }, [clienteId, aplicar]);

  const sincronizar = async () => {
    setSincronizando(true);
    setMensaje(null);
    const r = await refreshMetaCustomConversions(clienteId);
    setMensaje(
      r.error ? { ok: false, texto: r.error } : { ok: true, texto: r.message ?? 'Listo.' }
    );
    setSincronizando(false);
    await cargar();
  };

  const guardar = async (
    key: string,
    patch: Parameters<typeof actualizarConversionMeta>[2],
    optimista: Partial<ConversionMetaFila>
  ) => {
    const previas = filas;
    setFilas((fs) => fs.map((f) => (f.conversion_key === key ? { ...f, ...optimista } : f)));
    const r = await actualizarConversionMeta(clienteId, key, patch);
    if (r.error) {
      setFilas(previas);
      setMensaje({ ok: false, texto: r.error });
    } else if ('label_manual' in patch) {
      await cargar();
    }
  };

  const archivar = async (f: ConversionMetaFila) => {
    if (!f.archivada) {
      const refs = await referenciasConversionMeta(clienteId, f.conversion_key);
      const usos = refs.data ?? [];
      if (usos.length > 0) {
        const lista = usos
          .slice(0, 6)
          .map((u) => `• ${u.nombre} (${u.origen})`)
          .join('\n');
        const ok = window.confirm(
          `«${f.label}» está en uso:\n${lista}${usos.length > 6 ? '\n…' : ''}\n\nArchivarla la oculta de los selectores, pero los widgets que ya la usan siguen funcionando. ¿Archivar?`
        );
        if (!ok) return;
      }
    }
    await guardar(f.conversion_key, { archivada: !f.archivada }, { archivada: !f.archivada });
  };

  const visibles = useMemo(
    () =>
      filas
        .filter((f) => verAntiguas || f.activa || f.es_resultado)
        .sort(
          (a, b) =>
            Number(b.es_resultado) - Number(a.es_resultado) ||
            Number(b.activa) - Number(a.activa) ||
            a.label.localeCompare(b.label)
        ),
    [filas, verAntiguas]
  );
  const ocultas = filas.length - filas.filter((f) => f.activa || f.es_resultado).length;
  const dobles = useMemo(() => dobleConteo(filas), [filas]);
  const invalidasResultado = filas.filter(
    (f) => f.es_resultado && !claveValidaEnFormula(f.conversion_key)
  );

  return (
    <div className="pt-4 mt-2 border-t border-border space-y-3">
      <div className="flex flex-wrap justify-between items-center gap-3 bg-muted/50 p-3 rounded-lg border border-border">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-foreground">Conversiones Personalizadas</h4>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Conversiones personalizadas y eventos personalizados del píxel con actividad en los
            últimos {DIAS_ANTIGUA} días. Marca cuáles cuentan como resultado del cliente.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          className="bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/30 border border-indigo-500/30 whitespace-nowrap"
          onClick={sincronizar}
          disabled={sincronizando || !habilitado}
        >
          {sincronizando ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <DownloadCloud className="w-4 h-4 mr-2" />
          )}
          Sincronizar Conversiones
        </Button>
      </div>

      {mensaje && (
        <p
          className={`text-xs p-2 rounded ${mensaje.ok ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10' : 'text-red-600 dark:text-red-400 bg-red-500/10'}`}
        >
          {mensaje.texto}
        </p>
      )}

      {!migrada && (
        <p className="text-xs p-2 rounded text-amber-700 dark:text-amber-400 bg-amber-500/10">
          Falta aplicar la migración 096: se muestran las conversiones, pero aún no se pueden
          renombrar, clasificar ni marcar como resultado.
        </p>
      )}

      {dobles.length > 0 && (
        <p className="text-xs p-2 rounded text-amber-700 dark:text-amber-400 bg-amber-500/10 flex gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Posible doble conteo en «Resultados»:{' '}
            {dobles
              .map((d) => {
                const cc = filas.find((f) => f.conversion_key === d.cc)?.label ?? d.cc;
                const ev = filas.find((f) => f.conversion_key === d.evento)?.label ?? d.evento;
                return `«${cc}» se basa en el evento «${ev}»`;
              })
              .join('; ')}
            . Marca solo una de las dos.
          </span>
        </p>
      )}

      {invalidasResultado.length > 0 && (
        <p className="text-xs p-2 rounded text-amber-700 dark:text-amber-400 bg-amber-500/10">
          {invalidasResultado.map((f) => `«${f.label}»`).join(', ')} tiene espacios o símbolos en su
          nombre de evento: cuenta en los informes, pero no en «Resultados» de los reportes
          clásicos.
        </p>
      )}

      {cargando ? (
        <p className="text-xs text-muted-foreground flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Cargando conversiones…
        </p>
      ) : filas.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Aún no hay conversiones personalizadas. Pulsa «Sincronizar» para buscarlas.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {visibles.length} de {filas.length}
              {` · ${filas.filter((f) => f.es_resultado).length} cuentan como resultado`}
              {!verAntiguas && ocultas > 0 ? ` · ${ocultas} antiguas o archivadas ocultas` : ''}
            </span>
            <label className="flex items-center gap-2 cursor-pointer">
              <Switch checked={verAntiguas} onCheckedChange={setVerAntiguas} />
              Ver antiguas
            </label>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-left font-medium p-2">Nombre</th>
                  <th className="text-left font-medium p-2">Tipo</th>
                  <th className="text-center font-medium p-2" title="Cuenta como resultado">
                    Resultado
                  </th>
                  <th className="text-left font-medium p-2 whitespace-nowrap">Última actividad</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {visibles.map((f) => (
                  <tr
                    key={f.conversion_key}
                    className={`border-t border-border ${f.es_resultado ? 'bg-emerald-500/10' : ''} ${!f.activa ? 'opacity-60' : ''}`}
                  >
                    <td className="p-2 min-w-[220px]">
                      <Input
                        key={`${f.conversion_key}:${f.label_manual ?? ''}`}
                        defaultValue={f.label_manual ?? ''}
                        placeholder={f.nombre_meta ?? f.conversion_key}
                        disabled={!migrada}
                        className="h-7 text-xs"
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v === (f.label_manual ?? '')) return;
                          void guardar(
                            f.conversion_key,
                            { label_manual: v || null },
                            { label_manual: v || null }
                          );
                        }}
                      />
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span
                          className={`px-1.5 py-px rounded border ${f.origen === 'cc' ? 'border-sky-500/40 text-sky-700 dark:text-sky-300' : 'border-violet-500/40 text-violet-700 dark:text-violet-300'}`}
                          title={
                            f.origen === 'cc'
                              ? 'Conversión personalizada (regla de Events Manager)'
                              : 'Evento personalizado del píxel'
                          }
                        >
                          {f.origen === 'cc' ? 'CC' : 'Evento'}
                        </span>
                        <span className="truncate" title={f.conversion_key}>
                          {f.nombre_meta ?? f.conversion_key}
                        </span>
                        {f.es_resultado && (
                          <span className="px-1.5 py-px rounded border border-emerald-500/50 text-emerald-700 dark:text-emerald-300">
                            Resultado
                          </span>
                        )}
                        {f.archivada && <span>· archivada</span>}
                      </div>
                    </td>
                    <td className="p-2">
                      <select
                        value={f.tipo}
                        disabled={!migrada}
                        onChange={(e) =>
                          void guardar(
                            f.conversion_key,
                            { tipo: e.target.value },
                            { tipo: e.target.value as ConversionMetaFila['tipo'] }
                          )
                        }
                        className="h-7 rounded-md border border-input bg-background px-2 text-xs"
                      >
                        {TIPOS_CONVERSION.map((t) => (
                          <option key={t} value={t}>
                            {ETIQUETA_TIPO[t]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-2 text-center">
                      <Checkbox
                        checked={f.es_resultado}
                        disabled={!migrada}
                        aria-label="Cuenta como resultado"
                        onCheckedChange={(v) =>
                          void guardar(
                            f.conversion_key,
                            { es_resultado: v === true },
                            { es_resultado: v === true }
                          )
                        }
                      />
                    </td>
                    <td className="p-2 whitespace-nowrap text-muted-foreground">
                      {f.ultima_actividad ?? '—'}
                    </td>
                    <td className="p-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        disabled={!migrada}
                        title={f.archivada ? 'Restaurar' : 'Archivar'}
                        onClick={() => void archivar(f)}
                      >
                        {f.archivada ? (
                          <ArchiveRestore className="w-3.5 h-3.5" />
                        ) : (
                          <Archive className="w-3.5 h-3.5" />
                        )}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
