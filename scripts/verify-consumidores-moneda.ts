/**
 * Consumidores de la moneda de reporte fuera del dashboard.
 *
 * El dashboard convierte las ventas de Hotmart (guardadas en USD) a la moneda
 * del cliente antes de dividirlas entre el gasto (que ya está en esa moneda).
 * El motor de alertas y el digest de WhatsApp no lo hacían: en Cris (CLP) el
 * ROAS de una alerta salía ~900 veces menor que el de la pantalla. Además el
 * motor sumaba a los ingresos `VENTAS_CERRADAS` —un CONTEO de ventas— y se
 * olvidaba del downsell.
 *
 * También cubre los flags de conexión que usa la portada del dashboard: el
 * listado llega saneado (sin credenciales), así que la portada debe leer
 * `conexiones` y Hotmart debe decidirse con `hotmartConectado`.
 *
 * Puro: una base falsa en memoria, sin Postgres ni red.
 *
 *   npx tsx --conditions=react-server scripts/verify-consumidores-moneda.ts
 */

import { salir } from './_salida';
import {
  COLUMNAS_INGRESOS,
  evaluateAlertRules,
  ingresosEnMonedaReporte,
  type RuleRow,
} from '../src/lib/notifications/rules-engine';
import {
  conversorIdentidad,
  convertirFilasMetricas,
  crearConversor,
  _limpiarCacheMoneda,
} from '../src/lib/moneda-reporte';
import { aggregateFormula } from '../src/lib/formula-engine';
import { flagsConexion, sanearClienteParaListado } from '../src/lib/cliente-seguro';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const cerca = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;

// ── Fixtures ──────────────────────────────────────────────────────────
// usd_rate = USD por 1 CLP: 900 CLP = 1 USD el día 1, 950 el día 2.
const TASAS_CLP = [
  { fecha: '2026-08-01', moneda: 'CLP', usd_rate: 1 / 900 },
  { fecha: '2026-08-02', moneda: 'CLP', usd_rate: 1 / 950 },
];

/** Filas de `metricas_diarias` de Cris: gasto en CLP, Hotmart en USD. */
const FILAS_CRIS = [
  {
    cliente_id: 'pub-cris',
    fecha: '2026-08-01',
    meta_spend: 90000,
    meta_campaigns: [{ name: 'Campaña A', spend: '90000', leads: '30' }],
    ventas_principal: 100,
    ventas_bump: 10,
    ventas_upsell: 0,
    ventas_downsell: 20,
    // Un conteo, no dinero: no debe llegar a los ingresos.
    metricas_manuales: { VENTAS_CERRADAS: 5 },
  },
  {
    cliente_id: 'pub-cris',
    fecha: '2026-08-02',
    meta_spend: 95000,
    meta_campaigns: [{ name: 'Campaña A', spend: '95000', leads: '20' }],
    ventas_principal: 50,
    ventas_bump: 0,
    ventas_upsell: 0,
    ventas_downsell: 10,
    metricas_manuales: { VENTAS_CERRADAS: 3 },
  },
];

// (100 + 10 + 0 + 20) × 900 + (50 + 10) × 950
const INGRESOS_CLP = 130 * 900 + 60 * 950; // 174.000
const GASTO_CLP = 90000 + 95000; // 185.000

/** Mismas filas para un cliente que reporta en USD. */
const FILAS_USD = FILAS_CRIS.map((f) => ({ ...f, cliente_id: 'pub-usd' }));
const INGRESOS_USD = 130 + 60;

// ── 1. Ingresos en la moneda de reporte ───────────────────────────────
console.log('\n1. ingresosEnMonedaReporte');

