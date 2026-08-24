// ════════════════════════════════════════════════════════════════
// Sincronización y agregación de ventas de Hotmart
// ════════════════════════════════════════════════════════════════
//
// Sustituye a `fetchHotmart` (`worker/route.ts:1616-1886`, ~270 líneas inline)
// partiéndolo en dos pasos que antes estaban entrelazados:
//
//   1. sincronizarDiaHotmart  → trae de la API y PERSISTE en hotmart_ventas.
//   2. agregarDesdeHotmartVentas → lee la tabla y produce el registro diario.
//                                   NUNCA llama a la API.
//
// Separarlos es lo que permite reclasificar un histórico (cambiar el mapa de
// ofertas y volver a agregar) sin gastar una sola petición a Hotmart.
//
// ── DOS CAMBIOS DE FONDO FRENTE AL WORKER ANTERIOR ──────────────
//
//  a) Se QUITA el filtro `transaction_status=APPROVED&COMPLETE`
//     (`worker/route.ts:1656-1657`). Con él, una venta reembolsada al día
//     siguiente seguía contando como facturación PARA SIEMPRE — ni el cierre de
//     mes la veía, porque repide el mes con el mismo filtro. Ahora entran todos
//     los estados y es la AGREGACIÓN la que decide qué cuenta como cobrado.
//
//  b) Se retiene el item COMPLETO, no solo `{transaction, price}`. De ahí salen
//     `offer.code`, `order_bump`, método de pago, país de checkout y comprador.
//
// ── LA TRAMPA NUEVA, Y SU DEFENSA ───────────────────────────────
// Con una tabla intermedia, un fallo a media paginación deja `hotmart_ventas`
// PARCIALMENTE escrita, y la agregación devolvería un número bajo pero distinto
// de cero — que se colaría por la guarda `hotmartInconsistent` del worker, que
// solo mira si el conteo es 0.
//
// Por eso `agregarDesdeHotmartVentas` NO se llama si `completo === false`: el
// worker devuelve un registro vacío con `apiSuccess: false` y su red de
// seguridad omite los campos del upsert, preservando lo que ya había.

import { colombiaToday } from '../colombia-date';
import { paginarHotmart, ventanaDiaColombia } from './cliente';
import type { FamiliaErrorHotmart } from './cliente';
import { parsearApi } from './parser';
import { convertirLote } from './moneda';
import { clasificarLote, guardarLote } from './persistencia';
import { ESTADOS_COBRADOS, ESTADOS_DEVUELTOS } from './tipos';
import type { FunnelHotmart } from './clasificador';
import type { EstadoVenta, ItemComisiones, ItemHistorial, VentaHotmart } from './tipos';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any;

export type DesgloseFunnel = {
  principal: { count: number; gross: number; net: number };
  bump: { count: number; gross: number; net: number };
  upsell: { count: number; gross: number; net: number; page_visits: number };
  downsell: { count: number; gross: number; net: number };
  pagos_iniciados: number;
  landing_sessions: number;
};

/**
 * Registro diario de Hotmart. Es lo que consume el upsert de `metricas_diarias`.
 *
 * Mantiene los nombres del worker para no tocar su payload, y añade `downsell`
 * y `reembolsado`, que no existían.
 */
export type RegistroHotmart = {
  principal: number;
  bump: number;
  upsell: number;
  downsell: number;
  principal_count: number;
  bump_count: number;
  upsell_count: number;
  downsell_count: number;
  principal_bruto: number;
  bump_bruto: number;
  upsell_bruto: number;
  downsell_bruto: number;
  ventas_count: number;
  /** Neto de las ventas de ESTE día que acabaron devueltas. */
  reembolsado: number;
  reembolsado_count: number;
  affiliate_net: number;
  affiliate_count: number;
  coproducer_net: number;
  by_tab: Record<string, DesgloseFunnel>;
  extras: Array<{ product_name: string; count: number; gross: number; net: number }>;
  /** false = la API falló o se agotó el tope de páginas → NO pisar la BD con ceros. */
  apiSuccess: boolean;
  /**
   * Familia del fallo cuando `apiSuccess` es `false`. Llega hasta el `reason`
   * de la alerta y el título de la notificación: sin ella, un 400 por
   * parámetros y un 401 por credencial caducada se avisaban con el mismo
   * texto ("posible desconexión"), que no dice qué hay que arreglar.
   */
  familia?: FamiliaErrorHotmart;
  unconverted_count: number;
  monedas: string[];
  /** % de ventas del día clasificadas sin recurrir al nombre del producto. */
  cobertura_pct: number;
};

