/**
 * Herramientas de informes del agente/MCP: esquema, validación, ids de cliente,
 * política directa/aprobación, revisiones y consulta de la vista previa.
 *
 * Cada bloque sale de un defecto concreto de la auditoría del 2026-09-26:
 *
 *   · `create_report` guardaba el id PÚBLICO del cliente en `bi_reports`, que
 *     apunta a `report_utm.clientes`; a quien no era admin todo informe le daba
 *     «no encontrado» y `list_reports` sin cliente listaba los de todos.
 *   · Toda escritura quedaba como propuesta, así que un informe no se podía
 *     terminar; y las validaciones solo corrían al aprobar.
 *   · El esquema de widget descartaba `children` y admitía valores que el
 *     canvas no pinta; la validación de cruces solo miraba `config.metric`.
 *   · `remove_report_widget` decía que sí aunque el widget no existiera.
 *
 * No toca la base de datos: usa una base en memoria. Forma parte de `test:puro`.
 */
import { z } from 'zod';

import { ALL_TOOLS, getTool } from '../src/lib/agent/registry';
import { ejecutarConTool } from '../src/lib/agent/execute';
import { esDirecta, type AgentContext, type AnyAgentTool } from '../src/lib/agent/types';
import { ALL_PERMISSIONS } from '../src/lib/api-token-auth';
import {
  avisosDeClaves,
  normalizarWidget,
  widgetSchema,
} from '../src/lib/agent/tools/informes/esquema';
import {
  validarCampoCalculado,
  validarFormula,
  validarWidget,
} from '../src/lib/agent/tools/informes/validacion';
import { insertarWidget, moverWidget, quitarWidget } from '../src/lib/agent/tools/informes/layout';
import { escribirConRevision } from '../src/lib/agent/tools/informes/revisiones';
import { paramsDeWidget } from '../src/lib/report-utm/bi/consulta-widget';
import { columnasOfflineDeConfig } from '../src/lib/report-utm/bi/campos-cliente';
import {
  DIMENSION_META,
  METRIC_META,
  metricCrossesDimension,
} from '../src/lib/report-utm/bi-metadata';
import { BASE_REGISTRY, fieldCrossesDimension } from '../src/lib/report-utm/bi/registry';
import { migrateDimensionId, migrateMeasureId } from '../src/lib/report-utm/bi/legacy-tokens';
import type { BiWidget } from '../src/components/report-utm/bi/BiTypes';

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
// Imita lo justo del cliente de Supabase: from/schema, select/insert/update/
// delete, eq/in/is/or/ilike, order/limit/range, single/maybeSingle y await.

type Fila = Record<string, unknown>;
type ErrorDb = { code: string; message: string };

let secuencia = 0;
const nuevoUuid = () => `00000000-0000-4000-8000-${String(++secuencia).padStart(12, '0')}`;

class BaseFalsa {
  tablas = new Map<string, Fila[]>();
  errores = new Map<string, ErrorDb>();
  reloj = Date.parse('2026-09-26T12:00:00Z');

  tabla(nombre: string): Fila[] {
    if (!this.tablas.has(nombre)) this.tablas.set(nombre, []);
    return this.tablas.get(nombre)!;
  }
  ahora(): string {
    this.reloj += 1000;
    return new Date(this.reloj).toISOString();
  }
  from(t: string) {
    return new Consulta(this, `public.${t}`);
  }
  schema(s: string) {
    return { from: (t: string) => new Consulta(this, `${s}.${t}`) };
  }
}

class Consulta implements PromiseLike<{ data: unknown; error: ErrorDb | null }> {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private filtros: Array<(f: Fila) => boolean> = [];
  private payload: Fila | Fila[] | null = null;
  private orden: { col: string; asc: boolean } | null = null;
  private tope: number | null = null;
  private desde = 0;
  private modo: 'lista' | 'single' | 'maybe' = 'lista';
  private devolver = false;

  constructor(
    private db: BaseFalsa,
    private nombre: string
  ) {}

