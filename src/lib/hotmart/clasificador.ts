// ════════════════════════════════════════════════════════════════
// Clasificador de ventas: principal / bump / upsell / downsell
// ════════════════════════════════════════════════════════════════
//
// ── El problema que resuelve ────────────────────────────────────
// Hasta ahora había dos clasificadores, los dos malos:
//
//   • El webhook miraba `purchase.is_bump` / `purchase.is_upsell` — claves que
//     NO EXISTEN en el payload 2.0.0. `transaction_type` era siempre
//     'principal' y la dimensión del BI no distinguía nada.
//
//   • El worker comparaba el NOMBRE del producto contra patrones tipo LIKE
//     guardados en `cliente_tabs.hotmart_funnel`. Funciona, pero se rompe en
//     silencio en cuanto alguien renombra un producto en Hotmart: esas ventas
//     caen a `extras[]` y desaparecen de `ventas_principal/bump/upsell`.
//
// Y `downsell` no existía en ninguno de los dos, ni en ninguna parte del repo.
//
// ── La cascada ──────────────────────────────────────────────────
// 1. `offer.code` en el mapa de la pestaña → identificador ESTABLE de la oferta.
//    Sobrevive a renombrar el producto, que es justo lo que rompía el mecanismo
//    anterior.
// 2. `order_bump.is_order_bump` → bump. Es el flag real de la plataforma.
// 3. `parent_purchase_transaction` presente → cuelga de otra compra, luego es un
//    upsell (los bumps ya se han filtrado en el paso 2).
// 4. Patrones de nombre — el mecanismo viejo, intacto, como red de seguridad
//    para los clientes que todavía no han mapeado sus ofertas.
// 5. `sin_clasificar`.
//
// `clasificacion_origen` se PERSISTE para poder auditar por qué una venta cayó
// donde cayó y para medir la cobertura del mapa antes de que el dashboard
// confíe en el número.

import type { OrigenClasificacion, TipoVenta, VentaHotmart } from './tipos';

/** Configuración de embudo de una pestaña (`cliente_tabs.hotmart_funnel`). */
export type FunnelHotmart = {
  tab_id: string;
  /** Patrones tipo LIKE sobre el nombre del producto. Mecanismo heredado. */
  principal_patterns: string[];
  bump_patterns: string[];
  upsell_patterns: string[];
  downsell_patterns: string[];
  /** Códigos de oferta. Ganan sobre los patrones de nombre. */
  principal_offers: string[];
  bump_offers: string[];
  upsell_offers: string[];
  downsell_offers: string[];
  /** Siempre un array (`leerFunnel` normaliza): el worker itera sobre él sin guardas. */
  landing_page_urls: string[];
  payment_page_url?: string;
  upsell_page_url?: string;
  principal_price_usd?: number;
};

export type ResultadoClasificacion = {
  tipo: TipoVenta;
  tab_id: string | null;
  origen: OrigenClasificacion;
};

/**
 * Coincidencia estilo SQL LIKE: `%` = `.*`, `_` = `.`, sin distinguir mayúsculas.
 *
 * Movido literalmente desde `worker/route.ts:513` — incluido el detalle de que
 * un patrón sin comodines se compara por igualdad exacta y no por `includes`.
 * Cambiarlo aquí reclasificaría ventas históricas.
 */
export function matchesAny(name: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const lower = name.toLowerCase();
  for (const p of patterns) {
    if (!p) continue;
    if (!p.includes('%') && !p.includes('_')) {
      if (lower === p) return true;
    } else {
      const regexStr = p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')
        .replace(/_/g, '.');
      const re = new RegExp(`^${regexStr}$`, 'i');
      if (re.test(lower)) return true;
    }
  }
  return false;
}

/** Normaliza una lista de patrones de nombre igual que hace el worker. */
export function limpiarPatrones(arr: unknown): string[] {
  return Array.isArray(arr)
    ? arr
        .map((s) =>
          String(s ?? '')
            .toLowerCase()
            .trim()
        )
        .filter(Boolean)
    : [];
}

/** Normaliza una lista de códigos de oferta (sensibles a mayúsculas en Hotmart). */
export function limpiarOfertas(arr: unknown): string[] {
  return Array.isArray(arr) ? arr.map((s) => String(s ?? '').trim()).filter(Boolean) : [];
}

/**
 * Lee un `cliente_tabs.hotmart_funnel` crudo.
 *
 * Aditivo y retrocompatible: un funnel sin las claves `*_offers` ni
 * `downsell_names` se comporta EXACTAMENTE igual que antes de este cambio. Es
 * lo que comprueba el assert de antirregresión de
 * `scripts/verify-hotmart-clasificador.ts`.
 */