const clp = crearConversor('CLP', TASAS_CLP);
check(
  'suma principal + bump + upsell + DOWNSELL',
  COLUMNAS_INGRESOS.join(',') === 'ventas_principal,ventas_bump,ventas_upsell,ventas_downsell'
);
check(
  'en USD: la suma cruda, con downsell',
  ingresosEnMonedaReporte(FILAS_USD, conversorIdentidad()) === INGRESOS_USD,
  String(ingresosEnMonedaReporte(FILAS_USD, conversorIdentidad()))
);
check(
  'en CLP: cada día con SU tasa (900 y 950)',
  ingresosEnMonedaReporte(FILAS_CRIS, clp) === INGRESOS_CLP,
  String(ingresosEnMonedaReporte(FILAS_CRIS, clp))
);
check(
  'VENTAS_CERRADAS (conteo) no se suma a los ingresos',
  ingresosEnMonedaReporte(
    [{ fecha: '2026-08-01', metricas_manuales: { VENTAS_CERRADAS: 7 } }],
    clp
  ) === 0
);
check(
  'no muta las filas recibidas',
  FILAS_CRIS[0].ventas_principal === 100 && !('ventas_principal_usd' in FILAS_CRIS[0])
);
const sinTasas = crearConversor('CLP', []);
check(
  'sin ninguna tasa NO pone los ingresos a 0: se quedan en USD',
  ingresosEnMonedaReporte(FILAS_CRIS, sinTasas) === INGRESOS_USD
);
check(
  'y lo anota en sinTasa',
  sinTasas.sinTasa.has('2026-08-01') && sinTasas.sinTasa.has('2026-08-02')
);
check(
  'misma cifra que `total_facturacion_neta` del dashboard sobre filas convertidas',
  cerca(
    aggregateFormula('total_facturacion_neta', convertirFilasMetricas(FILAS_CRIS, clp)) ?? NaN,
    INGRESOS_CLP
  ),
  String(aggregateFormula('total_facturacion_neta', convertirFilasMetricas(FILAS_CRIS, clp)))
);

// ── Base falsa en memoria ─────────────────────────────────────────────
type Fila = Record<string, unknown>;
type Tablas = Record<string, Fila[]>;

function compara(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Un PostgREST de juguete: filtra `eq`/`gt`/`gte`/`lte`/`in` sobre las filas de
 * la tabla, ordena y limita. Registra lo que se inserta en `notifications`.
 */
function dbFalsa(tablas: Record<string, Tablas>) {
  const insertados: Record<string, Fila[]> = {};
  const cliente = (schema: string) => ({
    from(tabla: string) {
      const filtros: Array<(f: Fila) => boolean> = [];
      let single = false;
      let limite = Infinity;
      let orden: { col: string; asc: boolean } | null = null;
      let escritura: Fila[] | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (filtros.push((f) => f[c] === v), q),
        gt: (c: string, v: unknown) => (filtros.push((f) => compara(f[c], v) > 0), q),
        gte: (c: string, v: unknown) => (filtros.push((f) => compara(f[c], v) >= 0), q),
        lte: (c: string, v: unknown) => (filtros.push((f) => compara(f[c], v) <= 0), q),
        in: (c: string, vs: unknown[]) => (filtros.push((f) => vs.includes(f[c])), q),
        not: () => q,
        order: (col: string, o?: { ascending?: boolean }) => (
          (orden = { col, asc: o?.ascending !== false }),
          q
        ),
        limit: (n: number) => ((limite = n), q),
        single: () => ((single = true), q),
        maybeSingle: () => ((single = true), q),
        insert: (v: Fila | Fila[]) => ((escritura = Array.isArray(v) ? v : [v]), q),
        upsert: (v: Fila | Fila[]) => ((escritura = Array.isArray(v) ? v : [v]), q),
        then: (ok: (r: unknown) => unknown, ko: (e: unknown) => unknown) => {
          if (escritura) {
            (insertados[tabla] ??= []).push(...escritura);
            return Promise.resolve({ data: null, error: null }).then(ok, ko);
          }
          let filas = (tablas[schema]?.[tabla] ?? []).filter((f) => filtros.every((p) => p(f)));
          if (orden) {
            const { col, asc } = orden;
            filas = [...filas].sort((a, b) => (asc ? 1 : -1) * compara(a[col], b[col]));
          }
          filas = filas.slice(0, limite);
          const data = single ? (filas[0] ?? null) : filas;
          return Promise.resolve({ data, error: null }).then(ok, ko);
        },
      };
      return q;
    },
  });
  const db = { ...cliente('public'), schema: (s: string) => cliente(s) };
  return { db, insertados };
}