export function desgloseVacio(): DesgloseFunnel {
  return {
    principal: { count: 0, gross: 0, net: 0 },
    bump: { count: 0, gross: 0, net: 0 },
    upsell: { count: 0, gross: 0, net: 0, page_visits: 0 },
    downsell: { count: 0, gross: 0, net: 0 },
    pagos_iniciados: 0,
    landing_sessions: 0,
  };
}

export function registroVacio(): RegistroHotmart {
  return {
    principal: 0,
    bump: 0,
    upsell: 0,
    downsell: 0,
    principal_count: 0,
    bump_count: 0,
    upsell_count: 0,
    downsell_count: 0,
    principal_bruto: 0,
    bump_bruto: 0,
    upsell_bruto: 0,
    downsell_bruto: 0,
    ventas_count: 0,
    reembolsado: 0,
    reembolsado_count: 0,
    affiliate_net: 0,
    affiliate_count: 0,
    coproducer_net: 0,
    by_tab: {},
    extras: [],
    apiSuccess: true,
    unconverted_count: 0,
    monedas: [],
    cobertura_pct: 100,
  };
}

// ────────────────────────────────────────────────────────────────
// 1. Traer de la API y persistir
// ────────────────────────────────────────────────────────────────

export type ResultadoSync = {
  /** `true` solo si se consumieron TODAS las páginas de AMBOS endpoints. */
  completo: boolean;
  motivo?: string;
  /** Familia del fallo (`parametros`, `credenciales`, …) cuando `completo` es `false`. */
  familia?: FamiliaErrorHotmart;
  ventas: number;
  escritas: number;
  descartadas: number;
  sin_tasa: number;
  monedas: string[];
};

/**
 * Trae las ventas de un día y las persiste.
 *
 * `completo` es la señal que el worker convierte en `apiSuccess`. Vale `false`
 * ante cualquiera de las cinco situaciones que ya vigilaba el código anterior:
 * error de API, tope de páginas o `next_page_token` repetido, en cualquiera de
 * los dos endpoints.
 */