export function leerFunnel(tabId: string, crudo: unknown): FunnelHotmart | null {
  if (!crudo || typeof crudo !== 'object') return null;
  const f = crudo as Record<string, unknown>;
  if (!f.enabled) return null;
  return {
    tab_id: tabId,
    principal_patterns: limpiarPatrones(f.principal_names),
    bump_patterns: limpiarPatrones(f.bump_names),
    upsell_patterns: limpiarPatrones(f.upsell_names),
    downsell_patterns: limpiarPatrones(f.downsell_names),
    principal_offers: limpiarOfertas(f.principal_offers),
    bump_offers: limpiarOfertas(f.bump_offers),
    upsell_offers: limpiarOfertas(f.upsell_offers),
    downsell_offers: limpiarOfertas(f.downsell_offers),
    landing_page_urls: Array.isArray(f.landing_page_urls)
      ? f.landing_page_urls.map((s) => String(s).trim()).filter(Boolean)
      : [],
    payment_page_url: (f.payment_page_url as string) || undefined,
    upsell_page_url: (f.upsell_page_url as string) || undefined,
    principal_price_usd: f.principal_price_usd ? Number(f.principal_price_usd) : undefined,
  };
}

const SIN_CLASIFICAR: ResultadoClasificacion = {
  tipo: 'sin_clasificar',
  tab_id: null,
  origen: 'sin_clasificar',
};

/** Los cuatro roles, en el orden en que se prueban. El orden importa. */
const ROLES: ReadonlyArray<{
  tipo: TipoVenta;
  ofertas: keyof FunnelHotmart;
  patrones: keyof FunnelHotmart;
}> = [
  { tipo: 'principal', ofertas: 'principal_offers', patrones: 'principal_patterns' },
  { tipo: 'bump', ofertas: 'bump_offers', patrones: 'bump_patterns' },
  { tipo: 'upsell', ofertas: 'upsell_offers', patrones: 'upsell_patterns' },
  { tipo: 'downsell', ofertas: 'downsell_offers', patrones: 'downsell_patterns' },
];

/**
 * Clasifica una venta contra los embudos configurados del cliente.
 *
 * Los embudos se recorren en orden y el PRIMER match gana, igual que el `break`
 * del worker. Un producto que encaje en dos pestañas se asigna a la primera.
 */
export function clasificarVenta(
  venta: Pick<
    VentaHotmart,
    'oferta_codigo' | 'es_order_bump' | 'parent_transaction_id' | 'producto_nombre'
  >,
  funnels: FunnelHotmart[]
): ResultadoClasificacion {
  // ── 1. Por código de oferta. El camino bueno ────────────────
  const oferta = venta.oferta_codigo?.trim();
  if (oferta) {
    for (const f of funnels) {
      for (const rol of ROLES) {
        const codigos = f[rol.ofertas] as string[];
        if (codigos.includes(oferta)) {
          return { tipo: rol.tipo, tab_id: f.tab_id, origen: 'oferta' };
        }
      }
    }
  }

  // ── 2. El flag real de order bump de la plataforma ──────────
  // Sin oferta mapeada no sabemos a qué pestaña pertenece, pero el TIPO sí es
  // seguro. Un tipo correcto sin pestaña vale más que `sin_clasificar`.
  if (venta.es_order_bump) {
    return {
      tipo: 'bump',
      tab_id: tabPorNombre(venta.producto_nombre, funnels),
      origen: 'order_bump',
    };
  }

  // ── 3. Cuelga de otra compra y no es bump ⇒ upsell ──────────
  if (venta.parent_transaction_id) {
    return {
      tipo: 'upsell',
      tab_id: tabPorNombre(venta.producto_nombre, funnels),
      origen: 'parent_tx',
    };
  }

  // ── 4. Patrones de nombre. El mecanismo heredado ────────────
  const nombre = (venta.producto_nombre ?? '').trim();
  if (nombre) {
    for (const f of funnels) {
      for (const rol of ROLES) {
        if (matchesAny(nombre, f[rol.patrones] as string[])) {
          return { tipo: rol.tipo, tab_id: f.tab_id, origen: 'nombre' };
        }
      }
    }
  }

  return SIN_CLASIFICAR;
}

/** Pestaña a la que pertenece un producto por nombre, si alguna lo reclama. */
function tabPorNombre(nombre: string | null, funnels: FunnelHotmart[]): string | null {
  const n = (nombre ?? '').trim();
  if (!n) return null;
  for (const f of funnels) {
    for (const rol of ROLES) {
      if (matchesAny(n, f[rol.patrones] as string[])) return f.tab_id;
    }
  }
  return null;
}

/**
 * Cobertura del mapa de ofertas: qué porcentaje de ventas se clasificó sin
 * recurrir al nombre del producto.
 *
 * Es la métrica que decide si el agregado del dashboard puede confiar en el
 * `tipo`. Por debajo del 95% el panel avisa antes de que nadie tome decisiones
 * con esos números.
 */
export function cobertura(ventas: Array<Pick<VentaHotmart, 'clasificacion_origen'>>): {
  total: number;
  clasificadas: number;
  porOferta: number;
  pct: number;
} {
  const total = ventas.length;
  const clasificadas = ventas.filter((v) => v.clasificacion_origen !== 'sin_clasificar').length;
  const porOferta = ventas.filter((v) => v.clasificacion_origen === 'oferta').length;
  return {
    total,
    clasificadas,
    porOferta,
    pct: total === 0 ? 100 : Math.round((clasificadas / total) * 1000) / 10,
  };
}
