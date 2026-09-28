'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { PlusCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { MONEDAS_REPORTE } from '@/lib/moneda-reporte';
import { ZONAS_HABITUALES } from '@/lib/zona-horaria';
import { createCliente } from '../_actions';

const SELECT =
  'w-full bg-background border border-input rounded-md px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Alta corta: lo mínimo para que el cliente nazca bien (nombre, moneda, zona y
 * quién lo lleva). Al crearlo se abre su ficha, donde la «Puesta en marcha»
 * guía el resto: Meta, Sheets, Hotmart, GHL, píxel, WhatsApp…
 */
export function NewClientDialog({
  traffickers = [],
}: {
  traffickers?: Array<{ id: string; etiqueta: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [nombre, setNombre] = useState('');
  const [moneda, setMoneda] = useState('');
  const [zona, setZona] = useState('');
  const [asignados, setAsignados] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function reiniciar() {
    setNombre('');
    setMoneda('');
    setZona('');
    setAsignados([]);
    setError(null);
  }

  const alternar = (id: string) =>
    setAsignados((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!nombre.trim()) {
      setError('El nombre es requerido.');
      return;
    }

    setLoading(true);
    const r = await createCliente({
      nombre,
      moneda: moneda || null,
      zonaHoraria: zona || null,
      traffickers: asignados,
    });
    setLoading(false);

    if (!r.success || !r.data) {
      setError(r.error || 'Error al crear cliente.');
      return;
    }
    setOpen(false);
    reiniciar();
    router.push(`/admin/settings/${r.data.id}`);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reiniciar();
      }}
    >
      <DialogTrigger asChild>
        <Button className="gap-2">
          <PlusCircle className="h-4 w-4" />
          Agregar Cliente
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px] bg-card border-border text-foreground">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Nuevo Cliente</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              El cliente es de la empresa, no de quien lo crea. Después se abre su ficha para
              conectar sus canales.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="nombre" className="text-foreground">
                Nombre del Cliente o Proyecto
              </Label>
              <Input
                id="nombre"
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                maxLength={120}
                placeholder="Ej. Curso de Emprendimiento"
                className="bg-background border-input focus-visible:ring-ring"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="moneda" className="text-foreground">
                  Moneda de reporte
                </Label>
                <select
                  id="moneda"
                  value={moneda}
                  onChange={(e) => setMoneda(e.target.value)}
                  className={SELECT}
                >
                  <option value="">La de su cuenta de Meta</option>
                  {MONEDAS_REPORTE.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="zona" className="text-foreground">
                  Zona horaria
                </Label>
                <select
                  id="zona"
                  value={zona}
                  onChange={(e) => setZona(e.target.value)}
                  className={SELECT}
                >
                  <option value="">La de su cuenta de Meta</option>
                  {ZONAS_HABITUALES.map((z) => (
                    <option key={z.zona} value={z.zona}>
                      {z.etiqueta}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-foreground">Traffickers que lo llevan</Label>
              {traffickers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No hay traffickers. Los administradores ven todos los clientes.
                </p>
              ) : (
                <div className="max-h-36 overflow-y-auto rounded-md border border-input divide-y divide-border">
                  {traffickers.map((t) => (
                    <label
                      key={t.id}
                      className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        checked={asignados.includes(t.id)}
                        onChange={() => alternar(t.id)}
                      />
                      <span className="truncate">{t.etiqueta}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={loading} className="w-full sm:w-auto">
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Crear y configurar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
