/**
 * Ciclo de vida de un cliente: una sola casa.
 *
 * Hay dos tablas de clientes —`public.clientes` (reporting) y
 * `report_utm.clientes` (atribución)— unidas por `public_cliente_id`. Hasta el
 * 2026-09-12 cada lado creaba y borraba por su cuenta, y así nacieron los
 * huérfanos de Report-UTM. La regla ahora: **`public.clientes` es la fuente de
 * verdad** y su espejo UTM se crea, archiva y borra con él. Todo pasa por aquí
 * para que no vuelva a haber dos caminos: los botones de los dos módulos, la
 * herramienta `create_client` del agente y los scripts.
 *
 * Borrar = borrar TODO (regla del 2026-09-14). Casi todo lo hacen las FK en
 * cascada (migraciones 080 y 081; `scripts/verify-borrado-cascada.ts` lo vigila
 * en el catálogo). Aquí va lo que ninguna FK alcanza:
 *
 *   · Del agente, sin FK: las propuestas pendientes (`input.client_id`), las
 *     conversaciones de los grupos fijados al cliente y `agent_contacts.client_scope`.
 *   · Storage: las imágenes de sus bitácoras y sus logos de branding.
 *   · Fuera de la plataforma: la suscripción de sus Páginas de Meta al webhook
 *     de leads y sus grupos de WhatsApp. Lo que no se puede desconectar desde
 *     aquí (GoHighLevel, Hotmart, el píxel del sitio) lo lista la confirmación
 *     (`resumenBorrado`).
 *
 * Recibe el cliente Supabase con service role ya creado: así lo comparten las
 * acciones de los dos módulos y los scripts sin importar nada de Next.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Db = any;
type Fetch = typeof fetch;

/** Bucket donde viven las imágenes de bitácoras y los logos de los clientes. */
export const BUCKET_CLIENTES = 'bitacoras-images';
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? 'v19.0'}`;
/** Tope de la API de Storage por llamada, al listar y al borrar. */
const LOTE_STORAGE = 1000;

const mensaje = (e: unknown) => (e instanceof Error ? e.message : String(e));
const unicos = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export function slugDeNombre(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Slugs a probar para un espejo nuevo, siempre con un trozo del id. El slug
 * identifica al cliente en el píxel (sin autenticar) y en los enlaces `/t/`: si
 * un cliente nuevo heredara el slug de uno borrado, recibiría los eventos del
 * sitio web del antiguo.
 */
export function slugsCandidatos(nombre: string, publicId: string): string[] {
  const base = (slugDeNombre(nombre) || 'cliente').slice(0, 48).replace(/-+$/, '');
  const id = publicId.replace(/-/g, '');
  return [`${base}-${id.slice(0, 6)}`, `${base}-${id.slice(0, 12)}`, `${base}-${id}`];
}

/**
 * Devuelve el cliente UTM enlazado a un cliente del reporting, y lo crea si no
 * existe. Es idempotente: llamarlo dos veces no crea dos espejos.
 */
export async function asegurarEspejoUtm(
  admin: Db,
  publicId: string,
  nombre: string,
  extra: { descripcion?: string | null; color?: string } = {}
): Promise<{ id: string | null; creado: boolean; error?: string }> {
  const rtm = admin.schema('report_utm');
  const { data: existente, error: e1 } = await rtm
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId)
    .limit(1);
  if (e1) return { id: null, creado: false, error: e1.message };
  if (existente?.[0]?.id) return { id: existente[0].id as string, creado: false };

  for (const slug of slugsCandidatos(nombre, publicId)) {
    const { data, error } = await rtm
      .from('clientes')
      .insert({
        nombre,
        slug,
        public_cliente_id: publicId,
        color: extra.color ?? 'emerald',
        status: 'active',
        ...(extra.descripcion !== undefined ? { descripcion: extra.descripcion } : {}),
      })
      .select('id')
      .single();
    if (!error) return { id: data.id as string, creado: true };
    if ((error as { code?: string }).code !== '23505') {
      return { id: null, creado: false, error: error.message };
    }
  }
  return { id: null, creado: false, error: 'No se encontró un slug libre para el cliente.' };
}

/**
 * Da de alta un cliente: en el reporting y, enlazado, en Report-UTM. Si el
 * espejo falla, el cliente ya existe: se devuelve el aviso y la ficha del
 * cliente lo vuelve a intentar al abrirse (`asegurarEspejoUtm`).
 */
export async function crearCliente(
  admin: Db,
  nombre: string,
  extra: { descripcion?: string | null; color?: string } = {}
): Promise<
  | {
      ok: true;
      cliente: { id: string; nombre: string } & Record<string, unknown>;
      espejoId: string | null;
      aviso?: string;
    }
  | { ok: false; error: string }
> {
  const limpio = nombre.trim();
  if (!limpio) return { ok: false, error: 'El nombre del cliente es obligatorio.' };

  const { data, error } = await admin
    .from('clientes')
    .insert({ nombre: limpio, config_api: {} })
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  const espejo = await asegurarEspejoUtm(admin, data.id, limpio, extra);
  return {
    ok: true,
    cliente: data,
    espejoId: espejo.id,
    aviso: espejo.id
      ? undefined
      : `El cliente se creó en el reporting, pero no su espejo en Report-UTM: ${espejo.error}`,
  };
}

// ─── Resumen para la confirmación ──────────────────────────────────────

export type ResumenBorrado = {
  nombre: string;
  /** Si existe en el reporting (si no, es un huérfano de Report-UTM). */
  enlazado: boolean;
  diasMetricas: number;
  ventasHotmart: number;
  /** Aproximado: contar exacto decenas de miles de leads agota el timeout. */
  leadsAprox: number;
  ventas: number;
  informesBi: number;
  bitacoras: number;
  gruposWhatsapp: number;
  espejos: number;
  /** Lo que el borrado desconecta solo fuera de la base de datos. */
  automatico: string[];
  /** Lo que hay que desconectar a mano, fuera de la plataforma. */
  manual: string[];
};

/** Qué se desconecta solo y qué queda a mano, según lo que tiene conectado. */
export function pendientesExternos(o: {
  tiposIntegracion: string[];
  conPixel: boolean;
  gruposWhatsapp: number;
}): { automatico: string[]; manual: string[] } {
  const tipos = new Set(o.tiposIntegracion);
  const automatico: string[] = [];
  const manual: string[] = [];
  if (tipos.has('meta_lead_ads')) {
    automatico.push(
      'Sus Páginas de Meta dejan de enviar leads en tiempo real (se da de baja la suscripción, salvo que otro cliente use la misma Página).'
    );
  }
  if (o.gruposWhatsapp > 0) {
    automatico.push(
      `Sus grupos de WhatsApp (${o.gruposWhatsapp}) dejan de recibir notificaciones, salvo los que use otro cliente.`
    );
    manual.push('WhatsApp: saca el bot de sus grupos si ya no debe estar en ellos.');
  }
  if (tipos.has('gohighlevel')) {
    manual.push(
      'GoHighLevel: desactiva los workflows que envían leads y ventas a Report-UTM (seguirían llegando y fallando).'
    );
  }
  if (tipos.has('hotmart')) manual.push('Hotmart: quita el webhook que apunta a Report-UTM.');
  if (tipos.has('s2s') || o.conPixel) {
    manual.push(
      'Sitio web: retira el píxel o el plugin de WordPress de Report-UTM y las llamadas S2S.'
    );
  }
  return { automatico, manual };
}

async function resumir(
  admin: Db,
  { nombre, publicId, utmIds }: { nombre: string; publicId: string | null; utmIds: string[] }
): Promise<ResumenBorrado> {
  const rtm = admin.schema('report_utm');
  const contar = async (q: any): Promise<number> => {
    const { count } = await q;
    return count ?? 0;
  };
  const filas = async (q: any): Promise<any[]> => {
    const { data } = await q;
    return data ?? [];
  };
  const cero = Promise.resolve(0);
  const nada = Promise.resolve([] as any[]);
  const hayUtm = utmIds.length > 0;
  const exacto = { count: 'exact', head: true } as const;

  const [
    diasMetricas,
    ventasHotmart,
    bitacoras,
    rutas,
    canales,
    leadsAprox,
    ventas,
    informesBi,
    pixel,
    integraciones,
  ] = await Promise.all([
    publicId
      ? contar(admin.from('metricas_diarias').select('id', exacto).eq('cliente_id', publicId))
      : cero,
    publicId
      ? contar(admin.from('hotmart_ventas').select('id', exacto).eq('cliente_id', publicId))
      : cero,
    publicId
      ? contar(admin.from('bitacoras').select('id', exacto).eq('cliente_id', publicId))
      : cero,
    publicId
      ? filas(admin.from('whatsapp_routes').select('group_id').eq('cliente_id', publicId))
      : nada,
    publicId
      ? filas(
          admin
            .from('agent_channels')
            .select('external_id')
            .eq('cliente_id', publicId)
            .eq('kind', 'group')
        )
      : nada,
    hayUtm
      ? contar(
          rtm
            .from('lead_events')
            .select('id', { count: 'planned', head: true })
            .in('cliente_id', utmIds)
        )
      : cero,
    hayUtm ? contar(rtm.from('sales_events').select('id', exacto).in('cliente_id', utmIds)) : cero,
    hayUtm ? contar(admin.from('bi_reports').select('id', exacto).in('cliente_id', utmIds)) : cero,
    hayUtm ? filas(rtm.from('pixel_events').select('id').in('cliente_id', utmIds).limit(1)) : nada,
    hayUtm ? filas(rtm.from('integrations').select('tipo').in('cliente_id', utmIds)) : nada,
  ]);

  const gruposWhatsapp = unicos([
    ...rutas.map((r: { group_id: string }) => r.group_id),
    ...canales.map((c: { external_id: string }) => c.external_id),
  ]).length;

  return {
    nombre,
    enlazado: publicId !== null,
    diasMetricas,
    ventasHotmart,
    leadsAprox,
    ventas,
    informesBi,
    bitacoras,
    gruposWhatsapp,
    espejos: utmIds.length,
    ...pendientesExternos({
      tiposIntegracion: integraciones.map((i: { tipo: string }) => i.tipo),
      conPixel: pixel.length > 0,
      gruposWhatsapp,
    }),
  };
}

/** Lo que se va a perder, para que la confirmación no sea a ciegas. */
export async function resumenBorrado(admin: Db, publicId: string): Promise<ResumenBorrado | null> {
  const { data: cliente } = await admin
    .from('clientes')
    .select('id, nombre')
    .eq('id', publicId)
    .maybeSingle();
  if (!cliente) return null;

  const { data: espejos } = await admin
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId);
  const utmIds = ((espejos ?? []) as Array<{ id: string }>).map((e) => e.id);
  return resumir(admin, { nombre: String(cliente.nombre ?? ''), publicId, utmIds });
}

/** El mismo resumen desde Report-UTM: si está enlazado, es el del cliente entero. */
export async function resumenBorradoUtm(admin: Db, utmId: string): Promise<ResumenBorrado | null> {
  const { data: cliente } = await admin
    .schema('report_utm')
    .from('clientes')
    .select('id, nombre, public_cliente_id')
    .eq('id', utmId)
    .maybeSingle();
  if (!cliente) return null;
  if (cliente.public_cliente_id) return resumenBorrado(admin, cliente.public_cliente_id);
  return resumir(admin, { nombre: String(cliente.nombre ?? ''), publicId: null, utmIds: [utmId] });
}

// ─── Borrado ───────────────────────────────────────────────────────────

/** `avisos`: lo de fuera de la base que no se pudo limpiar; el cliente ya no existe. */
type Resultado = { ok: true; avisos: string[] } | { ok: false; error: string };

type Reunido = {
  publicId: string | null;
  utmIds: string[];
  /** `external_id` de los grupos del agente fijados al cliente. */
  conversaciones: string[];
  /** Sus grupos de WhatsApp: rutas de notificación y grupos fijados del agente. */
  grupos: string[];
  /** Páginas de Meta que suscribieron sus integraciones de leads, con su token. */
  paginas: Array<{ page_id: string; page_token: string }>;
};

type IntegracionMeta = {
  cliente_id?: string;
  config?: { pages?: Array<{ page_id?: string; page_token?: string }> } | null;
};

function paginasDe(
  integraciones: IntegracionMeta[]
): Array<{ page_id: string; page_token: string }> {
  const porId = new Map<string, string>();
  for (const i of integraciones) {
    for (const p of i.config?.pages ?? []) {
      if (p?.page_id && p.page_token) porId.set(String(p.page_id), String(p.page_token));
    }
  }
  return [...porId].map(([page_id, page_token]) => ({ page_id, page_token }));
}

/**
 * Todo lo que hará falta DESPUÉS de borrar, leído ANTES: con el cliente borrado
 * sus canales, rutas e integraciones ya no existen. Un fallo aquí aborta sin
 * haber tocado nada.
 */
async function reunir(
  admin: Db,
  publicId: string | null,
  utmIds: string[]
): Promise<{ ok: true; r: Reunido } | { ok: false; error: string }> {
  let canales: Array<{ external_id: string; kind: string }> = [];
  let rutas: Array<{ group_id: string }> = [];
  if (publicId) {
    const [c, w] = await Promise.all([
      admin.from('agent_channels').select('external_id, kind').eq('cliente_id', publicId),
      admin.from('whatsapp_routes').select('group_id').eq('cliente_id', publicId),
    ]);
    if (c.error)
      return { ok: false, error: `No se pudieron leer sus canales del agente: ${c.error.message}` };
    if (w.error)
      return { ok: false, error: `No se pudieron leer sus grupos de WhatsApp: ${w.error.message}` };
    canales = c.data ?? [];
    rutas = w.data ?? [];
  }

  let paginas: Reunido['paginas'] = [];
  if (utmIds.length > 0) {
    const { data, error } = await admin
      .schema('report_utm')
      .from('integrations')
      .select('config')
      .eq('tipo', 'meta_lead_ads')
      .in('cliente_id', utmIds);
    if (error)
      return { ok: false, error: `No se pudieron leer sus integraciones: ${error.message}` };
    paginas = paginasDe(data ?? []);
  }

  const gruposAgente = canales.filter((c) => c.kind === 'group').map((c) => c.external_id);
  return {
    ok: true,
    r: {
      publicId,
      utmIds,
      conversaciones: unicos(gruposAgente),
      grupos: unicos([...rutas.map((r) => r.group_id), ...gruposAgente]),
      paginas,
    },
  };
}

/**
 * Lo del agente que ninguna FK alcanza. Va ANTES de borrar el cliente: después
 * no habría forma de encontrarlo.
 *
 *   · Propuestas pendientes con `input.client_id` del cliente: sin esto seguían
 *     en la cola y se podían aprobar. Las ya resueltas son historial.
 *   · Conversaciones de sus grupos del agente (`external_id` sin FK al canal);
 *     mensajes y turnos caen con ellas. `agent_audit_log` se conserva: es el
 *     registro de quién hizo qué.
 *   · `agent_contacts.client_scope` es un array sin FK. El id se quita solo si
 *     quedan otros: un array vacío significa «sin recorte», así que vaciarlo
 *     AMPLIARÍA el acceso. Con el id borrado como único valor, el contacto no ve
 *     ningún cliente, que es lo correcto.
 */
export async function borrarDatosSueltos(
  admin: Db,
  {
    publicId,
    utmIds,
    conversaciones = [],
  }: { publicId: string | null; utmIds: string[]; conversaciones?: string[] }
): Promise<Resultado> {
  const ids = unicos([publicId ?? '', ...utmIds]);
  if (ids.length > 0) {
    const { error } = await admin
      .from('agent_action_approvals')
      .delete()
      .eq('status', 'pendiente')
      .in('input->>client_id', ids);
    if (error) {
      return {
        ok: false,
        error: `No se pudieron borrar sus propuestas del agente: ${error.message}`,
      };
    }
  }

  if (conversaciones.length > 0) {
    const { error } = await admin
      .from('agent_conversations')
      .delete()
      .eq('channel', 'whatsapp')
      .in('external_id', conversaciones);
    if (error) {
      return {
        ok: false,
        error: `No se pudieron borrar sus conversaciones del agente: ${error.message}`,
      };
    }
  }

  if (publicId) {
    const { data: contactos, error } = await admin
      .from('agent_contacts')
      .select('id, client_scope')
      .contains('client_scope', [publicId]);
    if (error) {
      return { ok: false, error: `No se pudo revisar el alcance del agente: ${error.message}` };
    }
    for (const c of (contactos ?? []) as Array<{ id: string; client_scope: string[] | null }>) {
      const resto = (c.client_scope ?? []).filter((id) => id !== publicId);
      if (resto.length === 0) continue;
      const { error: e } = await admin
        .from('agent_contacts')
        .update({ client_scope: resto })
        .eq('id', c.id);
      if (e) {
        return { ok: false, error: `No se pudo actualizar un contacto del agente: ${e.message}` };
      }
    }
  }
  return { ok: true, avisos: [] };
}

/** Tablas que pueden tener decenas de miles de filas por cliente (todas con `id` uuid). */
const PESADAS: Array<{ schema: 'public' | 'report_utm'; tabla: string }> = [
  { schema: 'report_utm', tabla: 'lead_events' },
  { schema: 'report_utm', tabla: 'pixel_events' },
  { schema: 'report_utm', tabla: 'sales_events' },
  { schema: 'public', tabla: 'ads_daily' },
  { schema: 'public', tabla: 'metricas_diarias' },
  { schema: 'public', tabla: 'sheet_filas' },
  { schema: 'public', tabla: 'sheet_campo_valores_diarios' },
];

/** 16 tramos contiguos del espacio de uuids por su primer dígito: [desde, hasta). */
export const TRAMOS_UUID: Array<[string, string | null]> = Array.from({ length: 16 }, (_, i) => [
  `${i.toString(16)}0000000-0000-0000-0000-000000000000`,
  i < 15 ? `${(i + 1).toString(16)}0000000-0000-0000-0000-000000000000` : null,
]);

type ErrorDb = { code?: string; message: string } | null;

const esTimeout = (e: ErrorDb) =>
  e !== null && (e.code === '57014' || /statement timeout/i.test(e.message));

/**
 * La base corta de vez en cuando una sentencia trivial bajo carga (`statement
 * timeout`, el mismo corte intermitente que se ve en test:datos). Borrar a
 * Peiurba —cero leads, plan de índice— falló así el 2026-09-14. Se reintenta.
 */
async function conReintento<T extends { error: ErrorDb }>(
  hacer: () => PromiseLike<T>,
  intentos = 3
): Promise<T> {
  let r = await hacer();
  for (let i = 1; i < intentos && esTimeout(r.error); i++) r = await hacer();
  return r;
}

/**
 * PostgREST corta cada sentencia a los 8 s (`statement_timeout` de
 * `authenticator`). Un solo DELETE del cliente arrastraría de golpe todas sus
 * filas —Eduversio pasa de 140.000— y podría cortarse. Las tablas grandes se
 * vacían antes en 16 tramos por rango de `id`: cada tramo es una sentencia
 * pequeña, y el DELETE final del cliente solo arrastra lo poco que queda. Una
 * tabla en la que el cliente no tiene filas se salta.
 *
 * Si falla a medias, el cliente sigue existiendo con parte de sus datos y
 * borrarlo otra vez termina el trabajo.
 */
async function vaciarPesadas(
  admin: Db,
  { publicId, utmIds }: { publicId: string | null; utmIds: string[] }
): Promise<Resultado> {
  for (const { schema, tabla } of PESADAS) {
    const ids = schema === 'report_utm' ? utmIds : publicId ? [publicId] : [];
    if (ids.length === 0) continue;
    const base = schema === 'public' ? admin : admin.schema(schema);

    const { data: alguna, error: e0 } = await conReintento<{
      data: unknown[] | null;
      error: ErrorDb;
    }>(() => base.from(tabla).select('id').in('cliente_id', ids).limit(1));
    if (e0) return { ok: false, error: `No se pudo leer ${tabla}: ${e0.message}` };
    if (!alguna?.length) continue;

    for (const [desde, hasta] of TRAMOS_UUID) {
      const { error } = await conReintento(() => {
        const q = base.from(tabla).delete().in('cliente_id', ids).gte('id', desde);
        return hasta ? q.lt('id', hasta) : q;
      });
      if (error) return { ok: false, error: `No se pudo vaciar ${tabla}: ${error.message}` };
    }
  }
  return { ok: true, avisos: [] };
}

/** Nombres de una carpeta de Storage, paginando (la API devuelve de mil en mil). */
export async function listarArchivos(
  bucket: any,
  carpeta: string,
  { incluirCarpetas = false }: { incluirCarpetas?: boolean } = {}
): Promise<string[]> {
  const nombres: string[] = [];
  for (let offset = 0; ; offset += LOTE_STORAGE) {
    const { data, error } = await bucket.list(carpeta, { limit: LOTE_STORAGE, offset });
    if (error) throw new Error(error.message);
    const filas = (data ?? []) as Array<{ name: string; id: string | null }>;
    // Las carpetas llegan con `id` null.
    for (const f of filas) if (incluirCarpetas || f.id !== null) nombres.push(f.name);
    if (filas.length < LOTE_STORAGE) break;
  }
  return nombres;
}

/**
 * Imágenes de sus bitácoras (`{id del reporting}/…`, las sube el editor) y logos
 * de branding (`branding/cliente_{id UTM}_…`). Sin borrar, sus URL públicas
 * seguían funcionando. No bloquea: el cliente ya está borrado, y
 * `scripts/limpiar-storage-huerfano.ts` recoge lo que quede.
 */
async function borrarArchivos(admin: Db, r: Reunido): Promise<string[]> {
  try {
    const bucket = admin.storage.from(BUCKET_CLIENTES);
    const rutas: string[] = [];
    if (r.publicId) {
      const imagenes = await listarArchivos(bucket, r.publicId);
      rutas.push(...imagenes.map((n) => `${r.publicId}/${n}`));
    }
    if (r.utmIds.length > 0) {
      const prefijos = r.utmIds.map((id) => `cliente_${id}_`);
      const logos = await listarArchivos(bucket, 'branding');
      rutas.push(
        ...logos.filter((n) => prefijos.some((p) => n.startsWith(p))).map((n) => `branding/${n}`)
      );
    }
    for (let i = 0; i < rutas.length; i += LOTE_STORAGE) {
      const { error } = await bucket.remove(rutas.slice(i, i + LOTE_STORAGE));
      if (error) throw new Error(error.message);
    }
    return [];
  } catch (e) {
    return [
      `Quedaron archivos suyos en Storage (${mensaje(e)}); bórralos con scripts/limpiar-storage-huerfano.ts.`,
    ];
  }
}

/**
 * Lo de fuera de la plataforma que sí se puede desconectar desde aquí. Va
 * DESPUÉS de borrar (si el borrado fallara, el cliente seguiría recibiendo sus
 * leads) y nunca bloquea. Un recurso que usa otro cliente no se toca.
 *
 *   · Meta: `DELETE /{page}/subscribed_apps`, el espejo de
 *     `discoverAndSubscribePages`. Sin esto la Página seguía enviando cada lead
 *     al webhook, que ya no encontraba a quién asignarlo.
 *   · WhatsApp: el grupo se desactiva en el catálogo. El bot sigue dentro: eso
 *     solo se puede hacer desde WhatsApp, y lo recuerda la confirmación.
 */
async function desconectarExternos(admin: Db, r: Reunido, fetchImpl: Fetch): Promise<string[]> {
  const avisos: string[] = [];

  if (r.paginas.length > 0) {
    try {
      const { data, error } = await admin
        .schema('report_utm')
        .from('integrations')
        .select('cliente_id, config')
        .eq('tipo', 'meta_lead_ads');
      if (error) throw new Error(error.message);
      const deOtros = new Set(
        paginasDe(
          ((data ?? []) as IntegracionMeta[]).filter((i) => !r.utmIds.includes(i.cliente_id ?? ''))
        ).map((p) => p.page_id)
      );
      for (const p of r.paginas.filter((x) => !deOtros.has(x.page_id))) {
        try {
          const res = await fetchImpl(
            `${GRAPH}/${p.page_id}/subscribed_apps?access_token=${encodeURIComponent(p.page_token)}`,
            { method: 'DELETE', signal: AbortSignal.timeout(8000) }
          );
          if (!res.ok)
            avisos.push(`Meta no dio de baja la Página ${p.page_id} (HTTP ${res.status}).`);
        } catch (e) {
          avisos.push(`No se pudo dar de baja la Página de Meta ${p.page_id}: ${mensaje(e)}.`);
        }
      }
    } catch (e) {
      avisos.push(`Sus Páginas de Meta siguen suscritas: ${mensaje(e)}.`);
    }
  }

  if (r.grupos.length > 0) {
    try {
      const [rutas, canales] = await Promise.all([
        admin.from('whatsapp_routes').select('group_id').in('group_id', r.grupos),
        admin.from('agent_channels').select('external_id').in('external_id', r.grupos),
      ]);
      if (rutas.error || canales.error) throw new Error((rutas.error ?? canales.error).message);
      const enUso = new Set<string>([
        ...(rutas.data ?? []).map((x: { group_id: string }) => x.group_id),
        ...(canales.data ?? []).map((x: { external_id: string }) => x.external_id),
      ]);
      const libres = r.grupos.filter((g) => !enUso.has(g));
      if (libres.length > 0) {
        const { error } = await admin
          .from('whatsapp_groups')
          .update({ enabled: false })
          .in('group_id', libres);
        if (error) throw new Error(error.message);
      }
    } catch (e) {
      avisos.push(`No se pudieron desactivar sus grupos de WhatsApp: ${mensaje(e)}.`);
    }
  }

  return avisos;
}

/**
 * El orden importa:
 *
 *   1. Reunir lo que hará falta después (canales, grupos, Páginas de Meta).
 *   2. Lo que ninguna FK alcanza.
 *   3. Vaciar por tramos las tablas grandes.
 *   4. UN solo DELETE: el del reporting (o el del huérfano UTM). La cascada
 *      arrastra en la misma sentencia —y por tanto en la misma transacción— el
 *      espejo UTM y todo lo demás. Antes se borraba el espejo primero y, si el
 *      segundo DELETE fallaba, la ficha del cliente recreaba un espejo vacío.
 *   5. Storage y sistemas externos: con el cliente ya borrado, se intentan y lo
 *      que falle se devuelve como aviso.
 */
async function borrar(
  admin: Db,
  ids: { publicId: string | null; utmIds: string[] },
  fetchImpl: Fetch
): Promise<Resultado> {
  const reunido = await reunir(admin, ids.publicId, ids.utmIds);
  if (!reunido.ok) return reunido;
  const r = reunido.r;

  const sueltos = await borrarDatosSueltos(admin, r);
  if (!sueltos.ok) return sueltos;

  const vaciado = await vaciarPesadas(admin, ids);
  if (!vaciado.ok) return vaciado;

  const { error } = await conReintento(() =>
    ids.publicId
      ? admin.from('clientes').delete().eq('id', ids.publicId)
      : admin.schema('report_utm').from('clientes').delete().in('id', ids.utmIds)
  );
  if (error) return { ok: false, error: `No se pudo borrar el cliente: ${error.message}` };

  const avisos = [
    ...(await borrarArchivos(admin, r)),
    ...(await desconectarExternos(admin, r, fetchImpl)),
  ];
  for (const a of avisos) console.error('[eliminarCliente]', a);
  return { ok: true, avisos };
}

/** Borra el cliente en LOS DOS lados con todo lo suyo. */
export async function eliminarClienteCompleto(
  admin: Db,
  publicId: string,
  deps: { fetch?: Fetch } = {}
): Promise<Resultado> {
  const { data: espejos, error } = await admin
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId);
  if (error)
    return { ok: false, error: `No se pudo leer el cliente en Report-UTM: ${error.message}` };
  const utmIds = ((espejos ?? []) as Array<{ id: string }>).map((e) => e.id);
  return borrar(admin, { publicId, utmIds }, deps.fetch ?? fetch);
}

/**
 * Borra un cliente de Report-UTM con todo lo suyo. Si está enlazado, lo borra en
 * los dos lados; si es huérfano, solo existe aquí y aquí acaba.
 */
export async function eliminarClienteUtm(
  admin: Db,
  utmId: string,
  deps: { fetch?: Fetch } = {}
): Promise<Resultado> {
  const { data: cliente, error } = await admin
    .schema('report_utm')
    .from('clientes')
    .select('id, public_cliente_id')
    .eq('id', utmId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!cliente) return { ok: true, avisos: [] };
  if (cliente.public_cliente_id) {
    return eliminarClienteCompleto(admin, cliente.public_cliente_id, deps);
  }
  return borrar(admin, { publicId: null, utmIds: [utmId] }, deps.fetch ?? fetch);
}

// ─── Archivo ───────────────────────────────────────────────────────────

/**
 * Archiva o reactiva. El estado vive en el espejo UTM (`status`), la única de
 * las dos tablas que ya tenía la columna; el reporting lo lee de ahí.
 */
export async function archivarCliente(
  admin: Db,
  publicId: string,
  nombre: string,
  archivar: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const espejo = await asegurarEspejoUtm(admin, publicId, nombre);
  if (!espejo.id) return { ok: false, error: espejo.error ?? 'Sin cliente en Report-UTM.' };
  const { error } = await admin
    .schema('report_utm')
    .from('clientes')
    .update({ status: archivar ? 'archived' : 'active' })
    .eq('id', espejo.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** `public_cliente_id` → está archivado, para anotar listados del reporting. */
export async function mapaArchivados(admin: Db): Promise<Set<string>> {
  const { data } = await admin
    .schema('report_utm')
    .from('clientes')
    .select('public_cliente_id')
    .eq('status', 'archived')
    .not('public_cliente_id', 'is', null);
  return new Set(
    ((data ?? []) as Array<{ public_cliente_id: string }>).map((r) => r.public_cliente_id)
  );
}
