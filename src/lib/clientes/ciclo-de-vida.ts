/**
 * Ciclo de vida de un cliente: una sola casa.
 *
 * Hay dos tablas de clientes —`public.clientes` (reporting) y
 * `report_utm.clientes` (atribución)— unidas por `public_cliente_id`. Hasta el
 * 2026-09-12 cada lado creaba y borraba por su cuenta, y pasaba lo que el PM vio
 * en la reunión:
 *
 *   · borrar en el reporting dejaba el cliente UTM huérfano (la FK es
 *     `ON DELETE SET NULL`), con cinco de sus siete fuentes en cero en silencio;
 *   · borrar en UTM no servía: `/report-utm/clientes` recreaba el cliente en
 *     cada render desde el reporting, con id nuevo y sin sus leads.
 *
 * La regla ahora: **`public.clientes` es la fuente de verdad** y su espejo UTM
 * se crea, archiva y borra con él. Todo pasa por aquí para que no vuelva a haber
 * dos caminos.
 *
 * Recibe el cliente Supabase con service role ya creado: así lo comparten las
 * acciones de los dos módulos sin importar nada de Next.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Db = any;

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
 * Devuelve el cliente UTM enlazado a un cliente del reporting, y lo crea si no
 * existe. Es idempotente: llamarlo dos veces no crea dos espejos.
 */
export async function asegurarEspejoUtm(
  admin: Db,
  publicId: string,
  nombre: string
): Promise<{ id: string | null; creado: boolean; error?: string }> {
  const rtm = admin.schema('report_utm');
  const { data: existente, error: e1 } = await rtm
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId)
    .limit(1);
  if (e1) return { id: null, creado: false, error: e1.message };
  if (existente?.[0]?.id) return { id: existente[0].id as string, creado: false };

  // El slug es único. Con el nombre solo chocaría con un homónimo (o con el
  // huérfano del mismo cliente): el sufijo del id lo desambigua sin azar.
  const base = slugDeNombre(nombre) || 'cliente';
  for (const slug of [
    base,
    `${base}-${publicId.slice(0, 6)}`,
    `${base}-${publicId.slice(0, 12)}`,
  ]) {
    const { data, error } = await rtm
      .from('clientes')
      .insert({ nombre, slug, public_cliente_id: publicId, color: 'emerald', status: 'active' })
      .select('id')
      .single();
    if (!error) return { id: data.id as string, creado: true };
    if ((error as { code?: string }).code !== '23505') {
      return { id: null, creado: false, error: error.message };
    }
  }
  return { id: null, creado: false, error: 'No se encontró un slug libre para el cliente.' };
}

export type ResumenBorrado = {
  nombre: string;
  diasMetricas: number;
  ventasHotmart: number;
  /** Aproximado: contar exacto decenas de miles de leads agota el timeout. */
  leadsAprox: number;
  ventas: number;
  informesBi: number;
  espejos: number;
};

/** Lo que se va a perder, para que la confirmación no sea a ciegas. */
export async function resumenBorrado(admin: Db, publicId: string): Promise<ResumenBorrado | null> {
  const { data: cliente } = await admin
    .from('clientes')
    .select('id, nombre')
    .eq('id', publicId)
    .maybeSingle();
  if (!cliente) return null;

  const rtm = admin.schema('report_utm');
  const { data: espejos } = await rtm
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId);
  const ids = ((espejos ?? []) as Array<{ id: string }>).map((e) => e.id);

  const contar = async (q: any): Promise<number> => {
    const { count } = await q;
    return count ?? 0;
  };

  const [diasMetricas, ventasHotmart, leadsAprox, ventas, informesBi] = await Promise.all([
    contar(
      admin
        .from('metricas_diarias')
        .select('id', { count: 'exact', head: true })
        .eq('cliente_id', publicId)
    ),
    contar(
      admin
        .from('hotmart_ventas')
        .select('id', { count: 'exact', head: true })
        .eq('cliente_id', publicId)
    ),
    ids.length
      ? contar(
          rtm
            .from('lead_events')
            .select('id', { count: 'planned', head: true })
            .in('cliente_id', ids)
        )
      : Promise.resolve(0),
    ids.length
      ? contar(
          rtm
            .from('sales_events')
            .select('id', { count: 'exact', head: true })
            .in('cliente_id', ids)
        )
      : Promise.resolve(0),
    ids.length
      ? contar(
          admin
            .from('bi_reports')
            .select('id', { count: 'exact', head: true })
            .in('cliente_id', ids)
        )
      : Promise.resolve(0),
  ]);

  return {
    nombre: String(cliente.nombre ?? ''),
    diasMetricas,
    ventasHotmart,
    leadsAprox,
    ventas,
    informesBi,
    espejos: ids.length,
  };
}

type Resultado = { ok: true } | { ok: false; error: string };