  select() {
    if (this.op === 'select') this.devolver = true;
    else this.devolver = true;
    return this;
  }
  insert(p: Fila | Fila[]) {
    this.op = 'insert';
    this.payload = p;
    return this;
  }
  update(p: Fila) {
    this.op = 'update';
    this.payload = p;
    return this;
  }
  delete() {
    this.op = 'delete';
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
  is(c: string, v: null) {
    this.filtros.push((f) => (f[c] ?? null) === v);
    return this;
  }
  or(expr: string) {
    // Solo lo que usan las herramientas: `col.is.null,col.in.(a,b)`.
    const partes = expr.match(/[a-z_]+\.(is\.null|in\.\([^)]*\))/g) ?? [];
    const preds = partes.map((p) => {
      const [col, op, ...resto] = p.split('.');
      if (op === 'is') return (f: Fila) => (f[col] ?? null) === null;
      const lista = resto
        .join('.')
        .replace(/^\(|\)$/g, '')
        .split(',');
      return (f: Fila) => lista.includes(String(f[col]));
    });
    this.filtros.push((f) => preds.some((p) => p(f)));
    return this;
  }
  ilike(c: string, patron: string) {
    const aguja = patron.replace(/%/g, '').toLowerCase();
    this.filtros.push((f) =>
      String(f[c] ?? '')
        .toLowerCase()
        .includes(aguja)
    );
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
  range(a: number, b: number) {
    this.desde = a;
    this.tope = b - a + 1;
    return this;
  }
  single() {
    this.modo = 'single';
    return this;
  }
  maybeSingle() {
    this.modo = 'maybe';
    return this;
  }

  private ejecutar(): { data: unknown; error: ErrorDb | null } {
    const forzado = this.db.errores.get(this.nombre);
    if (forzado) return { data: null, error: forzado };
    const filas = this.db.tabla(this.nombre);
    const casan = () => filas.filter((f) => this.filtros.every((p) => p(f)));
    let salida: Fila[] = [];

    if (this.op === 'select') {
      salida = casan();
      if (this.orden) {
        const { col, asc } = this.orden;
        salida = [...salida].sort((a, b) =>
          String(a[col] ?? '') < String(b[col] ?? '') ? (asc ? -1 : 1) : asc ? 1 : -1
        );
      }
      salida = salida.slice(this.desde, this.tope === null ? undefined : this.desde + this.tope);
    } else if (this.op === 'insert') {
      const nuevas = (Array.isArray(this.payload) ? this.payload : [this.payload!]).map((p) => ({
        id: nuevoUuid(),
        created_at: this.db.ahora(),
        updated_at: this.db.ahora(),
        ...structuredClone(p),
      }));
      filas.push(...nuevas);
      salida = nuevas;
    } else if (this.op === 'update') {
      salida = casan();
      for (const f of salida) Object.assign(f, structuredClone(this.payload));
    } else {
      salida = casan();
      this.db.tablas.set(
        this.nombre,
        filas.filter((f) => !salida.includes(f))
      );
    }

    if (this.op !== 'select' && !this.devolver && this.modo === 'lista') {
      return { data: null, error: null };
    }
    const copia = structuredClone(salida);
    if (this.modo === 'single') {
      return copia.length === 1
        ? { data: copia[0], error: null }
        : { data: null, error: { code: 'PGRST116', message: 'no hay exactamente una fila' } };
    }
    if (this.modo === 'maybe') return { data: copia[0] ?? null, error: null };
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
//  público A (visible) ↔ rtm rA · público B (ajeno) ↔ rtm rB
//  rtm rC sin enlace · público D sin espejo en report_utm

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const D = '44444444-4444-4444-8444-444444444444';
const rA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const rB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const rC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INF_A = 'a0000000-0000-4000-8000-00000000000a';
const INF_B = 'b0000000-0000-4000-8000-00000000000b';
const INF_C = 'c0000000-0000-4000-8000-00000000000c';
const PLANTILLA = 'f0000000-0000-4000-8000-00000000000f';

function escenario(): BaseFalsa {
  const db = new BaseFalsa();
  db.tabla('report_utm.clientes').push(
    { id: rA, public_cliente_id: A, created_at: '2026-01-01' },
    { id: rB, public_cliente_id: B, created_at: '2026-01-01' },
    { id: rC, public_cliente_id: null, created_at: '2026-01-01' }
  );
  const informe = (id: string, cliente: string | null, extra: Fila = {}): Fila => ({
    id,
    nombre: `Informe ${id.slice(0, 1)}`,
    descripcion: null,
    cliente_id: cliente,
    layout: [],
    filters: {},
    calculated_fields: [],
    is_template: false,
    created_by: 'otra-persona',
    public_token: null,
    updated_at: '2026-09-01T00:00:00.000Z',
    ...extra,
  });
  db.tabla('public.bi_reports').push(
    informe(INF_A, rA, {
      layout: [
        { id: 'k1', type: 'scorecard', title: 'Leads', config: { metric: 'leads_count' } },
        {
          id: 's1',
          type: 'section',
          title: 'Sección',
          config: {},
          children: [
            {
              id: 'c1',
              type: 'table',
              title: 'Campañas',
              config: { metric: 'spend,leads_count,CPL real', dimension: 'utm_campaign' },
            },
          ],
        },
      ],
      calculated_fields: [{ id: 'cf1', name: 'CPL real', expression: 'spend / leads_count' }],
    }),
    informe(INF_B, rB),
    informe(INF_C, rC),
    informe(PLANTILLA, null, { is_template: true, created_by: null, nombre: 'Plantilla base' })
  );
  return db;
}

function contexto(
  db: BaseFalsa,
  opts: Partial<AgentContext> & { allowedClientIds?: AgentContext['allowedClientIds'] } = {}
): AgentContext {
  return {
    userId: 'yo',
    role: 'trafficker',
    level: 'operador',
    allowedClientIds: [A],
    permissions: [...ALL_PERMISSIONS],
    db: db as unknown as AgentContext['db'],
    origin: 'mcp',
    conversationId: null,
    tokenId: null,
    ...opts,
  };
}

const tool = (n: string) => {
  const t = getTool(n);
  if (!t) throw new Error(`falta la herramienta ${n}`);
  return t;
};
const informeDe = (db: BaseFalsa, id: string) =>
  db.tabla('public.bi_reports').find((f) => f.id === id) as Fila & { layout: BiWidget[] };

async function main() {
  // ── 1. Esquema del widget ─────────────────────────────────────────────────
  console.log('\n── Esquema del widget ───────────────────────────────────────');

  const seccion = widgetSchema.safeParse({
    type: 'section',
    title: 'Captación',
    children: [{ type: 'scorecard', config: { metric: 'spend' } }],
  });
  check('una sección con hijos se acepta', seccion.success);
  check(
    'y conserva los hijos (antes se descartaban)',
    seccion.success && normalizarWidget(seccion.data).children?.length === 1
  );
  check(
    'hijos en algo que no es sección se rechazan',
    !widgetSchema.safeParse({ type: 'bar', children: [{ type: 'text' }] }).success
  );
  check(
    'una sección dentro de otra se rechaza',
    !widgetSchema.safeParse({ type: 'section', children: [{ type: 'section' }] }).success
  );
  check(
    'heading_level 4 se rechaza (el canvas pinta 1-3)',
    !widgetSchema.safeParse({ type: 'heading', config: { text: 'x', heading_level: 4 } }).success
  );
  check(
    "align 'right' se rechaza (el canvas no lo pinta)",
    !widgetSchema.safeParse({ type: 'text', config: { text: 'x', align: 'right' } }).success
  );
  const conClaveRara = widgetSchema.safeParse({
    type: 'scorecard',
    config: { metric: 'spend', inventada: 1 },
  });
  check('una clave desconocida no bloquea', conClaveRara.success);
  check(
    'pero se avisa',
    conClaveRara.success && avisosDeClaves(normalizarWidget(conClaveRara.data)).length === 1
  );
  const normal = normalizarWidget({ type: 'section' });
  check(
    'normalizar deja id, título, config y children',
    Boolean(normal.id) &&
      normal.title === '' &&
      typeof normal.config === 'object' &&
      Array.isArray(normal.children)
  );
  for (const t of ALL_TOOLS.filter((x) => x.domain === 'informes')) {
    check(
      `[${t.name}] su JSON Schema no usa $ref`,
      !JSON.stringify(z.toJSONSchema(t.input)).includes('$ref')
    );
  }

  // ── 2. Validación de widgets ──────────────────────────────────────────────
  console.log('\n── Validación de widgets ────────────────────────────────────');

  const w = (type: BiWidget['type'], config: BiWidget['config'], extra: Partial<BiWidget> = {}) =>
    ({ id: 'w', type, title: '', config, ...extra }) as BiWidget;
  const errores = (
    x: BiWidget,
    ...r: Parameters<typeof validarWidget> extends [unknown, ...infer R] ? R : never
  ) => validarWidget(x, ...r).errores;

  check(
    'gasto por campaña es válido',
    errores(w('bar', { metric: 'spend', dimension: 'utm_campaign' })).length === 0
  );
  check(
    'gasto por país se rechaza (mostraría 0)',
    errores(w('bar', { metric: 'spend', dimension: 'ip_country' })).some((e) =>
      e.includes('0 siempre')
    )
  );
  check(
    'una tabla revisa TODAS sus columnas',
    errores(w('table', { metric: 'leads_count,spend', dimension: 'ip_country' })).some((e) =>
      e.includes('"spend"')
    )
  );
  check(
    'la fórmula también se revisa contra la dimensión',
    errores(w('bar', { formula: 'spend / leads_count', dimension: 'ip_country' })).some((e) =>
      e.includes('"spend"')
    )
  );
  check(
    'y la dimensión secundaria',
    errores(
      w('bar', { metric: 'spend', dimension: 'utm_campaign', dimension2: 'ip_country' })
    ).some((e) => e.includes('"ip_country"'))
  );
  check(
    'un campo calculado se expande a sus bases',
    errores(w('table', { metric: 'CPL real', dimension: 'ip_country' }), [
      { id: 'c', name: 'CPL real', expression: 'spend / leads_count' },
    ]).some((e) => e.includes('"spend"'))
  );
  check(
    'MRR por source se rechaza (solo total)',
    errores(w('bar', { metric: 'subs_mrr', dimension: 'utm_source' })).length > 0
  );
  check(
    'los hijos de una sección se validan',
    errores(
      w('section', {}, { children: [w('bar', { metric: 'spend', dimension: 'ip_country' })] })
    ).length > 0
  );
  check('un scorecard sin métrica se rechaza', errores(w('scorecard', {})).length > 0);
  check(
    'un embudo de una etapa se rechaza',
    errores(w('funnel', { metrics: ['leads_count'] })).length > 0
  );
  check(
    'una etapa de embudo que no cuenta se rechaza',
    errores(w('funnel', { metrics: ['impressions', 'spend'] })).some((e) => e.includes('spend'))
  );
  check('un título sin texto se rechaza', errores(w('heading', {})).length > 0);
  check(
    'una métrica inventada se rechaza',
    errores(w('scorecard', { metric: 'gasto_total' })).some((e) => e.includes('no existe'))
  );
  check(
    'una dimensión inventada se rechaza',
    errores(w('bar', { metric: 'leads_count', dimension: 'provincia' })).some((e) =>
      e.includes('no existe')
    )
  );
  const leadans = w('bar', { metric: 'leadans:rango:2m_3m', dimension: 'utm_campaign' });
  check(
    'un token de respuesta sin catálogo pasa con aviso',
    errores(leadans).length === 0 && validarWidget(leadans).avisos.length > 0
  );
  const cat = { tokens: new Set(['leadans:rango:2m_3m']), aliases: new Set(['lf__rango__2m_3m']) };
  check('con catálogo, un token que existe pasa', errores(leadans, [], cat).length === 0);
  check(
    'con catálogo, un token que no existe se rechaza',
    errores(w('bar', { metric: 'leadans:rango:9m', dimension: 'utm_campaign' }), [], cat).length > 0
  );
  check(
    'dimension2 que el canvas ignora se avisa',
    validarWidget(
      w('bar', { metric: 'spend', dimension: 'date', dimension2: 'utm_source' })
    ).avisos.some((a) => a.includes('se ignora'))
  );

  // ── 3. Fórmulas ────────────────────────────────────────────────────────────
  console.log('\n── Fórmulas ─────────────────────────────────────────────────');

  check(
    'una fórmula bien formada pasa',
    validarFormula('spend / leads_count').errores.length === 0
  );
  check(
    'un error de sintaxis dice dónde',
    validarFormula('spend / (leads_count').errores.some((e) => e.includes('posición'))
  );
  check(
    'un identificador desconocido se detecta (antes valía 0 en silencio)',
    validarFormula('spend / lead_count').errores.some((e) => e.includes('lead_count'))
  );
  check(
    'un alias de respuesta con catálogo pasa',
    validarFormula('spend / lf__rango__2m_3m', cat).errores.length === 0
  );
  check(
    'un alias de respuesta que no está en el catálogo se rechaza',
    validarFormula('spend / lf__rango__9m', cat).errores.length > 0
  );
  check(
    'un campo calculado con coma se rechaza (rompería las columnas)',
    validarCampoCalculado({ name: 'CPL, real', expression: 'spend / leads_count' }).errores.length >
      0
  );

  // ── 4. Operaciones de layout ──────────────────────────────────────────────
  console.log('\n── Operaciones de layout ────────────────────────────────────');

  const base: BiWidget[] = [
    w('scorecard', { metric: 'spend' }, { id: 'a' }),
    w('section', {}, { id: 's', children: [w('text', { text: 'x' }, { id: 'b' })] }),
  ];
  check(
    'quitar un widget dentro de una sección funciona',
    quitarWidget(base, 'b')[1].children?.length === 0
  );
  let lanzo = false;
  try {
    quitarWidget(base, 'no-existe');
  } catch {
    lanzo = true;
  }
  check('quitar uno que no existe da error (antes decía que sí)', lanzo);
  check(
    'insertar en una sección y en una posición',
    insertarWidget(base, w('text', { text: 'y' }, { id: 'n' }), { seccionId: 's', posicion: 0 })[1]
      .children?.[0].id === 'n'
  );
  const movido = moverWidget(base, 'b', { seccionId: null, posicion: 0 });
  check('mover fuera de una sección', movido[0].id === 'b' && movido[2].children?.length === 0);
  lanzo = false;
  try {
    insertarWidget(base, w('section', {}, { id: 'z' }), { seccionId: 's' });
  } catch {
    lanzo = true;
  }
  check('no se mete una sección dentro de otra', lanzo);

  // ── 5. Ids de cliente y visibilidad ───────────────────────────────────────
  console.log('\n── Ids de cliente y visibilidad ─────────────────────────────');

  {
    const db = escenario();
    const ctx = contexto(db);
    const r = await ejecutarConTool(
      tool('create_report'),
      { nombre: 'Mensual', client_id: A },
      ctx
    );
    check(
      'create_report se aplica al momento',
      r.ok && r.aplicado === true,
      JSON.stringify(r.error)
    );
    const creado = db.tabla('public.bi_reports').find((f) => f.nombre === 'Mensual');
    check(
      'y guarda el id de report_utm, no el público',
      creado?.cliente_id === rA,
      String(creado?.cliente_id)
    );
    check(
      'devuelve el id y el client_id público',
      (r.data as { informe?: { id?: string; client_id?: string } })?.informe?.client_id === A &&
        Boolean((r.data as { informe?: { id?: string } })?.informe?.id)
    );
    check(
      'no deja ninguna propuesta pendiente',
      db.tabla('public.agent_action_approvals').length === 0
    );

    const ajeno = await ejecutarConTool(
      tool('create_report'),
      { nombre: 'Ajeno', client_id: B },
      ctx
    );
    check('create_report en un cliente ajeno da NOT_FOUND', ajeno.error?.code === 'NOT_FOUND');

    const sinEspejo = await ejecutarConTool(
      tool('create_report'),
      { nombre: 'Sin espejo', client_id: D },
      {
        ...ctx,
        allowedClientIds: [A, D],
      }
    );
    check(
      'un cliente sin espejo en Report-UTM se explica',
      sinEspejo.error?.code === 'VALIDATION_ERROR' && /espejo/.test(sinEspejo.error.message)
    );

    const get = await ejecutarConTool(tool('get_report'), { report_id: INF_A }, ctx);
    check(
      'un no-admin lee el informe de su cliente (antes: 404)',
      get.ok && (get.data as { informe: { client_id: string } }).informe.client_id === A
    );
    check(
      'get_report devuelve un índice con los widgets de dentro de las secciones',
      get.ok &&
        (get.data as { indice: { id: string; seccion_id: string | null }[] }).indice.some(
          (i) => i.id === 'c1' && i.seccion_id === 's1'
        )
    );
    const getB = await ejecutarConTool(tool('get_report'), { report_id: INF_B }, ctx);
    check('el informe de otro cliente da NOT_FOUND', getB.error?.code === 'NOT_FOUND');
    const getC = await ejecutarConTool(tool('get_report'), { report_id: INF_C }, ctx);
    check(
      'un informe de cliente sin enlace no lo ve un no-admin',
      getC.error?.code === 'NOT_FOUND'
    );
    const getCAdmin = await ejecutarConTool(
      tool('get_report'),
      { report_id: INF_C },
      {
        ...ctx,
        role: 'admin',
        level: 'admin',
        allowedClientIds: 'all',
      }
    );
    check('pero sí un admin', getCAdmin.ok);

    const lista = await ejecutarConTool(tool('list_reports'), {}, ctx);
    const ids = lista.ok
      ? [
          ...(lista.data as { informes: { id: string }[] }).informes,
          ...(lista.data as { plantillas: { id: string }[] }).plantillas,
        ].map((i) => i.id)
      : [];
    check('list_reports sin cliente incluye los suyos', ids.includes(INF_A));
    check('y las plantillas', ids.includes(PLANTILLA));
    check(
      'pero no los de otros clientes (antes listaba todos)',
      !ids.includes(INF_B) && !ids.includes(INF_C)
    );

    const desdeAjeno = await ejecutarConTool(
      tool('create_report'),
      { nombre: 'Copia', client_id: A, source_report_id: INF_B },
      ctx
    );
    check('no se copia un informe ajeno como plantilla', desdeAjeno.error?.code === 'NOT_FOUND');

    const desdePlantilla = await ejecutarConTool(
      tool('create_report'),
      { nombre: 'Desde plantilla', client_id: A, source_report_id: PLANTILLA },
      ctx
    );
    check('pero sí una plantilla', desdePlantilla.ok, JSON.stringify(desdePlantilla.error));

    const editarPlantilla = await ejecutarConTool(
      tool('update_report'),
      { report_id: PLANTILLA, nombre: 'Tocada' },
      { ...ctx, role: 'admin', level: 'admin', allowedClientIds: 'all' }
    );
    check(
      'una plantilla del sistema no se edita ni siendo admin',
      editarPlantilla.error?.code === 'UNAUTHORIZED'
    );
  }

  // ── 6. Directa frente a aprobación ────────────────────────────────────────
  console.log('\n── Directa frente a aprobación ──────────────────────────────');

  for (const t of ALL_TOOLS.filter((x) => x.mutation)) {
    if (t.mutation!.approval === 'directa') {
      check(`[${t.name}] directa ⇒ riesgo bajo`, t.mutation!.risk === 'low');
    }
  }
  const directas = ALL_TOOLS.filter((t) => esDirecta(t)).map((t) => t.name);
  check(
    'solo los informes (y sync_client) tienen escrituras directas',
    ALL_TOOLS.filter((t) => esDirecta(t)).every(
      (t) => t.domain === 'informes' || t.name === 'sync_client'
    ),
    directas.join(',')
  );
  for (const n of ['share_report', 'delete_report', 'set_report_client']) {
    check(
      `[${n}] sigue pidiendo aprobación`,
      !esDirecta(tool(n)) && tool(n).mutation?.risk === 'high'
    );
    check(
      `[${n}] comprueba al proponer (precheck)`,
      typeof tool(n).mutation?.precheck === 'function'
    );
  }

  {
    const db = escenario();
    const admin = contexto(db, { role: 'admin', level: 'admin', allowedClientIds: 'all' });
    const r = await ejecutarConTool(tool('share_report'), { report_id: INF_A }, admin);
    check(
      'share_report queda pendiente de aprobación',
      r.ok && (r.data as { estado?: string }).estado === 'pendiente_de_aprobacion'
    );
    check('y no se ejecuta', informeDe(db, INF_A).public_token === null);
    check('la propuesta se registra', db.tabla('public.agent_action_approvals').length === 1);

    const acotado = contexto(db, { role: 'admin', level: 'admin', allowedClientIds: [A] });
    const ajeno = await ejecutarConTool(tool('share_report'), { report_id: INF_B }, acotado);
    check('el precheck rechaza al proponer un informe ajeno', ajeno.error?.code === 'NOT_FOUND');
    check(
      'y no deja propuesta (antes quedaba «pendiente» y fallaba al aprobar)',
      db.tabla('public.agent_action_approvals').length === 1
    );

    const trampa: AnyAgentTool = {
      name: 'trampa',
      domain: 'informes',
      description: 'Una escritura de riesgo alto marcada por error como directa.',
      input: z.object({}),
      scopes: ['write:reports'],
      minLevel: 'admin',
      mutation: { risk: 'high', approval: 'directa', summarize: () => 'trampa' },
      handler: async () => {
        throw new Error('no debería ejecutarse');
      },
    };
    const t = await ejecutarConTool(trampa, {}, admin);
    check(
      'riesgo alto + directa se trata como aprobación',
      t.ok && (t.data as { estado?: string }).estado === 'pendiente_de_aprobacion'
    );
  }

  // ── 7. Editar, revisiones y deshacer ──────────────────────────────────────
  console.log('\n── Editar, revisiones y deshacer ────────────────────────────');

  {
    const db = escenario();
    const ctx = contexto(db);
    const add = await ejecutarConTool(
      tool('add_report_widget'),
      {
        report_id: INF_A,
        widget: {
          type: 'bar',
          title: 'Gasto',
          config: { metric: 'spend', dimension: 'utm_campaign' },
        },
        seccion_id: 's1',
      },
      ctx
    );
    check(
      'add_report_widget se aplica',
      add.ok && add.aplicado === true,
      JSON.stringify(add.error)
    );
    const revisionId = (add.data as { revision_id?: string })?.revision_id;
    check('y devuelve una revisión para deshacer', Boolean(revisionId));
    check(
      'el widget queda dentro de la sección',
      informeDe(db, INF_A).layout[1].children?.length === 2
    );

    const malo = await ejecutarConTool(
      tool('add_report_widget'),
      {
        report_id: INF_A,
        widget: { type: 'bar', config: { metric: 'spend', dimension: 'ip_country' } },
      },
      ctx
    );
    check(
      'un widget que mostraría 0 se rechaza al momento',
      malo.error?.code === 'VALIDATION_ERROR' && informeDe(db, INF_A).layout.length === 2
    );

    const upd = await ejecutarConTool(
      tool('update_report_widget'),
      {
        report_id: INF_A,
        widget_id: 'k1',
        cambios: { title: 'Contactos', config: { compare_period: true } },
        mover: { seccion_id: 's1', posicion: 0 },
      },
      ctx
    );
    check('update_report_widget cambia y mueve', upd.ok, JSON.stringify(upd.error));
    const layout = informeDe(db, INF_A).layout;
    check(
      'el widget editado conserva su config y la amplía',
      layout[0].id === 's1' &&
        layout[0].children?.[0].title === 'Contactos' &&
        layout[0].children?.[0].config.metric === 'leads_count' &&
        layout[0].children?.[0].config.compare_period === true
    );

    const quitarNada = await ejecutarConTool(
      tool('remove_report_widget'),
      { report_id: INF_A, widget_id: 'nada' },
      ctx
    );
    check(
      'remove_report_widget con un id inexistente da error',
      quitarNada.error?.code === 'NOT_FOUND'
    );

    const renombrar = await ejecutarConTool(
      tool('upsert_calculated_field'),
      {
        report_id: INF_A,
        nombre: 'CPL total',
        expresion: 'spend / leads_count',
        nombre_anterior: 'CPL real',
      },
      ctx
    );
    check('renombrar un campo calculado se aplica', renombrar.ok, JSON.stringify(renombrar.error));
    const tabla = informeDe(db, INF_A)
      .layout.flatMap((x) => [x, ...(x.children ?? [])])
      .find((x) => x.id === 'c1');
    check(
      'y actualiza las columnas de las tablas que lo usan',
      tabla?.config.metric === 'spend,leads_count,CPL total',
      String(tabla?.config.metric)
    );
    const borrarUsado = await ejecutarConTool(
      tool('remove_calculated_field'),
      { report_id: INF_A, nombre: 'CPL total' },
      ctx
    );
    check(
      'no se borra un campo calculado en uso',
      borrarUsado.error?.code === 'VALIDATION_ERROR' && /c1/.test(borrarUsado.error.message)
    );
    const formulaMala = await ejecutarConTool(
      tool('upsert_calculated_field'),
      { report_id: INF_A, nombre: 'Malo', expresion: 'spend / lead_count' },
      ctx
    );
    check('una fórmula con una errata se rechaza', formulaMala.error?.code === 'VALIDATION_ERROR');

    const filtroMalo = await ejecutarConTool(
      tool('update_report'),
      { report_id: INF_A, filtros: { provincia: 'Antioquia' } },
      ctx
    );
    check(
      'update_report rechaza una clave de filtro inventada',
      filtroMalo.error?.code === 'VALIDATION_ERROR'
    );
    const filtroBueno = await ejecutarConTool(
      tool('update_report'),
      {
        report_id: INF_A,
        filtros: { utm_source: 'facebook' },
        periodo: { date_from: '2026-08-01', date_to: '2026-08-31' },
      },
      ctx
    );
    check(
      'y guarda filtros y periodo',
      filtroBueno.ok &&
        (informeDe(db, INF_A).filters as Fila).utm_source === 'facebook' &&
        (informeDe(db, INF_A).filters as Fila).date_from === '2026-08-01'
    );

    // Deshacer el primer cambio devuelve el layout original.
    const restaurar = await ejecutarConTool(
      tool('restore_report_revision'),
      { revision_id: revisionId },
      ctx
    );
    check('restore_report_revision se aplica', restaurar.ok, JSON.stringify(restaurar.error));
    const tras = informeDe(db, INF_A);
    check(
      'y el informe vuelve a su estado anterior',
      tras.layout.length === 2 &&
        tras.layout[1].children?.length === 1 &&
        tras.layout[0].id === 'k1'
    );
    check(
      'restaurar también deja revisión (se puede deshacer)',
      Boolean((restaurar.data as { revision_id?: string })?.revision_id)
    );

    // Escritura condicionada: otra mano guardó entre la lectura y la escritura.
    const leido = structuredClone(informeDe(db, INF_A));
    informeDe(db, INF_A).updated_at = '2030-01-01T00:00:00.000Z';
    const antes = db.tabla('public.bi_report_revisions').length;
    let conflicto = '';
    try {
      await escribirConRevision(
        { ...ctx, operacion: { tool: 't', resumen: 'r' } },
        leido as never,
        {
          nombre: 'pisado',
        }
      );
    } catch (e) {
      conflicto = (e as { code?: string }).code ?? '';
    }
    check('un cambio concurrente da CONFLICT en vez de pisarlo', conflicto === 'CONFLICT');
    check(
      'y no deja una revisión huérfana',
      db.tabla('public.bi_report_revisions').length === antes
    );
    check('ni toca el informe', informeDe(db, INF_A).nombre !== 'pisado');
  }

  {
    // Sin la tabla de revisiones (migración 092 sin aplicar).
    const db = escenario();
    db.errores.set('public.bi_report_revisions', { code: 'PGRST205', message: 'no existe' });
    const ctx = contexto(db);
    const r = await ejecutarConTool(
      tool('add_report_widget'),
      { report_id: INF_A, widget: { type: 'text', config: { text: 'Hola' } } },
      ctx
    );
    check(
      'sin historial la edición sigue funcionando',
      r.ok && informeDe(db, INF_A).layout.length === 3
    );
    check('pero avisa de que no se podrá deshacer', JSON.stringify(r.data).includes('092'));
    const admin = contexto(db, { role: 'admin', level: 'admin', allowedClientIds: 'all' });
    let borrar = '';
    try {
      await tool('delete_report').handler({ report_id: INF_A }, admin);
    } catch (e) {
      borrar = (e as { code?: string }).code ?? '';
    }
    check('delete_report se niega a borrar sin revisión', borrar === 'INVALID_CONFIG');
    check('y el informe sigue ahí', Boolean(informeDe(db, INF_A)));
  }

  {
    // Borrar y recrear.
    const db = escenario();
    const admin = contexto(db, { role: 'admin', level: 'admin', allowedClientIds: 'all' });
    const res = (await tool('delete_report').handler(
      { report_id: INF_A },
      {
        ...admin,
        operacion: { tool: 'delete_report', resumen: 'borrar' },
      }
    )) as { revision_id?: string };
    check('delete_report borra y deja revisión', !informeDe(db, INF_A) && Boolean(res.revision_id));
    const vuelta = await ejecutarConTool(
      tool('restore_report_revision'),
      { revision_id: res.revision_id },
      admin
    );
    check(
      'restore_report_revision recrea un informe borrado',
      vuelta.ok && informeDe(db, INF_A)?.layout.length === 2,
      JSON.stringify(vuelta.error)
    );
  }

  {
    // La vista previa valida antes de consultar.
    const db = escenario();
    const r = await ejecutarConTool(
      tool('preview_widget'),
      {
        report_id: INF_A,
        widget: { type: 'bar', config: { metric: 'spend', dimension: 'ip_country' } },
      },
      contexto(db)
    );
    check(
      'preview_widget devuelve los errores de un widget inválido sin consultar',
      r.ok && (r.data as { valido?: boolean }).valido === false
    );
    const lejos = await ejecutarConTool(
      tool('preview_widget'),
      {
        client_id: A,
        widget: { type: 'scorecard', config: { metric: 'spend' } },
        date_from: '2025-01-01',
        date_to: '2026-01-01',
      },
      contexto(db)
    );
    check('preview_widget acota el periodo', lejos.error?.code === 'VALIDATION_ERROR');
  }

  {
    const db = escenario();
    const r = await ejecutarConTool(tool('list_report_fields'), { client_id: A }, contexto(db));
    const d = r.data as { metricas?: { id: string }[]; dimensiones?: { id: string }[] };
    check(
      'list_report_fields trae métricas fijas',
      Boolean(d?.metricas?.some((m) => m.id === 'spend'))
    );
    check('y dimensiones', Boolean(d?.dimensiones?.some((m) => m.id === 'utm_campaign')));
    const cruce = await ejecutarConTool(
      tool('list_report_fields'),
      { client_id: A, dimension: 'ip_country', buscar: 'gasto' },
      contexto(db)
    );
    check(
      'con dimension marca lo que no cruza',
      JSON.stringify(cruce.data).includes('"cruza":false')
    );
  }

  // ── 8. La consulta de la vista previa es la del widget ────────────────────
  console.log('\n── La vista previa pide lo mismo que el widget ──────────────');

  const filtros = { cliente_id: rA, date_from: '2026-09-01', date_to: '2026-09-26' };
  const p = (x: BiWidget, calc: Parameters<typeof paramsDeWidget>[2] = []) => {
    const r = paramsDeWidget(x, filtros, calc);
    return 'params' in r ? r.params : null;
  };
  const sc = p(w('scorecard', { formula: 'spend / leads_count' }));
  check(
    'scorecard con fórmula: bajo __formula y sin métricas',
    sc?.get('calc[__formula]') === 'spend / leads_count' && sc?.get('metrics') === ''
  );
  check(
    'lleva cliente y fechas',
    sc?.get('cliente_id') === rA && sc?.get('date_to') === '2026-09-26'
  );
  const piv = p(
    w('bar', { metric: 'leads_count', dimension: 'utm_campaign', dimension2: 'utm_source' })
  );
  check(
    'barras con dimensión secundaria: pivote',
    piv?.get('type') === 'pivot' && piv?.get('dimension2') === 'utm_source'
  );
  const sinPiv = p(
    w('bar', { metric: 'spend', dimension: 'utm_campaign', dimension2: 'utm_source' })
  );
  check('con gasto no hay pivote (como el canvas)', sinPiv?.get('type') === null);
  const tab = p(w('table', { metric: 'spend,CPL real', dimension: 'utm_campaign' }), [
    { id: 'c', name: 'CPL real', expression: 'spend / leads_count' },
  ]);
  check(
    'tabla: el campo calculado viaja como calc[], no como métrica',
    tab?.get('metrics') === 'spend' && tab?.get('calc[CPL real]') === 'spend / leads_count'
  );
  const emb = p(w('funnel', { metrics: ['impressions', 'clicks', 'leads_count'] }));
  check(
    'embudo',
    emb?.get('type') === 'funnel' && emb?.get('metrics') === 'impressions,clicks,leads_count'
  );
  check(
    'un título no consulta',
    'sinDatos' in paramsDeWidget(w('heading', { text: 'x' }), filtros)
  );

  check(
    'columnas offline: solo las numéricas incluidas',
    JSON.stringify(
      columnasOfflineDeConfig({
        google_sheets_conversiones: {
          name: 'Ventas',
          custom_columns: {
            ticket: { type: 'currency', label: 'Ticket' },
            nota: { type: 'text' },
            oculta: { type: 'count', include: false },
          },
        },
      }).map((c) => c.key)
    ) === '["ticket"]'
  );

  // ── 9. Las dos reglas de cruce no divergen más ────────────────────────────
  console.log('\n── Regla de cruce: editor frente a registro canónico ────────');
  // El editor y el agente usan `metricCrossesDimension`; el selector de campos,
  // `fieldCrossesDimension` del registro canónico. Hoy discrepan en 170 pares
  // (sobre todo dimensiones de ventas/Hotmart y utm_id): es deuda conocida. Esto
  // impide que crezca sin que nadie lo vea. 174 desde el 2026-09-28: las dos
  // métricas de resultados personalizados (`resultados_custom`,
  // `coste_por_resultado_custom`) heredan la MISMA pareja que cualquier métrica
  // de anuncios (`utm_id`, `platform`), no una discrepancia nueva. 177 desde la
  // migración 097: las tres derivadas de GA4 que dividen el gasto
  // (`ga4_coste_sesion`, `ga4_coste_evento_clave`, `ga4_roas`) heredan la pareja
  // `utm_id` del gasto, igual que `cpl`.
  const DISCREPANCIAS_CONOCIDAS = 177;
  let difs = 0;
  for (const m of Object.keys(METRIC_META)) {
    for (const d of Object.keys(DIMENSION_META)) {
      if (d === 'none') continue;
      if (
        metricCrossesDimension(m, d) !==
        fieldCrossesDimension(BASE_REGISTRY, migrateMeasureId(m), migrateDimensionId(d))
      ) {
        difs++;
      }
    }
  }
  check(
    `las discrepancias no crecen (hoy ${difs}, tope ${DISCREPANCIAS_CONOCIDAS})`,
    difs <= DISCREPANCIAS_CONOCIDAS
  );

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
