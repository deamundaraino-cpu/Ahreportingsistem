'use client';

import { useState, useTransition } from 'react';
import { Filter, Check, Eye, Play, AlertTriangle, Loader2 } from 'lucide-react';
import type { ReglaExclusion } from '@/lib/report-utm/lead-exclusion';
import { MOTIVOS_EXCLUSION } from '@/lib/report-utm/lead-exclusion';
import type { ResultadoReclasificacion } from '@/lib/report-utm/lead-exclusion-db';
import {
  guardarReglaExclusionAction,
  reclasificarLeadsAction,
} from '@/app/(report-utm)/report-utm/leads/_actions';

function aLista(texto: string): string[] {
  return texto
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Regla de exclusión del cliente: qué leads NO cuentan en los informes.
 *
 * Nace de la reunión del 2026-09-08: en Cris Tributario entraban como leads los
 * contactos de WhatsApp directo y del perfil de Instagram, sin ninguna UTM, y
 * hundían el CPL. Los leads excluidos se guardan igual —se pueden ver y
 * re-incluir desde Leads—; simplemente no suman.
 */
export function FiltroAtribucionCard({
  clienteId,
  inicial,
  migracionAplicada,
}: {
  clienteId: string;
  inicial: ReglaExclusion;
  migracionAplicada: boolean;
}) {
  const [activa, setActiva] = useState(inicial.activa);
  const [exigir, setExigir] = useState(inicial.exigir_atribucion);
  const [sources, setSources] = useState(inicial.excluir_sources.join(', '));
  const [formularios, setFormularios] = useState(inicial.excluir_formularios.join(', '));
  const [guardando, startGuardar] = useTransition();
  const [trabajando, startTrabajo] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);
  const [resultado, setResultado] = useState<ResultadoReclasificacion | null>(null);

  const regla: ReglaExclusion = {
    activa,
    exigir_atribucion: exigir,
    excluir_sources: aLista(sources),
    excluir_formularios: aLista(formularios),
  };

  function guardar() {
    setError(null);
    setGuardado(false);
    setResultado(null);
    startGuardar(async () => {
      const r = await guardarReglaExclusionAction(clienteId, regla);
      if (!r.ok) setError(r.error ?? 'No se pudo guardar.');
      else setGuardado(true);
    });
  }

  function reclasificar(aplicar: boolean) {
    setError(null);
    startTrabajo(async () => {
      // Siempre sobre la regla GUARDADA: se guarda primero para que la
      // previsualización no mienta sobre lo que hará el botón de aplicar.
      const g = await guardarReglaExclusionAction(clienteId, regla);
      if (!g.ok) {
        setError(g.error ?? 'No se pudo guardar la regla.');
        return;
      }
      const r = await reclasificarLeadsAction(clienteId, aplicar);
      if (!r.ok) setError(r.error ?? 'No se pudo reclasificar.');
      else setResultado(r.resultado ?? null);
    });
  }

  const totalExcluir = resultado
    ? Object.values(resultado.aExcluir).reduce((s, n) => s + (n ?? 0), 0)
    : 0;

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-emerald-500" />
            <h2 className="text-sm font-semibold text-foreground">Qué leads cuentan</h2>
          </div>
          <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
            Los leads que esta regla deja fuera se guardan igual —se ven en Leads y se pueden
            re-incluir—, pero no suman en el conteo, el CPL ni los informes.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium text-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={activa}
            onChange={(e) => setActiva(e.target.checked)}
            className="accent-emerald-500"
          />
          Regla activa
        </label>
      </div>

      {!migracionAplicada && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          La regla se puede guardar, pero no se aplica hasta que se instale la migración 079 en la
          base. Hasta entonces todos los leads siguen contando.
        </div>
      )}

      <div className={`space-y-3 ${activa ? '' : 'opacity-50'}`}>
        <label className="flex items-start gap-2 text-xs text-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={exigir}
            onChange={(e) => setExigir(e.target.checked)}
            className="accent-emerald-500 mt-0.5"
            disabled={!activa}
          />
          <span>
            <span className="font-medium">Exigir atribución publicitaria</span>
            <span className="block text-muted-foreground text-[11px]">
              Fuera los leads sin ninguna UTM de campaña, anuncio o conjunto ni click id: WhatsApp
              directo, perfil de Instagram, contactos creados a mano en el CRM.
            </span>
          </span>
        </label>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Excluir estas fuentes (utm_source exacto)
            </label>
            <input
              value={sources}
              onChange={(e) => setSources(e.target.value)}
              disabled={!activa}
              placeholder="whatsapp, messenger"
              className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Excluir orígenes que contengan (formulario / fuente GHL)
            </label>
            <input
              value={formularios}
              onChange={(e) => setFormularios(e.target.value)}
              disabled={!activa}
              placeholder="chat widget, importación"
              className="w-full px-3 py-2 text-xs rounded-lg bg-muted border border-border text-foreground"
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          onClick={guardar}
          disabled={guardando || trabajando}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white nav-active-emerald disabled:opacity-40"
        >
          {guardando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Guardar regla
        </button>
        <button
          onClick={() => reclasificar(false)}
          disabled={!migracionAplicada || guardando || trabajando}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border text-foreground hover:bg-accent disabled:opacity-40"
        >
          {trabajando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
          Previsualizar sobre el histórico
        </button>
        {resultado && !resultado.aplicado && (totalExcluir > 0 || resultado.aReincluir > 0) && (
          <button
            onClick={() => reclasificar(true)}
            disabled={trabajando}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-40"
          >
            <Play className="h-3 w-3" /> Aplicar al histórico
          </button>
        )}
        {guardado && <span className="text-[11px] text-emerald-600">Regla guardada.</span>}
      </div>

      {resultado && (
        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-[11px] text-foreground space-y-1">
          <p className="font-medium">
            {resultado.aplicado ? 'Aplicado' : 'Previsualización'} sobre{' '}
            {resultado.revisados.toLocaleString()} leads decididos automáticamente:
          </p>
          {Object.entries(resultado.aExcluir).map(([m, n]) => (
            <p key={m}>
              · {n?.toLocaleString()} {resultado.aplicado ? 'excluidos' : 'se excluirían'} —{' '}
              {MOTIVOS_EXCLUSION[m as keyof typeof MOTIVOS_EXCLUSION] ?? m}
            </p>
          ))}
          {resultado.aReincluir > 0 && (
            <p>
              · {resultado.aReincluir.toLocaleString()}{' '}
              {resultado.aplicado ? 'vuelven a contar' : 'volverían a contar'}
            </p>
          )}
          {resultado.yaExcluidos > 0 && (
            <p className="text-muted-foreground">
              · {resultado.yaExcluidos.toLocaleString()} ya estaban excluidos
            </p>
          )}
          {totalExcluir === 0 && resultado.aReincluir === 0 && (
            <p className="text-muted-foreground">Nada que cambiar.</p>
          )}
          <p className="text-muted-foreground">
            Los leads que alguien excluyó o re-incluyó a mano no se tocan.
          </p>
        </div>
      )}

      {error && <p className="text-[11px] text-red-500">{error}</p>}
    </div>
  );
}
