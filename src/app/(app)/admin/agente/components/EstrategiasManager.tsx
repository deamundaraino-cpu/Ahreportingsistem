'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Target, Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { METRIC_META } from '@/lib/report-utm/bi-metadata';
import {
  crearEstrategia,
  actualizarEstrategia,
  borrarEstrategia,
  listarEstrategias,
  type EstrategiaTipoRow,
} from '../_actions';

type Props = { iniciales: EstrategiaTipoRow[]; soloLectura: boolean };

/**
 * Métricas seleccionables.
 *
 * Salen del catálogo real del motor, no de texto libre: una errata en el nombre
 * de una métrica produce una lista que no filtra nada, y eso no se nota hasta
 * que un análisis sale raro.
 */
const METRICAS = Object.entries(METRIC_META)
  .map(([clave, meta]) => ({ clave, label: (meta as { label: string }).label }))
  .sort((a, b) => a.label.localeCompare(b.label));

function SelectorMetricas({
  valor,
  onChange,
  ayuda,
}: {
  valor: string[];
  onChange: (v: string[]) => void;
  ayuda: string;
}) {
  const [filtro, setFiltro] = useState('');
  const visibles = useMemo(() => {
    const f = filtro.trim().toLowerCase();
    if (!f) return METRICAS.slice(0, 60);
    return METRICAS.filter(
      (m) => m.label.toLowerCase().includes(f) || m.clave.toLowerCase().includes(f)
    ).slice(0, 60);
  }, [filtro]);

  function alternar(clave: string) {
    onChange(valor.includes(clave) ? valor.filter((v) => v !== clave) : [...valor, clave]);
  }

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground/70 text-xs">{ayuda}</p>
      {valor.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {valor.map((v) => (
            <Badge
              key={v}
              variant="outline"
              className="cursor-pointer border-indigo-500/20 bg-indigo-500/10 py-0.5 text-[10px] text-indigo-500"
              onClick={() => alternar(v)}
            >
              {v} ×
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={filtro}
        onChange={(e) => setFiltro(e.target.value)}
        placeholder="Buscar métrica…"
        className="bg-muted/50 border-border h-8 text-xs"
      />
      <div className="border-border max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
        {visibles.map((m) => (
          <label key={m.clave} className="flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={valor.includes(m.clave)} onCheckedChange={() => alternar(m.clave)} />
            <span>{m.label}</span>
            <span className="text-muted-foreground/50 font-mono text-[10px]">{m.clave}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

const VACIO = {
  categoria: '',
  subcategoria: '',
  nombre: '',
  descripcion: '',
  alcance: 'hasta_lead' as 'hasta_lead' | 'hasta_venta',
  temporal: false,
  metricas_clave: [] as string[],
  metricas_na: [] as string[],
  guia: '',
  activo: true,
};

export function EstrategiasManager({ iniciales, soloLectura }: Props) {
  const [filas, setFilas] = useState(iniciales);
  const [abierto, setAbierto] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [f, setF] = useState(VACIO);

  function abrirNuevo() {
    setF(VACIO);
    setEditandoId(null);
    setAbierto(true);
  }

  function abrirEdicion(r: EstrategiaTipoRow) {
    setF({
      categoria: r.categoria,
      subcategoria: r.subcategoria,
      nombre: r.nombre,
      descripcion: r.descripcion ?? '',
      alcance: r.alcance,
      temporal: r.temporal,
      metricas_clave: r.metricas_clave ?? [],
      metricas_na: r.metricas_na ?? [],
      guia: r.guia ?? '',
      activo: r.activo,
    });
    setEditandoId(r.id);
    setAbierto(true);
  }

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (!f.categoria.trim() || !f.subcategoria.trim() || !f.nombre.trim()) {
      toast.error('Categoría, subcategoría y nombre son obligatorios.');
      return;
    }

    setGuardando(true);
    try {
      const payload = {
        categoria: f.categoria.trim().toLowerCase(),
        subcategoria: f.subcategoria.trim().toLowerCase(),
        nombre: f.nombre.trim(),
        descripcion: f.descripcion.trim() || null,
        alcance: f.alcance,
        temporal: f.temporal,
        metricas_clave: f.metricas_clave,
        metricas_na: f.metricas_na,
        guia: f.guia.trim() || null,
        activo: f.activo,
      };

      const res = editandoId
        ? await actualizarEstrategia(editandoId, payload)
        : await crearEstrategia(payload);

      if ('error' in res) throw new Error(res.error);

      setFilas(await listarEstrategias());
      setAbierto(false);
      toast.success(editandoId ? 'Estrategia actualizada' : 'Estrategia creada');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setGuardando(false);
    }
  }

  async function eliminar(r: EstrategiaTipoRow) {
    if (!window.confirm(`¿Borrar "${r.nombre}"?`)) return;
    const res = await borrarEstrategia(r.id);
    if ('error' in res) {
      toast.error(res.error);
      return;
    }
    setFilas((prev) => prev.filter((x) => x.id !== r.id));
    toast.success('Estrategia borrada');
  }

  async function alternarActivo(r: EstrategiaTipoRow, activo: boolean) {
    setFilas((prev) => prev.map((x) => (x.id === r.id ? { ...x, activo } : x)));
    const res = await actualizarEstrategia(r.id, { activo });
    if ('error' in res) {
      toast.error(res.error);
      setFilas((prev) => prev.map((x) => (x.id === r.id ? { ...x, activo: !activo } : x)));
    }
  }

  return (
    <>
      <Card className="bg-card border-border shadow-lg">
        <CardHeader className="flex flex-row items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-indigo-500/10 p-2">
              <Target className="h-5 w-5 text-indigo-500" />
            </div>
            <div>
              <CardTitle>Tipos de estrategia</CardTitle>
              <CardDescription>
                Qué mide cada tipo de campaña y cómo se interpreta. Se define una vez para toda la
                agencia y cada pestaña de cliente elige el suyo.
              </CardDescription>
            </div>
          </div>
          {!soloLectura && (
            <Button
              onClick={abrirNuevo}
              className="bg-blue-600 font-medium text-white hover:bg-blue-500"
            >
              <Plus className="h-4 w-4" /> Nuevo tipo
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {filas.length === 0 ? (
            <div className="py-10 text-center">
              <Target className="text-muted-foreground/50 mx-auto h-10 w-10" />
              <p className="mt-3 text-sm font-medium">Todavía no hay tipos de estrategia</p>
              <p className="text-muted-foreground/70 mt-1 text-sm">
                Sin ellos, el agente no sabe qué métricas mirar en cada pestaña.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Mide</TableHead>
                  <TableHead>No aplica</TableHead>
                  <TableHead className="w-20">Activo</TableHead>
                  {!soloLectura && <TableHead className="w-24" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filas.map((r) => (
                  <TableRow key={r.id} className="border-border hover:bg-muted/10 border-b">
                    <TableCell>
                      <p className="font-medium">{r.nombre}</p>
                      <p className="text-muted-foreground/70 text-xs">
                        {r.categoria}/{r.subcategoria}
                        {r.temporal && ' · con fecha de fin'}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          r.alcance === 'hasta_venta'
                            ? 'border-emerald-500/20 bg-emerald-500/10 py-0.5 text-[10px] text-emerald-500'
                            : 'border-amber-500/20 bg-amber-500/10 py-0.5 text-[10px] text-amber-500'
                        }
                      >
                        {r.alcance === 'hasta_venta' ? 'hasta la venta' : 'hasta el lead'}
                      </Badge>
                      <p className="text-muted-foreground/70 mt-1 text-xs">
                        {(r.metricas_clave ?? []).length} métrica(s) clave
                      </p>
                    </TableCell>
                    <TableCell>
                      {(r.metricas_na ?? []).length === 0 ? (
                        <span className="text-muted-foreground/50 text-xs">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {(r.metricas_na ?? []).slice(0, 3).map((m) => (
                            <span
                              key={m}
                              className="text-muted-foreground/70 bg-muted/50 rounded px-1.5 py-0.5 font-mono text-[10px]"
                            >
                              {m}
                            </span>
                          ))}
                          {(r.metricas_na ?? []).length > 3 && (
                            <span className="text-muted-foreground/50 text-[10px]">
                              +{(r.metricas_na ?? []).length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={r.activo}
                        onCheckedChange={(v) => void alternarActivo(r, v)}
                        disabled={soloLectura}
                      />
                    </TableCell>
                    {!soloLectura && (
                      <TableCell>
                        <div className="flex gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => abrirEdicion(r)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => void eliminar(r)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={abierto} onOpenChange={setAbierto}>
        <DialogContent className="bg-card border-border max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
          <form onSubmit={guardar} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{editandoId ? 'Editar tipo' : 'Nuevo tipo de estrategia'}</DialogTitle>
              <DialogDescription>
                Lo que se configure aquí es lo que el agente usa para interpretar las cifras de las
                pestañas de este tipo.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Categoría</Label>
                <Input
                  value={f.categoria}
                  onChange={(e) => setF({ ...f, categoria: e.target.value })}
                  placeholder="evergreen, lanzamiento…"
                  className="bg-muted/50 border-border"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Subcategoría</Label>
                <Input
                  value={f.subcategoria}
                  onChange={(e) => setF({ ...f, subcategoria: e.target.value })}
                  placeholder="captacion, infoproducto…"
                  className="bg-muted/50 border-border"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Nombre</Label>
              <Input
                value={f.nombre}
                onChange={(e) => setF({ ...f, nombre: e.target.value })}
                placeholder="Evergreen de captación"
                className="bg-muted/50 border-border"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Hasta dónde mide</Label>
                <Select
                  value={f.alcance}
                  onValueChange={(v) => setF({ ...f, alcance: v as typeof f.alcance })}
                >
                  <SelectTrigger className="bg-muted/50 border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    <SelectItem value="hasta_lead">Hasta el lead</SelectItem>
                    <SelectItem value="hasta_venta">Hasta la venta</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>¿Tiene fecha de fin?</Label>
                <div className="flex h-9 items-center gap-2">
                  <Switch
                    checked={f.temporal}
                    onCheckedChange={(v) => setF({ ...f, temporal: v })}
                  />
                  <span className="text-muted-foreground text-sm">
                    {f.temporal ? 'Sí, es un lanzamiento' : 'No, es continuo'}
                  </span>
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Métricas clave</Label>
              <SelectorMetricas
                valor={f.metricas_clave}
                onChange={(v) => setF({ ...f, metricas_clave: v })}
                ayuda="Las que el agente mira primero al analizar una pestaña de este tipo."
              />
            </div>

            <div className="space-y-1.5">
              <Label>Métricas que NO aplican</Label>
              <SelectorMetricas
                valor={f.metricas_na}
                onChange={(v) => setF({ ...f, metricas_na: v })}
                ayuda="Lo que el agente debe CALLAR, no ignorar. Si una estrategia solo capta leads, el ROAS no es un dato que falte: es un dato que no tiene sentido, y reportarlo como carencia hace inútil el análisis."
              />
            </div>

            <div className="space-y-1.5">
              <Label>Cómo se interpreta</Label>
              <Textarea
                value={f.guia}
                onChange={(e) => setF({ ...f, guia: e.target.value })}
                rows={4}
                placeholder="Ej.: capta leads de forma continua, sin fecha de fin. Se juzga por volumen y CPL sostenidos. No hay ventas que medir."
                className="bg-muted/50 border-border"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAbierto(false)}>
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={guardando}
                className="bg-blue-600 font-medium text-white hover:bg-blue-500"
              >
                {guardando && <Loader2 className="h-4 w-4 animate-spin" />}
                {editandoId ? 'Guardar' : 'Crear'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
