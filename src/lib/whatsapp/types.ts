// Tipos compartidos para el módulo de notificaciones de WhatsApp.

// Tipos de notificación soportados. Se usan como `notification_type` en
// whatsapp_routes / whatsapp_messages. Los `sale.*` matchean los
// OutboundEventType del módulo report-utm para reusar el enganche de ventas.
export const NOTIFICATION_TYPES = [
  'metrics_summary',
  'alert_threshold',
  'report_ready',
  'sale.approved',
  'sale.refunded',
  'roadmap_created',
  'roadmap_updated',
  'manual',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

// Etiquetas legibles para la UI de administración.
export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  metrics_summary: 'Resumen de métricas',
  alert_threshold: 'Alerta por umbral',
  report_ready: 'Reporte listo',
  'sale.approved': 'Venta aprobada',
  'sale.refunded': 'Venta reembolsada',
  roadmap_created: 'Roadmap: ítem nuevo',
  roadmap_updated: 'Roadmap: cambio de estado',
  manual: 'Envío manual',
};

export type WhatsAppGroup = {
  id: string; // jid "...@g.us"
  name: string;
};

export type GatewayStatus = {
  connected: boolean;
  me: { id: string; name?: string } | null;
  lastSeen: string | null;
};

// Interfaz común que implementa cada proveedor de WhatsApp (gateway Baileys
// propio o Evolution API). gateway.ts elige uno según WHATSAPP_PROVIDER.
export type WhatsAppProvider = {
  getStatus(): Promise<GatewayStatus>;
  getQr(): Promise<{ qr: string | null; connected: boolean }>;
  listGroups(): Promise<WhatsAppGroup[]>;
  sendToGroup(groupId: string, message: string): Promise<{ messageId: string }>;
};
