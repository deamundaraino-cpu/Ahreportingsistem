'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle, MinusCircle, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Pestana } from '@/lib/clientes/config-pestanas';
import type { PasoPuestaEnMarcha } from '@/lib/clientes/puesta-en-marcha';
import { marcarPasoPuestaEnMarcha } from '../_actions';

/**
 * Lista de lo que le falta al cliente para reportar bien, arriba de su ficha.
 * Cada paso lleva a su pestaña (sin navegar) o a la página donde se configura.
 * Se pliega sola cuando todo está hecho o marcado «No aplica».
 */
export function PuestaEnMarchaCard({
  clienteId,
  pasos,
  onIrA,
}: {
  clienteId: string;
  pasos: PasoPuestaEnMarcha[];
  onIrA: (pestana: Pestana) => void;
}) {
  const router = useRouter();
  const [pendiente, startTransition] = useTransition();
  const [enCurso, setEnCurso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resueltos = pasos.filter((p) => p.estado !== 'pendiente').length;
  const completa = resueltos === pasos.length;
  const [abierta, setAbierta] = useState(!completa);
  const obligatoriosPendientes = pasos.filter((p) => !p.opcional && p.estado === 'pendiente');

  function omitir(clave: string, valor: boolean) {
    setError(null);
    setEnCurso(clave);
    startTransition(async () => {
      const r = await marcarPasoPuestaEnMarcha(clienteId, clave, valor);
      setEnCurso(null);
      if (r.error) setError(r.error);
      else router.refresh();
    });
  }

  return (
    <Card className="bg-card border-border mb-6">
      <CardHeader className="pb-3">
        <button
          type="button"
          onClick={() => setAbierta((v) => !v)}
          className="flex w-full items-start justify-between gap-4 text-left"
        >
          <div className="min-w-0">
            <CardTitle className="text-base">
              Puesta en marcha · {resueltos} de {pasos.length}
            </CardTitle>
            <CardDescription>
              {completa
                ? 'Todo listo: cada canal está conectado o marcado «No aplica».'
                : obligatoriosPendientes.length > 0
                  ? `Imprescindible: ${obligatoriosPendientes.map((p) => p.titulo.toLowerCase()).join(', ')}.`
                  : 'Lo imprescindible está hecho; completa o descarta el resto.'}
            </CardDescription>
          </div>
          {abierta ? (
            <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>
        <div className="mt-3 h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${(resueltos / Math.max(pasos.length, 1)) * 100}%` }}
          />
        </div>
      </CardHeader>

      {abierta && (
        <CardContent className="pt-0">
          <ul className="divide-y divide-border">
            {pasos.map((p) => (
              <li key={p.clave} className="flex items-start gap-3 py-2.5">
                <Icono estado={p.estado} />
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm ${p.estado === 'pendiente' ? 'text-foreground' : 'text-muted-foreground'}`}
                  >
                    {p.titulo}
                    {!p.opcional && (
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        Imprescindible
                      </span>
                    )}
                  </p>
                  {p.estado === 'pendiente' && (
                    <p className="text-xs text-muted-foreground">{p.ayuda}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {p.estado === 'pendiente' &&
                    ('pestana' in p.destino ? (
                      <button
                        type="button"
                        onClick={() => 'pestana' in p.destino && onIrA(p.destino.pestana)}
                        className="text-xs px-2 py-1 rounded hover:bg-accent text-indigo-600 dark:text-indigo-400"
                      >
                        Configurar
                      </button>
                    ) : (
                      <Link
                        href={p.destino.href}
                        className="text-xs px-2 py-1 rounded hover:bg-accent text-indigo-600 dark:text-indigo-400"
                      >
                        Configurar
                      </Link>
                    ))}
                  {p.opcional && p.estado !== 'hecho' && (
                    <button
                      type="button"
                      disabled={pendiente}
                      onClick={() => omitir(p.clave, p.estado === 'pendiente')}
                      className="text-xs px-2 py-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-40"
                    >
                      {enCurso === p.clave ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : p.estado === 'omitido' ? (
                        'Sí aplica'
                      ) : (
                        'No aplica'
                      )}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
        </CardContent>
      )}
    </Card>
  );
}

function Icono({ estado }: { estado: PasoPuestaEnMarcha['estado'] }) {
  if (estado === 'hecho') {
    return (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
    );
  }
  if (estado === 'omitido') {
    return <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" />;
  }
  return <Circle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />;
}
