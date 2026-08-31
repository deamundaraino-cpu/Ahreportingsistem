'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Smartphone, Users, Link2, Info, Trash2, Plus, Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
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
import {
  actualizarCanal,
  guardarContacto,
  borrarContacto,
  vincularRemitente,
  listarCanales,
  listarContactos,
  listarRemitentesVistos,
  type CanalRow,
  type ContactoConIdentidades,
  type RemitenteVisto,
} from '../_actions';

type Props = {
  canalesIniciales: CanalRow[];
  contactosIniciales: ContactoConIdentidades[];
  remitentesIniciales: RemitenteVisto[];
  clientes: { id: string; nombre: string }[];
  usuarios: { id: string; role: string; full_name: string | null }[];
  politica: Record<string, unknown>;
};

const NIVELES = ['consulta', 'operador', 'aprobador', 'admin'] as const;
const SIN_CLIENTE = '__ninguno__';

const DESCRIPCION_NIVEL: Record<string, string> = {
  consulta: 'solo puede preguntar',
  operador: 'puede proponer cambios',
  aprobador: 'puede aprobar los de otros',
  admin: 'todo, incluido crear clientes',
};

export function CanalesWhatsApp({
  canalesIniciales,
  contactosIniciales,
  remitentesIniciales,
  clientes,
  usuarios,
  politica,
}: Props) {
  const [canales, setCanales] = useState(canalesIniciales);
  const [contactos, setContactos] = useState(contactosIniciales);
  const [remitentes, setRemitentes] = useState(remitentesIniciales);
  const [ocupado, setOcupado] = useState<string | null>(null);

  // Alta de contacto
  const [nuevoUsuario, setNuevoUsuario] = useState('');
  const [nuevoNivel, setNuevoNivel] = useState<string>('consulta');

  async function tocarCanal(c: CanalRow, parche: Partial<CanalRow>) {
    setCanales((prev) => prev.map((x) => (x.id === c.id ? { ...x, ...parche } : x)));
    const res = await actualizarCanal(c.id, parche);
    if ('error' in res) {
      toast.error(res.error);
      setCanales(await listarCanales());
    }
  }

  async function anadirContacto() {
    if (!nuevoUsuario) {
      toast.error('Elige a la persona.');
      return;
    }
    setOcupado('contacto');
    try {
      const res = await guardarContacto({ user_id: nuevoUsuario, level: nuevoNivel });
      if ('error' in res) throw new Error(res.error);
      setContactos(await listarContactos());
      setNuevoUsuario('');
      setNuevoNivel('consulta');
      toast.success('Contacto autorizado');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(null);
    }
  }

  async function cambiarNivel(c: ContactoConIdentidades, level: string) {
    const res = await guardarContacto({
      id: c.id,
      user_id: c.user_id,
      display_name: c.display_name,
      level,
      client_scope: c.client_scope,
      is_active: c.is_active,
    });
    if ('error' in res) {
      toast.error(res.error);
      return;
    }
    setContactos(await listarContactos());
  }

  async function quitarContacto(c: ContactoConIdentidades) {
    if (!window.confirm(`¿Quitar el acceso a ${c.display_name ?? 'esta persona'}?`)) return;
    const res = await borrarContacto(c.id);
    if ('error' in res) {
      toast.error(res.error);
      return;
    }
    setContactos((prev) => prev.filter((x) => x.id !== c.id));
    toast.success('Contacto retirado');
  }

  async function vincular(r: RemitenteVisto, contactoId: string) {
    setOcupado(r.id);
    try {
      const res = await vincularRemitente(r.id, contactoId);
      if ('error' in res) throw new Error(res.error);
      setRemitentes(await listarRemitentesVistos());
      setContactos(await listarContactos());
      toast.success('Identidad vinculada');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo vincular.');
    } finally {
      setOcupado(null);
    }
  }

  const grupos = canales.filter((c) => c.kind === 'group');
  const privados = canales.filter((c) => c.kind === 'dm');

  return (
    <div className="space-y-4">
      {/* ── Grupos ─────────────────────────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-500/10 p-2">
              <Smartphone className="h-5 w-5 text-emerald-500" />
            </div>
            <div>
              <CardTitle>Grupos</CardTitle>
              <CardDescription>
                Un grupo aparece aquí en cuanto alguien escribe con el bot dentro, y nace
                desactivado: que lo añadan no basta para que empiece a responder.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {grupos.length === 0 ? (
            <p className="text-muted-foreground/70 py-6 text-center text-sm">
              Ningún grupo todavía. Añade el bot a uno y escribe cualquier cosa.
            </p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead>Grupo</TableHead>
                  <TableHead className="w-36">Techo</TableHead>
                  <TableHead className="w-40">Cliente fijo</TableHead>
                  <TableHead className="w-24">Mención</TableHead>
                  <TableHead className="w-24">Aprender</TableHead>
                  <TableHead className="w-20">Activo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grupos.map((c) => (
                  <TableRow key={c.id} className="border-border hover:bg-muted/10 border-b">
                    <TableCell>
                      <p className="text-sm font-medium">{c.nombre ?? 'Grupo sin nombre'}</p>
                      <p className="text-muted-foreground/50 font-mono text-[10px]">
                        {c.external_id}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={c.max_level}
                        onValueChange={(v) => void tocarCanal(c, { max_level: v })}
                      >
                        <SelectTrigger className="bg-background border-input h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {NIVELES.map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={c.cliente_id ?? SIN_CLIENTE}
                        onValueChange={(v) =>
                          void tocarCanal(c, { cliente_id: v === SIN_CLIENTE ? null : v })
                        }
                      >
                        <SelectTrigger className="bg-background border-input h-8 text-xs">
                          <SelectValue placeholder="Ninguno" />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          <SelectItem value={SIN_CLIENTE}>Todos los suyos</SelectItem>
                          {clientes.map((cl) => (
                            <SelectItem key={cl.id} value={cl.id}>
                              {cl.nombre}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={c.require_mention}
                        onCheckedChange={(v) => void tocarCanal(c, { require_mention: v })}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={c.learning_mode}
                        onCheckedChange={(v) => void tocarCanal(c, { learning_mode: v })}
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={c.is_active}
                        onCheckedChange={(v) => void tocarCanal(c, { is_active: v })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          <div className="text-muted-foreground/70 mt-3 flex items-start gap-2 text-xs">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              El <strong>techo</strong> limita lo que se puede pedir desde ese grupo, aunque quien
              escriba sea administrador: el permiso real es el menor entre su nivel, este techo y su
              rol en la plataforma. Con <strong>mención</strong> activada, el agente solo responde
              si lo llaman con <code>/ah</code> o mencionándolo — sin eso leería y pagaría por cada
              mensaje del grupo.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* ── Contactos ──────────────────────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-violet-500/10 p-2">
              <Users className="h-5 w-5 text-violet-500" />
            </div>
            <div>
              <CardTitle>Contactos autorizados</CardTitle>
              <CardDescription>
                Quién puede hablar con el agente. La autorización es de la persona, no del grupo:
                estar en un grupo habilitado no basta.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_180px_auto]">
            <div className="space-y-1.5">
              <Label className="text-xs">Persona</Label>
              <Select value={nuevoUsuario} onValueChange={setNuevoUsuario}>
                <SelectTrigger className="bg-background border-input">
                  <SelectValue placeholder="Elige un usuario" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {usuarios
                    .filter((u) => !contactos.some((c) => c.user_id === u.id))
                    .map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.full_name ?? u.id.slice(0, 8)} · {u.role}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Nivel</Label>
              <Select value={nuevoNivel} onValueChange={setNuevoNivel}>
                <SelectTrigger className="bg-background border-input">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  {NIVELES.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => void anadirContacto()}
              disabled={ocupado === 'contacto'}
              className="bg-blue-600 font-medium text-white hover:bg-blue-500"
            >
              {ocupado === 'contacto' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Autorizar
            </Button>
          </div>

          {contactos.length > 0 && (
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead>Persona</TableHead>
                  <TableHead className="w-40">Nivel</TableHead>
                  <TableHead className="w-44">Efectivo</TableHead>
                  <TableHead>Identidades</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contactos.map((c) => {
                  const recortado = c.nivel_efectivo !== c.level;
                  return (
                    <TableRow key={c.id} className="border-border hover:bg-muted/10 border-b">
                      <TableCell>
                        <p className="text-sm font-medium">{c.display_name ?? '—'}</p>
                        <p className="text-muted-foreground/70 text-xs">rol: {c.rol_app}</p>
                      </TableCell>
                      <TableCell>
                        <Select value={c.level} onValueChange={(v) => void cambiarNivel(c, v)}>
                          <SelectTrigger className="bg-background border-input h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-card border-border">
                            {NIVELES.map((n) => (
                              <SelectItem key={n} value={n}>
                                {n}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        {/* El efectivo se muestra porque el rol de la plataforma
                            manda: marcar a alguien como admin no le da permisos
                            que su rol no tenga, y verlo evita la confusión. */}
                        <Badge
                          variant="outline"
                          className={
                            recortado
                              ? 'border-amber-500/20 bg-amber-500/10 py-0.5 text-[10px] text-amber-500'
                              : 'border-emerald-500/20 bg-emerald-500/10 py-0.5 text-[10px] text-emerald-500'
                          }
                        >
                          {c.nivel_efectivo}
                        </Badge>
                        <p className="text-muted-foreground/70 mt-0.5 text-[10px]">
                          {recortado
                            ? `su rol "${c.rol_app}" lo limita`
                            : DESCRIPCION_NIVEL[c.nivel_efectivo]}
                        </p>
                      </TableCell>
                      <TableCell>
                        {c.identidades.length === 0 ? (
                          <span className="text-xs text-amber-500">
                            sin vincular — no lo reconocerá
                          </span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {c.identidades.map((i) => (
                              <span
                                key={i.id}
                                className="bg-muted/50 text-muted-foreground/70 rounded px-1.5 py-0.5 font-mono text-[10px]"
                              >
                                {i.kind === 'lid' ? 'grupo' : 'privado'}
                              </span>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => void quitarContacto(c)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Identidades por vincular ───────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-amber-500/10 p-2">
              <Link2 className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <CardTitle>Identidades por vincular</CardTitle>
              <CardDescription>
                Dentro de un grupo, WhatsApp no da el número de quien escribe sino un código opaco.
                Por eso alguien puede funcionar en privado y ser ignorado en el grupo: son dos
                identidades distintas de la misma persona.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-muted-foreground/70 mb-3 flex items-start gap-2 text-xs">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p>
              Para rellenar esta lista: activa <strong>Aprender</strong> en el grupo, pide que cada
              persona escriba cualquier cosa (el agente no responderá), vincula a cada una con su
              contacto, y vuelve a apagarlo.
            </p>
          </div>

          {remitentes.length === 0 ? (
            <p className="text-muted-foreground/70 py-6 text-center text-sm">
              Nada pendiente de vincular.
            </p>
          ) : (
            <Table>
              <TableHeader className="bg-muted/30">
                <TableRow>
                  <TableHead>Quién escribió</TableHead>
                  <TableHead>Identificador</TableHead>
                  <TableHead className="w-56">Vincular a</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {remitentes.map((r) => (
                  <TableRow key={r.id} className="border-border hover:bg-muted/10 border-b">
                    <TableCell>
                      <p className="text-sm font-medium">{r.push_name ?? 'Sin nombre'}</p>
                      <p className="text-muted-foreground/70 text-xs">
                        {new Date(r.last_seen_at).toLocaleString('es-CO')}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="text-muted-foreground/50 font-mono text-[10px]">
                        {r.lid ?? r.participant_pn}
                      </p>
                    </TableCell>
                    <TableCell>
                      <Select
                        disabled={ocupado === r.id}
                        onValueChange={(v) => void vincular(r, v)}
                      >
                        <SelectTrigger className="bg-background border-input h-8 text-xs">
                          <SelectValue placeholder="Elige un contacto" />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-border">
                          {contactos.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.display_name ?? c.user_id.slice(0, 8)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Chats privados ─────────────────────────────────────── */}
      {privados.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-base">Chats privados</CardTitle>
            <CardDescription>
              Se abren solos cuando un contacto autorizado escribe por primera vez. Apagar uno es la
              forma de cortarle el acceso sin borrar su contacto.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-border divide-y">
              {privados.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-2.5">
                  <div>
                    <p className="text-sm">{c.nombre ?? c.external_id.split('@')[0]}</p>
                    <p className="text-muted-foreground/50 font-mono text-[10px]">
                      {c.external_id}
                    </p>
                  </div>
                  <Switch
                    checked={c.is_active}
                    onCheckedChange={(v) => void tocarCanal(c, { is_active: v })}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Modelos ────────────────────────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base">Modelos en uso</CardTitle>
          <CardDescription>
            Cada tier tiene un modelo principal y una cadena de reserva: si el primero falla o está
            saturado, se usa el siguiente automáticamente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            {(['nano', 'work', 'power'] as const).map((tier) => {
              const p = politica[tier] as { primary?: string; fallbacks?: string[] } | undefined;
              return (
                <div key={tier} className="flex items-start gap-3">
                  <Badge variant="outline" className="w-16 justify-center py-0.5 text-[10px]">
                    {tier}
                  </Badge>
                  <div className="min-w-0">
                    <p className="font-mono text-xs">{p?.primary ?? '—'}</p>
                    {p?.fallbacks && p.fallbacks.length > 0 && (
                      <p className="text-muted-foreground/50 font-mono text-[10px]">
                        reserva: {p.fallbacks.join(', ')}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-muted-foreground/70 mt-3 text-xs">
            El tier <code>nano</code> nunca recibe herramientas: los modelos gratuitos rotan sin
            aviso y su soporte de llamadas a función es irregular. Para redactar y resumir van bien,
            y es donde ahorran de verdad.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
