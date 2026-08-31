'use client';

/**
 * Perfil del cliente para el agente.
 *
 * Es la sección que evita el análisis que motivó todo esto: sin ella, una
 * lectura automática de un cliente que solo capta leads concluye que "faltan los
 * datos de ventas y de Google Analytics" y que "es imposible calcular el ROAS".
 * Todo cierto y todo irrelevante, porque ese cliente nunca tuvo esas fuentes.
 *
 * Se autogestiona igual que `SheetCamposSection`: recibe solo `clienteId`, hace
 * su propio fetch y su propio guardado. No toca el estado `config` de
 * `ClientConfigForm` ni depende del botón "Guardar Todo" — el perfil vive en su
 * propia tabla.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Brain, Loader2, Save, Info, EyeOff } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  leerPerfilIA,
  guardarPerfilIA,
  desactivarFeedback,
  type PerfilIA,
} from '../../_actions-perfil-ia';

/** Fuentes que la plataforma sabe integrar. Conjunto cerrado a propósito. */
const FUENTES = [
  { clave: 'meta', label: 'Meta Ads' },
  { clave: 'tiktok', label: 'TikTok Ads' },
  { clave: 'ga4', label: 'Google Analytics' },
  { clave: 'hotmart', label: 'Hotmart' },
  { clave: 'sheets', label: 'Google Sheets' },
] as const;

export function PerfilIASection({ clienteId }: { clienteId: string }) {
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [perfil, setPerfil] = useState<PerfilIA | null>(null);

  const [descripcion, setDescripcion] = useState('');
  const [productos, setProductos] = useState('');
  const [alcance, setAlcance] = useState('');
  const [instrucciones, setInstrucciones] = useState('');
  const [activas, setActivas] = useState<string[]>([]);
  const [ausentes, setAusentes] = useState<string[]>([]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const p = await leerPerfilIA(clienteId);
      setPerfil(p);
      setDescripcion(p.descripcion ?? '');
      setProductos(p.productos ?? '');
      setAlcance(p.alcance_medicion ?? '');
      setInstrucciones(p.instrucciones ?? '');
      // Si el perfil está vacío se parte de lo deducido de las integraciones:
      // rellenarlo es confirmar, no escribir desde cero.
      setActivas(p.fuentes_activas.length ? p.fuentes_activas : p.deducidas_activas);
      setAusentes(p.fuentes_ausentes.length ? p.fuentes_ausentes : p.deducidas_ausentes);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar el perfil.');
    } finally {
      setCargando(false);
    }
  }, [clienteId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function alternar(lista: string[], set: (v: string[]) => void, clave: string) {
    set(lista.includes(clave) ? lista.filter((x) => x !== clave) : [...lista, clave]);
  }

  async function guardar() {
    setGuardando(true);
    try {
      const res = await guardarPerfilIA(clienteId, {
        descripcion: descripcion.trim() || null,
        productos: productos.trim() || null,
        alcance_medicion: alcance.trim() || null,
        instrucciones: instrucciones.trim() || null,
        fuentes_activas: activas,
        fuentes_ausentes: ausentes,
      });
      if ('error' in res) throw new Error(res.error);
      await cargar();
      toast.success('Perfil guardado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  async function silenciar(id: string) {
    const res = await desactivarFeedback(id);
    if ('error' in res) {
      toast.error(res.error);
      return;
    }
    setPerfil((p) => (p ? { ...p, feedback: p.feedback.filter((f) => f.id !== id) } : p));
    toast.success('Nota desactivada');
  }

  return (
    <Card className="bg-card border-violet-500/30">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-violet-500/10 p-2">
            <Brain className="h-5 w-5 text-violet-500" />
          </div>
          <div>
            <CardTitle>Perfil para el agente</CardTitle>
            <CardDescription>
              Lo que el agente necesita saber de este cliente antes de interpretar sus cifras.
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {cargando ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : (
          <>
            {!perfil?.configurado && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p className="text-muted-foreground text-xs">
                  Todavía sin configurar. Las fuentes de abajo están deducidas de las integraciones
                  conectadas; revísalas y guarda para confirmarlas.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Qué hace este cliente</Label>
              <Textarea
                value={descripcion}
                onChange={(e) => setDescripcion(e.target.value)}
                rows={2}
                placeholder="Ej.: captación de leads inmobiliarios. No vende por la plataforma."
                className="bg-background border-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Productos o servicios</Label>
              <Textarea
                value={productos}
                onChange={(e) => setProductos(e.target.value)}
                rows={2}
                placeholder="Las líneas que trabaja, si son varias."
                className="bg-background border-input"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Hasta dónde llega la medición</Label>
              <Textarea
                value={alcance}
                onChange={(e) => setAlcance(e.target.value)}
                rows={2}
                placeholder="Ej.: la medición llega hasta el lead. Las ventas las reporta el cliente aparte."
                className="bg-background border-input"
              />
              <p className="text-muted-foreground/70 text-xs">
                Es el campo que más cambia la calidad del análisis.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-emerald-600 dark:text-emerald-400">
                  Fuentes que SÍ tiene
                </Label>
                <div className="space-y-1.5">
                  {FUENTES.map((f) => (
                    <label key={f.clave} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={activas.includes(f.clave)}
                        onCheckedChange={() => alternar(activas, setActivas, f.clave)}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-amber-600 dark:text-amber-400">Fuentes que NO tiene</Label>
                <div className="space-y-1.5">
                  {FUENTES.map((f) => (
                    <label key={f.clave} className="flex cursor-pointer items-center gap-2 text-sm">
                      <Checkbox
                        checked={ausentes.includes(f.clave)}
                        onCheckedChange={() => alternar(ausentes, setAusentes, f.clave)}
                      />
                      {f.label}
                    </label>
                  ))}
                </div>
                <p className="text-muted-foreground/70 text-xs">
                  El agente no las reportará como carencia. Marcar aquí lo que este cliente no usa
                  por diseño es lo que evita conclusiones del tipo «faltan los datos de ventas».
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Indicaciones para el análisis</Label>
              <Textarea
                value={instrucciones}
                onChange={(e) => setInstrucciones(e.target.value)}
                rows={2}
                placeholder="Ej.: no comentes la ausencia de datos de venta; analiza solo hasta el lead."
                className="bg-background border-input"
              />
            </div>

            {perfil && perfil.feedback.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs">Correcciones acumuladas</Label>
                <div className="divide-border border-border divide-y rounded-lg border">
                  {perfil.feedback.map((f) => (
                    <div key={f.id} className="flex items-start justify-between gap-3 px-3 py-2">
                      <p className="text-muted-foreground text-xs">{f.texto}</p>
                      <button
                        type="button"
                        onClick={() => void silenciar(f.id)}
                        className="text-muted-foreground/50 hover:text-foreground shrink-0"
                        title="Dejar de aplicar esta nota"
                      >
                        <EyeOff className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-muted-foreground/70 text-xs">
                  Notas que el equipo le ha dado al agente. Se le pasan en cada consulta sobre este
                  cliente.
                </p>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                onClick={() => void guardar()}
                disabled={guardando}
                className="bg-blue-600 font-medium text-white hover:bg-blue-500"
              >
                {guardando ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Guardar perfil
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
