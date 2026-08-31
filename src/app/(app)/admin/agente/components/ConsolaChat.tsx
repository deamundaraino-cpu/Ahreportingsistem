'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Send, Plus, Trash2, Loader2, Wrench, Check, X, ChevronDown } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  listarConversaciones,
  leerConversacion,
  borrarConversacion,
  type ConversacionResumen,
} from '../_actions';

type Props = {
  conversacionesIniciales: ConversacionResumen[];
  clientes: { id: string; nombre: string }[];
  puedeResponder: boolean;
};

type Burbuja =
  | { tipo: 'usuario'; texto: string; id: string }
  | { tipo: 'agente'; texto: string; id: string; modelo?: string | null; coste?: number | null }
  | { tipo: 'paso'; nombre: string; ok: boolean; ms: number; id: string };

const SIN_CLIENTE = '__ninguno__';
/** Cada cuánto se pregunta por pasos nuevos mientras hay una respuesta en vuelo. */
const MS_SONDEO = 800;

function formatearCoste(usd: number | null | undefined): string | null {
  if (!usd || usd <= 0) return null;
  return usd < 0.01 ? '<$0.01' : '$' + usd.toFixed(3);
}

export function ConsolaChat({ conversacionesIniciales, clientes, puedeResponder }: Props) {
  const [conversaciones, setConversaciones] = useState(conversacionesIniciales);
  const [activa, setActiva] = useState<string | null>(null);
  const [burbujas, setBurbujas] = useState<Burbuja[]>([]);
  const [entrada, setEntrada] = useState('');
  const [clienteId, setClienteId] = useState<string>(SIN_CLIENTE);
  const [enviando, setEnviando] = useState(false);
  const [cargando, setCargando] = useState(false);

  const finRef = useRef<HTMLDivElement>(null);
  // El sondeo se para desde el `finally` del envío pase lo que pase: si se
  // quedara vivo, seguiría consultando para siempre en segundo plano.
  const sondeoRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    finRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [burbujas]);

  useEffect(() => {
    return () => {
      if (sondeoRef.current) clearInterval(sondeoRef.current);
    };
  }, []);

  const abrir = useCallback(async (id: string) => {
    setActiva(id);
    setCargando(true);
    try {
      const mensajes = await leerConversacion(id);
      setBurbujas(
        mensajes.map((m): Burbuja => {
          if (m.role === 'user') {
            return { tipo: 'usuario', texto: String(m.content ?? ''), id: m.id };
          }
          if (m.role === 'tool') {
            const meta = (m.tool_calls ?? {}) as { nombre?: string; ok?: boolean; ms?: number };
            return {
              tipo: 'paso',
              nombre: meta.nombre ?? String(m.content ?? ''),
              ok: meta.ok ?? true,
              ms: meta.ms ?? 0,
              id: m.id,
            };
          }
          return {
            tipo: 'agente',
            texto: String(m.content ?? ''),
            id: m.id,
            modelo: m.model_used,
            coste: m.cost_usd,
          };
        })
      );
    } finally {
      setCargando(false);
    }
  }, []);

  function nueva() {
    setActiva(null);
    setBurbujas([]);
    setEntrada('');
  }

  async function eliminar(id: string) {
    if (!window.confirm('¿Borrar esta conversación?')) return;
    const res = await borrarConversacion(id);
    if ('error' in res) {
      toast.error(res.error);
      return;
    }
    setConversaciones((prev) => prev.filter((c) => c.id !== id));
    if (activa === id) nueva();
    toast.success('Conversación borrada');
  }

  /**
   * Sondea los mensajes nuevos mientras el agente trabaja.
   *
   * Solo corre durante los segundos que dura una respuesta: en reposo no
   * consulta nada. Se eligió esto y no Supabase Realtime porque aquello exige
   * que `agent_messages` esté en la publicación de la base, y esto funciona
   * siempre.
   */
  function arrancarSondeo(conversationId: string, desde: string) {
    let ultimo = desde;
    sondeoRef.current = setInterval(async () => {
      try {
        const r = await fetch(
          `/api/agent/chat?conversation_id=${conversationId}&desde=${encodeURIComponent(ultimo)}`
        );
        if (!r.ok) return;
        const { mensajes } = (await r.json()) as {
          mensajes: {
            id: string;
            role: string;
            content: unknown;
            tool_calls: unknown;
            created_at: string;
          }[];
        };
        for (const m of mensajes) {
          ultimo = m.created_at;
          if (m.role !== 'tool') continue;
          const meta = (m.tool_calls ?? {}) as { nombre?: string; ok?: boolean; ms?: number };
          setBurbujas((prev) =>
            prev.some((b) => b.id === m.id)
              ? prev
              : [
                  ...prev,
                  {
                    tipo: 'paso',
                    nombre: meta.nombre ?? 'herramienta',
                    ok: meta.ok ?? true,
                    ms: meta.ms ?? 0,
                    id: m.id,
                  },
                ]
          );
        }
      } catch {
        // Un sondeo fallido no es motivo de nada: al siguiente lo intenta otra vez.
      }
    }, MS_SONDEO);
  }

  function pararSondeo() {
    if (sondeoRef.current) {
      clearInterval(sondeoRef.current);
      sondeoRef.current = null;
    }
  }

  async function enviar() {
    const texto = entrada.trim();
    if (!texto || enviando) return;

    if (!puedeResponder) {
      toast.error('Falta la clave de OpenRouter: el agente no puede responder todavía.');
      return;
    }

    setEnviando(true);
    setEntrada('');
    setBurbujas((prev) => [...prev, { tipo: 'usuario', texto, id: 'tmp-' + Date.now() }]);

    const desde = new Date().toISOString();

    try {
      const cuerpo: Record<string, unknown> = { mensaje: texto };
      if (activa) cuerpo.conversation_id = activa;
      if (clienteId !== SIN_CLIENTE) cuerpo.client_id = clienteId;

      const peticion = fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });

      // El sondeo necesita el id, que en una conversación nueva llega con la
      // respuesta. Por eso solo se arranca cuando ya se tiene.
      if (activa) arrancarSondeo(activa, desde);

      const r = await peticion;
      const j = await r.json();

      if (!r.ok) {
        throw new Error(j?.error?.message ?? 'No se pudo enviar el mensaje.');
      }

      pararSondeo();

      if (!activa) {
        setActiva(j.conversation_id);
        setConversaciones(await listarConversaciones());
      }

      const meta = j.meta as {
        herramientas?: { nombre: string; ok: boolean; ms: number }[];
        modelos?: string[];
        coste_usd?: number;
        truncado?: boolean;
      };

      setBurbujas((prev) => {
        // Los pasos que el sondeo no llegó a ver se añaden ahora, para que el
        // detalle quede completo aunque la respuesta haya sido muy rápida.
        const yaVistos = new Set(prev.filter((b) => b.tipo === 'paso').map((b) => b.nombre));
        const faltan = (meta?.herramientas ?? [])
          .filter((h) => !yaVistos.has(h.nombre))
          .map((h, i): Burbuja => ({
            tipo: 'paso',
            nombre: h.nombre,
            ok: h.ok,
            ms: h.ms,
            id: `post-${Date.now()}-${i}`,
          }));

        return [
          ...prev,
          ...faltan,
          {
            tipo: 'agente',
            texto: j.respuesta,
            id: 'resp-' + Date.now(),
            modelo: meta?.modelos?.[meta.modelos.length - 1],
            coste: meta?.coste_usd,
          },
        ];
      });

      if (meta?.truncado) {
        toast.warning('El agente llegó al límite de pasos y cerró con lo que tenía.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error al hablar con el agente.');
      setBurbujas((prev) => prev.filter((b) => !b.id.startsWith('tmp-')));
      setEntrada(texto);
    } finally {
      // Siempre: un sondeo huérfano seguiría consultando indefinidamente.
      pararSondeo();
      setEnviando(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
      {/* Conversaciones */}
      <div className="border-border bg-card overflow-hidden rounded-xl border">
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-medium">Conversaciones</span>
          <Button variant="outline" size="sm" className="h-8" onClick={nueva}>
            <Plus className="h-3.5 w-3.5" /> Nueva
          </Button>
        </div>
        <div className="divide-border max-h-[calc(100vh-320px)] divide-y overflow-y-auto">
          {conversaciones.length === 0 && (
            <p className="text-muted-foreground/70 px-4 py-6 text-center text-sm">
              Todavía no hay ninguna.
            </p>
          )}
          {conversaciones.map((c) => (
            <div
              key={c.id}
              className={cn(
                'hover:bg-accent group flex items-center gap-2 px-3 py-2.5 transition-colors',
                activa === c.id && 'bg-brand-blue/5'
              )}
            >
              <button
                type="button"
                onClick={() => abrir(c.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-sm">{c.titulo ?? 'Sin título'}</p>
                <p className="text-muted-foreground/70 text-xs">
                  {new Date(c.last_activity_at).toLocaleString('es-CO', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  {c.channel === 'whatsapp' && ' · WhatsApp'}
                </p>
              </button>
              <button
                type="button"
                onClick={() => eliminar(c.id)}
                className="text-muted-foreground/50 hover:text-destructive opacity-0 transition-opacity group-hover:opacity-100"
                aria-label="Borrar conversación"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Hilo */}
      <Card className="bg-card border-border flex h-[calc(100vh-300px)] flex-col overflow-hidden py-0">
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {cargando && (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
            </div>
          )}

          {!cargando && burbujas.length === 0 && (
            <div className="text-muted-foreground/70 flex h-full flex-col items-center justify-center gap-2 text-center text-sm">
              <p>Pregúntale por un cliente.</p>
              <p className="text-xs">
                Por ejemplo: «¿cómo va Goodprop este mes?» o «compárame la última semana».
              </p>
            </div>
          )}

          {burbujas.map((b) => {
            if (b.tipo === 'paso') {
              return (
                <div
                  key={b.id}
                  className="text-muted-foreground/70 flex items-center gap-2 pl-1 text-xs"
                >
                  {b.ok ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <X className="text-destructive h-3 w-3" />
                  )}
                  <Wrench className="h-3 w-3" />
                  <span className="font-mono">{b.nombre}</span>
                  {b.ms > 0 && <span>{b.ms} ms</span>}
                </div>
              );
            }

            if (b.tipo === 'usuario') {
              return (
                <div key={b.id} className="flex justify-end">
                  <div className="bg-brand-blue/10 max-w-[80%] rounded-xl px-3.5 py-2 text-sm whitespace-pre-wrap">
                    {b.texto}
                  </div>
                </div>
              );
            }

            const coste = formatearCoste(b.coste);
            return (
              <div key={b.id} className="space-y-1">
                <div className="bg-muted/40 max-w-[85%] rounded-xl px-3.5 py-2 text-sm whitespace-pre-wrap">
                  {b.texto}
                </div>
                {(b.modelo || coste) && (
                  <p className="text-muted-foreground/50 pl-1 text-[11px]">
                    {/* El modelo se muestra a propósito: con una cadena de reserva,
                        un salto silencioso a uno peor explicaría una respuesta mala. */}
                    {b.modelo}
                    {coste && ` · ${coste}`}
                  </p>
                )}
              </div>
            );
          })}

          {enviando && (
            <div className="text-muted-foreground flex items-center gap-2 pl-1 text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Pensando…
            </div>
          )}

          <div ref={finRef} />
        </div>

        {/* Entrada */}
        <div className="border-border space-y-2 border-t p-3">
          <div className="flex items-center gap-2">
            <Select value={clienteId} onValueChange={setClienteId}>
              <SelectTrigger className="bg-background border-input h-8 w-[220px] text-xs">
                <SelectValue placeholder="Sin cliente" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border">
                <SelectItem value={SIN_CLIENTE}>Sin cliente concreto</SelectItem>
                {clientes.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.nombre}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {clienteId !== SIN_CLIENTE && (
              <span className="text-muted-foreground/70 flex items-center gap-1 text-[11px]">
                <ChevronDown className="h-3 w-3" />
                Se le pasa el perfil y la estrategia de este cliente
              </span>
            )}
          </div>

          <div className="flex items-end gap-2">
            <Textarea
              value={entrada}
              onChange={(e) => setEntrada(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void enviar();
                }
              }}
              placeholder={
                puedeResponder
                  ? 'Escribe tu pregunta…  (Enter envía, Mayús+Enter salta de línea)'
                  : 'Falta configurar la clave de OpenRouter'
              }
              disabled={!puedeResponder || enviando}
              className="bg-background max-h-40 min-h-[42px] resize-none"
              rows={1}
            />
            <Button
              onClick={() => void enviar()}
              disabled={!puedeResponder || enviando || !entrada.trim()}
              className="h-[42px] bg-blue-600 font-medium text-white hover:bg-blue-500"
            >
              {enviando ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