export async function sincronizarDiaHotmart(
  db: Db,
  clienteId: string,
  fecha: string,
  token: string,
  funnels: FunnelHotmart[],
  log: (msg: string) => void = () => {},
  /**
   * `persistir: false` sondea la API sin escribir NI UNA fila. Es el modo
   * `--contar` del script de backfill: dimensionar el volumen antes de tocar
   * una base que está en 449 MB de 500 MB.
   */
  opts: { persistir?: boolean } = {}
): Promise<ResultadoSync> {
  const persistir = opts.persistir !== false;
  const { inicio, fin } = ventanaDiaColombia(fecha);
  const rango: Array<[string, string]> = [
    ['start_date', String(inicio)],
    ['end_date', String(fin)],
    ['max_results', '100'],
  ];

  // PASO 1 — historial. SIN filtro de estado: es lo que hace que los
  // reembolsos existan.
  const historial = await paginarHotmart<ItemHistorial>({
    ruta: '/payments/api/v1/sales/history',
    params: rango,
    token,
    log,
  });

  // PASO 2 — comisiones. Es lo único que dice cuánto se cobró de verdad.
  const comisiones = await paginarHotmart<ItemComisiones>({
    ruta: '/payments/api/v1/sales/commissions',
    params: rango,
    token,
    log,
  });

  const completo = historial.completo && comisiones.completo;
  const motivo = historial.motivo ?? comisiones.motivo;
  const familia = historial.familia ?? comisiones.familia;

  const porTx = new Map<string, ItemComisiones>();
  for (const c of comisiones.items) {
    const tx = c.transaction ?? c.purchase?.transaction;
    if (tx) porTx.set(String(tx), c);
  }

  const ventas: VentaHotmart[] = [];
  for (const item of historial.items) {
    const tx = item.purchase?.transaction;
    const r = parsearApi(item, tx ? porTx.get(String(tx)) : undefined, { origen: 'api' });
    if (r.ok) ventas.push(r.venta);
  }

  if (ventas.length === 0) {
    return {
      completo,
      motivo,
      familia,
      ventas: 0,
      escritas: 0,
      descartadas: 0,
      sin_tasa: 0,
      monedas: [],
    };
  }

  if (!persistir) {
    return {
      completo,
      motivo,
      familia,
      ventas: ventas.length,
      escritas: 0,
      descartadas: 0,
      sin_tasa: 0,
      monedas: [],
    };
  }

  clasificarLote(ventas, funnels);
  const fx = await convertirLote(db, ventas, fecha);
  const guardado = await guardarLote(db, clienteId, ventas);

  if (fx.sin_tasa > 0) {
    log(
      `[Hotmart] ${fecha} ${fx.sin_tasa} importe(s) sin tasa de cambio (monedas: ${fx.monedas.join(', ')}) — quedaron fuera del total.`
    );
  }

  return {
    completo,
    motivo,
    familia,
    ventas: ventas.length,
    escritas: guardado.escritas,
    descartadas: guardado.descartadas,
    sin_tasa: fx.sin_tasa,
    monedas: fx.monedas,
  };
}

// ────────────────────────────────────────────────────────────────
// 2. Agregar desde la tabla
// ────────────────────────────────────────────────────────────────

type FilaVenta = {
  tipo: string;
  tab_id: string | null;
  estado: EstadoVenta;
  clasificacion_origen: string;
  producto_nombre: string | null;
  moneda: string | null;
  bruto: number | string | null;
  bruto_usd: number | string | null;
  neto_productor_usd: number | string | null;
  neto_afiliado_usd: number | string | null;
  neto_coproductor_usd: number | string | null;
};

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Construye el registro diario leyendo `hotmart_ventas`. No toca la API.
 *
 * El comportamiento heredado que se conserva a propósito:
 *   • `principal_price_usd` de la pestaña sustituye al bruto de la API cuando
 *     está configurado (`worker/route.ts:1824`).
 *   • Los productos sin clasificar van a `extras[]`, con su nombre.
 *   • Un importe sin tasa de cambio NO se suma como 0: se cuenta aparte.
 */
