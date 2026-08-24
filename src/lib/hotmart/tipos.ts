// ════════════════════════════════════════════════════════════════
// Tipos de Hotmart y el tipo canónico al que convergen los dos orígenes
// ════════════════════════════════════════════════════════════════
//
// Hotmart entra al sistema por dos caminos que hasta ahora no se hablaban:
//
//   • WEBHOOK 2.0.0 — push, por transacción, con UTMs y datos del comprador.
//   • API REST      — pull, por día, con las comisiones reales (lo único que
//                     dice cuánto se cobró de verdad tras la tarifa de Hotmart).
//
// Cada uno traía la mitad de la información y la tiraba a un sitio distinto
// (`report_utm.sales_events` y `public.metricas_diarias`). `VentaHotmart` es la
// forma común: ambos parsers producen esto, y `public.hotmart_ventas` guarda
// exactamente esto. Es lo que permite que haya UN solo número de ventas.
//
// Los tipos del payload son PARCIALES a propósito: Hotmart añade campos sin
// avisar y no queremos que un campo nuevo rompa el parseo. Lo que no está
// declarado se ignora, no falla.

/** Estado de una transacción, ya normalizado a nuestro vocabulario. */
export type EstadoVenta =
  'aprobada' | 'completa' | 'pendiente' | 'reembolsada' | 'chargeback' | 'cancelada' | 'expirada';

/** Los estados que cuentan como dinero cobrado. */
export const ESTADOS_COBRADOS: readonly EstadoVenta[] = ['aprobada', 'completa'] as const;

/** Los estados en que el dinero se devolvió. */
export const ESTADOS_DEVUELTOS: readonly EstadoVenta[] = ['reembolsada', 'chargeback'] as const;

/** Posición de la venta en el embudo. */
export type TipoVenta =
  'principal' | 'bump' | 'upsell' | 'downsell' | 'suscripcion' | 'sin_clasificar';

/**
 * Cómo se decidió el `tipo`. Se PERSISTE, no solo se calcula.
 *
 * Sin esta columna es imposible auditar por qué una venta cayó en `bump`, ni
 * medir qué porcentaje del catálogo está realmente mapeado antes de que el
 * dashboard confíe en el número. `nombre` es el mecanismo viejo (frágil ante un
 * rename en Hotmart); `oferta` es el bueno.
 */
export type OrigenClasificacion =
  | 'oferta' // purchase.offer.code estaba en el mapa de la pestaña
  | 'order_bump' // purchase.order_bump.is_order_bump === true
  | 'parent_tx' // cuelga de otra transacción ⇒ upsell
  | 'nombre' // coincidencia de patrón sobre el nombre del producto
  | 'sin_clasificar';

/** De dónde salió la fila. Permite re-backfillear sin pisar lo que llega en vivo. */
export type OrigenVenta = 'webhook' | 'api' | 'backfill' | 'reconciliacion';

// ────────────────────────────────────────────────────────────────
// El tipo canónico
// ────────────────────────────────────────────────────────────────

/**
 * Una venta de Hotmart, normalizada. Mapea 1:1 con `public.hotmart_ventas`.
 *
 * Nota sobre los importes: `bruto_usd` y los `neto_*_usd` son `null` cuando no
 * hay tasa de cambio para esa divisa y ese día. NUNCA cero. Es el mismo
 * criterio que `src/lib/fx.ts` y el worker: un cero se suma en silencio y hunde
 * el ROAS; un null se puede reportar.
 */
export type VentaHotmart = {
  transaction_id: string;
  parent_transaction_id: string | null;

  /** Día de calendario en hora Colombia. Se materializa al escribir. */
  fecha_venta: string;
  aprobada_at: string | null;
  orden_at: string | null;

  estado: EstadoVenta;
  /** Instante del evento. Es la guarda de orden contra reentregas de Hotmart. */
  evento_ts: string;
  reembolsada_at: string | null;

  tipo: TipoVenta;
  clasificacion_origen: OrigenClasificacion;
  tab_id: string | null;

  producto_id: string | null;
  producto_nombre: string | null;
  oferta_codigo: string | null;
  es_order_bump: boolean;

  moneda: string | null;
  bruto: number;
  bruto_usd: number | null;
  neto_productor_usd: number | null;
  neto_afiliado_usd: number | null;
  neto_coproductor_usd: number | null;
  usd_rate: number | null;
  pago_tipo: string | null;
  pago_cuotas: number | null;

  comprador_email: string | null;
  comprador_nombre: string | null;
  comprador_telefono: string | null;
  comprador_doc: string | null;
  comprador_pais: string | null;
  checkout_pais: string | null;

  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  utm_id: string | null;
  click_id: string | null;
  src: string | null;
  sck: string | null;
  xcod: string | null;

  raw_payload: unknown | null;
  origen: OrigenVenta;
};