const TABLAS: Record<string, Tablas> = {
  public: {
    clientes: [
      { id: 'pub-cris', nombre: 'Cris tributario' },
      { id: 'pub-usd', nombre: 'Cliente en dólares' },
    ],
    cliente_tabs: [
      {
        id: 'tab-cris',
        cliente_id: 'pub-cris',
        nombre: 'Lanzamiento',
        keyword_meta: null,
        presupuesto_objetivo: 370000,
        fecha_inicio: '2026-08-01',
        fecha_finalizacion: '2099-12-31',
      },
      {
        id: 'tab-usd',
        cliente_id: 'pub-usd',
        nombre: 'Evergreen',
        keyword_meta: null,
        presupuesto_objetivo: null,
        fecha_inicio: '2026-08-01',
        fecha_finalizacion: '2099-12-31',
      },
    ],
    campaign_groups: [],
    notification_rule_cooldowns: [],
    metricas_diarias: [...FILAS_CRIS, ...FILAS_USD],
    fx_rates: TASAS_CLP,
    user_profiles: [{ id: 'u-admin', role: 'admin' }],
    user_client_assignments: [],
    notification_preferences: [],
  },
  report_utm: {
    clientes: [
      { id: 'rtm-cris', public_cliente_id: 'pub-cris', config: { moneda_reporte: 'CLP' } },
      { id: 'rtm-usd', public_cliente_id: 'pub-usd', config: {} },
    ],
  },
};

function regla(
  clienteId: string,
  metric: RuleRow['metric'],
  operator: RuleRow['operator'],
  value: number
): RuleRow {
  return {
    id: `r-${clienteId}-${metric}-${operator}-${value}`,
    cliente_id: clienteId,
    tab_id: null,
    nombre: `${metric} ${operator} ${value}`,
    metric,
    operator,
    value,
    time_window: 'custom_range',
    custom_start: '2026-08-01',
    custom_end: '2026-08-02',
    channels: ['in_app'],
    cooldown_hours: 24,
    last_triggered_at: null,
    enabled: true,
  };
}

