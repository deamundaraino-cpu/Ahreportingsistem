'use client';

// Página /notificaciones: historial completo con filtros y paginación,
// y preferencias opt-out por tipo de notificación.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { es } from 'date-fns/locale';
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  Send,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getNotifications,
  markAllAsRead,
  markAsRead,
  sendTestNotification,
  updatePreference,
} from './_actions';
import {
  IN_APP_NOTIFICATION_TYPES,
  IN_APP_NOTIFICATION_TYPE_LABELS,
  type InAppNotification,
  type InAppNotificationType,
  type NotificationSeverity,
} from '@/lib/notifications/types';

const PAGE_SIZE = 50;

const SEVERITY_ICON: Record<NotificationSeverity, React.ReactNode> = {
  info: <Info className="h-4 w-4 text-indigo-500 shrink-0" />,
  success: <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />,
  warning: <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />,
  error: <XCircle className="h-4 w-4 text-rose-500 shrink-0" />,
};

type Props = {
  initialItems: InAppNotification[];
  initialTotal: number;
  initialPreferences: Record<string, boolean>;
  initialType?: InAppNotificationType;
  userRole: string;
};

export function NotificacionesClient({
  initialItems,
  initialTotal,
  initialPreferences,
  initialType,
  userRole,
}: Props) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string>(initialType ?? 'all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [prefs, setPrefs] = useState(initialPreferences);
  const [isPending, startTransition] = useTransition();

  const isAdmin = ['admin', 'superadmin'].includes(userRole);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = (nextPage: number, nextType: string, nextUnread: boolean) => {
    startTransition(async () => {
      const { items: data, total: count } = await getNotifications({
        page: nextPage,
        type: nextType === 'all' ? undefined : (nextType as InAppNotificationType),
        unreadOnly: nextUnread,
      });
      setItems(data);
      setTotal(count);
      setPage(nextPage);
    });
  };

  const handleClick = (notif: InAppNotification) => {
    if (!notif.read_at) {
      setItems((prev) =>
        prev.map((n) => (n.id === notif.id ? { ...n, read_at: new Date().toISOString() } : n))
      );
      markAsRead(notif.id);
    }
    if (notif.link) router.push(notif.link);
  };

  const handleMarkAll = async () => {
    setItems((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    await markAllAsRead();
  };

  const togglePref = (type: InAppNotificationType) => {
    const next = !(prefs[type] ?? true);
    setPrefs((prev) => ({ ...prev, [type]: next }));
    updatePreference(type, next);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bell className="h-6 w-6" />
            Notificaciones
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Historial de avisos y preferencias de notificación
          </p>
        </div>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await sendTestNotification();
            }}
          >
            <Send className="h-4 w-4 mr-2" />
            Enviar prueba
          </Button>
        )}
      </div>

      <Tabs defaultValue="historial">
        <TabsList>
          <TabsTrigger value="historial">Historial</TabsTrigger>
          <TabsTrigger value="preferencias">Preferencias</TabsTrigger>
        </TabsList>

        <TabsContent value="historial" className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Select
              value={typeFilter}
              onValueChange={(v) => {
                setTypeFilter(v);
                load(0, v, unreadOnly);
              }}
            >
              <SelectTrigger className="w-56">
                <SelectValue placeholder="Tipo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tipos</SelectItem>
                {IN_APP_NOTIFICATION_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {IN_APP_NOTIFICATION_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant={unreadOnly ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                const next = !unreadOnly;
                setUnreadOnly(next);
                load(0, typeFilter, next);
              }}
            >
              Solo no leídas
            </Button>

            <Button variant="ghost" size="sm" onClick={handleMarkAll}>
              <CheckCheck className="h-4 w-4 mr-2" />
              Marcar todas como leídas
            </Button>
          </div>

          <div
            className={`rounded-xl border border-border divide-y divide-border overflow-hidden ${isPending ? 'opacity-60' : ''}`}
          >
            {items.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No hay notificaciones para mostrar
              </div>
            ) : (
              items.map((notif) => (
                <button
                  key={notif.id}
                  onClick={() => handleClick(notif)}
                  className={`w-full text-left px-4 py-3.5 flex gap-3 hover:bg-muted/50 transition-colors ${
                    !notif.read_at ? 'bg-indigo-50/50 dark:bg-indigo-500/[0.06]' : ''
                  }`}
                >
                  <span className="mt-0.5">
                    {SEVERITY_ICON[notif.severity] ?? SEVERITY_ICON.info}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{notif.title}</span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {IN_APP_NOTIFICATION_TYPE_LABELS[notif.type] ?? notif.type}
                      </span>
                    </span>
                    {notif.message && (
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {notif.message}
                      </span>
                    )}
                    <span className="block text-[11px] text-muted-foreground/70 mt-1">
                      {formatDistanceToNow(new Date(notif.created_at), {
                        addSuffix: true,
                        locale: es,
                      })}
                    </span>
                  </span>
                  {!notif.read_at && (
                    <span className="mt-1.5 h-2 w-2 rounded-full bg-[#1E6AB5] shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                Página {page + 1} de {totalPages} · {total} notificaciones
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0 || isPending}
                  onClick={() => load(page - 1, typeFilter, unreadOnly)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page + 1 >= totalPages || isPending}
                  onClick={() => load(page + 1, typeFilter, unreadOnly)}
                >
                  Siguiente
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="preferencias">
          <div className="rounded-xl border border-border divide-y divide-border overflow-hidden max-w-xl">
            {IN_APP_NOTIFICATION_TYPES.map((type) => {
              const enabled = prefs[type] ?? true;
              return (
                <div key={type} className="flex items-center justify-between px-4 py-3.5">
                  <div>
                    <p className="text-sm font-medium">{IN_APP_NOTIFICATION_TYPE_LABELS[type]}</p>
                    <p className="text-xs text-muted-foreground">
                      {enabled ? 'Recibirás estas notificaciones' : 'Desactivadas'}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => togglePref(type)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      enabled ? 'bg-[#1E6AB5]' : 'bg-muted'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                        enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
