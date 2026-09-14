/**
 * Comprobaciones del borrado de clientes (`src/lib/clientes/ciclo-de-vida.ts`).
 *
 * Regla del 2026-09-14: eliminar un cliente borra TODOS sus datos. Las FK en
 * cascada cubren casi todo; esto vigila lo que no: informes BI (sin FK), canales
 * del agente, notificaciones y mensajes (SET NULL), el alcance de los contactos
 * del agente (array) y el logo en Storage. Y el orden: lo suelto antes que los
 * clientes, o ya no habría forma de encontrarlo.
 *
 * Puro: una base falsa registra cada operación, sin Postgres.
 *
 *   npx tsx --conditions=react-server scripts/verify-borrado-cliente.ts
 */

import {
  borrarDatosSueltos,
  eliminarClienteCompleto,
  eliminarClienteUtm,
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
type Op = {
  schema: string;
  tabla: string;
  accion: 'select' | 'delete' | 'update' | 'list' | 'remove';
  filtros: Array<[string, string, unknown]>;
  valores?: unknown;
};

function dbFalsa(opts: {
  filas?: (op: Op) => unknown[];
  fallaEn?: (op: Op) => string | null;
  archivos?: string[];
  storageRevienta?: boolean;
}) {
  const ops: Op[] = [];
  const removidos: string[] = [];
  const cliente = (schema: string) => ({
    from(tabla: string) {
      const op: Op = { schema, tabla, accion: 'select', filtros: [] };
      let single = false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q: any = {
        select: () => q,
        delete: () => ((op.accion = 'delete'), q),
        update: (v: unknown) => ((op.accion = 'update'), (op.valores = v), q),
        eq: (c: string, v: unknown) => (op.filtros.push([c, 'eq', v]), q),
        in: (c: string, v: unknown) => (op.filtros.push([c, 'in', v]), q),
        contains: (c: string, v: unknown) => (op.filtros.push([c, 'contains', v]), q),
        maybeSingle: () => ((single = true), q),
        then: (ok: (r: unknown) => unknown, ko: (e: unknown) => unknown) => {
          ops.push(op);
          const err = opts.fallaEn?.(op) ?? null;
          let data: unknown = null;
          if (!err && op.accion === 'select') {
            const filas = opts.filas?.(op) ?? [];
            data = single ? (filas[0] ?? null) : filas;
          }
          return Promise.resolve({ data, error: err ? { message: err } : null }).then(ok, ko);
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
        list: async (prefijo: string, o?: { search?: string }) => {
          if (opts.storageRevienta) throw new Error('storage caído');
          ops.push({
            schema: 'storage',
            tabla: prefijo,
            accion: 'list',
            filtros: [['search', 'eq', o?.search]],
          });
          return { data: (opts.archivos ?? []).map((name) => ({ name })), error: null };
        },
        remove: async (rutas: string[]) => {
          removidos.push(...rutas);
          ops.push({ schema: 'storage', tabla: 'branding', accion: 'remove', filtros: [] });
          return { data: null, error: null };
        },
      }),
    },
  };
  return { db, ops, removidos };
}

const es = (op: Op, schema: string, tabla: string, accion: Op['accion']) =>
  op.schema === schema && op.tabla === tabla && op.accion === accion;
const filtro = (op: Op | undefined, col: string) => op?.filtros.find(([c]) => c === col)?.[2];
const idx = (ops: Op[], schema: string, tabla: string, accion: Op['accion']) =>
  ops.findIndex((o) => es(o, schema, tabla, accion));

const PUB = 'pub-1';
const UTM = 'utm-1';
const CONTACTOS = [
  { id: 'c-varios', client_scope: [PUB, 'pub-otro'] },
  { id: 'c-solo', client_scope: [PUB] },
];
const filasBase = (op: Op): unknown[] => {
  if (es(op, 'report_utm', 'clientes', 'select')) return [{ id: UTM, public_cliente_id: PUB }];
  if (es(op, 'public', 'agent_contacts', 'select')) return CONTACTOS;
  return [];
};

async function main() {
  // ── 1. Borrado completo de un cliente enlazado ──────────────────────
  console.log('\n1. Cliente enlazado: se borra todo, en orden');
  {
    const { db, ops, removidos } = dbFalsa({
      filas: filasBase,
      archivos: [`cliente_${UTM}_1.png`, `cliente_${UTM}0_2.png`],
    });
    const r = await eliminarClienteCompleto(db, PUB);
    check('termina bien', r.ok, JSON.stringify(r));

    const bi = ops.find((o) => es(o, 'public', 'bi_reports', 'delete'));
    check(
      'borra los informes BI del cliente UTM (no tienen FK)',
      JSON.stringify(filtro(bi, 'cliente_id')) === JSON.stringify([UTM])
    );
    for (const t of ['agent_channels', 'notifications', 'whatsapp_messages']) {
      const op = ops.find((o) => es(o, 'public', t, 'delete'));
      check(`borra ${t} del cliente (eran SET NULL)`, filtro(op, 'cliente_id') === PUB);
    }

    const updates = ops.filter((o) => es(o, 'public', 'agent_contacts', 'update'));
    const varios = updates.find((o) => filtro(o, 'id') === 'c-varios');
    check(
      'contacto con varios clientes: se le quita solo el borrado',
      JSON.stringify((varios?.valores as { client_scope?: string[] })?.client_scope) ===
        JSON.stringify(['pub-otro'])
    );
    check(
      'contacto con solo ese cliente: NO se vacía (vacío = acceso a todos)',
      !updates.some((o) => filtro(o, 'id') === 'c-solo')
    );

    check(
      'borra el logo del cliente y no el de otro con id parecido',
      JSON.stringify(removidos) === JSON.stringify([`branding/cliente_${UTM}_1.png`]),
      JSON.stringify(removidos)
    );

    const iUtm = idx(ops, 'report_utm', 'clientes', 'delete');
    const iPub = idx(ops, 'public', 'clientes', 'delete');
    const sueltos = ['bi_reports', 'agent_channels', 'notifications', 'whatsapp_messages'].map(
      (t) => idx(ops, 'public', t, 'delete')
    );
    check('borra el espejo UTM', iUtm >= 0);
    check('borra el cliente del reporting', iPub >= 0);
    check(
      'lo suelto va ANTES que los clientes',
      sueltos.every((i) => i >= 0 && i < iUtm && i < iPub),
      JSON.stringify({ sueltos, iUtm, iPub })
    );
    check('el espejo UTM va antes que el reporting (FK SET NULL hasta la 080)', iUtm < iPub);
  }

  // ── 2. Un fallo a medias no borra los clientes ───────────────────────
  console.log('\n2. Si falla lo suelto, los clientes no se tocan');
  {
    const { db, ops } = dbFalsa({
      filas: filasBase,
      fallaEn: (op) => (es(op, 'public', 'bi_reports', 'delete') ? 'timeout' : null),
    });
    const r = await eliminarClienteCompleto(db, PUB);
    check('devuelve el error', !r.ok && /informes BI/.test(r.error), JSON.stringify(r));
    check(
      'no borra ni el espejo ni el reporting',
      idx(ops, 'report_utm', 'clientes', 'delete') < 0 &&
        idx(ops, 'public', 'clientes', 'delete') < 0
    );
  }

  // ── 3. Storage caído no bloquea ──────────────────────────────────────
  console.log('\n3. Storage caído no deja el cliente a medio borrar');
  {
    const { db, ops } = dbFalsa({ filas: filasBase, storageRevienta: true });
    const errorOriginal = console.error;
    console.error = () => undefined;
    const r = await eliminarClienteCompleto(db, PUB);
    console.error = errorOriginal;
    check('termina bien', r.ok);
    check('borra igualmente el cliente', idx(ops, 'public', 'clientes', 'delete') >= 0);
  }

  // ── 4. Huérfano de Report-UTM ────────────────────────────────────────
  console.log('\n4. Cliente UTM huérfano (sin enlace)');
  {
    const { db, ops } = dbFalsa({
      filas: (op) =>
        es(op, 'report_utm', 'clientes', 'select')
          ? [{ id: 'utm-9', public_cliente_id: null }]
          : [],
    });
    const r = await eliminarClienteUtm(db, 'utm-9');
    check('termina bien', r.ok);
    const bi = ops.find((o) => es(o, 'public', 'bi_reports', 'delete'));
    check(
      'borra sus informes BI',
      JSON.stringify(filtro(bi, 'cliente_id')) === JSON.stringify(['utm-9'])
    );
    check(
      'no toca tablas del reporting (no tiene cliente allí)',
      !ops.some((o) =>
        ['agent_channels', 'notifications', 'whatsapp_messages', 'agent_contacts', 'clientes'].some(
          (t) => o.schema === 'public' && o.tabla === t && o.accion !== 'select'
        )
      )
    );
    const del = ops.find((o) => es(o, 'report_utm', 'clientes', 'delete'));
    check('borra el cliente UTM por su id', filtro(del, 'id') === 'utm-9');
  }

  // ── 5. Enlazado borrado desde Report-UTM → los dos lados ─────────────
  console.log('\n5. Cliente enlazado borrado desde Report-UTM');
  {
    const { db, ops } = dbFalsa({ filas: filasBase });
    const r = await eliminarClienteUtm(db, UTM);
    check('termina bien', r.ok);
    const pub = ops.find((o) => es(o, 'public', 'clientes', 'delete'));
    check('borra también el cliente del reporting', filtro(pub, 'id') === PUB);
  }

  // ── 6. Sin cliente del reporting no se filtra por null ───────────────
  console.log('\n6. borrarDatosSueltos sin nada que borrar');
  {
    const { db, ops } = dbFalsa({});
    const r = await borrarDatosSueltos(db, { publicId: null, utmIds: [] });
    check('termina bien sin operaciones', r.ok && ops.length === 0, JSON.stringify(ops));
  }

  console.log(fallos === 0 ? '\n✓ TODO OK\n' : `\n✗ ${fallos} fallo(s)\n`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n✗ Fallo del arnés:', e);
  process.exit(1);
});
