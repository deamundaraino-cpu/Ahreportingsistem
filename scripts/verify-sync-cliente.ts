/**
 * Sincronizar todos los canales de un cliente desde el agente/MCP.
 *
 * Cubre lo que salió de la auditoría del 2026-09-28:
 *
 *   · `trigger_sync` solo encolaba `metricas`: Sheets, GA4, las ventas de
 *     Hotmart y los leads se quedaban fuera.
 *   · Un job de leads POR CLIENTE llegaba a su ruta con el id público, no casaba
 *     ninguna integración de `report_utm` y se daba por hecho sin hacer nada.
 *   · Refrescar un cliente pedía aprobación por WhatsApp; ahora `sync_client`
 *     es directa, con un freno para no saturar la instancia Micro.
 *
 * No toca la base de datos: usa una base en memoria. Forma parte de `test:puro`.
 */
import { getTool, toolsFor } from '../src/lib/agent/registry';
import { ejecutarConTool } from '../src/lib/agent/execute';
import { esDirecta, type AgentContext } from '../src/lib/agent/types';
import { ALL_PERMISSIONS } from '../src/lib/api-token-auth';
import {
  canalesDeCliente,
  planSyncCliente,
  MAX_DIAS_SYNC_AGENTE,
  type ContextoSync,
} from '../src/lib/sync/cliente';
import { buildRequest } from '../src/lib/sync/runner';
import type { SyncJob } from '../src/lib/sync/queue';

let ok = 0,
  fail = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    ok++;
    console.log('  ✓ ' + nombre);
  } else {
    fail++;
    console.log('  ✗ ' + nombre + (detalle ? '  → ' + detalle : ''));
  }
}

// ═══ Base de datos en memoria ═══════════════════════════════════════════════

type Fila = Record<string, unknown>;
type ErrorDb = { code: string; message: string };
let secuencia = 0;
const nuevoUuid = () => `00000000-0000-4000-8000-${String(++secuencia).padStart(12, '0')}`;

class BaseFalsa {
  tablas = new Map<string, Fila[]>();
  tabla(n: string): Fila[] {
    if (!this.tablas.has(n)) this.tablas.set(n, []);
    return this.tablas.get(n)!;
  }
  from(t: string) {
    return new Consulta(this, `public.${t}`);
  }
  schema(s: string) {
    return { from: (t: string) => new Consulta(this, `${s}.${t}`) };
  }
}

