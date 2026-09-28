/**
 * Duplicados: «cuenta el primero».
 *
 * Un lead es duplicado si ya existe un lead ANTERIOR del mismo cliente, que
 * CUENTA, con el mismo email o el mismo teléfono. Si el primero no contaba —por
 * ejemplo, un WhatsApp sin atribución—, el siguiente sí cuenta: la persona
 * todavía no estaba en el conteo.
 *
 * No vive en `motivoExclusion` porque no se puede decidir mirando un solo lead.
 * Hay dos caminos, y los dos usan las mismas claves (`clavesContacto`):
 *
 *   · histórico (`marcarDuplicados`, puro): recorre los leads por fecha y lleva
 *     la cuenta de los contactos ya vistos;
 *   · ingesta (`excluirDuplicadosLote`): pregunta a la base qué contactos del
 *     lote ya existen (RPC `lead_contactos_existentes`, migración 093) y además
 *     deduplica dentro del propio lote.
 *
 * Sin la migración 093 la ingesta no marca duplicados: deja entrar el lead y
 * «Aplicar al histórico» lo corrige después. Nunca se pierde un lead por esto.
 */

import type { ReglaExclusion, MarcaExclusion } from './lead-exclusion';
import { soloDigitos } from './lead-exclusion';

/** Dígitos que se comparan de un teléfono: los últimos 9. */
export const DIGITOS_TELEFONO = 9;
/** Por debajo de esto no es un teléfono, es ruido («0», «123»). */
export const MIN_DIGITOS_TELEFONO = 7;

/**
 * Email en minúsculas, o `null` si no parece un email.
 *
 * Mismo cálculo que el índice de la migración 093: `lower(btrim(lead_email))`.
 */
export function claveEmail(v: unknown): string | null {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return s.includes('@') && s.length >= 3 ? s : null;
}

/**
 * Los últimos 9 dígitos, o `null` si no llega a 7.
 *
 * Nueve porque es lo que tienen en común las dos formas en que llega un mismo
 * número: con prefijo de país o sin él. Un móvil chileno son 9 dígitos
 * (+56 9xxxxxxxx) y uno colombiano 10 (+57 3xxxxxxxxx) cuyo primer dígito es
 * siempre 3, así que los 9 finales lo identifican igual.
 *
 * Mismo cálculo que el índice de la migración 093:
 * `right(regexp_replace(lead_phone, '\D', '', 'g'), 9)`.
 */
export function claveTelefono(v: unknown): string | null {
  const d = soloDigitos(v);
  return d.length >= MIN_DIGITOS_TELEFONO ? d.slice(-DIGITOS_TELEFONO) : null;
}

/** Claves de contacto de un lead: `e:<email>` y `t:<teléfono>`. */
export function clavesContacto(lead: { lead_email?: unknown; lead_phone?: unknown }): string[] {
  const out: string[] = [];
  const e = claveEmail(lead.lead_email);
  if (e) out.push(`e:${e}`);
  const t = claveTelefono(lead.lead_phone);
  if (t) out.push(`t:${t}`);
  return out;
}

/** ¿La regla pide marcar duplicados? */
export function reglaExcluyeDuplicados(regla: ReglaExclusion): boolean {
  return regla.activa && regla.excluir_duplicados;
}

// ── Ingesta ──────────────────────────────────────────────────────────

/** Una vez que se sabe que la RPC no existe, no se vuelve a preguntar en un rato. */
const REINTENTO_SIN_RPC_MS = 5 * 60_000;
let sinRpcDesde: number | null = null;

/** Solo para las comprobaciones. */
export function _reiniciarDeteccionRpc(): void {
  sinRpcDesde = null;
}

/** ¿El error dice que la función no existe? (PostgREST PGRST202 / Postgres 42883) */
function esFuncionInexistente(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'PGRST202' || code === '42883';
}

/**
 * ¿Está la migración 093? Para avisar en la ficha del cliente. Un error que no
 * sea «la función no existe» cuenta como SÍ: no se asusta a nadie por un
 * pico de latencia.
 */
export async function rpcDuplicadosDisponible(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): Promise<boolean> {
  try {
    const rtm = typeof db?.schema === 'function' ? db.schema('report_utm') : db;
    const { error } = await rtm.rpc('lead_contactos_existentes', {
      p_cliente_id: '00000000-0000-0000-0000-000000000000',
      p_emails: [],
      p_telefonos: [],
    });
    return !(error && esFuncionInexistente(error));
  } catch {
    return true;
  }
}

/**
 * Qué claves de contacto ya tienen un lead que cuenta en la base.
 * `null` = no se pudo saber (sin migración 093 o error): quien llama no marca.
 */
export async function contactosExistentes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  clienteId: string,
  claves: string[]
): Promise<Set<string> | null> {
  if (claves.length === 0) return new Set();
  if (sinRpcDesde !== null && Date.now() - sinRpcDesde < REINTENTO_SIN_RPC_MS) return null;

  const emails = claves.filter((k) => k.startsWith('e:')).map((k) => k.slice(2));
  const telefonos = claves.filter((k) => k.startsWith('t:')).map((k) => k.slice(2));
  try {
    const { data, error } = await db.rpc('lead_contactos_existentes', {
      p_cliente_id: clienteId,
      p_emails: emails,
      p_telefonos: telefonos,
    });
    if (error) {
      if (esFuncionInexistente(error)) sinRpcDesde = Date.now();
      else console.error('[lead-duplicados] lead_contactos_existentes', error.message ?? error);
      return null;
    }
    sinRpcDesde = null;
    return new Set(
      ((data ?? []) as Array<{ tipo: string; clave: string }>).map((r) => `${r.tipo}:${r.clave}`)
    );
  } catch (e) {
    console.error('[lead-duplicados] lead_contactos_existentes', e);
    return null;
  }
}

/**
 * Marca como `duplicado` las filas de un lote de ingesta cuyo contacto ya
 * existe (en la base o antes en el mismo lote). Devuelve filas nuevas; no muta.
 *
 * Solo mira las filas que por lo demás cuentan: una fila ya excluida por otra
 * condición conserva su motivo, y tampoco «ocupa» el contacto.
 *
 * @param db cliente Supabase ya en el esquema `report_utm`.
 */
export async function excluirDuplicadosLote<T extends Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  clienteId: string,
  filas: T[],
  regla: ReglaExclusion,
  ahora: string = new Date().toISOString()
): Promise<Array<T & Partial<MarcaExclusion>>> {
  if (!reglaExcluyeDuplicados(regla) || filas.length === 0) return filas;

  const candidatas = filas.filter((f) => f.excluido !== true);
  const claves = [...new Set(candidatas.flatMap((f) => clavesContacto(f)))];
  if (claves.length === 0) return filas;

  const existentes = await contactosExistentes(db, clienteId, claves);
  if (!existentes) return filas;

  // Dentro del lote, por fecha: el primero en llegar es el que cuenta.
  const orden = filas
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const fa = String(a.f.created_at ?? '');
      const fb = String(b.f.created_at ?? '');
      return fa === fb ? a.i - b.i : fa < fb ? -1 : 1;
    });

  const vistos = new Set(existentes);
  const salida: Array<T & Partial<MarcaExclusion>> = [...filas];
  for (const { f, i } of orden) {
    if (f.excluido === true) continue;
    const ks = clavesContacto(f);
    if (ks.some((k) => vistos.has(k))) {
      salida[i] = { ...f, excluido: true, excluido_motivo: 'duplicado', excluido_at: ahora };
    } else {
      for (const k of ks) vistos.add(k);
    }
  }
  return salida;
}
