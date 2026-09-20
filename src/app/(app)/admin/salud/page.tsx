'use client';

// Panel de salud de las fuentes de datos.
//
// El problema que resuelve: un informe con una fuente muerta no se ve roto, se
// ve vacío. Por eso una integración en error puede pasar siete semanas sin que
// nadie la reporte. Esta pantalla hace visible lo que no genera síntomas.
//
// Se ordena por gravedad y cada hallazgo lleva su acción: un panel que solo
// señala problemas sin decir qué hacer se deja de mirar a la semana.

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, AlertCircle } from 'lucide-react';

type Gravedad = 'critico' | 'aviso' | 'ok' | 'no_aplica';

interface Hallazgo {
  gravedad: Gravedad;
  ambito: string;
  titulo: string;
  accion?: string;
}
interface SaludCliente {
  clienteId: string;
  nombre: string;
  gravedad: Gravedad;
  hallazgos: Hallazgo[];
}
interface Resumen {
  criticos: number;
  avisos: number;
  ok: number;
}

const ESTILO: Record<
  Gravedad,
  { chip: string; borde: string; Icono: typeof AlertTriangle; texto: string }
> = {
  critico: {
    chip: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    borde: 'border-l-red-500',
    Icono: AlertTriangle,
    texto: 'Crítico',
  },
  aviso: {
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    borde: 'border-l-amber-500',
    Icono: AlertCircle,
    texto: 'Aviso',
  },
  ok: {
    chip: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    borde: 'border-l-emerald-500',
    Icono: CheckCircle2,
    texto: 'En orden',
  },
  no_aplica: {
    chip: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
    borde: 'border-l-neutral-400',
    Icono: CheckCircle2,
    texto: 'N/A',
  },
};

export default function SaludFuentesPage() {
  const [clientes, setClientes] = useState<SaludCliente[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const res = await fetch('/api/report-utm/salud-fuentes');
      if (!res.ok) throw new Error('No se pudo leer la salud de las fuentes.');
      const json = await res.json();
      setClientes(json.data?.clientes ?? []);
      setResumen(json.data?.resumen ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error inesperado.');
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Salud de las fuentes</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Un informe con una fuente muerta no se ve roto: se ve vacío. Aquí sale lo que no genera
            síntomas — integraciones caídas, fuentes paradas y cruces degradados.
          </p>
        </div>
        <button
          onClick={() => void cargar()}
          disabled={cargando}
          className="shrink-0 inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm
                               hover:bg-accent disabled:opacity-50 focus-visible:outline-none
                               focus-visible:ring-2 focus-visible:ring-ring"
        >
          {cargando ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden />
          )}
          Actualizar
        </button>
      </header>

      {resumen && (
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ['critico', resumen.criticos, 'Con algo crítico'],
              ['aviso', resumen.avisos, 'Con avisos'],
              ['ok', resumen.ok, 'En orden'],
            ] as const
          ).map(([g, n, label]) => (
            <div key={g} className="rounded-lg border p-4">
              <div className="text-2xl font-semibold tabular-nums">{n}</div>
              <div className="text-xs text-muted-foreground mt-1">{label}</div>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 p-4 text-sm">
          {error}
        </div>
      )}

      {cargando && clientes.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Comprobando todas las fuentes de todos los clientes…
        </div>
      )}

      <div className="space-y-3">
        {clientes.map((c) => {
          const est = ESTILO[c.gravedad];
          return (
            <section key={c.clienteId} className={`rounded-lg border border-l-4 ${est.borde} p-4`}>
              <div className="flex items-center gap-3">
                <est.Icono className="h-4 w-4 shrink-0" aria-hidden />
                <h2 className="font-medium flex-1">{c.nombre}</h2>
                <span className={`text-xs px-2 py-0.5 rounded ${est.chip}`}>{est.texto}</span>
              </div>

              {c.hallazgos.length === 0 ? (
                <p className="text-sm text-muted-foreground mt-2 pl-7">
                  Todas las fuentes configuradas están entregando.
                </p>
              ) : (
                <ul className="mt-3 pl-7 space-y-3">
                  {c.hallazgos.map((h, i) => (
                    <li key={i} className="text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span
                          className={`text-[11px] px-1.5 py-0.5 rounded ${ESTILO[h.gravedad].chip}`}
                        >
                          {h.ambito}
                        </span>
                        <span>{h.titulo}</span>
                      </div>
                      {h.accion && (
                        <p className="text-xs text-muted-foreground mt-1">→ {h.accion}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