/**
 * Lo que las FK no borran solas. Va ANTES de borrar los clientes: después ya no
 * habría forma de encontrarlo, porque las `SET NULL` dejan `cliente_id` en null.
 *
 *   · `bi_reports` guarda el id del cliente UTM sin FK: sus informes (y, por
 *     cascada, sus envíos) sobrevivían al cliente.
 *   · `agent_channels`, `notifications` y `whatsapp_messages` son `SET NULL`. En
 *     los canales es además un agujero: un grupo fijado a un cliente limita al
 *     agente a ese cliente (`api/agent/run`); con el cliente en null, el grupo
 *     pasaría a ver TODOS los clientes del contacto.
 *   · `agent_contacts.client_scope` es un array sin FK. El id se quita solo si
 *     quedan otros: un array vacío significa «sin recorte», así que vaciarlo
 *     AMPLIARÍA el acceso. Con el id borrado como único valor, el contacto no ve
 *     ningún cliente, que es lo correcto.
 *   · El logo de branding vive en Storage con el id UTM en el nombre.
 *
 * La migración 080 convierte las FK en cascada; mientras no esté aplicada esto
 * lo cubre, y después sigue siendo inofensivo.
 */
export async function borrarDatosSueltos(
  admin: Db,
  { publicId, utmIds }: { publicId: string | null; utmIds: string[] }
): Promise<Resultado> {
  const pasos: Array<[string, () => any]> = [];
  if (utmIds.length > 0) {
    pasos.push([
      'sus informes BI',
      () => admin.from('bi_reports').delete().in('cliente_id', utmIds),
    ]);
  }
  if (publicId) {
    for (const tabla of ['agent_channels', 'notifications', 'whatsapp_messages']) {
      pasos.push([tabla, () => admin.from(tabla).delete().eq('cliente_id', publicId)]);
    }
  }
  for (const [que, paso] of pasos) {
    const { error } = await paso();
    if (error) return { ok: false, error: `No se pudo borrar ${que}: ${error.message}` };
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
      if (e)
        return { ok: false, error: `No se pudo actualizar un contacto del agente: ${e.message}` };
    }
  }

  // El logo no bloquea el borrado: un archivo suelto en Storage no se ve en
  // ninguna parte, y fallar aquí dejaría el cliente a medio borrar.
  for (const id of utmIds) {
    try {
      const bucket = admin.storage.from('bitacoras-images');
      const prefijo = `cliente_${id}_`;
      const { data: archivos } = await bucket.list('branding', { search: prefijo, limit: 100 });
      const rutas = ((archivos ?? []) as Array<{ name: string }>)
        .filter((a) => a.name.startsWith(prefijo))
        .map((a) => `branding/${a.name}`);
      if (rutas.length > 0) await bucket.remove(rutas);
    } catch (e) {
      console.error('[borrarDatosSueltos] logo sin borrar:', e);
    }
  }
  return { ok: true };
}

/**
 * Borra un cliente de Report-UTM con todo lo suyo. Si está enlazado, lo borra en
 * los dos lados; si es huérfano, solo existe aquí y aquí acaba.
 */
export async function eliminarClienteUtm(admin: Db, utmId: string): Promise<Resultado> {
  const rtm = admin.schema('report_utm');
  const { data: cliente, error: e0 } = await rtm
    .from('clientes')
    .select('id, public_cliente_id')
    .eq('id', utmId)
    .maybeSingle();
  if (e0) return { ok: false, error: e0.message };
  if (!cliente) return { ok: true };
  if (cliente.public_cliente_id) return eliminarClienteCompleto(admin, cliente.public_cliente_id);

  const sueltos = await borrarDatosSueltos(admin, { publicId: null, utmIds: [utmId] });
  if (!sueltos.ok) return sueltos;
  const { error } = await rtm.from('clientes').delete().eq('id', utmId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Borra el cliente en LOS DOS lados con todo lo suyo. Orden: lo suelto, el
 * espejo UTM (arrastra leads, ventas, integraciones, mapeos…) y el público
 * (arrastra métricas, Hotmart, pestañas…). El espejo va antes del público
 * porque, hasta la migración 080, su FK es `SET NULL`: borrar solo el público
 * lo dejaba huérfano, que es como nacieron los huérfanos de Report-UTM.
 */
export async function eliminarClienteCompleto(admin: Db, publicId: string): Promise<Resultado> {
  const { data: espejos, error: e0 } = await admin
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicId);
  if (e0) return { ok: false, error: `No se pudo leer el cliente en Report-UTM: ${e0.message}` };
  const utmIds = ((espejos ?? []) as Array<{ id: string }>).map((e) => e.id);

  const sueltos = await borrarDatosSueltos(admin, { publicId, utmIds });
  if (!sueltos.ok) return sueltos;

  const { error: e1 } = await admin
    .schema('report_utm')
    .from('clientes')
    .delete()
    .eq('public_cliente_id', publicId);
  if (e1) return { ok: false, error: `No se pudo borrar el cliente en Report-UTM: ${e1.message}` };

  const { error: e2 } = await admin.from('clientes').delete().eq('id', publicId);
  if (e2) return { ok: false, error: e2.message };
  return { ok: true };
}

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
