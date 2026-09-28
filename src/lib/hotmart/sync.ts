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

import { addDaysISO, colombiaToday } from '../colombia-date';
import { conZonaDeCliente } from '@/lib/zona-activa';
import { fetchAllRows } from '../supabase-paginate';
import { paginarHotmart, ventanaDiaColombia } from './cliente';
import type { FamiliaErrorHotmart } from './cliente';
import { parsearApi } from './parser';
import { convertirLote } from './moneda';
import { clasificarLote, guardarLote } from './persistencia';
import { atribuirLote } from './atribucion-db';
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
  /** Items con un `status` que no sabemos traducir: no se guardan (ver parser). */
  desconocidas?: number;
  /**
   * Fechas cuyo agregado cambió: la `fecha_venta` de lo escrito MÁS la fecha
   * anterior de las ventas que se movieron de día (una aprobación posterior a
   * la orden). El worker agrega la fecha pedida; las demás hay que reagregarlas
   * aparte o la venta cuenta en los dos días.
   */
  fechasTocadas?: string[];
};

/**
 * Estados que se piden EXPLÍCITAMENTE a `sales/history`.
 *
 * Sin `transaction_status`, la API solo devuelve las ventas COMPLETE (sondeo
 * del 2026-09-25 con `diagnostico-hotmart --estados`: 88 de 88, cero
 * REFUNDED/CANCELLED/EXPIRED). O sea que la sync diaria NUNCA veía un
 * reembolso; solo la reconciliación semanal. La API acepta el parámetro
 * repetido y devuelve la unión.
 *
 * OJO: un solo valor inválido tumba la petición entera con 400
 * `invalid_parameter` — `BILLET_PRINTED` lo es (el válido es `PRINTED_BILLET`)
 * y así empezó el incidente del 2026-08-18. Todos los de esta lista dieron 200
 * en el sondeo. Si Hotmart retira alguno, `sincronizarDiaHotmart` reintenta sin
 * filtro para no quedarse ciego.
 */
export const ESTADOS_API_SYNC = [
  'APPROVED',
  'COMPLETE',
  'REFUNDED',
  'CHARGEBACK',
  'PARTIALLY_REFUNDED',
  'PROTESTED',
  'CANCELLED',
  'EXPIRED',
  'NO_FUNDS',
  'BLOCKED',
  'OVERDUE',
  'WAITING_PAYMENT',
  'PRINTED_BILLET',
  'PROCESSING_TRANSACTION',
  'PRE_ORDER',
  'UNDER_ANALISYS',
  'STARTED',
] as const;

export function paramsDeEstados(estados: readonly string[]): Array<[string, string]> {
  return estados.map((e) => ['transaction_status', e] as [string, string]);
}

/**
 * Trae las ventas de un día y las persiste.
 *
 * `completo` es la señal que el worker convierte en `apiSuccess`. Vale `false`
 * ante cualquiera de las cinco situaciones que ya vigilaba el código anterior:
 * error de API, tope de páginas o `next_page_token` repetido, en cualquiera de
 * los dos endpoints.
 */
/**
 * La zona horaria del cliente decide la ventana del día que se pide a la API y
 * el `fecha_venta` que se materializa (zona-activa.ts). Las tres funciones que
 * reciben un cliente corren dentro de su zona; el cuerpo está en las `*EnZona`.
 */
export async function sincronizarDiaHotmart(
  ...args: Parameters<typeof sincronizarDiaHotmartEnZona>
): ReturnType<typeof sincronizarDiaHotmartEnZona> {
  return conZonaDeCliente({ publico: args[1] }, () => sincronizarDiaHotmartEnZona(...args));
}

export async function reconciliarReembolsos(
  ...args: Parameters<typeof reconciliarReembolsosEnZona>
): ReturnType<typeof reconciliarReembolsosEnZona> {
  return conZonaDeCliente({ publico: args[1] }, () => reconciliarReembolsosEnZona(...args));
}

export async function barrerAprobacionesTardias(
  ...args: Parameters<typeof barrerAprobacionesTardiasEnZona>
): ReturnType<typeof barrerAprobacionesTardiasEnZona> {
  return conZonaDeCliente({ publico: args[1] }, () => barrerAprobacionesTardiasEnZona(...args));
}

