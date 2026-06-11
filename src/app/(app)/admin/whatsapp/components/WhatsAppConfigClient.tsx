'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_LABELS,
  type GatewayStatus,
  type NotificationType,
} from '@/lib/whatsapp/types';
import {
  syncGroups,
  upsertRoute,
  setRouteEnabled,
  deleteRoute,
  sendManualWhatsApp,
} from '../_actions';

type Group = { id: string; group_id: string; group_name: string; enabled: boolean };
type Cliente = { id: string; nombre: string };
type Route = {
  id: string;
  cliente_id: string | null;
  notification_type: string;
  group_id: string;
  enabled: boolean;
  cliente: { nombre: string } | null;
  grupo: { group_name: string } | null;
};
type Message = {
  id: string;
  cliente_id: string | null;
  notification_type: string;
  group_id: string;
  message: string;
  status: string;
  error: string | null;
  created_at: string;
  cliente: { nombre: string } | null;
};

const GLOBAL = '__global__';

export function WhatsAppConfigClient({
  status,
  gatewayError,
  qr,
  groups,
  routes,
  clientes,
  messages,
}: {
  status: GatewayStatus | null;
  gatewayError: string | null;
  qr: string | null;
  groups: Group[];
  routes: Route[];
  clientes: Cliente[];
  messages: Message[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Form: nueva ruta
  const [routeCliente, setRouteCliente] = useState<string>(GLOBAL);
  const [routeType, setRouteType] = useState<NotificationType>('metrics_summary');
  const [routeGroup, setRouteGroup] = useState<string>(groups[0]?.group_id ?? '');

  // Form: envío manual
  const [manualCliente, setManualCliente] = useState<string>(GLOBAL);
  const [manualMsg, setManualMsg] = useState('');

  function notify(kind: 'ok' | 'err', text: string) {
    setFeedback({ kind, text });
    router.refresh();
  }

  function handleSync() {
    startTransition(async () => {
      const res = await syncGroups();
      if (res.error) notify('err', res.error);
      else notify('ok', `Sincronizados ${res.count} grupos`);
    });
  }

  function handleAddRoute() {
    if (!routeGroup) {
      notify('err', 'Selecciona un grupo (primero sincroniza grupos)');
      return;
    }
    startTransition(async () => {
      const res = await upsertRoute({
        clienteId: routeCliente === GLOBAL ? null : routeCliente,
        notificationType: routeType,
        groupId: routeGroup,
      });
      if (res.error) notify('err', res.error);
      else notify('ok', 'Ruta agregada');
    });
  }

  function handleToggleRoute(id: string, enabled: boolean) {
    startTransition(async () => {
      const res = await setRouteEnabled(id, enabled);
      if (res.error) notify('err', res.error);
      else router.refresh();
    });
  }

  function handleDeleteRoute(id: string) {
    startTransition(async () => {
      const res = await deleteRoute(id);
      if (res.error) notify('err', res.error);
      else notify('ok', 'Ruta eliminada');
    });
  }

  function handleSendManual() {
    if (!manualMsg.trim()) {
      notify('err', 'Escribe un mensaje');
      return;
    }
    startTransition(async () => {
      const res = await sendManualWhatsApp({
        clienteId: manualCliente === GLOBAL ? null : manualCliente,
        message: manualMsg,
      });
      if (res.error) notify('err', res.error);
      else {
        notify(
          'ok',
          `Enviado a ${res.sent} grupo(s)${res.failed ? `, ${res.failed} fallaron` : ''}`
        );
        setManualMsg('');
      }
    });
  }

  const selectCls =
    'w-full rounded-md bg-zinc-950 border border-zinc-700 px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-zinc-500';

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`rounded-md px-4 py-2 text-sm ${
            feedback.kind === 'ok'
              ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30'
              : 'bg-red-500/10 text-red-300 border border-red-500/30'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {/* ── Conexión ─────────────────────────────────────── */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-white">Conexión</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {gatewayError ? (
            <p className="text-amber-400 text-sm">
              No se pudo contactar al gateway: {gatewayError}
              <br />
              <span className="text-zinc-500">
                Verifica WHATSAPP_GATEWAY_URL / WHATSAPP_GATEWAY_API_KEY y que el servicio esté
                arriba.
              </span>
            </p>
          ) : status?.connected ? (
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              ● Conectado{status.me?.name ? ` como ${status.me.name}` : ''}
              {status.me?.id ? (
                <span className="text-zinc-500">({status.me.id.split(':')[0]})</span>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-amber-400 text-sm">
                Sin conexión. Escanea el QR con el WhatsApp del número de la agencia.
              </p>
              {qr ? (
                <Image
                  src={qr}
                  alt="QR de WhatsApp"
                  width={240}
                  height={240}
                  unoptimized
                  className="rounded-md bg-white p-2"
                />
              ) : (
                <p className="text-zinc-500 text-sm">
                  QR no disponible todavía. Refresca en unos segundos.
                </p>
              )}
            </div>
          )}
          <button
            onClick={() => router.refresh()}
            className="text-xs px-3 py-1.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
          >
            Refrescar estado
          </button>
        </CardContent>
      </Card>

      {/* ── Grupos ───────────────────────────────────────── */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-white">Grupos ({groups.length})</CardTitle>
          <button
            onClick={handleSync}
            disabled={pending}
            className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Sincronizar grupos
          </button>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <p className="text-zinc-500 text-sm">
              Sin grupos. Conecta WhatsApp y pulsa “Sincronizar grupos”.
            </p>
          ) : (
            <ul className="text-sm text-zinc-300 space-y-1 max-h-48 overflow-y-auto">
              {groups.map((g) => (
                <li
                  key={g.group_id}
                  className="flex justify-between bg-zinc-950/60 px-3 py-1.5 rounded"
                >
                  <span>{g.group_name}</span>
                  <span className="text-zinc-600 text-xs">{g.group_id.split('@')[0]}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Ruteo ────────────────────────────────────────── */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-white">Ruteo (cliente o tipo → grupo)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <select
              className={selectCls}
              value={routeCliente}
              onChange={(e) => setRouteCliente(e.target.value)}
            >
              <option value={GLOBAL}>Global (todos los clientes)</option>
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nombre}
                </option>
              ))}
            </select>
            <select
              className={selectCls}
              value={routeType}
              onChange={(e) => setRouteType(e.target.value as NotificationType)}
            >
              {NOTIFICATION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {NOTIFICATION_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <select
              className={selectCls}
              value={routeGroup}
              onChange={(e) => setRouteGroup(e.target.value)}
            >
              <option value="">— grupo —</option>
              {groups.map((g) => (
                <option key={g.group_id} value={g.group_id}>
                  {g.group_name}
                </option>
              ))}
            </select>
            <button
              onClick={handleAddRoute}
              disabled={pending}
              className="rounded-md bg-emerald-600 text-white text-sm px-3 py-2 hover:bg-emerald-500 disabled:opacity-50"
            >
              Agregar ruta
            </button>
          </div>

          {routes.length === 0 ? (
            <p className="text-zinc-500 text-sm">Sin rutas configuradas.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-zinc-300">
                <thead className="text-zinc-500 text-xs uppercase">
                  <tr className="border-b border-zinc-800">
                    <th className="text-left py-2">Cliente</th>
                    <th className="text-left py-2">Tipo</th>
                    <th className="text-left py-2">Grupo</th>
                    <th className="text-right py-2">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((r) => (
                    <tr key={r.id} className="border-b border-zinc-900">
                      <td className="py-2">{r.cliente?.nombre ?? 'Global'}</td>
                      <td className="py-2">
                        {NOTIFICATION_TYPE_LABELS[r.notification_type as NotificationType] ??
                          r.notification_type}
                      </td>
                      <td className="py-2">{r.grupo?.group_name ?? r.group_id}</td>
                      <td className="py-2 text-right space-x-2">
                        <button
                          onClick={() => handleToggleRoute(r.id, !r.enabled)}
                          disabled={pending}
                          className={`text-xs px-2 py-1 rounded ${
                            r.enabled
                              ? 'bg-emerald-500/10 text-emerald-300'
                              : 'bg-zinc-700 text-zinc-400'
                          }`}
                        >
                          {r.enabled ? 'Activa' : 'Inactiva'}
                        </button>
                        <button
                          onClick={() => handleDeleteRoute(r.id)}
                          disabled={pending}
                          className="text-xs px-2 py-1 rounded bg-red-500/10 text-red-300 hover:bg-red-500/20"
                        >
                          Eliminar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Envío manual ─────────────────────────────────── */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-white">Envío manual</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <select
            className={selectCls}
            value={manualCliente}
            onChange={(e) => setManualCliente(e.target.value)}
          >
            <option value={GLOBAL}>Global (rutas de “Envío manual”)</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nombre}
              </option>
            ))}
          </select>
          <textarea
            className={`${selectCls} min-h-24`}
            placeholder="Mensaje a enviar al grupo…"
            value={manualMsg}
            onChange={(e) => setManualMsg(e.target.value)}
          />
          <button
            onClick={handleSendManual}
            disabled={pending}
            className="rounded-md bg-blue-600 text-white text-sm px-4 py-2 hover:bg-blue-500 disabled:opacity-50"
          >
            Enviar
          </button>
          <p className="text-zinc-600 text-xs">
            Se envía a los grupos ruteados para el tipo “Envío manual” (del cliente, o global si no
            hay).
          </p>
        </CardContent>
      </Card>

      {/* ── Log reciente ─────────────────────────────────── */}
      <Card className="bg-zinc-900 border-zinc-800">
        <CardHeader>
          <CardTitle className="text-white">Últimos envíos</CardTitle>
        </CardHeader>
        <CardContent>
          {messages.length === 0 ? (
            <p className="text-zinc-500 text-sm">Sin envíos todavía.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className="bg-zinc-950/60 px-3 py-2 rounded flex justify-between gap-3"
                >
                  <div className="min-w-0">
                    <span className="text-zinc-300 truncate block">{m.message}</span>
                    <span className="text-zinc-600 text-xs">
                      {m.cliente?.nombre ?? 'Global'} ·{' '}
                      {NOTIFICATION_TYPE_LABELS[m.notification_type as NotificationType] ??
                        m.notification_type}{' '}
                      · {new Date(m.created_at).toLocaleString()}
                    </span>
                  </div>
                  <span
                    className={`text-xs shrink-0 ${
                      m.status === 'sent' ? 'text-emerald-400' : 'text-red-400'
                    }`}
                    title={m.error ?? ''}
                  >
                    {m.status === 'sent' ? '✓ enviado' : '✕ error'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