export async function agregarDesdeHotmartVentas(
  db: Db,
  clienteId: string,
  fecha: string,
  funnels: FunnelHotmart[]
): Promise<RegistroHotmart> {
  const registro = registroVacio();
  for (const f of funnels) registro.by_tab[f.tab_id] = desgloseVacio();

  const { data, error } = await db
    .from('hotmart_ventas')
    .select(
      'tipo, tab_id, estado, clasificacion_origen, producto_nombre, moneda, bruto, bruto_usd, neto_productor_usd, neto_afiliado_usd, neto_coproductor_usd'
    )
    .eq('cliente_id', clienteId)
    .eq('fecha_venta', fecha);

  if (error) throw new Error(`agregarDesdeHotmartVentas: ${error.message}`);

  const filas: FilaVenta[] = data ?? [];
  const precioPorTab = new Map<string, number | undefined>(
    funnels.map((f) => [f.tab_id, f.principal_price_usd])
  );
  const extras = new Map<string, { count: number; gross: number; net: number }>();
  const monedas = new Set<string>();
  let clasificadas = 0;

  for (const fila of filas) {
    if (fila.moneda && fila.moneda.toUpperCase() !== 'USD') monedas.add(fila.moneda.toUpperCase());
    if (fila.clasificacion_origen !== 'sin_clasificar') clasificadas++;

    const cobrada = ESTADOS_COBRADOS.includes(fila.estado);
    const devuelta = ESTADOS_DEVUELTOS.includes(fila.estado);

    // Un importe sin tasa no se suma como cero: se cuenta y se reporta.
    if (fila.bruto_usd == null && num(fila.bruto) !== 0) registro.unconverted_count++;

    const neto = num(fila.neto_productor_usd);
    const bruto = num(fila.bruto_usd);

    if (devuelta) {
      // Se imputa a la fecha de la VENTA, no a la del reembolso: es lo que
      // hace que el ROAS de la campaña refleje lo que de verdad dejó.
      registro.reembolsado += neto;
      registro.reembolsado_count++;
      continue;
    }
    if (!cobrada) continue; // pendiente / expirada / cancelada: aún no es dinero

    registro.ventas_count++;
    registro.affiliate_net += num(fila.neto_afiliado_usd);
    if (num(fila.neto_afiliado_usd) > 0) registro.affiliate_count++;
    registro.coproducer_net += num(fila.neto_coproductor_usd);

    const tab = fila.tab_id && registro.by_tab[fila.tab_id] ? fila.tab_id : null;

    switch (fila.tipo) {
      case 'principal': {
        // El precio configurado de la pestaña manda sobre el bruto de la
        // API cuando existe.
        const precio = tab ? precioPorTab.get(tab) : undefined;
        const brutoPrincipal = precio ?? bruto;
        registro.principal += neto;
        registro.principal_count++;
        registro.principal_bruto += brutoPrincipal;
        if (tab) {
          registro.by_tab[tab].principal.count++;
          registro.by_tab[tab].principal.net += neto;
          registro.by_tab[tab].principal.gross += brutoPrincipal;
        }
        break;
      }
      case 'bump':
      case 'upsell':
      case 'downsell': {
        const k = fila.tipo as 'bump' | 'upsell' | 'downsell';
        registro[k] += neto;
        registro[`${k}_count` as const]++;
        registro[`${k}_bruto` as const] += bruto;
        if (tab) {
          registro.by_tab[tab][k].count++;
          registro.by_tab[tab][k].net += neto;
          registro.by_tab[tab][k].gross += bruto;
        }
        break;
      }
      default: {
        // Sin clasificar o suscripción → extras, igual que antes.
        const key = fila.producto_nombre?.trim() || '(Sin nombre)';
        const cur = extras.get(key) ?? { count: 0, gross: 0, net: 0 };
        cur.count++;
        cur.net += neto;
        cur.gross += bruto;
        extras.set(key, cur);
      }
    }
  }

  for (const [product_name, vals] of extras) registro.extras.push({ product_name, ...vals });
  registro.monedas = Array.from(monedas);
  registro.cobertura_pct =
    filas.length === 0 ? 100 : Math.round((clasificadas / filas.length) * 1000) / 10;

  return registro;
}

// ────────────────────────────────────────────────────────────────
// 3. Reclasificar sin llamar a la API
// ────────────────────────────────────────────────────────────────

/**
 * Reescribe `tipo` / `tab_id` / `clasificacion_origen` de un rango ya
 * almacenado.
 *
 * Es lo que se ejecuta cuando alguien asigna una oferta en la UI: cambia la
 * clasificación de todo el histórico sin gastar una sola petición a Hotmart.
 */