class Consulta implements PromiseLike<{ data: unknown; error: ErrorDb | null }> {
  private op: 'select' | 'insert' = 'select';
  private filtros: Array<(f: Fila) => boolean> = [];
  private payload: Fila | null = null;
  private orden: { col: string; asc: boolean } | null = null;
  private tope: number | null = null;
  private modo: 'lista' | 'maybe' | 'single' = 'lista';
  constructor(
    private db: BaseFalsa,
    private nombre: string
  ) {}
  select() {
    return this;
  }
  insert(p: Fila) {
    this.op = 'insert';
    this.payload = p;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filtros.push((f) => f[c] === v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filtros.push((f) => vs.includes(f[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.filtros.push((f) => String(f[c] ?? '') >= v);
    return this;
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orden = { col, asc: o?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.tope = n;
    return this;
  }
  maybeSingle() {
    this.modo = 'maybe';
    return this;
  }
  single() {
    this.modo = 'single';
    return this;
  }
  private ejecutar(): { data: unknown; error: ErrorDb | null } {
    const filas = this.db.tabla(this.nombre);
    let salida: Fila[];
    if (this.op === 'insert') {
      const nueva: Fila = {
        id: nuevoUuid(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        estado: 'pending',
        ...structuredClone(this.payload!),
      };
      // El índice único parcial de la migración 051.
      if (this.nombre === 'public.sync_jobs') {
        const dup = filas.some(
          (f) =>
            ['pending', 'running'].includes(String(f.estado)) &&
            f.tipo === nueva.tipo &&
            (f.cliente_id ?? null) === (nueva.cliente_id ?? null) &&
            (f.fecha_inicio ?? null) === (nueva.fecha_inicio ?? null) &&
            (f.fecha_fin ?? null) === (nueva.fecha_fin ?? null)
        );
        if (dup) return { data: null, error: { code: '23505', message: 'duplicado' } };
      }
      filas.push(nueva);
      salida = [nueva];
    } else {
      salida = filas.filter((f) => this.filtros.every((p) => p(f)));
      if (this.orden) {
        const { col, asc } = this.orden;
        salida = [...salida].sort((a, b) =>
          String(a[col] ?? '') < String(b[col] ?? '') ? (asc ? -1 : 1) : asc ? 1 : -1
        );
      }
      if (this.tope !== null) salida = salida.slice(0, this.tope);
    }
    const copia = structuredClone(salida);
    if (this.modo === 'maybe') return { data: copia[0] ?? null, error: null };
    if (this.modo === 'single') {
      return copia.length === 1
        ? { data: copia[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no hay una fila' } };
    }
    return { data: copia, error: null };
  }
  then<A, B>(
    ok?: ((v: { data: unknown; error: ErrorDb | null }) => A | PromiseLike<A>) | null,
    ko?: ((e: unknown) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return Promise.resolve(this.ejecutar()).then(ok, ko);
  }
}

// ═══ Escenario ══════════════════════════════════════════════════════════════

const A = '11111111-1111-4111-8111-111111111111'; // todo conectado
const B = '22222222-2222-4222-8222-222222222222'; // ajeno
const V = '33333333-3333-4333-8333-333333333333'; // sin nada conectado
const rA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CONFIG_COMPLETA = {
  meta_accounts: [{ account_id: 'act_1', token: 't' }],
  ga_property_id: '123456',
  google_sheets_conversiones: [{ enabled: true, sheet_url: 'https://docs.google.com/x' }],
};

function escenario(): BaseFalsa {
  const db = new BaseFalsa();
  db.tabla('public.clientes').push(
    { id: A, config_api: CONFIG_COMPLETA },
    { id: B, config_api: CONFIG_COMPLETA },
    { id: V, config_api: {} }
  );
  db.tabla('report_utm.clientes').push({
    id: rA,
    public_cliente_id: A,
    created_at: '2026-01-01',
  });
  db.tabla('report_utm.integrations').push(
    { cliente_id: rA, tipo: 'meta_lead_ads', status: 'error' },
    { cliente_id: rA, tipo: 'gohighlevel', status: 'active' }
  );
  return db;
}

function contexto(db: BaseFalsa, extra: Partial<AgentContext> = {}): AgentContext {
  return {
    userId: 'yo',
    role: 'trafficker',
    level: 'operador',
    allowedClientIds: [A, V],
    permissions: [...ALL_PERMISSIONS],
    db: db as unknown as AgentContext['db'],
    origin: 'mcp',
    conversationId: null,
    tokenId: null,
    ...extra,
  };
}

const HOY = '2026-09-28';
const AYER = '2026-09-27';

async function main() {
  // ── 1. Qué canales tiene un cliente ───────────────────────────────────────
  console.log('\n── Canales de un cliente ────────────────────────────────────');

  const ctxA: ContextoSync = {
    publicId: A,
    rtmId: rA,
    configApi: CONFIG_COMPLETA,
    integraciones: [
      { tipo: 'meta_lead_ads', status: 'error' },
      { tipo: 'gohighlevel', status: 'active' },
    ],
  };
  const estados = canalesDeCliente(ctxA);
  const conectado = (canal: string, est = estados) =>
    est.find((e) => e.canal === canal)?.conectado === true;
  check('métricas conectadas (hay Meta y GA4)', conectado('metricas'));
  check('Sheets conectado', conectado('sheets'));
  check('GA4 conectado', conectado('ga4'));
  check('Hotmart NO conectado', !conectado('hotmart'));
  check('Meta Lead Ads en error cuenta (se reintenta)', conectado('meta_leads'));
  check('GoHighLevel conectado', conectado('ghl'));
  check('TikTok leads NO conectado', !conectado('tiktok_leads'));

  const sinEspejo = canalesDeCliente({ ...ctxA, rtmId: null });
  check(
    'sin espejo en Report-UTM no hay canales de leads, y se dice por qué',
    !conectado('meta_leads', sinEspejo) &&
      /espejo/.test(sinEspejo.find((e) => e.canal === 'ghl')!.detalle)
  );
  const ghlInactivo = canalesDeCliente({
    ...ctxA,
    integraciones: [{ tipo: 'gohighlevel', status: 'inactive' }],
  });
  check('una integración inactiva no cuenta', !conectado('ghl', ghlInactivo));
  const vacio = canalesDeCliente({ publicId: V, rtmId: null, configApi: {}, integraciones: [] });
  check(
    'sin nada conectado, nada conectado',
    vacio.every((e) => !e.conectado)
  );

  // ── 2. El plan ──────────────────────────────────────────────────────────────
  console.log('\n── Plan de sincronización ───────────────────────────────────');

  const plan = planSyncCliente(ctxA, estados, { hoy: HOY, ayer: AYER });
  const tipos = plan.map((j) => j.tipo);
  check(
    'encola todos los canales conectados',
    [
      'metricas',
      'sheets_conversiones',
      'ga4',
      'meta_leads',
      'ghl_leads',
      'ghl_oportunidades',
    ].every((t) => (tipos as string[]).includes(t)),
    tipos.join(',')
  );
  check(
    'y nada de lo no conectado',
    !tipos.includes('hotmart_ventas') && !tipos.includes('tiktok_leads')
  );
  const met = plan.find((j) => j.tipo === 'metricas')!;
  check('métricas: ayer y hoy, como el planner', met.start === AYER && met.end === HOY);
  const ga4 = plan.find((j) => j.tipo === 'ga4')!;
  check('GA4: los últimos días', ga4.start === '2026-09-25' && ga4.end === HOY);
  check(
    'los leads llevan el id de report_utm',
    plan
      .filter((j) => ['meta_leads', 'ghl_leads', 'ghl_oportunidades'].includes(j.tipo))
      .every((j) => j.params?.rtm_cliente_id === rA && j.clienteId === A)
  );
  check(
    'todo con prioridad manual y firmado por el agente',
    plan.every((j) => j.prioridad === 1 && j.triggeredBy === 'agente')
  );

  const conRango = planSyncCliente(ctxA, estados, {
    hoy: HOY,
    ayer: AYER,
    rango: { desde: '2026-07-01', hasta: '2026-07-30' },
  });
  const tramos = conRango.filter((j) => j.tipo === 'metricas');
  check('con rango, métricas en tramos de 14 días', tramos.length === 3, String(tramos.length));
  check(
    'y con force (si no, salta los días que ya tienen datos)',
    tramos.every((j) => j.params?.force === true)
  );
  check('GA4 en un tramo de hasta 90 días', conRango.filter((j) => j.tipo === 'ga4').length === 1);
  check(
    'los leads no usan fechas (van por cursor)',
    conRango.filter((j) => j.tipo === 'ghl_leads').length === 1 &&
      !conRango.find((j) => j.tipo === 'ghl_leads')!.start
  );
  check(
    'solo los canales pedidos',
    planSyncCliente(ctxA, estados, { hoy: HOY, ayer: AYER, canales: ['ga4'] }).every(
      (j) => j.tipo === 'ga4'
    )
  );
  check(
    'omite lo que ya está en curso',
    !planSyncCliente(ctxA, estados, { hoy: HOY, ayer: AYER, omitirTipos: ['metricas'] }).some(
      (j) => j.tipo === 'metricas'
    )
  );

  // ── 3. El runner manda el id correcto a las rutas de leads ─────────────────
  console.log('\n── Jobs de leads por cliente ────────────────────────────────');

  const job = (extra: Partial<SyncJob>): SyncJob =>
    ({
      id: 'j',
      tipo: 'meta_leads',
      cliente_id: A,
      fecha_inicio: null,
      fecha_fin: null,
      params: {},
      cursor: {},
      estado: 'running',
      prioridad: 1,
      intentos: 1,
      max_intentos: 3,
      last_error: null,
      locked_at: null,
      locked_by: null,
      triggered_by: 'agente',
      created_at: '',
      updated_at: '',
      ...extra,
    }) as SyncJob;
  for (const tipo of ['meta_leads', 'ghl_leads', 'ghl_oportunidades', 'tiktok_leads'] as const) {
    const r = buildRequest(job({ tipo, params: { rtm_cliente_id: rA } }), 'https://app');
    check(
      `[${tipo}] por cliente pasa el id de report_utm`,
      r.url.includes(`clienteId=${rA}`),
      r.url
    );
  }
  let lanzo = false;
  try {
    buildRequest(job({ params: {} }), 'https://app');
  } catch {
    lanzo = true;
  }
  check('sin rtm_cliente_id falla (antes se daba por hecho sin sincronizar)', lanzo);
  check(
    'un job global sigue sin cliente',
    !buildRequest(job({ cliente_id: null }), 'https://app').url.includes('clienteId')
  );
  check(
    'métricas sigue usando el id público',
    buildRequest(
      job({ tipo: 'metricas', fecha_inicio: AYER, fecha_fin: HOY }),
      'https://app'
    ).url.includes(`client_id=${A}`)
  );

  // ── 4. Las herramientas ─────────────────────────────────────────────────────
  console.log('\n── sync_client y trigger_sync ───────────────────────────────');

  const syncClient = getTool('sync_client')!;
  const triggerSync = getTool('trigger_sync')!;
  check('sync_client es directa', esDirecta(syncClient));
  check('trigger_sync sigue pidiendo aprobación', !esDirecta(triggerSync));
  check('trigger_sync comprueba al proponer', typeof triggerSync.mutation?.precheck === 'function');
  const consulta = toolsFor(contexto(escenario(), { level: 'consulta' })).map((t) => t.name);
  check('un contacto de consulta no ve sync_client', !consulta.includes('sync_client'));

  {
    const db = escenario();
    const ctx = contexto(db);
    const r = await ejecutarConTool(syncClient, { client_id: A }, ctx);
    const d = r.data as {
      estado?: string;
      encolados?: { tipo: string }[];
      worker_avisado?: boolean;
    };
    check('sync_client se aplica al momento', r.ok && r.aplicado === true, JSON.stringify(r.error));
    check(
      'y encola todos los canales',
      d?.estado === 'encolado' && (d.encolados?.length ?? 0) === 6,
      JSON.stringify(d?.encolados)
    );
    check('sin propuestas pendientes', db.tabla('public.agent_action_approvals').length === 0);
    const jobs = db.tabla('public.sync_jobs');
    check(
      'los jobs de leads llevan rtm_cliente_id en la cola',
      jobs
        .filter((j) => String(j.tipo).includes('leads') || j.tipo === 'ghl_oportunidades')
        .every((j) => (j.params as Fila)?.rtm_cliente_id === rA)
    );
    check('sin CRON_SECRET no intenta despertar al worker', d?.worker_avisado === false);

    const otra = await ejecutarConTool(syncClient, { client_id: A }, ctx);
    check(
      'una segunda llamada seguida no duplica (freno de 10 min)',
      (otra.data as { estado?: string })?.estado === 'reciente' &&
        db.tabla('public.sync_jobs').length === jobs.length
    );

    const estado = await ejecutarConTool(getTool('get_sync_status')!, { client_id: A }, ctx);
    const porCanal = (estado.data as { por_canal?: Record<string, unknown> })?.por_canal ?? {};
    check(
      'get_sync_status resume el último job por canal',
      ['metricas', 'sheets', 'ga4', 'meta_leads', 'ghl'].every((c) => c in porCanal),
      Object.keys(porCanal).join(',')
    );
  }

  {
    // El planner ya dejó métricas pendientes: no se repiten, se informan.
    const db = escenario();
    db.tabla('public.sync_jobs').push({
      id: 'plan',
      tipo: 'metricas',
      cliente_id: A,
      estado: 'pending',
      fecha_inicio: '2026-01-01',
      fecha_fin: '2026-01-02',
      triggered_by: 'planner',
      created_at: '2026-09-28T05:00:00.000Z',
    });
    const r = await ejecutarConTool(syncClient, { client_id: A }, contexto(db));
    const d = r.data as { encolados?: { tipo: string }[]; ya_en_cola?: string[] };
    check(
      'lo que ya está en curso no se reencola y se dice',
      r.ok &&
        !d.encolados?.some((j) => j.tipo === 'metricas') &&
        Boolean(d.ya_en_cola?.includes('metricas')),
      JSON.stringify(d)
    );
  }

  {
    const db = escenario();
    const ajeno = await ejecutarConTool(syncClient, { client_id: B }, contexto(db));
    check('un cliente ajeno da NOT_FOUND', ajeno.error?.code === 'NOT_FOUND');
    const nada = await ejecutarConTool(syncClient, { client_id: V }, contexto(db));
    check(
      'un cliente sin nada conectado lo explica',
      nada.error?.code === 'VALIDATION_ERROR' && /nada que sincronizar/.test(nada.error.message)
    );
  }

  {
    const db = escenario();
    const ctx = contexto(db);
    const largo = await ejecutarConTool(
      triggerSync,
      { client_id: A, desde: '2026-01-01', hasta: '2026-06-30' },
      ctx
    );
    check(
      `trigger_sync rechaza más de ${MAX_DIAS_SYNC_AGENTE} días al proponer`,
      largo.error?.code === 'VALIDATION_ERROR' &&
        db.tabla('public.agent_action_approvals').length === 0
    );
    const bien = await ejecutarConTool(
      triggerSync,
      { client_id: A, desde: '2026-07-01', hasta: '2026-07-30' },
      ctx
    );
    check(
      'un periodo válido queda pendiente de aprobación',
      bien.ok && (bien.data as { estado?: string }).estado === 'pendiente_de_aprobacion'
    );
    check('y no encola nada todavía', db.tabla('public.sync_jobs').length === 0);

    const res = (await triggerSync.handler(
      { client_id: A, desde: '2026-07-01', hasta: '2026-07-30' },
      ctx
    )) as { encolados?: { tipo: string }[] };
    check(
      'al aprobarse encola el periodo troceado de todos los canales',
      (res.encolados?.filter((j) => j.tipo === 'metricas').length ?? 0) === 3 &&
        Boolean(res.encolados?.some((j) => j.tipo === 'ghl_leads')),
      JSON.stringify(res.encolados?.map((j) => j.tipo))
    );
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
