// ── Zona horaria de la consulta en curso ──────────────────────────────
//
// Cada consulta de un cliente (un widget del BI, una pestaña del dashboard, el
// diagnóstico del cruce, el CSV de leads, la sincronización de Hotmart) corre
// dentro de `conZonaDeCliente`. Mientras dura, los helpers de `colombia-date.ts`
// (`colombiaRangeBounds`, `colombiaDateOf`, `colombiaToday`…) cortan los días en
// la zona de ESE cliente, y las RPC por día reciben `p_zona` (migración 095).
//
// Por qué un contexto y no un parámetro: los días se cortan en más de veinte
// sitios y en varias capas (motor, cubos, cruce, filtros). Pasar la zona por cada
// firma tocaría decenas de funciones y bastaría con olvidar una para que leads y
// gasto volvieran a desalinearse. Es el mismo patrón que `avisos-tasas.ts`.
//
// Fuera de un contexto no hay zona: el worker, el planificador y el navegador
// siguen en Colombia, que es exactamente lo de antes.

import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registrarProveedorZona } from './colombia-date';
import { ZONA_POR_DEFECTO, zonaHorariaDeCliente } from './zona-horaria';
import { createAdminClient } from '@/utils/supabase/server';

const zonaDeLaPeticion = new AsyncLocalStorage<string>();

registrarProveedorZona(
  () => zonaDeLaPeticion.getStore() ?? null,
  (config) => zonaHorariaDeCliente(config)
);

/** Zona de la consulta en curso (Colombia fuera de un contexto). */
export function zonaActiva(): string {
  return zonaDeLaPeticion.getStore() ?? ZONA_POR_DEFECTO;
}

/**
 * Argumentos extra para una RPC que agrupa por día (migración 095). Solo se
 * manda `p_zona` cuando NO es Colombia: así la llamada normal sigue siendo la de
 * siempre y funciona con o sin la migración, igual que `p_incluir_excluidos`.
 */
export function argsZona(): { p_zona?: string } {
  const z = zonaActiva();
  return z === ZONA_POR_DEFECTO ? {} : { p_zona: z };
}

/** Corre `fn` con los días cortados en `zona`. */
export function conZona<T>(zona: string, fn: () => Promise<T>): Promise<T> {
  return zonaDeLaPeticion.run(zona, fn);
}

const TTL_MS = 60_000;
const cachePublico = new Map<string, { zona: string; ts: number }>();
const cacheRtm = new Map<string, { zona: string; ts: number }>();

/** Zona de un cliente del reporting (`public.clientes.id`). */
export async function zonaDeClientePublico(publicId: string): Promise<string> {
  const hit = cachePublico.get(publicId);
  if (hit && Date.now() - hit.ts <= TTL_MS) return hit.zona;
  const db = await createAdminClient();
  const { data, error } = await db
    .from('clientes')
    .select('config_api')
    .eq('id', publicId)
    .maybeSingle();
  // Un fallo de lectura NO se cachea: cae a Colombia solo esta vez.
  if (error) return ZONA_POR_DEFECTO;
  const zona = zonaHorariaDeCliente(data?.config_api ?? null);
  if (cachePublico.size > 500) cachePublico.clear();
  cachePublico.set(publicId, { zona, ts: Date.now() });
  return zona;
}

/** Zona de un cliente de `report_utm.clientes` (vía su `public_cliente_id`). */
export async function zonaDeClienteRtm(rtmId: string): Promise<string> {
  const hit = cacheRtm.get(rtmId);
  if (hit && Date.now() - hit.ts <= TTL_MS) return hit.zona;
  const db = await createAdminClient();
  const { data, error } = await db
    .schema('report_utm')
    .from('clientes')
    .select('public_cliente_id')
    .eq('id', rtmId)
    .maybeSingle();
  if (error) return ZONA_POR_DEFECTO;
  const publicId = (data as { public_cliente_id?: string } | null)?.public_cliente_id;
  const zona = publicId ? await zonaDeClientePublico(publicId) : ZONA_POR_DEFECTO;
  if (cacheRtm.size > 500) cacheRtm.clear();
  cacheRtm.set(rtmId, { zona, ts: Date.now() });
  return zona;
}

/**
 * Corre `fn` en la zona del cliente. Acepta el id de cualquiera de los dos
 * esquemas; sin cliente (consultas globales), Colombia.
 */
export async function conZonaDeCliente<T>(
  cliente: { rtm?: string | null; publico?: string | null },
  fn: () => Promise<T>
): Promise<T> {
  const zona = cliente.publico
    ? await zonaDeClientePublico(cliente.publico)
    : cliente.rtm
      ? await zonaDeClienteRtm(cliente.rtm)
      : ZONA_POR_DEFECTO;
  return conZona(zona, fn);
}

/**
 * Fija la zona del cliente para el RESTO de la petición en curso, sin envolver.
 * Para páginas y rutas cuyo cuerpo es largo (`/leads`, su CSV): a partir de esta
 * llamada, todo lo que se ejecute en la misma petición corta los días en su zona.
 */
export async function fijarZonaDeCliente(cliente: {
  rtm?: string | null;
  publico?: string | null;
}): Promise<void> {
  const zona = cliente.publico
    ? await zonaDeClientePublico(cliente.publico)
    : cliente.rtm
      ? await zonaDeClienteRtm(cliente.rtm)
      : ZONA_POR_DEFECTO;
  zonaDeLaPeticion.enterWith(zona);
}
