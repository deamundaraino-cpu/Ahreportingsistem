'use client';

// La pantalla ÚNICA de configuración de las respuestas de formulario.
//
// Sustituye a la tarjeta «Campos de lead» de la pestaña CRM y al botón
// «Guardar en el catálogo» del dashboard como sitio donde se decide qué se
// mide (auditoría del 2026-09-26). En orden de uso:
//
//   1. Preguntas medidas: cada pregunta activa, con sus respuestas. Se
//      renombran, se reordenan arrastrando, se unen, se apartan («Seleccione
//      una opción» → sin respuesta) y se agrupan en segmentos, todo en el sitio
//      y guardando al momento. Renombrar no rompe nada: la clave de cada
//      respuesta (la de `lf__<campo>__<resp>`) se conserva al guardar.
//   2. Preguntas detectadas sin medir: lo que llega en los leads o publica la
//      plataforma (Meta, GHL, WordPress) y aún no se mide. «Activar» crea el
//      campo YA listo en un clic.
//
// Cada respuesta activa es automáticamente una métrica en las pestañas y en
// los informes: no hace falta crear un segmento por respuesta.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertCircle,
  ArrowDownWideNarrow,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  GripVertical,
  Layers,
  ListChecks,
  Loader2,
  Merge,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LeadCampoEditorDialog } from '@/components/report-utm/LeadCampoEditorDialog';
import {
  bucketsAcumulados,
  type LeadCampoDef,
  type LeadSegmentoDef,
  type ClaveDetectada,
  type CampoValorCrudo,
} from '@/lib/report-utm/lead-campos';
import { resumirReferencias, type ReferenciaCampo } from '@/lib/report-utm/lead-campo-referencias';
import type { PreguntaUnificada } from '@/lib/leads/respuestas/catalogo';
import { respuestasSinClasificar } from '@/lib/leads/respuestas/catalogo';
import {
  anadirSinClasificar,
  apartarRespuesta,
  ordenAutomatico,
  recuperarValor,
  renombrarRespuesta,
  respuestasConConteo,
  unirRespuestas,
  valoresApartados,
} from '@/lib/leads/respuestas/edicion';

const nf = new Intl.NumberFormat('es-CO');

const FUENTE_LABEL: Record<string, string> = {
  meta: 'Meta',
  ghl: 'GHL',
  wordpress: 'Web',
  leads: 'Leads',
};

const TIPO_LABEL: Record<string, string> = {
  opcion: 'Desplegable',
  multiple: 'Selección múltiple',
  texto: 'Texto',
  numero: 'Número',
};

/** Lista de referencias para un `confirm()`, nombrando hasta cinco. */
function detalleReferencias(refs: ReferenciaCampo[]): string {
  if (refs.length === 0) return '\n\nAhora mismo no lo usa ningún informe ni pestaña.';
  const lista = refs.slice(0, 5).map((r) => `  · ${r.origen}: ${r.nombre} — ${r.motivo}`);
  if (refs.length > 5) lista.push(`  · …y ${refs.length - 5} más`);
  return `\n\nLo usan ${resumirReferencias(refs)}:\n${lista.join('\n')}`;
}