/** Lo que devuelve el parser cuando el payload no es una venta o no se entiende. */
export type ResultadoParseo =
  | { ok: true; venta: VentaHotmart }
  | { ok: false; motivo: 'no_venta'; evento: string }
  | { ok: false; motivo: 'ilegible'; detalle: string };

// ────────────────────────────────────────────────────────────────
// Payload del webhook 2.0.0 (parcial)
// ────────────────────────────────────────────────────────────────

/**
 * Una comisión. Los dos orígenes la anidan distinto y hay que aceptar ambos:
 *
 *   webhook 2.0.0 → { source: 'PRODUCER', value: 97, currency_value: 'BRL' }
 *   sales/commissions → { source: 'PRODUCER', commission: { value, currency_code } }
 *
 * Leer solo una de las dos formas devolvía 0 en silencio para la otra.
 */
export type HotmartComision = {
  /** PRODUCER | AFFILIATE | COPRODUCER | MARKETPLACE */
  source?: string;
  value?: number;
  currency_value?: string;
  currency_code?: string;
  commission?: { value?: number; currency_code?: string; currency_value?: string };
};

export type HotmartPrecio = {
  value?: number;
  currency_value?: string;
  currency_code?: string;
};

export type HotmartCompra = {
  transaction?: string;
  /** Presente en los upsells y en los bumps: la compra de la que cuelgan. */
  parent_purchase_transaction?: string;
  status?: string;
  approved_date?: number | string;
  order_date?: number | string;
  date?: number | string;

  price?: HotmartPrecio;
  full_price?: HotmartPrecio;
  original_offer_price?: HotmartPrecio;

  /** El identificador ESTABLE de la oferta. Sobrevive a renombrar el producto. */
  offer?: { code?: string; key?: string };

  /** El flag REAL de order bump en 2.0.0 (no `is_bump`, que no existe). */
  order_bump?: {
    is_order_bump?: boolean;
    parent_purchase_transaction?: string;
  };

  payment?: {
    type?: string;
    method?: string;
    installments_number?: number;
    refusal_reason?: string;
  };

  commissions?: HotmartComision[];
  checkout_country?: { name?: string; iso?: string };
  /** Ubicación canónica de sck/xcod en 2.0.0. */
  origin?: { xcod?: string; sck?: string; src?: string };
  tracking?: Record<string, unknown>;
  customData?: Record<string, unknown>;
  custom_data?: Record<string, unknown>;

  recurrence_number?: number;
  is_funnel?: boolean;
  business_model?: string;
};

export type HotmartComprador = {
  name?: string;
  email?: string;
  checkout_phone?: string;
  phone?: string;
  document?: string;
  country?: string;
  address?: { country?: string; country_iso?: string; city?: string; state?: string };
};

export type HotmartProducto = {
  id?: number | string;
  ucode?: string;
  name?: string;
};

export type HotmartDatos = {
  purchase?: HotmartCompra;
  buyer?: HotmartComprador;
  product?: HotmartProducto;
  subscription?: { status?: string; plan?: { id?: number | string; name?: string } };
  affiliates?: Array<{ affiliate_code?: string; name?: string }>;
  commissions?: HotmartComision[];
  producer?: { name?: string };
};

export type HotmartWebhook = {
  id?: string;
  event?: string;
  version?: string;
  creation_date?: number | string;
  hottok?: string;
  data?: HotmartDatos;
};

// ────────────────────────────────────────────────────────────────
// Respuestas de la API REST (parcial)
// ────────────────────────────────────────────────────────────────

/** Un item de `GET /payments/api/v1/sales/history`. */
export type ItemHistorial = {
  purchase?: HotmartCompra;
  buyer?: HotmartComprador;
  product?: HotmartProducto;
};

/**
 * Un item de `GET /payments/api/v1/sales/commissions`.
 *
 * Ojo: aquí `transaction` va en la RAÍZ del item, no bajo `purchase` como en
 * `sales/history`. Se aceptan las dos ubicaciones para no depender de ello.
 */
export type ItemComisiones = {
  transaction?: string;
  purchase?: { transaction?: string };
  product?: HotmartProducto;
  commissions?: HotmartComision[];
};

/** Envoltorio paginado común a los endpoints de Hotmart. */
export type PaginaHotmart<T> = {
  items?: T[];
  page_info?: { next_page_token?: string; total_results?: number };
  error?: unknown;
  message?: unknown;
};
