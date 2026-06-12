// Tipos compartidos para notificaciones in-app (campanita).
// Espejo del patrón de src/lib/whatsapp/types.ts; los tipos matchean
// el CHECK de public.notifications (migración 022).

export const IN_APP_NOTIFICATION_TYPES = [
  'alert_threshold',
  'ticket_created',
  'ticket_updated',
  'sale_approved',
  'sale_refunded',
  'sale_cancelled',
  'client_assigned',
  'sync_failed',
  'token_expiring',
  'system',
] as const;

export type InAppNotificationType = (typeof IN_APP_NOTIFICATION_TYPES)[number];

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

// Etiquetas legibles para la UI (filtros, preferencias).
export const IN_APP_NOTIFICATION_TYPE_LABELS: Record<InAppNotificationType, string> = {
  alert_threshold: 'Alerta de presupuesto',
  ticket_created: 'Ticket nuevo',
  ticket_updated: 'Ticket actualizado',
  sale_approved: 'Venta aprobada',
  sale_refunded: 'Venta reembolsada',
  sale_cancelled: 'Suscripción cancelada',
  client_assigned: 'Cliente asignado',
  sync_failed: 'Fallo de sincronización',
  token_expiring: 'Token por expirar',
  system: 'Sistema',
};

// Fila de public.notifications tal como la devuelve supabase-js.
export type InAppNotification = {
  id: string;
  user_id: string;
  type: InAppNotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string | null;
  link: string | null;
  cliente_id: string | null;
  metadata: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};

export type NotificationPreference = {
  user_id: string;
  type: InAppNotificationType;
  enabled: boolean;
};
