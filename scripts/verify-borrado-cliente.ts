/**
 * Comprobaciones del ciclo de vida de un cliente (`src/lib/clientes/ciclo-de-vida.ts`).
 *
 * Regla del 2026-09-14: eliminar un cliente borra TODOS sus datos. Las FK en
 * cascada cubren la base (eso lo vigila `verify-borrado-cascada.ts` contra el
 * catálogo real); esto vigila lo que no:
 *
 *   · lo del agente sin FK (propuestas pendientes, conversaciones de sus grupos,
 *     `client_scope`), antes de borrar;
 *   · las tablas grandes vaciadas por tramos, y UN solo DELETE de cliente, el
 *     del reporting, que arrastra el espejo en la misma sentencia;
 *   · Storage (bitácoras y logos, paginando) y lo externo (Meta, WhatsApp)
 *     después, sin bloquear y sin tocar lo que usa otro cliente;
 *   · el alta: siempre los dos lados enlazados, con un slug que no se reutiliza.
 *
 * Puro: una base falsa registra cada operación, sin Postgres ni red.
 *
 *   npx tsx --conditions=react-server scripts/verify-borrado-cliente.ts
 */

import {
  TRAMOS_UUID,
  borrarDatosSueltos,
  crearCliente,
  eliminarClienteCompleto,
  eliminarClienteUtm,
  pendientesExternos,
  resumenBorradoUtm,
  slugsCandidatos,
} from '../src/lib/clientes/ciclo-de-vida';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

// ── Base falsa ────────────────────────────────────────────────────────
type Accion = 'select' | 'delete' | 'update' | 'insert' | 'list' | 'remove' | 'fetch';
type Op = {
  schema: string;
  tabla: string;
  accion: Accion;
  filtros: Array<[string, string, unknown]>;
  valores?: unknown;
};