export function LeadsConfigCard({ clienteId }: { clienteId: string }) {
  const [campos, setCampos] = useState<LeadCampoDef[]>([]);
  const [segmentos, setSegmentos] = useState<LeadSegmentoDef[]>([]);
  const [referencias, setReferencias] = useState<Record<string, ReferenciaCampo[]>>({});
  const [preguntas, setPreguntas] = useState<PreguntaUnificada[]>([]);
  const [conPlataforma, setConPlataforma] = useState(false);
  const [leadsVistos, setLeadsVistos] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [verTexto, setVerTexto] = useState(false);
  const [avanzado, setAvanzado] = useState<Partial<LeadCampoDef> | null>(null);
  const [errorAvanzado, setErrorAvanzado] = useState<string | undefined>();

  const cargar = useCallback(
    async (opts?: { refrescar?: boolean }) => {
      setCargando(true);
      setError(null);
      try {
        const [rc, rs, rp] = await Promise.all([
          fetch(`/api/report-utm/lead-campos?cliente_id=${clienteId}&con_referencias=1`),
          fetch(`/api/report-utm/lead-campos/segmentos?cliente_id=${clienteId}`),
          fetch(
            `/api/report-utm/lead-preguntas?cliente_id=${clienteId}${opts?.refrescar ? '&refrescar=1' : ''}`
          ),
        ]);
        const jc = await rc.json().catch(() => ({}));
        const js = await rs.json().catch(() => ({}));
        const jp = await rp.json().catch(() => ({}));
        if (!rc.ok) throw new Error(jc?.error ?? 'No se pudieron leer las preguntas medidas.');
        setCampos(Array.isArray(jc.data) ? jc.data : []);
        setReferencias(jc.referencias ?? {});
        setSegmentos(Array.isArray(js.data) ? js.data : []);
        setPreguntas(Array.isArray(jp.data) ? jp.data : []);
        setConPlataforma(!!jp.conPlataforma);
        setLeadsVistos(Number(jp.leads ?? 0));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCargando(false);
      }
    },
    [clienteId]
  );

  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** Respuestas vistas en los leads para las claves de un campo. */
  const valoresDe = useCallback(
    (campo: Pick<LeadCampoDef, 'claves_origen'>): CampoValorCrudo[] => {
      const acc = new Map<string, CampoValorCrudo>();
      for (const p of preguntas) {
        if (!campo.claves_origen.includes(p.clave_norm)) continue;
        for (const v of p.valores) {
          const prev = acc.get(v.valor_crudo);
          if (prev) prev.filas += v.filas;
          else acc.set(v.valor_crudo, { ...v });
        }
      }
      return [...acc.values()].sort((a, b) => b.filas - a.filas);
    },
    [preguntas]
  );

  // ── Guardado ──────────────────────────────────────────────────────
  async function guardarCampo(campo: Partial<LeadCampoDef>, etiqueta = 'Guardado') {
    setOcupado(campo.id ?? 'nuevo');
    setError(null);
    // Optimista: la lista refleja el cambio ya; si falla, se recarga.
    if (campo.id)
      setCampos((prev) => prev.map((c) => (c.id === campo.id ? { ...c, ...campo } : c)));
    try {
      const res = await fetch('/api/report-utm/lead-campos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...campo, cliente_id: clienteId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'No se pudo guardar.');
      const renombres = (json?.data?.renombres ?? []) as [string, string][];
      setAviso(
        renombres.length > 0
          ? `${etiqueta}. ${renombres.length === 1 ? 'La respuesta renombrada conserva' : 'Las respuestas renombradas conservan'} su métrica: las tarjetas y segmentos que la usaban siguen funcionando.`
          : etiqueta
      );
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await cargar();
    } finally {
      setOcupado(null);
    }
  }

  async function activar(p: PreguntaUnificada) {
    setOcupado(`activar:${p.clave_norm}`);
    setError(null);
    try {
      const res = await fetch('/api/report-utm/lead-campos/activar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cliente_id: clienteId, claves_origen: [p.clave_norm] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'No se pudo activar.');
      setAviso(
        json?.data?.existente
          ? `«${p.nombre}» ya se medía en otro campo.`
          : `«${p.nombre}» activada: cada respuesta ya es una métrica en pestañas e informes.`
      );
      await cargar();
      if (json?.data?.id) setAbierto(json.data.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(null);
    }
  }

  async function unirACampo(p: PreguntaUnificada, campoId: string) {
    const campo = campos.find((c) => c.id === campoId);
    if (!campo) return;
    await guardarCampo(
      { ...campo, claves_origen: [...new Set([...campo.claves_origen, p.clave_norm])] },
      `«${p.nombre}» se suma a «${campo.nombre}»`
    );
  }

  async function alternarActivo(campo: LeadCampoDef) {
    if (
      campo.activo &&
      !confirm(
        `¿Dejar de medir «${campo.nombre}»? Sus respuestas dejan de ofrecerse como métrica y los bloques que la usan se quedan sin datos.` +
          detalleReferencias(referencias[campo.clave] ?? [])
      )
    )
      return;
    await guardarCampo(
      { ...campo, activo: !campo.activo },
      campo.activo ? 'Desactivada' : 'Activada'
    );
  }

  async function borrarCampo(campo: LeadCampoDef) {
    if (
      !confirm(
        `¿Borrar «${campo.nombre}»? Sus segmentos se borran con él.` +
          detalleReferencias(referencias[campo.clave] ?? [])
      )
    )
      return;
    const res = await fetch(`/api/report-utm/lead-campos?id=${campo.id}`, { method: 'DELETE' });
    if (!res.ok) setError('No se pudo borrar.');
    await cargar();
  }

  // ── Segmentos ─────────────────────────────────────────────────────
  async function guardarSegmento(seg: Partial<LeadSegmentoDef> & { campo_id: string }) {
    setOcupado(`seg:${seg.id ?? 'nuevo'}`);
    try {
      const res = await fetch('/api/report-utm/lead-campos/segmentos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...seg, cliente_id: clienteId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? 'No se pudo guardar el segmento.');
      setAviso('Segmento guardado');
      await cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOcupado(null);
    }
  }

  async function borrarSegmento(seg: LeadSegmentoDef) {
    if (!confirm(`¿Borrar el segmento «${seg.nombre}»?`)) return;
    let res = await fetch(`/api/report-utm/lead-campos/segmentos?id=${seg.id}`, {
      method: 'DELETE',
    });
    if (res.status === 409) {
      // Se usa en algún sitio: se enseña dónde y se pide confirmación explícita.
      const json = await res.json().catch(() => ({}));
      if (
        !confirm(
          `${json?.error ?? 'Se usa en otros sitios.'}${detalleReferencias(json?.referencias ?? [])}\n\n¿Borrarlo igualmente?`
        )
      )
        return;
      res = await fetch(`/api/report-utm/lead-campos/segmentos?id=${seg.id}&forzar=1`, {
        method: 'DELETE',
      });
    }
    if (!res.ok) setError('No se pudo borrar el segmento.');
    await cargar();
  }

  // ── Vistas derivadas ──────────────────────────────────────────────
  const clavesMedidas = useMemo(
    () => new Set(campos.filter((c) => c.activo).flatMap((c) => c.claves_origen)),
    [campos]
  );
  const sinMedir = useMemo(
    () => preguntas.filter((p) => !clavesMedidas.has(p.clave_norm) && (verTexto || p.es_opcion)),
    [preguntas, clavesMedidas, verTexto]
  );
  const ocultasTexto = useMemo(
    () => preguntas.filter((p) => !clavesMedidas.has(p.clave_norm) && !p.es_opcion).length,
    [preguntas, clavesMedidas]
  );
  const ordenados = useMemo(
    () => [...campos].sort((a, b) => Number(b.activo) - Number(a.activo) || a.orden - b.orden),
    [campos]
  );

  // El editor avanzado necesita las claves detectadas en su formato de siempre.
  const detectadasParaEditor: ClaveDetectada[] = useMemo(
    () =>
      preguntas.map((p) => ({
        clave: p.clave,
        clave_norm: p.clave_norm,
        leads: p.leads,
        distintos: p.distintos,
        es_opcion: p.es_opcion,
        formularios: p.formularios,
        valores: p.valores,
      })),
    [preguntas]
  );

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold text-foreground">Respuestas de formularios</h3>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Cada respuesta de una pregunta medida es una métrica en las pestañas y en los informes
            (leads, CPL, % del total), cruzable por campaña, conjunto y anuncio. Aquí se decide qué
            preguntas se miden y cómo se llaman sus respuestas.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void cargar({ refrescar: true })}
          disabled={cargando}
          className="h-7 text-xs gap-1 shrink-0"
          title="Volver a leer los leads en busca de preguntas y respuestas nuevas"
        >
          {cargando ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Actualizar
        </Button>
      </div>

      {error && (
        <p className="text-xs text-red-500 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </p>
      )}
      {aviso && !error && (
        <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
          <Sparkles className="w-3 h-3" /> {aviso}
          <button onClick={() => setAviso(null)} className="ml-1 opacity-60 hover:opacity-100">
            <X className="w-3 h-3" />
          </button>
        </p>
      )}

      {/* ── 1. Preguntas medidas ─────────────────────────────────────── */}
      <section className="space-y-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Preguntas medidas ({campos.filter((c) => c.activo).length})
        </h4>
        {!cargando && ordenados.length === 0 && (
          <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border p-4 text-center">
            Todavía no se mide ninguna pregunta. Activa una de las detectadas abajo.
          </p>
        )}
        {ordenados.map((campo) => (
          <CampoFila
            key={campo.id}
            campo={campo}
            abierto={abierto === campo.id}
            onAbrir={() => setAbierto(abierto === campo.id ? null : campo.id)}
            valores={valoresDe(campo)}
            segmentos={segmentos.filter((s) => s.campo_id === campo.id)}
            referencias={referencias[campo.clave] ?? []}
            preguntas={preguntas.filter((p) => campo.claves_origen.includes(p.clave_norm))}
            ocupado={ocupado === campo.id}
            onGuardar={(parche, etiqueta) => void guardarCampo({ ...campo, ...parche }, etiqueta)}
            onAlternar={() => void alternarActivo(campo)}
            onBorrar={() => void borrarCampo(campo)}
            onAvanzado={() => {
              setErrorAvanzado(undefined);
              setAvanzado(campo);
            }}
            onGuardarSegmento={(s) => void guardarSegmento({ ...s, campo_id: campo.id })}
            onBorrarSegmento={(s) => void borrarSegmento(s)}
          />
        ))}
      </section>

      {/* ── 2. Preguntas detectadas sin medir ────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-end justify-between gap-2">
          <div>
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Preguntas detectadas sin medir ({sinMedir.length})
            </h4>
            <p className="text-[11px] text-muted-foreground/80">
              {leadsVistos > 0 && `Sobre ${nf.format(leadsVistos)} leads del último año. `}
              {conPlataforma
                ? 'Incluye las preguntas y opciones que publican Meta, GHL y el plugin web.'
                : 'Detectadas en los leads. Las opciones de Meta, GHL y el plugin web aparecerán cuando se sincronicen sus formularios.'}
            </p>
          </div>
          {ocultasTexto > 0 && (
            <button
              onClick={() => setVerTexto((v) => !v)}
              className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 shrink-0"
            >
              {verTexto ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {verTexto ? 'Solo desplegables' : `Ver también texto libre (${ocultasTexto})`}
            </button>
          )}
        </div>
        {!cargando && sinMedir.length === 0 && (
          <p className="text-xs text-muted-foreground">No hay preguntas nuevas.</p>
        )}
        <div className="divide-y divide-border rounded-lg border border-border">
          {sinMedir.map((p) => (
            <div key={p.clave_norm} className="flex items-start gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm text-foreground">{p.nombre}</span>
                  {p.fuentes.map((f) => (
                    <span
                      key={f}
                      className="text-[9px] uppercase tracking-wide rounded px-1 py-0.5 bg-muted text-muted-foreground"
                    >
                      {FUENTE_LABEL[f] ?? f}
                    </span>
                  ))}
                  {p.tipo && (
                    <span className="text-[9px] uppercase tracking-wide text-sky-600 dark:text-sky-400">
                      {TIPO_LABEL[p.tipo] ?? p.tipo}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 break-words">
                  {nf.format(p.leads)} leads ·{' '}
                  {p.opciones.length > 0
                    ? `${p.opciones.length} opciones`
                    : `${p.distintos} respuestas distintas`}
                  {p.formularios.length > 0 && ` · ${p.formularios.slice(0, 3).join(', ')}`}
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5 break-words">
                  {(p.opciones.length > 0
                    ? p.opciones.map((o) => o.etiqueta || o.valor)
                    : p.valores.map((v) => v.valor_crudo)
                  )
                    .slice(0, 6)
                    .join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {campos.some((c) => c.activo) && (
                  <select
                    value=""
                    onChange={(e) => e.target.value && void unirACampo(p, e.target.value)}
                    className="h-7 text-[11px] rounded-md border border-input bg-background px-1.5 text-muted-foreground"
                    title="Es la misma pregunta que otra ya medida (p. ej. la versión web de una de Meta)"
                  >
                    <option value="">Es la misma que…</option>
                    {campos
                      .filter((c) => c.activo)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nombre}
                        </option>
                      ))}
                  </select>
                )}
                <Button
                  size="sm"
                  onClick={() => void activar(p)}
                  disabled={ocupado !== null}
                  className="h-7 text-xs gap-1"
                >
                  {ocupado === `activar:${p.clave_norm}` ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Plus className="w-3 h-3" />
                  )}
                  Medir
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      {avanzado && (
        <LeadCampoEditorDialog
          open
          campo={avanzado}
          detectadas={detectadasParaEditor}
          guardando={ocupado !== null}
          error={errorAvanzado}
          onClose={() => setAvanzado(null)}
          onGuardar={async (c) => {
            await guardarCampo(c, 'Guardado');
            setAvanzado(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Una pregunta medida ─────────────────────────────────────────────────────

function CampoFila({
  campo,
  abierto,
  onAbrir,
  valores,
  segmentos,
  referencias,
  preguntas,
  ocupado,
  onGuardar,
  onAlternar,
  onBorrar,
  onAvanzado,
  onGuardarSegmento,
  onBorrarSegmento,
}: {
  campo: LeadCampoDef;
  abierto: boolean;
  onAbrir: () => void;
  valores: CampoValorCrudo[];
  segmentos: LeadSegmentoDef[];
  referencias: ReferenciaCampo[];
  preguntas: PreguntaUnificada[];
  ocupado: boolean;
  onGuardar: (parche: Partial<LeadCampoDef>, etiqueta?: string) => void;
  onAlternar: () => void;
  onBorrar: () => void;
  onAvanzado: () => void;
  onGuardarSegmento: (s: Partial<LeadSegmentoDef>) => void;
  onBorrarSegmento: (s: LeadSegmentoDef) => void;
}) {
  const [nombre, setNombre] = useState(campo.nombre);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
  const [editando, setEditando] = useState<string | null>(null);
  const [nuevoSeg, setNuevoSeg] = useState<{ nombre: string; valores: Set<string> } | null>(null);

  const respuestas = useMemo(() => respuestasConConteo(campo, valores), [campo, valores]);
  const sinClasificar = useMemo(
    () => (campo.sin_mapear === 'crudo' ? [] : respuestasSinClasificar(campo, valores)),
    [campo, valores]
  );
  const crudasTalCual = useMemo(
    () => (campo.sin_mapear === 'crudo' ? respuestasSinClasificar(campo, valores) : []),
    [campo, valores]
  );
  const apartados = useMemo(() => valoresApartados(campo, valores), [campo, valores]);
  const total = respuestas.reduce((s, r) => s + r.leads, 0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const orden = respuestas.map((r) => r.etiqueta);
    const nuevo = arrayMove(
      orden,
      orden.indexOf(String(active.id)),
      orden.indexOf(String(over.id))
    );
    onGuardar({ valores_orden: nuevo }, 'Orden guardado');
  }

  const fuentes = [...new Set(preguntas.flatMap((p) => p.fuentes))];

  return (
    <div
      className={`rounded-lg border ${campo.activo ? 'border-border' : 'border-dashed border-border opacity-70'}`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onAbrir} className="text-muted-foreground hover:text-foreground">
          {abierto ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <input
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          onBlur={() =>
            nombre.trim() &&
            nombre.trim() !== campo.nombre &&
            onGuardar({ nombre: nombre.trim() }, 'Nombre guardado')
          }
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none focus:underline"
          title="Nombre de la pregunta en pestañas e informes (renombrarla no rompe nada)"
        />
        <span className="text-[11px] text-muted-foreground shrink-0">
          {respuestas.filter((r) => r.leads > 0).length} respuestas · {nf.format(total)} leads
        </span>
        {fuentes.map((f) => (
          <span
            key={f}
            className="text-[9px] uppercase tracking-wide rounded px-1 py-0.5 bg-muted text-muted-foreground shrink-0"
          >
            {FUENTE_LABEL[f] ?? f}
          </span>
        ))}
        {referencias.length > 0 && (
          <span
            className="text-[10px] text-muted-foreground shrink-0"
            title={referencias.map((r) => `${r.origen}: ${r.nombre}`).join('\n')}
          >
            en {resumirReferencias(referencias)}
          </span>
        )}
        {ocupado && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        <Button
          variant="ghost"
          size="sm"
          onClick={onAvanzado}
          className="h-6 w-6 p-0"
          title="Edición avanzada (agrupar valores a mano, claves de origen)"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onAlternar}
          className="h-6 w-6 p-0"
          title={campo.activo ? 'Dejar de medir' : 'Volver a medir'}
        >
          {campo.activo ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onBorrar}
          className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500"
          title="Borrar"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      {abierto && (
        <div className="border-t border-border px-3 py-3 space-y-3">
          {/* Barra de acciones sobre la selección */}
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] gap-1"
              disabled={seleccion.size < 2}
              onClick={() => {
                const n = prompt('Nombre de la respuesta unida:', [...seleccion][0]);
                if (!n?.trim()) return;
                onGuardar(unirRespuestas(campo, [...seleccion], n, valores), 'Respuestas unidas');
                setSeleccion(new Set());
              }}
              title="Junta varias respuestas en una (por ejemplo dos formas de escribir lo mismo)"
            >
              <Merge className="w-3 h-3" /> Unir {seleccion.size >= 2 ? `(${seleccion.size})` : ''}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] gap-1"
              onClick={() => onGuardar({ valores_orden: ordenAutomatico(campo) }, 'Ordenado')}
              title="Ordena los rangos numéricos de menor a mayor"
            >
              <ArrowDownWideNarrow className="w-3 h-3" /> Orden automático
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] gap-1"
              onClick={() => setNuevoSeg({ nombre: '', valores: new Set(seleccion) })}
              title="Un segmento suma varias respuestas bajo un nombre («Desde 2M»)"
            >
              <Layers className="w-3 h-3" /> Nuevo segmento
            </Button>
            <label className="flex items-center gap-1 text-muted-foreground ml-auto">
              <input
                type="checkbox"
                checked={campo.tipo === 'multiple'}
                onChange={(e) =>
                  onGuardar({ tipo: e.target.checked ? 'multiple' : 'opcion' }, 'Guardado')
                }
                className="accent-sky-500"
              />
              Se pueden elegir varias
            </label>
          </div>

          {/* Respuestas */}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={respuestas.map((r) => r.etiqueta)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-0.5">
                {respuestas.map((r) => (
                  <RespuestaFila
                    key={r.etiqueta}
                    etiqueta={r.etiqueta}
                    leads={r.leads}
                    pct={total > 0 ? (r.leads / total) * 100 : 0}
                    seleccionada={seleccion.has(r.etiqueta)}
                    editando={editando === r.etiqueta}
                    onSeleccionar={() =>
                      setSeleccion((prev) => {
                        const n = new Set(prev);
                        if (n.has(r.etiqueta)) n.delete(r.etiqueta);
                        else n.add(r.etiqueta);
                        return n;
                      })
                    }
                    onEditar={() => setEditando(r.etiqueta)}
                    onRenombrar={(nueva) => {
                      setEditando(null);
                      if (nueva.trim() && nueva.trim() !== r.etiqueta)
                        onGuardar(
                          renombrarRespuesta(campo, r.etiqueta, nueva),
                          'Respuesta renombrada'
                        );
                    }}
                    onApartar={() =>
                      onGuardar(
                        apartarRespuesta(campo, r.etiqueta, valores),
                        `«${r.etiqueta}» cuenta como sin respuesta`
                      )
                    }
                    onDesdeAqui={
                      (campo.valores_orden ?? []).includes(r.etiqueta)
                        ? () =>
                            onGuardarSegmento({
                              nombre: `Desde ${r.etiqueta}`,
                              operador: 'in',
                              valores: bucketsAcumulados(campo, r.etiqueta),
                            })
                        : undefined
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {(sinClasificar.length > 0 || crudasTalCual.length > 0) && (
            <div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <AlertCircle className="w-3 h-3 shrink-0" />
              <span className="flex-1">
                {sinClasificar.length + crudasTalCual.length} respuestas sin nombre propio (
                {[...sinClasificar, ...crudasTalCual]
                  .slice(0, 3)
                  .map((v) => v.valor_crudo)
                  .join(' · ')}
                {sinClasificar.length + crudasTalCual.length > 3 ? '…' : ''})
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px]"
                onClick={() =>
                  onGuardar(anadirSinClasificar(campo, valores), 'Respuestas añadidas')
                }
              >
                Añadir como respuestas
              </Button>
            </div>
          )}

          {apartados.length > 0 && (
            <div className="text-[11px] text-muted-foreground">
              <span className="font-medium">Cuentan como sin respuesta:</span>{' '}
              {apartados.map((v) => (
                <span key={v.valor_crudo} className="inline-flex items-center gap-0.5 mr-2">
                  {v.valor_crudo} ({nf.format(v.filas)})
                  <button
                    onClick={() => onGuardar(recuperarValor(campo, v.valor_crudo), 'Recuperada')}
                    title="Volver a contarla como respuesta"
                    className="hover:text-foreground"
                  >
                    <Undo2 className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Segmentos */}
          {(segmentos.length > 0 || nuevoSeg) && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Segmentos
              </p>
              {segmentos.map((s) => (
                <SegmentoFila
                  key={s.id}
                  seg={s}
                  respuestas={respuestas.map((r) => r.etiqueta)}
                  onGuardar={(parche) => onGuardarSegmento({ ...s, ...parche })}
                  onBorrar={() => onBorrarSegmento(s)}
                />
              ))}
              {nuevoSeg && (
                <div className="rounded-md border border-border p-2 space-y-1.5">
                  <Input
                    autoFocus
                    value={nuevoSeg.nombre}
                    onChange={(e) => setNuevoSeg({ ...nuevoSeg, nombre: e.target.value })}
                    placeholder="Nombre del segmento (p. ej. Desde 2M)"
                    className="h-7 text-xs"
                  />
                  <div className="flex flex-wrap gap-1">
                    {respuestas.map((r) => (
                      <label
                        key={r.etiqueta}
                        className="flex items-center gap-1 text-[11px] rounded border border-border px-1.5 py-0.5"
                      >
                        <input
                          type="checkbox"
                          checked={nuevoSeg.valores.has(r.etiqueta)}
                          onChange={() => {
                            const v = new Set(nuevoSeg.valores);
                            if (v.has(r.etiqueta)) v.delete(r.etiqueta);
                            else v.add(r.etiqueta);
                            setNuevoSeg({ ...nuevoSeg, valores: v });
                          }}
                        />
                        {r.etiqueta}
                      </label>
                    ))}
                  </div>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[11px]"
                      onClick={() => setNuevoSeg(null)}
                    >
                      Cancelar
                    </Button>
                    <Button
                      size="sm"
                      className="h-6 text-[11px]"
                      disabled={!nuevoSeg.nombre.trim() || nuevoSeg.valores.size === 0}
                      onClick={() => {
                        onGuardarSegmento({
                          nombre: nuevoSeg.nombre.trim(),
                          operador: 'in',
                          valores: [...nuevoSeg.valores],
                        });
                        setNuevoSeg(null);
                      }}
                    >
                      Crear segmento
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <p className="text-[10px] text-muted-foreground/70">
            Preguntas de origen: {campo.claves_origen.join(', ')}. Cada respuesta se usa en fórmulas
            y en los selectores de métricas con su nombre; no hace falta crear un segmento por
            respuesta.
          </p>
        </div>
      )}
    </div>
  );
}

function RespuestaFila({
  etiqueta,
  leads,
  pct,
  seleccionada,
  editando,
  onSeleccionar,
  onEditar,
  onRenombrar,
  onApartar,
  onDesdeAqui,
}: {
  etiqueta: string;
  leads: number;
  pct: number;
  seleccionada: boolean;
  editando: boolean;
  onSeleccionar: () => void;
  onEditar: () => void;
  onRenombrar: (nueva: string) => void;
  onApartar: () => void;
  onDesdeAqui?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: etiqueta,
  });
  const [valor, setValor] = useState(etiqueta);
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
      }}
      className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-muted/50"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-muted-foreground/50 hover:text-muted-foreground"
        title="Arrastra para reordenar"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <input
        type="checkbox"
        checked={seleccionada}
        onChange={onSeleccionar}
        className="accent-sky-500"
      />
      {editando ? (
        <input
          autoFocus
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          onBlur={() => onRenombrar(valor)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenombrar(valor);
            if (e.key === 'Escape') onRenombrar(etiqueta);
          }}
          className="min-w-0 flex-1 text-xs bg-background border border-input rounded px-1.5 py-0.5"
        />
      ) : (
        <button
          onClick={onEditar}
          className="min-w-0 flex-1 text-left text-xs text-foreground truncate"
          title="Clic para renombrar"
        >
          {etiqueta}
        </button>
      )}
      <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden shrink-0">
        <div
          className="h-full bg-sky-500 dark:bg-sky-400 rounded-full"
          style={{ width: `${Math.max(pct, leads > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className="text-[11px] tabular-nums text-muted-foreground w-10 text-right shrink-0">
        {pct.toFixed(0)}%
      </span>
      <span className="text-[11px] tabular-nums text-foreground w-14 text-right shrink-0">
        {nf.format(leads)}
      </span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 shrink-0">
        {onDesdeAqui && (
          <button
            onClick={onDesdeAqui}
            className="text-[10px] px-1 rounded hover:bg-accent text-muted-foreground"
            title="Crea el segmento «Desde esta respuesta en adelante»"
          >
            ≥
          </button>
        )}
        <button
          onClick={onApartar}
          className="text-[10px] px-1 rounded hover:bg-accent text-muted-foreground"
          title="Contarla como sin respuesta (p. ej. «Seleccione una opción»)"
        >
          Apartar
        </button>
      </div>
    </div>
  );
}

function SegmentoFila({
  seg,
  respuestas,
  onGuardar,
  onBorrar,
}: {
  seg: LeadSegmentoDef;
  respuestas: string[];
  onGuardar: (parche: Partial<LeadSegmentoDef>) => void;
  onBorrar: () => void;
}) {
  const [editando, setEditando] = useState(false);
  const [nombre, setNombre] = useState(seg.nombre);
  const [valores, setValores] = useState<Set<string>>(new Set(seg.valores));
  if (!editando) {
    return (
      <div className="flex items-center gap-2 text-[11px]">
        <Layers className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="font-medium text-foreground">{seg.nombre}</span>
        <span className="text-muted-foreground truncate">
          {seg.operador === 'not_in' ? 'todas menos ' : ''}
          {seg.valores.join(' · ')}
        </span>
        <button
          onClick={() => setEditando(true)}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          Editar
        </button>
        <button
          onClick={onBorrar}
          className="text-muted-foreground hover:text-red-500"
          title="Borrar segmento"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border p-2 space-y-1.5">
      <Input value={nombre} onChange={(e) => setNombre(e.target.value)} className="h-7 text-xs" />
      <div className="flex flex-wrap gap-1">
        {respuestas.map((r) => (
          <label
            key={r}
            className="flex items-center gap-1 text-[11px] rounded border border-border px-1.5 py-0.5"
          >
            <input
              type="checkbox"
              checked={valores.has(r)}
              onChange={() => {
                const v = new Set(valores);
                if (v.has(r)) v.delete(r);
                else v.add(r);
                setValores(v);
              }}
            />
            {r}
          </label>
        ))}
      </div>
      <div className="flex justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          className="h-6 text-[11px]"
          onClick={() => setEditando(false)}
        >
          Cancelar
        </Button>
        <Button
          size="sm"
          className="h-6 text-[11px]"
          disabled={!nombre.trim() || (seg.operador === 'in' && valores.size === 0)}
          onClick={() => {
            onGuardar({ nombre: nombre.trim(), valores: [...valores] });
            setEditando(false);
          }}
        >
          Guardar
        </Button>
      </div>
    </div>
  );
}