async function sincronizarDiaHotmartEnZona(
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

  // PASO 1 — historial, pidiendo TODOS los estados (ver `ESTADOS_API_SYNC`):
  // sin la lista, la API solo devuelve las COMPLETE y los reembolsos no
  // existen para la sync diaria.
  let historial = await paginarHotmart<ItemHistorial>({
    ruta: '/payments/api/v1/sales/history',
    params: [...rango, ...paramsDeEstados(ESTADOS_API_SYNC)],
    token,
    log,
  });
  if (!historial.completo && historial.familia === 'parametros') {
    log(
      `[Hotmart] ${fecha} la lista de estados dio «parámetro inválido» — se repite sin filtro (solo COMPLETE). Revisa ESTADOS_API_SYNC con diagnostico-hotmart --estados.`
    );
    historial = await paginarHotmart<ItemHistorial>({
      ruta: '/payments/api/v1/sales/history',
      params: rango,
      token,
      log,
    });
  }

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
  let desconocidas = 0;
  for (const item of historial.items) {
    const tx = item.purchase?.transaction;
    const r = parsearApi(item, tx ? porTx.get(String(tx)) : undefined, { origen: 'api' });
    if (r.ok) ventas.push(r.venta);
    else if (r.motivo === 'ilegible' && r.detalle.startsWith('status desconocido')) desconocidas++;
  }
  if (desconocidas > 0) {
    log(
      `[Hotmart] ${fecha} ${desconocidas} transacción(es) con un status desconocido — NO se cuentan. Añádelo a ESTADO_POR_STATUS_API (eventos.ts).`
    );
  }

  const vacio = {
    completo,
    motivo,
    familia,
    escritas: 0,
    descartadas: 0,
    sin_tasa: 0,
    monedas: [],
    desconocidas,
    fechasTocadas: [],
  };
  if (ventas.length === 0) return { ...vacio, ventas: 0 };
  if (!persistir) return { ...vacio, ventas: ventas.length };

  clasificarLote(ventas, funnels);
  // Atribución por lead ANTES de guardar: la tupla viaja en la misma
  // escritura. Sin la migración 089 no hace nada.
  await atribuirLote(db, clienteId, ventas, log);
  // La tasa diaria de las monedas de REPORTE ya no se precarga aquí: solo
  // corría los días con ventas, y un cliente sin ventas se quedaba sin tasas.
  // La guarda `capturarTasasDelDia` al inicio de cada corrida del worker.
  const fx = await convertirLote(db, ventas, fecha);

  // La fecha que tenían ANTES las ventas que ya existían: si una aprobación
  // la mueve, el día viejo también hay que reagregarlo.
  const fechasTocadas = new Set<string>(ventas.map((v) => v.fecha_venta));
  const { data: previas } = await db
    .from('hotmart_ventas')
    .select('transaction_id, fecha_venta')
    .eq('cliente_id', clienteId)
    .in(
      'transaction_id',
      ventas.map((v) => v.transaction_id)
    );
  for (const p of previas ?? []) if (p?.fecha_venta) fechasTocadas.add(String(p.fecha_venta));

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
    desconocidas,
    fechasTocadas: Array.from(fechasTocadas).sort(),
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

  // Paginado: PostgREST corta en 1.000 filas y un día de lanzamiento puede
  // pasar de ahí. `estricto`: un agregado a medias sustituiría uno correcto.
  const filas = (await fetchAllRows(
    () =>
      db
        .from('hotmart_ventas')
        .select(
          'id, tipo, tab_id, estado, clasificacion_origen, producto_nombre, moneda, bruto, bruto_usd, neto_productor_usd, neto_afiliado_usd, neto_coproductor_usd'
        )
        .eq('cliente_id', clienteId)
        .eq('fecha_venta', fecha),
    1000,
    200000,
    { estricto: true }
  )) as unknown as FilaVenta[];
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
): Promise<{ revisadas: number; cambiadas: number; fechas: string[] }> {
  const filas = (await fetchAllRows(
    () =>
      db
        .from('hotmart_ventas')
        .select(
          'id, fecha_venta, oferta_codigo, es_order_bump, parent_transaction_id, producto_nombre, tipo, tab_id, clasificacion_origen'
        )
        .eq('cliente_id', clienteId)
        .gte('fecha_venta', desde)
        .lte('fecha_venta', hasta),
    1000,
    200000,
    { estricto: true }
  )) as Array<Record<string, any>>;

  const copia = filas.map((f) => ({ ...f })) as unknown as VentaHotmart[];
  clasificarLote(copia, funnels);

  let cambiadas = 0;
  // Las fechas cuyo agregado cambia: el llamante las reagrega. Antes el
  // dashboard seguía con la clasificación vieja hasta que el worker volviera a
  // descargar ESE día, cosa que para el histórico no pasaba nunca.
  const fechas = new Set<string>();
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
      .eq('cliente_id', clienteId)
      .eq('id', antes.id);
    cambiadas++;
    if (antes.fecha_venta) fechas.add(String(antes.fecha_venta));
  }
  return { revisadas: filas.length, cambiadas, fechas: Array.from(fechas).sort() };
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
async function reconciliarReembolsosEnZona(
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
  const ahora = new Date();

  const ventas: VentaHotmart[] = [];
  for (const item of res.items) {
    const r = parsearApi(item, undefined, { origen: 'reconciliacion', ahora });
    if (r.ok) ventas.push(r.venta);
  }

  // Una sola lectura por lote en vez de un SELECT por transacción (N+1).
  const existentes = new Map<
    string,
    {
      id: string;
      estado: string;
      fecha_venta: string;
      evento_ts: string;
      reembolsada_at: string | null;
    }
  >();
  for (let i = 0; i < ventas.length; i += 200) {
    const { data } = await db
      .from('hotmart_ventas')
      .select('id, transaction_id, estado, fecha_venta, evento_ts, reembolsada_at')
      .eq('cliente_id', clienteId)
      .in(
        'transaction_id',
        ventas.slice(i, i + 200).map((v) => v.transaction_id)
      );
    for (const e of data ?? []) existentes.set(String(e.transaction_id), e);
  }

  for (const v of ventas) {
    const existente = existentes.get(v.transaction_id);
    if (!existente) continue;
    if (existente.estado === v.estado) continue;

    // `evento_ts` NUNCA retrocede. Antes se escribía `approved_date` (la API no
    // tiene instante de evento): la marca se movía hacia atrás, por debajo del
    // `creation_date` de un webhook, y un reintento tardío del
    // PURCHASE_APPROVED pasaba la guarda y resucitaba la venta.
    const eventoTs = new Date(
      Math.max(Date.parse(existente.evento_ts) || 0, ahora.getTime())
    ).toISOString();
    const devuelta = ESTADOS_DEVUELTOS.includes(v.estado);

    // UPDATE condicional sobre el estado leído: si el webhook lo cambió entre
    // la lectura y ahora, no se pisa.
    const { error } = await db
      .from('hotmart_ventas')
      .update({
        estado: v.estado,
        // La fecha en que lo VEMOS reembolsado (la API no da la del reembolso),
        // conservando la primera si ya había una.
        reembolsada_at: devuelta ? (existente.reembolsada_at ?? ahora.toISOString()) : null,
        evento_ts: eventoTs,
        origen: 'reconciliacion',
        actualizado_at: ahora.toISOString(),
      })
      .eq('cliente_id', clienteId)
      .eq('id', existente.id)
      .eq('estado', existente.estado);
    if (error) {
      log(`[Hotmart] Reconciliación: no se pudo actualizar ${v.transaction_id}: ${error.message}`);
      continue;
    }

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

// ────────────────────────────────────────────────────────────────
// 5. Barrido de aprobaciones tardías
// ────────────────────────────────────────────────────────────────

/**
 * Vuelve a pedir los últimos `dias` días.
 *
 * `sales/history` filtra por fecha de ORDEN (comprobado el 2026-09-25 con
 * `diagnostico-hotmart --claves`), mientras que `fecha_venta` es la de
 * APROBACIÓN. El worker solo re-pide ayer y hoy, así que un pago aprobado dos
 * días después de la orden (boleto, pix, transferencia) no entraba nunca por la
 * sync diaria. En Cris la demora máxima medida fue de ~8 minutos; por eso 3
 * días bastan y cuestan 6 peticiones.
 *
 * Devuelve las fechas a reagregar; no reagrega él mismo.
 */
async function barrerAprobacionesTardiasEnZona(
  db: Db,
  clienteId: string,
  token: string,
  funnels: FunnelHotmart[],
  dias = 3,
  log: (msg: string) => void = () => {}
): Promise<{ completo: boolean; ventas: number; escritas: number; fechasTocadas: string[] }> {
  const hoy = colombiaToday();
  const fechas = new Set<string>();
  let completo = true;
  let ventas = 0;
  let escritas = 0;
  for (let i = 0; i < dias; i++) {
    const fecha = addDaysISO(hoy, -i);
    const r = await sincronizarDiaHotmart(db, clienteId, fecha, token, funnels, log);
    completo &&= r.completo;
    ventas += r.ventas;
    escritas += r.escritas;
    for (const f of r.fechasTocadas ?? []) fechas.add(f);
  }
  return { completo, ventas, escritas, fechasTocadas: Array.from(fechas).sort() };
}