/** Evalúa UNA regla con la base falsa y devuelve si saltó y el mensaje. */
async function evaluar(r: RuleRow) {
  _limpiarCacheMoneda();
  const { db, insertados } = dbFalsa({
    ...TABLAS,
    public: { ...TABLAS.public, notification_rules: [{ ...r }] },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await evaluateAlertRules(db as any, { force: true });
  const notif = (insertados.notifications ?? [])[0] as { message?: string } | undefined;
  return { disparo: res.triggered > 0, mensaje: notif?.message ?? '' };
}

async function motorDeAlertas() {
  // ── 2. Motor de alertas: ingresos ───────────────────────────────────
  console.log('\n2. Motor de alertas — ingresos');

  let r = await evaluar(regla('pub-cris', 'revenue', '>=', INGRESOS_CLP));
  check(
    `Cris: ingresos convertidos a CLP (${INGRESOS_CLP}) disparan revenue >= ${INGRESOS_CLP}`,
    r.disparo
  );
  check(
    'y el mensaje lleva el código de moneda',
    r.mensaje.includes('CLP 174,000') && r.mensaje.includes('límite de CLP 174,000'),
    r.mensaje
  );

  r = await evaluar(regla('pub-cris', 'revenue', '>', INGRESOS_CLP + 0.5));
  check(
    'no se suma VENTAS_CERRADAS (8 ventas) a los ingresos: revenue > 174.000,5 no salta',
    !r.disparo,
    r.mensaje
  );

  r = await evaluar(regla('pub-usd', 'revenue', '>=', INGRESOS_USD));
  check(`cliente USD: ingresos con downsell (${INGRESOS_USD}) disparan`, r.disparo);
  check('y en dólares se sigue pintando «$»', r.mensaje.includes('$190'), r.mensaje);

  r = await evaluar(regla('pub-usd', 'revenue', '>', INGRESOS_USD - 30 + 0.5));
  check('el downsell cuenta: sin él (160) no superaría 160,5', r.disparo, r.mensaje);

  // ── 3. Motor de alertas: ROAS ───────────────────────────────────────
  console.log('\n3. Motor de alertas — ROAS');
  const roas = INGRESOS_CLP / GASTO_CLP; // ≈ 0,94
  r = await evaluar(regla('pub-cris', 'roas', '>', 0.9));
  check(
    `Cris: ROAS = ingresos CLP / gasto CLP ≈ ${roas.toFixed(3)} (antes ≈ 0,0009)`,
    r.disparo,
    r.mensaje
  );
  check('el ROAS no lleva moneda', r.mensaje.includes('ROAS de 0.94,'), r.mensaje);
  r = await evaluar(regla('pub-cris', 'roas', '>', 1));
  check('y no pasa de 1', !r.disparo, r.mensaje);

  // ── 4. Motor de alertas: gasto y presupuesto con su moneda ─────────
  console.log('\n4. Motor de alertas — gasto y presupuesto');
  r = await evaluar(regla('pub-cris', 'spend', '>', 100000));
  check('el gasto se etiqueta en CLP', r.mensaje.includes('CLP 185,000'), r.mensaje);
  r = await evaluar(regla('pub-cris', 'budget_percentage', '>=', 50));
  check(
    'presupuesto: gasto y objetivo con el código de moneda',
    r.disparo && r.mensaje.includes('CLP 185,000') && r.mensaje.includes('CLP 370,000'),
    r.mensaje
  );
  r = await evaluar(regla('pub-cris', 'leads', '>=', 50));
  check('leads: sin moneda y sin tocar', r.disparo && !r.mensaje.includes('CLP'), r.mensaje);
}

// ── 5. Flags de conexión ──────────────────────────────────────────────
function conexiones() {
  console.log('\n5. Flags de conexión (portada del dashboard)');

  check('sin config → todo desconectado', !Object.values(flagsConexion(null)).some(Boolean));
  check('Hotmart Basic en claro', flagsConexion({ hotmart_basic: 'abc' }).hotmart);
  check('Hotmart Basic cifrado (`_enc`)', flagsConexion({ hotmart_basic_enc: 'a:b:c' }).hotmart);
  check(
    'Hotmart por client_id + secret',
    flagsConexion({ hotmart_client_id: 'id', hotmart_client_secret: 's' }).hotmart
  );
  check(
    'HotConnect con tokens cifrados (antes salía desconectado)',
    flagsConexion({ hotmart_auth_mode: 'hotconnect', hotmart_refresh_token_enc: 'a:b:c' }).hotmart
  );
  check(
    'HotConnect sin tokens → desconectado',
    !flagsConexion({ hotmart_auth_mode: 'hotconnect', hotmart_basic: 'viejo' }).hotmart
  );
  check('solo client_id no basta', !flagsConexion({ hotmart_client_id: 'id' }).hotmart);

  const fila = sanearClienteParaListado({
    id: 'c1',
    config_api: {
      meta_token: 'EAAB-secreto',
      hotmart_basic_enc: 'a:b:c',
      ga_property_id: '123',
      meta_keywords: ['x'],
    },
  });
  const cfg = fila.config_api as Record<string, unknown>;
  check(
    'el listado saneado ya no trae credenciales (por eso la portada no puede mirar config_api)',
    !('meta_token' in cfg) && !('hotmart_basic_enc' in cfg) && !('ga_property_id' in cfg)
  );
  check(
    'pero sí los flags: Meta, Hotmart y GA4 conectados',
    fila.conexiones.meta && fila.conexiones.hotmart && fila.conexiones.ga,
    JSON.stringify(fila.conexiones)
  );
}

motorDeAlertas()
  .then(() => {
    conexiones();
    console.log(`\n${fallos === 0 ? '✅ TODO OK' : `❌ ${fallos} fallo(s)`}\n`);
    salir(fallos);
  })
  .catch((e) => {
    console.error('ERROR:', e instanceof Error ? e.stack : e);
    process.exit(1);
  });