export async function reclasificarRango(
  db: Db,
  clienteId: string,
  desde: string,
  hasta: string,
  funnels: FunnelHotmart[]
): Promise<{ revisadas: number; cambiadas: number }> {
  const { data, error } = await db
    .from('hotmart_ventas')
    .select(
      'id, oferta_codigo, es_order_bump, parent_transaction_id, producto_nombre, tipo, tab_id, clasificacion_origen'
    )
    .eq('cliente_id', clienteId)
    .gte('fecha_venta', desde)
    .lte('fecha_venta', hasta);

  if (error) throw new Error(`reclasificarRango: ${error.message}`);

  const filas = data ?? [];
  const copia = filas.map((f: Record<string, unknown>) => ({ ...f })) as unknown as VentaHotmart[];
  clasificarLote(copia, funnels);

  let cambiadas = 0;
  for (let i = 0; i < filas.length; i++) {
    const antes = filas[i];
    const ahora = copia[i];
    if (
      antes.tipo === ahora.tipo &&
      antes.tab_id === ahora.tab_id &&
      antes.clasificacion_origen === ahora.clasificacion_origen
    )
      continue;
    await db
      .from('hotmart_ventas')
      .update({
        tipo: ahora.tipo,
        tab_id: ahora.tab_id,
        clasificacion_origen: ahora.clasificacion_origen,
        actualizado_at: new Date().toISOString(),
      })
      .eq('id', antes.id);
    cambiadas++;
  }
  return { revisadas: filas.length, cambiadas };
}

// ────────────────────────────────────────────────────────────────
// 4. Reconciliación de reembolsos
// ────────────────────────────────────────────────────────────────

/**
 * Reescanea una ventana móvil buscando reembolsos y chargebacks.
 *
 * Hace falta una pasada aparte porque `start_date`/`end_date` de la API filtran
 * por FECHA DE COMPRA, no por fecha de cambio de estado: un reembolso de hoy
 * sobre una compra de hace un mes NO aparece al pedir hoy.
 *
 * Solo toca el estado. Los importes se conservan intactos, que es lo que
 * permite calcular la tasa de reembolso en vez de perder la venta.
 */
export async function reconciliarReembolsos(
  db: Db,
  clienteId: string,
  token: string,
  dias = 90,
  log: (msg: string) => void = () => {}
): Promise<{ completo: boolean; revisadas: number; actualizadas: number; fechas: string[] }> {
  const hasta = colombiaToday();
  const desdeMs = new Date(`${hasta}T23:59:59.999-05:00`).getTime() - dias * 24 * 60 * 60 * 1000;
  const { fin } = ventanaDiaColombia(hasta);

  const params: Array<[string, string]> = [
    ['start_date', String(desdeMs)],
    ['end_date', String(fin)],
    ['max_results', '100'],
    ['transaction_status', 'REFUNDED'],
    ['transaction_status', 'CHARGEBACK'],
    ['transaction_status', 'CANCELLED'],
  ];

  const res = await paginarHotmart<ItemHistorial>({
    ruta: '/payments/api/v1/sales/history',
    params,
    token,
    // Ventana larga: el tope se sube porque son 90 días, no uno.
    maxPaginas: 120,
    log,
  });

  const fechas = new Set<string>();
  let actualizadas = 0;

  for (const item of res.items) {
    const r = parsearApi(item, undefined, { origen: 'reconciliacion' });
    if (!r.ok) continue;
    const v = r.venta;

    const { data: existente } = await db
      .from('hotmart_ventas')
      .select('id, estado, fecha_venta')
      .eq('cliente_id', clienteId)
      .eq('transaction_id', v.transaction_id)
      .maybeSingle();

    if (!existente) continue;
    if (existente.estado === v.estado) continue;

    await db
      .from('hotmart_ventas')
      .update({
        estado: v.estado,
        reembolsada_at: v.reembolsada_at ?? v.evento_ts,
        evento_ts: v.evento_ts,
        origen: 'reconciliacion',
        actualizado_at: new Date().toISOString(),
      })
      .eq('id', existente.id);

    actualizadas++;
    fechas.add(existente.fecha_venta);
  }

  log(
    `[Hotmart] Reconciliación: ${res.items.length} revisadas, ${actualizadas} actualizadas, ${fechas.size} fecha(s) a reagregar.`
  );
  return {
    completo: res.completo,
    revisadas: res.items.length,
    actualizadas,
    fechas: Array.from(fechas).sort(),
  };
}