function dbFalsa(opts: {
  filas?: (op: Op) => unknown[];
  contar?: (op: Op) => number;
  insertar?: (op: Op) => { data?: unknown; error?: { message: string; code?: string } };
  fallaEn?: (op: Op) => string | null;
  archivos?: Record<string, string[]>;
  storageRevienta?: boolean;
  fetchRevienta?: boolean;
}) {
  const ops: Op[] = [];
  const removidos: string[] = [];
  const llamadas: Array<{ url: string; method?: string }> = [];

  const cliente = (schema: string) => ({
    from(tabla: string) {
      const op: Op = { schema, tabla, accion: 'select', filtros: [] };
      let single = false;
      const filtro =
        (tipo: string) =>
        (c: string, v: unknown): unknown => (op.filtros.push([c, tipo, v]), q);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        delete: () => ((op.accion = 'delete'), q),
        update: (v: unknown) => ((op.accion = 'update'), (op.valores = v), q),
        insert: (v: unknown) => ((op.accion = 'insert'), (op.valores = v), q),
        eq: filtro('eq'),
        in: filtro('in'),
        gte: filtro('gte'),
        lt: filtro('lt'),
        contains: filtro('contains'),
        not: (c: string, _o: string, v: unknown) => (op.filtros.push([c, 'not', v]), q),
        limit: () => q,
        order: () => q,
        maybeSingle: () => ((single = true), q),
        single: () => ((single = true), q),
        then: (ok: (r: unknown) => unknown, ko: (e: unknown) => unknown) => {
          ops.push(op);
          const falla = opts.fallaEn?.(op) ?? null;
          let data: unknown = null;
          let count: number | null = null;
          let error: { message: string; code?: string } | null = falla ? { message: falla } : null;
          if (!falla && op.accion === 'select') {
            const filas = opts.filas?.(op) ?? [];
            data = single ? (filas[0] ?? null) : filas;
            count = opts.contar?.(op) ?? filas.length;
          }
          if (!falla && op.accion === 'insert') {
            const r = opts.insertar?.(op) ?? { data: { id: 'nuevo' } };
            data = r.data ?? null;
            error = r.error ?? null;
          }
          if (!falla && op.accion === 'update') data = [];
          return Promise.resolve({ data, error, count }).then(ok, ko);
        },
      };
      return q;
    },
  });

  const db = {
    ...cliente('public'),
    schema: (s: string) => cliente(s),
    storage: {
      from: () => ({
        list: async (carpeta: string, o: { limit: number; offset: number }) => {
          if (opts.storageRevienta) throw new Error('storage caído');
          ops.push({ schema: 'storage', tabla: carpeta, accion: 'list', filtros: [] });
          const todos = (opts.archivos?.[carpeta] ?? []).map((name) => ({
            name,
            id: `id-${name}`,
          }));
          return { data: todos.slice(o.offset, o.offset + o.limit), error: null };
        },
        remove: async (rutas: string[]) => {
          removidos.push(...rutas);
          ops.push({
            schema: 'storage',
            tabla: 'remove',
            accion: 'remove',
            filtros: [['n', 'eq', rutas.length]],
          });
          return { data: null, error: null };
        },
      }),
    },
  };

  const fetchFalso = (async (url: string, init?: { method?: string }) => {
    ops.push({ schema: 'meta', tabla: String(url), accion: 'fetch', filtros: [] });
    if (opts.fetchRevienta) throw new Error('red caída');
    llamadas.push({ url: String(url), method: init?.method });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  return { db, ops, removidos, llamadas, fetch: fetchFalso };
}

const es = (op: Op, schema: string, tabla: string, accion: Accion) =>
  op.schema === schema && op.tabla === tabla && op.accion === accion;
const filtro = (op: Op | undefined, col: string) => op?.filtros.find(([c]) => c === col)?.[2];
const tiene = (op: Op, col: string) => op.filtros.some(([c]) => c === col);
/** Valor del filtro `tipo` (gte, lt…) sobre `col`. */
const rango = (op: Op | undefined, col: string, tipo: string) =>
  op?.filtros.find(([c, t]) => c === col && t === tipo)?.[2];
const idx = (ops: Op[], schema: string, tabla: string, accion: Accion) =>
  ops.findIndex((o) => es(o, schema, tabla, accion));
const json = (v: unknown) => JSON.stringify(v);

const PUB = 'pub-1';
const UTM = 'utm-1';
const CONTACTOS = [
  { id: 'c-varios', client_scope: [PUB, 'pub-otro'] },
  { id: 'c-solo', client_scope: [PUB] },
];

/** Tablas que se vacían por tramos; la base falsa les da una fila para que no se salten. */
const PESADAS = [
  'lead_events',
  'pixel_events',
  'sales_events',
  'ads_daily',
  'metricas_diarias',
  'sheet_filas',
  'sheet_campo_valores_diarios',
];
const conFilasPesadas = (op: Op) => op.accion === 'select' && PESADAS.includes(op.tabla);

/** Cliente enlazado con un grupo propio, uno compartido, y una Página propia y otra compartida. */
const filasBase = (op: Op): unknown[] => {
  if (conFilasPesadas(op)) return [{ id: 'fila' }];
  if (es(op, 'report_utm', 'clientes', 'select')) return [{ id: UTM, public_cliente_id: PUB }];
  if (es(op, 'public', 'agent_contacts', 'select')) return CONTACTOS;
  if (es(op, 'public', 'agent_channels', 'select')) {
    return tiene(op, 'cliente_id')
      ? [
          { external_id: 'g-suyo@g.us', kind: 'group' },
          { external_id: 'dm@s.whatsapp.net', kind: 'dm' },
        ]
      : // Después del borrado solo quedan los canales de otros clientes.
        [{ external_id: 'g-compartido@g.us' }];
  }
  if (es(op, 'public', 'whatsapp_routes', 'select')) {
    return tiene(op, 'cliente_id')
      ? [{ group_id: 'g-suyo@g.us' }, { group_id: 'g-compartido@g.us' }]
      : [];
  }
  if (es(op, 'report_utm', 'integrations', 'select')) {
    return tiene(op, 'cliente_id')
      ? [
          {
            config: {
              pages: [
                { page_id: 'p-suya', page_token: 't1' },
                { page_id: 'p-compartida', page_token: 't2' },
              ],
            },
          },
        ]
      : [
          {
            cliente_id: 'utm-otro',
            config: { pages: [{ page_id: 'p-compartida', page_token: 't9' }] },
          },
        ];
  }
  return [];
};

const MIL_QUINIENTAS = Array.from({ length: 1500 }, (_, i) => `${i}.webp`);
const archivosBase = {
  [PUB]: MIL_QUINIENTAS,
  branding: [`cliente_${UTM}_1.png`, `cliente_${UTM}0_2.png`, 'logo_1.webp'],
};

const SUELTAS_VIEJAS = ['bi_reports', 'agent_channels', 'notifications', 'whatsapp_messages'];

async function silencioso<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

async function main() {
  // ── 1. Borrado completo de un cliente enlazado ──────────────────────
  console.log('\n1. Cliente enlazado: se borra todo, en orden');
  {
    const f = dbFalsa({ filas: filasBase, archivos: archivosBase });
    const r = await eliminarClienteCompleto(f.db, PUB, { fetch: f.fetch });
    check('termina bien y sin avisos', r.ok && r.avisos.length === 0, json(r));
    const { ops } = f;

    const propuestas = ops.find((o) => es(o, 'public', 'agent_action_approvals', 'delete'));
    check(
      'borra sus propuestas PENDIENTES del agente, por client_id de los dos lados',
      filtro(propuestas, 'status') === 'pendiente' &&
        json(filtro(propuestas, 'input->>client_id')) === json([PUB, UTM])
    );
    const conv = ops.find((o) => es(o, 'public', 'agent_conversations', 'delete'));
    check(
      'borra las conversaciones de sus grupos del agente (no las de privados)',
      filtro(conv, 'channel') === 'whatsapp' &&
        json(filtro(conv, 'external_id')) === json(['g-suyo@g.us'])
    );

    const updates = ops.filter((o) => es(o, 'public', 'agent_contacts', 'update'));
    const varios = updates.find((o) => filtro(o, 'id') === 'c-varios');
    check(
      'contacto con varios clientes: se le quita solo el borrado',
      json((varios?.valores as { client_scope?: string[] })?.client_scope) === json(['pub-otro'])
    );
    check(
      'contacto con solo ese cliente: NO se vacía (vacío = acceso a todos)',
      !updates.some((o) => filtro(o, 'id') === 'c-solo')
    );

    const leads = ops.filter((o) => es(o, 'report_utm', 'lead_events', 'delete'));
    check(
      'vacía lead_events en 16 tramos, por su cliente UTM',
      leads.length === 16 && leads.every((o) => json(filtro(o, 'cliente_id')) === json([UTM])),
      `${leads.length} tramos`
    );
    check(
      'los tramos cubren todo: el primero desde 0000…, el último sin tope',
      rango(leads[0], 'id', 'gte') === TRAMOS_UUID[0][0] &&
        rango(leads[0], 'id', 'lt') === TRAMOS_UUID[1][0] &&
        rango(leads[15], 'id', 'gte') === TRAMOS_UUID[15][0] &&
        rango(leads[15], 'id', 'lt') === undefined
    );
    const ads = ops.filter((o) => es(o, 'public', 'ads_daily', 'delete'));
    check(
      'vacía ads_daily en 16 tramos, por su cliente del reporting',
      ads.length === 16 && ads.every((o) => json(filtro(o, 'cliente_id')) === json([PUB]))
    );

    const iPub = idx(ops, 'public', 'clientes', 'delete');
    check('borra el cliente del reporting por su id', filtro(ops[iPub], 'id') === PUB);
    check(
      'UN solo DELETE de cliente: el espejo UTM cae por la cascada',
      idx(ops, 'report_utm', 'clientes', 'delete') < 0 &&
        ops.filter((o) => o.tabla === 'clientes' && o.accion === 'delete').length === 1
    );
    check(
      'ya no borra a mano lo que cubren las FK (informes, canales, notificaciones, mensajes)',
      SUELTAS_VIEJAS.every((t) => idx(ops, 'public', t, 'delete') < 0)
    );
    const antes = ops
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.accion === 'delete' && o.tabla !== 'clientes')
      .map(({ i }) => i);
    check(
      'lo suelto y las tablas grandes van ANTES del DELETE del cliente',
      antes.length > 0 && antes.every((i) => i < iPub)
    );
    const despues = ops
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => o.accion === 'remove' || o.accion === 'fetch')
      .map(({ i }) => i);
    check(
      'Storage y Meta van DESPUÉS (si el borrado fallara, no se desconecta nada)',
      despues.length > 0 && despues.every((i) => i > iPub)
    );

    check(
      'borra las 1500 imágenes de sus bitácoras y su logo (paginando)',
      f.removidos.length === 1501 &&
        f.removidos.includes(`${PUB}/1499.webp`) &&
        f.removidos.includes(`branding/cliente_${UTM}_1.png`),
      `${f.removidos.length} archivos`
    );
    check(
      'no toca el logo de otro cliente con id parecido ni el branding global',
      !f.removidos.includes(`branding/cliente_${UTM}0_2.png`) &&
        !f.removidos.includes('branding/logo_1.webp')
    );
    check(
      'borra de mil en mil (tope de la API de Storage)',
      ops.filter((o) => o.accion === 'remove').every((o) => (filtro(o, 'n') as number) <= 1000)
    );

    check(
      'da de baja en Meta su Página, y no la que usa otro cliente',
      f.llamadas.length === 1 &&
        f.llamadas[0].method === 'DELETE' &&
        f.llamadas[0].url.includes('/p-suya/subscribed_apps') &&
        f.llamadas[0].url.includes('access_token=t1'),
      json(f.llamadas)
    );
    const grupos = ops.find((o) => es(o, 'public', 'whatsapp_groups', 'update'));
    check(
      'desactiva su grupo de WhatsApp, y no el que usa otro cliente',
      json(grupos?.valores) === json({ enabled: false }) &&
        json(filtro(grupos, 'group_id')) === json(['g-suyo@g.us'])
    );
  }

  // ── 2. Un fallo antes de borrar no toca el cliente ───────────────────
  console.log('\n2. Si falla lo suelto, el cliente no se toca');
  {
    const f = dbFalsa({
      filas: filasBase,
      fallaEn: (op) => (es(op, 'public', 'agent_action_approvals', 'delete') ? 'timeout' : null),
    });
    const r = await eliminarClienteCompleto(f.db, PUB, { fetch: f.fetch });
    check('devuelve el error', !r.ok && /propuestas/.test(r.error), json(r));
    check(
      'no borra el cliente ni vacía sus tablas',
      idx(f.ops, 'public', 'clientes', 'delete') < 0 &&
        idx(f.ops, 'report_utm', 'lead_events', 'delete') < 0
    );
  }

  // ── 3. Si falla el DELETE del cliente, no se desconecta nada ─────────
  console.log('\n3. Si falla el DELETE del cliente, Storage y externos no se tocan');
  {
    const f = dbFalsa({
      filas: filasBase,
      archivos: archivosBase,
      fallaEn: (op) => (es(op, 'public', 'clientes', 'delete') ? 'canceling statement' : null),
    });
    const r = await eliminarClienteCompleto(f.db, PUB, { fetch: f.fetch });
    check('devuelve el error', !r.ok && /No se pudo borrar el cliente/.test(r.error), json(r));
    check(
      'ni archivos, ni Meta, ni WhatsApp',
      f.removidos.length === 0 &&
        f.llamadas.length === 0 &&
        idx(f.ops, 'public', 'whatsapp_groups', 'update') < 0
    );
  }

  // ── 4. Storage y Meta caídos no dejan el cliente a medias ────────────
  console.log('\n4. Storage y Meta caídos: el cliente se borra y se avisa');
  {
    const f = dbFalsa({ filas: filasBase, storageRevienta: true, fetchRevienta: true });
    const r = await silencioso(() => eliminarClienteCompleto(f.db, PUB, { fetch: f.fetch }));
    check('termina bien', r.ok, json(r));
    check('borra igualmente el cliente', idx(f.ops, 'public', 'clientes', 'delete') >= 0);
    check(
      'devuelve un aviso por Storage y otro por Meta',
      r.ok &&
        r.avisos.length === 2 &&
        r.avisos.some((a) => /Storage/.test(a)) &&
        r.avisos.some((a) => /Meta/.test(a)),
      json(r)
    );
  }

  // ── 5. Huérfano de Report-UTM ────────────────────────────────────────
  console.log('\n5. Cliente UTM huérfano (sin enlace)');
  {
    const f = dbFalsa({
      filas: (op) => {
        if (conFilasPesadas(op)) return [{ id: 'fila' }];
        if (es(op, 'report_utm', 'clientes', 'select'))
          return [{ id: 'utm-9', public_cliente_id: null }];
        if (es(op, 'report_utm', 'integrations', 'select') && tiene(op, 'cliente_id')) {
          return [{ config: { pages: [{ page_id: 'p-huerfana', page_token: 'th' }] } }];
        }
        return [];
      },
      archivos: { branding: ['cliente_utm-9_a.png', 'cliente_utm-1_b.png'] },
    });
    const r = await eliminarClienteUtm(f.db, 'utm-9', { fetch: f.fetch });
    check('termina bien', r.ok, json(r));
    const del = f.ops.find((o) => es(o, 'report_utm', 'clientes', 'delete'));
    check('borra el cliente UTM por su id', json(filtro(del, 'id')) === json(['utm-9']));
    const propuestas = f.ops.find((o) => es(o, 'public', 'agent_action_approvals', 'delete'));
    check(
      'borra sus propuestas del agente',
      json(filtro(propuestas, 'input->>client_id')) === json(['utm-9'])
    );
    check(
      'no escribe en el reporting (no tiene cliente allí)',
      !f.ops.some(
        (o) =>
          o.schema === 'public' && o.accion !== 'select' && o.tabla !== 'agent_action_approvals'
      )
    );
    check(
      'vacía sus tablas UTM por tramos',
      f.ops.filter((o) => es(o, 'report_utm', 'pixel_events', 'delete')).length === 16
    );
    check(
      'borra su logo y no el de otro cliente',
      json(f.removidos) === json(['branding/cliente_utm-9_a.png']),
      json(f.removidos)
    );
    check(
      'da de baja su Página de Meta',
      f.llamadas.length === 1 && f.llamadas[0].url.includes('/p-huerfana/')
    );
  }

  // ── 6. Enlazado borrado desde Report-UTM → los dos lados ─────────────
  console.log('\n6. Cliente enlazado borrado desde Report-UTM');
  {
    const f = dbFalsa({ filas: filasBase });
    const r = await eliminarClienteUtm(f.db, UTM, { fetch: f.fetch });
    check('termina bien', r.ok);
    const pub = f.ops.find((o) => es(o, 'public', 'clientes', 'delete'));
    check('borra el cliente del reporting', filtro(pub, 'id') === PUB);
  }

  // ── 7. Sin nada que borrar, sin operaciones ──────────────────────────
  console.log('\n7. borrarDatosSueltos sin nada que borrar');
  {
    const f = dbFalsa({});
    const r = await borrarDatosSueltos(f.db, { publicId: null, utmIds: [] });
    check('termina bien sin operaciones', r.ok && f.ops.length === 0, json(f.ops));
  }

  // ── 8. Qué se desconecta solo y qué queda a mano ─────────────────────
  console.log('\n8. Checklist de sistemas externos');
  {
    const todo = pendientesExternos({
      tiposIntegracion: ['gohighlevel', 'hotmart', 'meta_lead_ads'],
      conPixel: true,
      gruposWhatsapp: 2,
    });
    check(
      'Meta y los grupos se desconectan solos',
      todo.automatico.length === 2 &&
        todo.automatico.some((t) => /Meta/.test(t)) &&
        todo.automatico.some((t) => /WhatsApp/.test(t))
    );
    check(
      'GHL, Hotmart, el sitio web y el bot quedan a mano',
      ['GoHighLevel', 'Hotmart', 'Sitio web', 'bot'].every((p) =>
        todo.manual.some((t) => t.includes(p))
      ),
      json(todo.manual)
    );
    const nada = pendientesExternos({ tiposIntegracion: [], conPixel: false, gruposWhatsapp: 0 });
    check('sin conexiones, nada que listar', nada.automatico.length + nada.manual.length === 0);
    const s2s = pendientesExternos({
      tiposIntegracion: ['s2s'],
      conPixel: false,
      gruposWhatsapp: 0,
    });
    check('S2S sin eventos de píxel también pide retirar el del sitio', s2s.manual.length === 1);
  }

  // ── 9. Resumen de un huérfano ────────────────────────────────────────
  console.log('\n9. Resumen para confirmar el borrado de un huérfano');
  {
    const f = dbFalsa({
      filas: (op) => {
        if (es(op, 'report_utm', 'clientes', 'select')) {
          return [{ id: 'utm-9', nombre: 'Huérfano', public_cliente_id: null }];
        }
        if (es(op, 'report_utm', 'integrations', 'select')) {
          return [{ tipo: 'gohighlevel' }, { tipo: 's2s' }];
        }
        return [];
      },
      contar: (op) => (es(op, 'report_utm', 'lead_events', 'select') ? 7 : 0),
    });
    const r = await resumenBorradoUtm(f.db, 'utm-9');
    check('no está enlazado', r?.enlazado === false, json(r));
    check('cuenta sus leads', r?.leadsAprox === 7);
    check(
      'no consulta el reporting',
      !f.ops.some(
        (o) => o.schema === 'public' && ['metricas_diarias', 'bitacoras'].includes(o.tabla)
      )
    );
    check(
      'lista GoHighLevel y el sitio web para desconectar a mano',
      r?.manual.length === 2 && r.manual.some((t) => t.includes('GoHighLevel'))
    );
  }

  // ── 10. Tramos y slugs ───────────────────────────────────────────────
  console.log('\n10. Tramos de uuid y slugs');
  {
    const contiguos = TRAMOS_UUID.every(([, hasta], i) =>
      i < 15 ? hasta === TRAMOS_UUID[i + 1][0] : hasta === null
    );
    check('16 tramos contiguos, de 0 a f', TRAMOS_UUID.length === 16 && contiguos);
    const slugs = slugsCandidatos('Café Ñandú', '1bf00bdb-38e7-4070-96b9-f00aa05db73f');
    check(
      'el slug lleva siempre un trozo del id (no se reutiliza el de un borrado)',
      slugs.every((s) => s.startsWith('cafe-nandu-1bf00b')) && new Set(slugs).size === 3,
      json(slugs)
    );
  }

  // ── 11. Alta: los dos lados, enlazados ───────────────────────────────
  console.log('\n11. Alta de cliente');
  {
    let intentosUtm = 0;
    const f = dbFalsa({
      insertar: (op) => {
        if (op.schema === 'public') return { data: { id: 'pub-n', nombre: 'Nuevo' } };
        intentosUtm++;
        return intentosUtm === 1
          ? { error: { message: 'duplicate key', code: '23505' } }
          : { data: { id: 'utm-n' } };
      },
    });
    const r = await crearCliente(f.db, '  Nuevo  ');
    check('crea el cliente y su espejo', r.ok && r.espejoId === 'utm-n', json(r));
    const pub = f.ops.find((o) => es(o, 'public', 'clientes', 'insert'));
    check('el nombre se guarda limpio', (pub?.valores as { nombre?: string })?.nombre === 'Nuevo');
    const utm = f.ops.filter((o) => es(o, 'report_utm', 'clientes', 'insert'));
    const esperados = slugsCandidatos('Nuevo', 'pub-n');
    check(
      'el espejo nace enlazado, y un slug ocupado prueba el siguiente',
      utm.length === 2 &&
        utm.every(
          (o) => (o.valores as { public_cliente_id?: string }).public_cliente_id === 'pub-n'
        ) &&
        (utm[1].valores as { slug?: string }).slug === esperados[1]
    );

    const vacio = dbFalsa({});
    const r2 = await crearCliente(vacio.db, '   ');
    check('sin nombre no crea nada', !r2.ok && vacio.ops.length === 0);
  }

  // ── 12. Tabla sin filas del cliente: se salta ────────────────────────
  console.log('\n12. Tablas grandes sin filas del cliente');
  {
    const f = dbFalsa({
      filas: (op) => (es(op, 'report_utm', 'lead_events', 'select') ? [] : filasBase(op)),
    });
    const r = await eliminarClienteCompleto(f.db, PUB, { fetch: f.fetch });
    check('termina bien', r.ok, json(r));
    check(
      'no lanza 16 DELETE sobre una tabla vacía para el cliente',
      idx(f.ops, 'report_utm', 'lead_events', 'delete') < 0
    );
    check(
      'las demás se siguen vaciando',
      f.ops.filter((o) => es(o, 'report_utm', 'pixel_events', 'delete')).length === 16
    );
  }

  // ── 13. Un statement timeout suelto se reintenta ─────────────────────
  console.log('\n13. Cortes transitorios de la base (statement timeout)');
  {
    const TIMEOUT = 'canceling statement due to statement timeout';
    let tramos = 0;
    let finales = 0;
    const f = dbFalsa({
      filas: filasBase,
      fallaEn: (op) => {
        if (es(op, 'report_utm', 'lead_events', 'delete') && ++tramos === 1) return TIMEOUT;
        if (es(op, 'public', 'clientes', 'delete') && ++finales === 1) return TIMEOUT;
        return null;
      },
    });
    const r = await eliminarClienteCompleto(f.db, PUB, { fetch: f.fetch });
    check('un corte en un tramo y otro en el DELETE final no abortan', r.ok, json(r));
    check(
      'repite solo lo que se cortó',
      f.ops.filter((o) => es(o, 'report_utm', 'lead_events', 'delete')).length === 17 &&
        f.ops.filter((o) => es(o, 'public', 'clientes', 'delete')).length === 2
    );

    const siempre = dbFalsa({
      filas: filasBase,
      fallaEn: (op) => (es(op, 'report_utm', 'lead_events', 'delete') ? TIMEOUT : null),
    });
    const r2 = await eliminarClienteCompleto(siempre.db, PUB, { fetch: siempre.fetch });
    check('un corte persistente se rinde y lo dice', !r2.ok && /lead_events/.test(r2.error));
    check(
      'tras 3 intentos, sin tocar el cliente',
      siempre.ops.filter((o) => es(o, 'report_utm', 'lead_events', 'delete')).length === 3 &&
        idx(siempre.ops, 'public', 'clientes', 'delete') < 0
    );
  }

  console.log(fallos === 0 ? '\n✓ TODO OK\n' : `\n✗ ${fallos} fallo(s)\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n✗ Fallo del arnés:', e);
  process.exit(1);
});
