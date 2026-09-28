'use server';

import { createClient, createAdminClient } from '@/utils/supabase/server';
import { sanearClienteParaListado } from '@/lib/cliente-seguro';
import { revalidatePath } from 'next/cache';
import type {
  ConversionesConfig,
  DriveSheet,
  SheetTabConfig,
  SheetTabInfo,
  DetectedColumn,
  SheetSyncStatus,
  SyncConversionesResponse,
} from '@/lib/integrations/google-sheets-conversiones';
import type { GA4Property } from '@/lib/integrations/google-analytics';
import type { SheetCampoDef, SheetCampoVistaDef, CampoValorCrudo } from '@/lib/sheets/campos';
import type { FuenteColumnas } from '@/lib/sheets/campos-db';
import { loadCamposCliente as loadCamposClienteServer } from '@/lib/sheets/campos-db';
import { leerJsonRespuesta, esTimeoutDeFetch } from '@/lib/fetch-json';
import {
  CLAVES_POR_PESTANA,
  enmascararSecretosHotmart,
  prepararParcheHotmart,
  superponerFormularioHotmart,
  type Pestana,
} from '@/lib/clientes/config-pestanas';
import { encrypt } from '@/lib/secretos';
import {
  HOTMART_API_BASE,
  obtenerToken,
  TIMEOUT_TOKEN_MS,
  type ConfigHotmart,
} from '@/lib/hotmart/cliente';
import { internalFetch } from '@/lib/internal-fetch';
import {
  archivarCliente,
  crearCliente,
  eliminarClienteCompleto,
  mapaArchivados,
  resumenBorrado,
} from '@/lib/clientes/ciclo-de-vida';
import { CLAVE_OMITIDOS } from '@/lib/clientes/puesta-en-marcha';
import { interpretarEstadoCuenta } from '@/lib/meta/estado-cuenta';
import { cuentasMetaDe } from '@/lib/meta/cuentas';
import { sincronizarCatalogo } from '@/lib/meta/conversiones-personalizadas-sync';
import {
  DIAS_ANTIGUA,
  TIPOS_CONVERSION,
  conversionActiva,
  type TipoConversion,
} from '@/lib/meta/conversiones-personalizadas';
import { buscarReferenciasConversion } from '@/lib/meta/conversiones-referencias';
import { addDaysISO, hoyCliente } from '@/lib/colombia-date';

/**
 * Marca `archivado` en cada cliente. El estado vive en su espejo de
 * Report-UTM (ver `lib/clientes/ciclo-de-vida.ts`); un error al leerlo no
 * esconde a nadie: sin dato, el cliente se muestra como activo.
 */
async function anotarArchivados<T extends { id: string }>(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  clientes: T[]
): Promise<Array<T & { archivado: boolean }>> {
  let archivados = new Set<string>();
  try {
    archivados = await mapaArchivados(admin);
  } catch {
    /* sin Report-UTM: todos activos */
  }
  return clientes.map((c) => ({ ...c, archivado: archivados.has(c.id) }));
}

export async function getClientes() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const adminSupabase = await createAdminClient();

  if (user) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const role = profile?.role ?? 'viewer';

    if (role === 'trafficker') {
      // Only return clients assigned to this user
      const { data: assignments } = await adminSupabase
        .from('user_client_assignments')
        .select('client_id')
        .eq('user_id', user.id);

      const clientIds = (assignments ?? []).map((a: { client_id: string }) => a.client_id);

      if (clientIds.length === 0) return [];

      const { data: clientes, error } = await adminSupabase
        .from('clientes')
        .select('*, layout:layouts_reporte(id, nombre)')
        .in('id', clientIds)
        .order('created_at', { ascending: false });

      if (error) return [];
      return anotarArchivados(adminSupabase, (clientes ?? []).map(sanearClienteParaListado));
    }
  }

  const { data: clientes, error } = await adminSupabase
    .from('clientes')
    .select('*, layout:layouts_reporte(id, nombre)')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching clients:', error);
    return [];
  }

  // Este listado llega a /dashboard y /soporte, que ve cualquier rol: nunca
  // debe cargar credenciales. El editor usa getCliente(), que sí las necesita.
  return anotarArchivados(adminSupabase, (clientes ?? []).map(sanearClienteParaListado));
}

export async function getCliente(id: string) {
  // Es una server action: además de la página de ajustes (que el layout de
  // admin ya cierra a los viewers), cualquiera podía invocarla por POST y leer
  // el `config_api` de un cliente con el cliente de servicio. Mismo criterio
  // que `guardarConfigPestana`.
  const rol = await rolActual();
  if (!rol || rol === 'viewer') return null;

  const supabase = await createAdminClient();
  const { data: cliente, error } = await supabase
    .from('clientes')
    .select('*, layout:layouts_reporte(*)')
    .eq('id', id)
    .single();

  if (error) {
    console.error('Error fetching client:', error);
    return null;
  }

  // La ficha es un componente de cliente: todo lo que devuelva esta acción
  // viaja al navegador. Los secretos de Hotmart llegan como `SECRETO_GUARDADO`
  // y el formulario solo los manda si el usuario escribe uno nuevo.
  return cliente?.config_api
    ? { ...cliente, config_api: enmascararSecretosHotmart(cliente.config_api) }
    : cliente;
}

/**
 * Alta de un cliente desde Ajustes. Solo admin y superadmin: un cliente es de la
 * empresa, y crearlo no lo ata a quien lo crea (migración 098). Hasta el
 * 2026-09-28 esta acción no comprobaba nada: cualquier sesión, hasta un viewer,
 * podía crear clientes con el cliente de servicio.
 *
 * Nace ya con moneda, zona y traffickers si se indican; lo demás (Meta, Sheets,
 * Hotmart…) lo guía la «Puesta en marcha» de su ficha.
 */
export async function createCliente(data: {
  nombre: string;
  moneda?: string | null;
  zonaHoraria?: string | null;
  traffickers?: string[];
}) {
  const sesion = await sesionActual();
  if (!sesion || !ROLES_ADMIN.has(sesion.rol)) {
    return { error: 'Solo un administrador puede crear clientes.' };
  }

  const admin = await createAdminClient();
  const pedidos = [...new Set(data.traffickers ?? [])];
  if (pedidos.length > 0) {
    const { data: validos, error } = await admin
      .from('user_profiles')
      .select('id')
      .in('id', pedidos)
      .eq('role', 'trafficker');
    if (error) return { error: error.message };
    if ((validos ?? []).length !== pedidos.length) {
      return { error: 'Alguno de los usuarios elegidos no es trafficker.' };
    }
  }

  // Una sola casa: el cliente nace también en Report-UTM, ya enlazado, o no nace.
  const r = await crearCliente(admin, data.nombre, {
    moneda: data.moneda,
    zonaHoraria: data.zonaHoraria,
    traffickers: pedidos,
    asignadoPor: sesion.userId,
  });
  if (!r.ok) {
    console.error('Error creating client:', r.error);
    return { error: r.error };
  }

  revalidatePath('/admin/settings');
  revalidatePath('/dashboard');
  return { success: true, data: r.cliente };
}

/** ¿Puede quien mira crear, archivar y borrar clientes? Para mostrar u ocultar botones. */
export async function puedeAdministrarClientes(): Promise<boolean> {
  const sesion = await sesionActual();
  return sesion !== null && ROLES_ADMIN.has(sesion.rol);
}

/** Traffickers para asignar en el alta: id y nombre legible. Solo para admins. */
export async function getTraffickersParaAlta(): Promise<Array<{ id: string; etiqueta: string }>> {
  const sesion = await sesionActual();
  if (!sesion || !ROLES_ADMIN.has(sesion.rol)) return [];
  const admin = await createAdminClient();
  const { data: perfiles } = await admin
    .from('user_profiles')
    .select('id, full_name')
    .eq('role', 'trafficker');
  if (!perfiles?.length) return [];
  const {
    data: { users },
  } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const correo = new Map((users ?? []).map((u) => [u.id, u.email ?? '']));
  return (perfiles as Array<{ id: string; full_name?: string | null }>)
    .map((p) => {
      const email = correo.get(p.id) ?? '';
      return {
        id: p.id,
        etiqueta: p.full_name ? `${p.full_name}${email ? ` · ${email}` : ''}` : email || p.id,
      };
    })
    .sort((x, y) => x.etiqueta.localeCompare(y.etiqueta));
}

async function sesionActual(): Promise<{ userId: string; rol: string } | null> {
  const supabaseStore = await createClient();
  const {
    data: { user },
  } = await supabaseStore.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabaseStore
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  return { userId: user.id, rol: profile?.role ?? 'viewer' };
}

async function rolActual(): Promise<string | null> {
  return (await sesionActual())?.rol ?? null;
}

/** Crear, archivar y borrar clientes. */
const ROLES_ADMIN = new Set(['superadmin', 'admin']);

/** Lo que se perdería al borrar, para el diálogo de confirmación. */
export async function resumenBorradoCliente(id: string) {
  const rol = await rolActual();
  if (!rol || !ROLES_ADMIN.has(rol))
    return { error: 'Solo un administrador puede borrar clientes.' };
  const resumen = await resumenBorrado(await createAdminClient(), id);
  if (!resumen) return { error: 'El cliente no existe.' };
  return { success: true, resumen };
}

/** Archiva o reactiva el cliente en los dos lados a la vez. */
export async function setClienteArchivado(id: string, archivado: boolean) {
  const rol = await rolActual();
  if (!rol || !ROLES_ADMIN.has(rol)) return { error: 'Solo un administrador puede archivar.' };

  const admin = await createAdminClient();
  const { data: cliente } = await admin
    .from('clientes')
    .select('nombre')
    .eq('id', id)
    .maybeSingle();
  if (!cliente) return { error: 'El cliente no existe.' };

  const r = await archivarCliente(admin, id, String(cliente.nombre ?? ''), archivado);
  if (!r.ok) return { error: r.error };

  revalidatePath('/admin/settings');
  revalidatePath('/dashboard');
  revalidatePath('/admin/settings');
  return { success: true };
}

export async function updateClienteConfig(id: string, config_api: any) {
  const supabase = await createAdminClient();

  // ─── GA4 Private Key Sanitization ──────────────────────────────────────────
  if (config_api?.ga_private_key) {
    let key = config_api.ga_private_key;
    // Si el frontend envía la llave con los caracteres literales "\n" (json escape), los transformamos a saltos reales
    if (key.includes('\\n')) {
      key = key.replace(/\\n/g, '\n');
    }

    // Validación básica de formato
    if (!key.includes('BEGIN PRIVATE KEY') || !key.includes('END PRIVATE KEY')) {
      return {
        error: 'El formato de la Private Key de GA4 es inválido. Sube el archivo JSON original.',
      };
    }
    config_api.ga_private_key = key;
  }

  const { error } = await supabase.from('clientes').update({ config_api }).eq('id', id);

  if (error) {
    console.error('Error updating config:', error);
    return { error: error.message };
  }

  revalidatePath(`/admin/settings/${id}`);
  revalidatePath('/admin/settings');
  return { success: true };
}

export async function assignLayoutToCliente(clienteId: string, layoutId: string | null) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('clientes')
    .update({ layout_id: layoutId })
    .eq('id', clienteId);
  if (error) return { error: error.message };
  revalidatePath(`/admin/settings/${clienteId}`);
  return { success: true };
}

/**
 * Borra el cliente en el reporting Y en Report-UTM.
 *
 * Hasta el 2026-09-12 el control de rol estaba comentado como TODO: cualquier
 * usuario autenticado podía borrar cualquier cliente y, por cascada, todas sus
 * métricas. Y solo borraba este lado, dejando el cliente UTM huérfano.
 */
export async function deleteCliente(id: string) {
  const rol = await rolActual();
  if (!rol) return { error: 'No autorizado' };
  if (!ROLES_ADMIN.has(rol)) {
    return { error: 'Solo los administradores pueden borrar clientes' };
  }

  const r = await eliminarClienteCompleto(await createAdminClient(), id);
  if (!r.ok) {
    console.error('Error deleting client:', r.error);
    return { error: r.error };
  }

  revalidatePath('/admin/settings');
  revalidatePath('/dashboard');
  revalidatePath('/admin/settings');
  // Lo de fuera (Storage, Meta, WhatsApp) que no se pudo limpiar: el cliente
  // ya está borrado, pero quien lo borró tiene que saberlo.
  return { success: true, avisos: r.avisos };
}

// ─── Layout CRUD ────────────────────────────────────────────────────────────

export async function getLayouts() {
  const supabase = await createAdminClient();
  const { data, error } = await supabase.from('layouts_reporte').select('*').order('nombre');
  if (error) return [];
  return data;
}

export async function createLayout(payload: {
  nombre: string;
  descripcion?: string;
  columnas: any[];
  tarjetas: any[];
  source_mapping?: Record<string, string>;
  attribution_strategy?: string;
}) {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('layouts_reporte')
    .insert([payload])
    .select()
    .single();
  if (error) return { error: error.message };
  revalidatePath('/admin/settings');
  return { success: true, data };
}

export async function updateLayout(
  id: string,
  payload: {
    nombre?: string;
    descripcion?: string;
    columnas?: any[];
    tarjetas?: any[];
    source_mapping?: Record<string, string>;
    attribution_strategy?: string;
  }
) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('layouts_reporte')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/settings');
  return { success: true };
}

export async function deleteLayout(id: string) {
  const supabaseStore = await createClient();
  const {
    data: { user },
  } = await supabaseStore.auth.getUser();

  if (!user) return { error: 'No autorizado' };

  // TODO: Implement role-based access control
  // const { data: profile } = await supabaseStore.from('user_profiles').select('role').eq('id', user.id).single()
  // if (profile?.role !== 'admin') return { error: 'Solo los administradores pueden borrar layouts' }

  const supabase = await createAdminClient();
  const { error } = await supabase.from('layouts_reporte').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/settings');
  return { success: true };
}

// ─── Connection Tests ───────────────────────────────────────────────────────

export async function testGA4Connection(config: any) {
  // Misma precedencia de credenciales que el worker (`crearClienteGa4`). Si
  // falla por permisos, `probarAccesoGa4` contrasta con las propiedades que ve
  // la cuenta de la agencia: así se descubrió que Cris tenía un ID equivocado.
  const { probarAccesoGa4 } = await import('@/lib/integrations/ga4-cliente');
  const r = await probarAccesoGa4(config);
  return r.ok ? { success: true, message: r.mensaje } : { error: r.mensaje };
}

export async function testMetaConnection(token: string, accountId: string) {
  if (!token || !accountId) return { error: 'Faltan credenciales' };

  try {
    const actId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
    const url = `https://graph.facebook.com/v19.0/${actId}?fields=name&access_token=${token}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return { error: data.error.message };
    }
    return { success: true, name: data.name };
  } catch (err: any) {
    return { error: err.message };
  }
}

// Lista las ad accounts disponibles con el token guardado (sin re-hacer OAuth).
// Devuelve [{ account_id: 'act_XXX', name }] para que la UI las agregue a meta_accounts[].
export async function fetchMetaAdAccounts(token: string) {
  if (!token) return { error: 'Falta el token de Meta' };

  try {
    // `account_status` y `disable_reason`: al elegir la cuenta ya se ve si Meta
    // la tiene parada por pago. `currency`: la moneda en la que gasta, que tiene
    // que coincidir con la moneda de reporte del cliente para que el ROAS valga.
    const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=account_id,name,account_status,disable_reason,currency&limit=200&access_token=${token}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.error) {
      return { error: data.error.message };
    }

    const accounts = (data.data ?? []).map((a: any) => {
      const actId = String(a.account_id || '').startsWith('act_')
        ? String(a.account_id)
        : `act_${a.account_id}`;
      const estado = interpretarEstadoCuenta(a);
      return {
        account_id: actId,
        name: a.name || actId,
        currency: estado.moneda,
        bloqueada: estado.bloqueada,
        estado: estado.texto,
      };
    });
    return { success: true, accounts };
  } catch (err: any) {
    return { error: err.message };
  }
}

// Lista las cuentas publicitarias disponibles con el token de TikTok guardado (sin re-hacer OAuth).
// Devuelve [{ advertiser_id, name }] para que la UI las agregue a tiktok_accounts[].
// El token solo trae IDs, así que usamos oauth2/advertiser/get/ para obtener también el nombre.
export async function fetchTikTokAdAccounts(token: string) {
  if (!token) return { error: 'Falta el token de TikTok' };

  try {
    const appId = process.env.TIKTOK_APP_ID!;
    const secret = process.env.TIKTOK_APP_SECRET!;
    const url = `https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?app_id=${appId}&secret=${secret}&access_token=${token}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.code !== 0) {
      return { error: data.message || 'Error obteniendo cuentas de TikTok' };
    }

    const accounts = (data.data?.list ?? []).map((a: any) => ({
      advertiser_id: a.advertiser_id,
      name: a.advertiser_name || `Cuenta ${a.advertiser_id}`,
    }));
    return { success: true, accounts };
  } catch (err: any) {
    return { error: err.message };
  }
}

/**
 * Prueba la conexión de Hotmart con lo que hay en la pestaña.
 *
 * El formulario ya no tiene los secretos (llegan como `SECRETO_GUARDADO`), así
 * que se parte de la config GUARDADA y encima se pone solo lo que el usuario
 * tecleó. El token sale de `obtenerToken`, el mismo camino que usa el worker:
 * la versión anterior leía `hotmart_access_token` en claro, que tras el cifrado
 * es `null`, y guardaba «error» en conexiones de HotConnect que funcionaban.
 *
 * El estado se guarda con `fusionar_config_api`: el read-modify-write de antes
 * podía pisar los tokens que el cron renovara entre la lectura y la escritura.
 */
export async function testHotmartConnection(config: any, clienteId?: string) {
  // Escribe en `config_api`: mismo permiso que guardar la pestaña.
  const rol = await rolActual();
  if (!rol || rol === 'viewer') return { error: 'No autorizado' };

  const formulario: Record<string, unknown> =
    config && typeof config === 'object' ? (config as Record<string, unknown>) : {};

  let admin: Awaited<ReturnType<typeof createAdminClient>> | null = null;
  let guardada: Record<string, unknown> = { hotmart_auth_mode: formulario.hotmart_auth_mode };
  if (clienteId) {
    admin = await createAdminClient();
    const { data: fila, error } = await admin
      .from('clientes')
      .select('config_api')
      .eq('id', clienteId)
      .maybeSingle();
    if (error) return { error: error.message };
    if (!fila) return { error: 'El cliente no existe.' };
    guardada = (fila.config_api ?? {}) as Record<string, unknown>;
  }
  const efectiva = superponerFormularioHotmart(guardada, formulario) as ConfigHotmart;
  const hotconnect = efectiva.hotmart_auth_mode === 'hotconnect';

  // Best-effort: un fallo al guardar el estado no invalida la prueba.
  const persistir = async (
    status: 'connected' | 'error',
    extra: Record<string, unknown> | null = null
  ) => {
    if (!clienteId || !admin) return;
    try {
      await admin.rpc('fusionar_config_api', {
        p_cliente_id: clienteId,
        p_parche: {
          ...(extra ?? {}),
          hotmart_connection_status: status,
          hotmart_last_checked_at: new Date().toISOString(),
        },
      });
    } catch {
      /* best-effort */
    }
  };

  const db = admin;
  const releer =
    clienteId && db
      ? async () => {
          const { data } = await db
            .from('clientes')
            .select('config_api')
            .eq('id', clienteId)
            .maybeSingle();
          return (data?.config_api ?? null) as ConfigHotmart | null;
        }
      : undefined;

  // Solo se guarda el parche de HotConnect: si el refresco rotó el refresh
  // token, NO guardarlo deja la conexión muerta, pase lo que pase después. El
  // de modo Basic (migración de credenciales) puede llevar lo que el usuario
  // tecleó y aún no guardó; esa migración la hace el worker con lo guardado.
  let parcheTokens: Record<string, unknown> | null = null;

  try {
    const auth = await obtenerToken(efectiva, { releer });
    if (hotconnect) parcheTokens = auth.parche ?? null;

    if (!auth.token) {
      await persistir('error', parcheTokens);
      return { error: auth.motivo ?? 'No se pudo obtener un token de Hotmart.' };
    }

    // Hotmart exige start_date y end_date: se sondean los últimos 7 días.
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const url = new URL(`${HOTMART_API_BASE}/payments/api/v1/sales/history`);
    url.searchParams.set('start_date', sevenDaysAgo.toString());
    url.searchParams.set('end_date', now.toString());
    url.searchParams.set('max_results', '1');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(TIMEOUT_TOKEN_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status !== 200) {
      await persistir('error', parcheTokens);
      return {
        error: data?.message || data?.error_description || `Error de conexión (HTTP ${res.status})`,
      };
    }

    await persistir('connected', parcheTokens);
    return { success: true };
  } catch (err: any) {
    await persistir('error', parcheTokens);
    return { error: err.message };
  }
}

/**
 * Botón «Sincronizar» de la tarjeta de conversiones: descubre las conversiones
 * personalizadas con actividad en los últimos 90 días (zona del cliente) y
 * actualiza el catálogo. Lee las cuentas y tokens de la config GUARDADA: el
 * navegador ya no los envía. El segundo argumento se ignora (compatibilidad).
 */
export async function refreshMetaCustomConversions(clienteId: string, _legacy?: unknown) {
  void _legacy;
  const rol = await rolActual();
  if (!rol || rol === 'viewer') return { error: 'No autorizado.' };

  const admin = await createAdminClient();
  const { data: cliente } = await admin
    .from('clientes')
    .select('config_api')
    .eq('id', clienteId)
    .maybeSingle();
  if (!cliente) return { error: 'El cliente no existe.' };
  const config = (cliente.config_api ?? {}) as Record<string, any>;
  const cuentas = cuentasMetaDe(config);
  if (cuentas.length === 0) {
    return {
      error:
        'El cliente no tiene cuentas de Meta guardadas. Guarda la configuración antes de sincronizar.',
    };
  }

  const hasta = hoyCliente(config);
  const desde = addDaysISO(hasta, -(DIAS_ANTIGUA - 1));
  try {
    const r = await sincronizarCatalogo(admin, clienteId, cuentas, desde, hasta);
    if (r.error) return { error: `Error guardando en BD: ${r.error}` };
    if (r.cuentasConError.length === cuentas.length) {
      return { error: 'Meta no respondió para ninguna cuenta (revisa el token).' };
    }
    const avisoCuentas =
      r.cuentasConError.length > 0 ? ` Sin respuesta de: ${r.cuentasConError.join(', ')}.` : '';
    revalidatePath('/admin/settings');
    return {
      success: true,
      count: r.total,
      conversions: r.claves,
      message:
        r.total === 0
          ? `No hay conversiones personalizadas con actividad en los últimos ${DIAS_ANTIGUA} días.${avisoCuentas}`
          : `${r.total} conversiones con actividad (${r.nuevas} nuevas).${avisoCuentas}`,
    };
  } catch (e: any) {
    return { error: e?.message ?? 'Error desconocido' };
  }
}

export interface ConversionMetaFila {
  conversion_key: string;
  label: string;
  field_id: string;
  last_seen: string | null;
  origen: 'cc' | 'evento';
  nombre_meta: string | null;
  label_manual: string | null;
  tipo: TipoConversion;
  es_resultado: boolean;
  archivada: boolean;
  regla: unknown;
  ultima_actividad: string | null;
  activa: boolean;
}

/** Catálogo del cliente para la tarjeta de ajustes (incluye antiguas y archivadas). */
export async function listarConversionesMeta(
  clienteId: string
): Promise<{ data?: ConversionMetaFila[]; migrada?: boolean; hoy?: string; error?: string }> {
  const rol = await rolActual();
  if (!rol) return { error: 'No autorizado.' };
  const admin = await createAdminClient();
  const [{ data: cliente }, completo] = await Promise.all([
    admin.from('clientes').select('config_api').eq('id', clienteId).maybeSingle(),
    admin
      .from('meta_conversiones_catalogo')
      .select(
        'conversion_key, label, field_id, last_seen, origen, nombre_meta, label_manual, tipo, es_resultado, archivada, regla, ultima_actividad'
      )
      .eq('cliente_id', clienteId)
      .order('label'),
  ]);
  const hoy = hoyCliente(cliente?.config_api ?? undefined);
  let filas: any[] | null = completo.data;
  let migrada = true;
  if (completo.error) {
    // Sin la migración 096: solo las columnas antiguas.
    migrada = false;
    const antiguo = await admin
      .from('meta_conversiones_catalogo')
      .select('conversion_key, label, field_id, last_seen')
      .eq('cliente_id', clienteId)
      .order('label');
    if (antiguo.error) return { error: antiguo.error.message };
    filas = antiguo.data;
  }
  const data = (filas ?? []).map((r: any): ConversionMetaFila => {
    const ultima = r.ultima_actividad ?? r.last_seen ?? null;
    return {
      conversion_key: r.conversion_key,
      label: r.label,
      field_id: r.field_id,
      last_seen: r.last_seen ?? null,
      origen: r.origen ?? (/^\d+$/.test(r.conversion_key) ? 'cc' : 'evento'),
      nombre_meta: r.nombre_meta ?? null,
      label_manual: r.label_manual ?? null,
      tipo: (TIPOS_CONVERSION as readonly string[]).includes(r.tipo) ? r.tipo : 'otro',
      es_resultado: Boolean(r.es_resultado),
      archivada: Boolean(r.archivada),
      regla: r.regla ?? null,
      ultima_actividad: ultima,
      activa: !r.archivada && conversionActiva(ultima, hoy),
    };
  });
  return { data, migrada, hoy };
}

/**
 * Cambia lo que decide el usuario sobre una conversión. Lista blanca de campos:
 * el resto lo mantiene el sync.
 */
export async function actualizarConversionMeta(
  clienteId: string,
  conversionKey: string,
  patch: {
    label_manual?: string | null;
    tipo?: string;
    es_resultado?: boolean;
    archivada?: boolean;
  }
) {
  const rol = await rolActual();
  if (!rol || rol === 'viewer') return { error: 'No autorizado.' };
  const cambios: Record<string, unknown> = {};
  if ('label_manual' in patch) {
    const v = (patch.label_manual ?? '').trim();
    if (v.length > 80) return { error: 'El nombre admite como mucho 80 caracteres.' };
    cambios.label_manual = v || null;
  }
  if (patch.tipo !== undefined) {
    if (!(TIPOS_CONVERSION as readonly string[]).includes(patch.tipo)) {
      return { error: 'Tipo no válido.' };
    }
    cambios.tipo = patch.tipo;
  }
  if (patch.es_resultado !== undefined) cambios.es_resultado = Boolean(patch.es_resultado);
  if (patch.archivada !== undefined) cambios.archivada = Boolean(patch.archivada);
  if (Object.keys(cambios).length === 0) return { success: true };

  const admin = await createAdminClient();
  const { error } = await admin
    .from('meta_conversiones_catalogo')
    .update(cambios)
    .eq('cliente_id', clienteId)
    .eq('conversion_key', conversionKey);
  if (error) {
    return {
      error: /column .* does not exist|schema cache/i.test(error.message)
        ? 'Falta aplicar la migración 096 para editar conversiones.'
        : error.message,
    };
  }
  revalidatePath('/admin/settings');
  revalidatePath(`/dashboard/${clienteId}`);
  revalidatePath(`/report/${clienteId}`);
  return { success: true };
}

/** Dónde se usa una conversión (antes de archivarla). */
export async function referenciasConversionMeta(clienteId: string, conversionKey: string) {
  const rol = await rolActual();
  if (!rol) return { error: 'No autorizado.' };
  const admin = await createAdminClient();
  return { data: await buscarReferenciasConversion(admin, clienteId, conversionKey) };
}

export async function testTikTokConnection(accessToken: string, advertiserId: string) {
  if (!accessToken || !advertiserId) return { error: 'Faltan credenciales de TikTok' };

  try {
    const url = `https://business-api.tiktok.com/open_api/v1.3/advertiser/info/?advertiser_ids=["${advertiserId}"]`;
    const res = await fetch(url, {
      headers: { 'Access-Token': accessToken },
    });
    const data = await res.json();

    if (data.code !== 0) {
      return { error: data.message || 'Error de conexión con TikTok' };
    }
    const advertiser = data.data?.list?.[0];
    return { success: true, name: advertiser?.advertiser_name };
  } catch (err: any) {
    return { error: err.message };
  }
}

// ─── Public Layout (Executive View) ──────────────────────────────────────────

export async function savePublicLayout(
  clienteId: string,
  payload: {
    tarjetas: any[];
    graficos: any[];
  }
) {
  const supabase = await createAdminClient();
  const { error } = await supabase
    .from('clientes')
    .update({ layout_publico: payload })
    .eq('id', clienteId);

  if (error) return { error: error.message };
  revalidatePath(`/report/${clienteId}`);
  revalidatePath(`/dashboard/${clienteId}`);
  return { success: true };
}

export async function syncClienteMetrics(clienteId: string, startDate: string, endDate: string) {
  try {
    const url = `/api/worker?client_id=${clienteId}&start=${startDate}&end=${endDate}`;
    const cronSecret = process.env.CRON_SECRET;

    const res = await internalFetch(url, {
      headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {},
      cache: 'no-store',
    });

    const data = await res.json();

    if (!res.ok) return { error: data.error || 'Error al sincronizar' };

    const logs = (data.debugLogs || []) as string[];
    const metaLog =
      logs.find((l: string) => l.includes('[Meta]') && l.includes('Datos de campañas')) || '';
    const dbLog = logs.find((l: string) => l.includes('Mass Upsert exitoso')) || '';
    const errorLog = logs.find((l: string) => l.includes('❌')) || '';

    if (errorLog) return { error: errorLog };

    // ── También sincronizar los Google Sheets del cliente ─────────────────
    // Antes esto disparaba el sync legacy de leads; desde la migración 059
    // todas las hojas (incluida la que era de leads) van por el módulo
    // unificado, que además recalcula los campos de Sheet al terminar.
    const supabase = await createAdminClient();
    const { data: cliente } = await supabase
      .from('clientes')
      .select('config_api')
      .eq('id', clienteId)
      .single();

    const sheets = cliente?.config_api?.google_sheets_conversiones;
    const haySheets = Array.isArray(sheets)
      ? sheets.some((s: { enabled?: boolean; sheet_url?: string }) => s?.enabled && s?.sheet_url)
      : !!sheets?.sheet_url;
    // El sync de Sheets no bloquea el resultado principal, pero su fallo sí se
    // cuenta: antes no se miraba ni el status de la respuesta, así que un 4xx/5xx
    // desaparecía y el botón decía "Sincronizado correctamente".
    let avisoSheets: string | null = null;
    if (haySheets) {
      try {
        const resSheets = await internalFetch(`/api/admin/sync-conversiones-offline`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: clienteId }),
          cache: 'no-store',
          signal: AbortSignal.timeout(58_000),
        });
        const leido = await leerJsonRespuesta<SyncConversionesResponse>(
          resSheets,
          'Error al sincronizar Google Sheets',
          TIMEOUT_SYNC_SHEETS
        );
        if (!leido.ok) {
          avisoSheets = leido.error;
        } else if (!resSheets.ok || leido.data.success === false) {
          avisoSheets = leido.data.error || 'Error al sincronizar Google Sheets';
        } else if (leido.data.warnings?.length) {
          const resto = leido.data.warnings.length - 1;
          avisoSheets = leido.data.warnings[0] + (resto > 0 ? ` (+${resto} avisos)` : '');
        }
      } catch (gsErr: any) {
        console.error('[syncClienteMetrics] Google Sheets sync error:', gsErr);
        avisoSheets = esTimeoutDeFetch(gsErr)
          ? TIMEOUT_SYNC_SHEETS
          : gsErr?.message || 'Error al sincronizar Google Sheets';
      }
    }

    revalidatePath(`/dashboard/${clienteId}`);
    const base = dbLog
      ? `✓ Sincronizado correctamente. ${metaLog}`
      : `Sync completado. Revisa los datos en el dashboard.`;
    return {
      success: true,
      // En el mensaje y no solo en `warnings`: es lo que enseña el botón.
      message: base + (avisoSheets ? ` · ⚠ Google Sheets: ${avisoSheets}` : ''),
      ...(avisoSheets ? { warnings: [`Google Sheets: ${avisoSheets}`] } : {}),
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

export async function getPublicLayout(clienteId: string) {
  const supabase = await createAdminClient();
  const { data, error } = await supabase
    .from('clientes')
    .select('layout_publico')
    .eq('id', clienteId)
    .single();

  if (error) return null;
  return data?.layout_publico || null;
}

// ─── Google Sheets Sync ────────────────────────────────────────────────────

// ─── Budget Alerts ────────────────────────────────────────────────────────────

export interface ActiveAlert {
  tabId: string;
  tabNombre: string;
  clienteId: string;
  clienteNombre: string;
  presupuestoObjetivo: number;
  level: 90 | 100;
  sentAt: string;
}

export async function getActiveAlerts(): Promise<ActiveAlert[]> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const adminSupabase = await createAdminClient();

  let allowedClientIds: string[] | null = null;

  if (user) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profile?.role === 'trafficker') {
      const { data: assignments } = await adminSupabase
        .from('user_client_assignments')
        .select('client_id')
        .eq('user_id', user.id);
      allowedClientIds = (assignments ?? []).map((a: { client_id: string }) => a.client_id);
      if (allowedClientIds.length === 0) return [];
    }
  }

  // Antes se leía `cliente_tabs.alert_sent_at_90/100`, que NADA en el repo
  // escribe (el comprobador de presupuesto externo que las llenaba ya no
  // existe): el KPI de alertas del dashboard estaba congelado. Ahora sale de lo
  // que el motor de reglas SÍ escribe al disparar una alerta — el cooldown por
  // (regla, cliente, pestaña) de `notification_rule_cooldowns` — en los últimos
  // 7 días. Consultas separadas y unión en memoria: embebidas, esas tablas dan
  // un PGRST201 por la doble FK entre pestañas y clientes.
  const desde = new Date(Date.now() - 7 * 86400_000).toISOString();
  let qCool = adminSupabase
    .from('notification_rule_cooldowns')
    .select('rule_id, cliente_id, tab_id, last_triggered_at')
    .gte('last_triggered_at', desde)
    .order('last_triggered_at', { ascending: false })
    .limit(200);
  if (allowedClientIds) qCool = qCool.in('cliente_id', allowedClientIds);
  const { data: disparos, error } = await qCool;
  if (error || !disparos || disparos.length === 0) return [];

  const ids = <K extends string>(k: K) =>
    Array.from(new Set(disparos.map((d: any) => d[k]).filter(Boolean))) as string[];
  const [{ data: reglas }, { data: tabs }, { data: clientes }] = await Promise.all([
    adminSupabase
      .from('notification_rules')
      .select('id, nombre, metric, value')
      .in('id', ids('rule_id')),
    ids('tab_id').length
      ? adminSupabase
          .from('cliente_tabs')
          .select('id, nombre, presupuesto_objetivo, archived')
          .in('id', ids('tab_id'))
      : Promise.resolve({ data: [] as any[] }),
    adminSupabase.from('clientes').select('id, nombre').in('id', ids('cliente_id')),
  ]);
  const porId = <T extends { id: string }>(xs: T[] | null) =>
    new Map((xs ?? []).map((x) => [x.id, x]));
  const R = porId(reglas as any[]);
  const T = porId(tabs as any[]);
  const C = porId(clientes as any[]);

  return disparos
    .filter((d: any) => !T.get(d.tab_id)?.archived)
    .map((d: any) => {
      const regla: any = R.get(d.rule_id);
      const tab: any = T.get(d.tab_id);
      const esPresupuesto = regla?.metric === 'budget_percentage';
      return {
        tabId: d.tab_id ?? '',
        tabNombre: tab?.nombre ?? regla?.nombre ?? 'Regla de alerta',
        clienteId: d.cliente_id,
        clienteNombre: (C.get(d.cliente_id) as any)?.nombre ?? d.cliente_id,
        presupuestoObjetivo: Number(tab?.presupuesto_objetivo ?? 0),
        level: (esPresupuesto && Number(regla?.value ?? 0) >= 100 ? 100 : 90) as 90 | 100,
        sentAt: d.last_triggered_at,
      };
    });
}

// ─── Google OAuth (conexión a nivel agencia) ─────────────────────────────────

// Estado de la conexión OAuth global de Google (Analytics + Sheets).
export async function getGoogleConnectionStatus() {
  const { getGoogleIntegration } = await import('@/lib/integrations/google-auth');
  const row = await getGoogleIntegration();
  return {
    connected: !!row?.refresh_token && row.connection_status === 'connected',
    email: row?.connected_email ?? null,
  };
}

// Desconecta la cuenta de Google de la agencia (borra los tokens).
export async function disconnectGoogle(): Promise<{ success: boolean; error?: string }> {
  try {
    const { disconnectGoogleIntegration } = await import('@/lib/integrations/google-auth');
    await disconnectGoogleIntegration();
    revalidatePath('/admin/settings');
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message || 'Error al desconectar' };
  }
}

// ─── Conversiones Offline ────────────────────────────────────────────────────

export async function detectConversionesColumns(
  sheetConfig: ConversionesConfig,
  tab?: SheetTabConfig
) {
  try {
    const res = await internalFetch(`/api/admin/detect-sheet-columns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetConfig, tab }),
      cache: 'no-store',
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al detectar columnas' };
    return { headers: (data.headers ?? []) as string[], columns: data.columns as DetectedColumn[] };
  } catch (e: any) {
    return { error: e.message || 'Error al detectar columnas' };
  }
}

export interface SheetEliminarPreview {
  filas: { conversiones: number; diarias: number; crudas: number; total: number };
  campos: Array<{
    nombre: string;
    clave: string;
    origenesQuePierde: number;
    quedaSinOrigen: boolean;
  }>;
}

/** Qué se llevará por delante borrar un sheet: filas y campos que lo usan. */
export async function previewEliminarSheet(
  clienteId: string,
  sheetId: string
): Promise<SheetEliminarPreview | { error: string }> {
  try {
    const res = await internalFetch(
      `/api/admin/sheets-conversiones/eliminar` +
        `?clientId=${encodeURIComponent(clienteId)}&sheetId=${encodeURIComponent(sheetId)}`,
      { cache: 'no-store' }
    );
    const leido = await leerJsonRespuesta<SheetEliminarPreview & { error?: string }>(
      res,
      'Error al consultar el sheet'
    );
    if (!leido.ok) return { error: leido.error };
    if (!res.ok) return { error: leido.data.error || 'Error al consultar el sheet' };
    return { filas: leido.data.filas, campos: leido.data.campos ?? [] };
  } catch (e: any) {
    return { error: e.message || 'Error al consultar el sheet' };
  }
}

/**
 * Borra una tanda de filas del sheet. Con `done:false` quedan más: el llamador
 * repite hasta que sea `true`, que es cuando además se retira de la config y se
 * recalculan los campos.
 */
export async function eliminarSheetConversiones(
  clienteId: string,
  sheetId: string
): Promise<{
  done?: boolean;
  borradas?: number;
  restantes?: number;
  warning?: string;
  error?: string;
}> {
  try {
    const res = await internalFetch(`/api/admin/sheets-conversiones/eliminar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clienteId, sheetId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(58_000),
    });
    const leido = await leerJsonRespuesta<any>(
      res,
      'Error al eliminar el sheet',
      'El borrado superó el tiempo máximo del servidor. Vuelve a pulsar Eliminar: retoma donde lo dejó.'
    );
    if (!leido.ok) return { error: leido.error };
    if (!res.ok) return { error: leido.data.error || 'Error al eliminar el sheet' };

    if (leido.data.done) revalidatePath(`/admin/settings/${clienteId}`);
    return leido.data;
  } catch (e: any) {
    if (esTimeoutDeFetch(e)) {
      return {
        error:
          'El borrado superó el tiempo máximo del servidor. Vuelve a pulsar Eliminar: retoma donde lo dejó.',
      };
    }
    return { error: e.message || 'Error al eliminar el sheet' };
  }
}

// Pestañas reales del documento, para elegirlas en vez de teclear el nombre.
export async function listConversionesTabs(sheetConfig: ConversionesConfig) {
  try {
    const res = await internalFetch(`/api/admin/list-sheet-tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetConfig }),
      cache: 'no-store',
    });

    const leido = await leerJsonRespuesta<{ tabs?: SheetTabInfo[]; error?: string }>(
      res,
      'Error al listar las pestañas'
    );
    if (!leido.ok) return { error: leido.error };
    if (!res.ok) return { error: leido.data.error || 'Error al listar las pestañas' };
    return { tabs: (leido.data.tabs ?? []) as SheetTabInfo[] };
  } catch (e: any) {
    return { error: e.message || 'Error al listar las pestañas' };
  }
}

// Estado del último sync por sheet (filas ok/descartadas y avisos por pestaña).
export async function getConversionesSyncStatus(clienteId: string) {
  try {
    const res = await internalFetch(
      `/api/admin/sync-conversiones-offline?clientId=${encodeURIComponent(clienteId)}`,
      { cache: 'no-store' }
    );

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al consultar el estado del sync' };
    return { lastSync: (data.lastSync ?? {}) as Record<string, SheetSyncStatus> };
  } catch (e: any) {
    return { error: e.message || 'Error al consultar el estado del sync' };
  }
}

export async function listDriveSheets() {
  try {
    const res = await internalFetch(`/api/admin/list-google-sheets`, {
      cache: 'no-store',
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al listar Sheets' };
    return { sheets: data.sheets as DriveSheet[] };
  } catch (e: any) {
    return { error: e.message || 'Error al listar Sheets' };
  }
}

// Propiedades GA4 visibles para la cuenta OAuth de la agencia, para el selector
// por cliente (evita teclear el ID numérico a mano).
export async function listGa4Properties() {
  try {
    const res = await internalFetch(`/api/admin/list-ga4-properties`, {
      cache: 'no-store',
    });

    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al listar propiedades de GA4' };
    return { properties: data.properties as GA4Property[] };
  } catch (e: any) {
    return { error: e.message || 'Error al listar propiedades de GA4' };
  }
}

// ─── Campos de Sheet ─────────────────────────────────────────────────────────
// Definiciones por cliente que unifican columnas equivalentes de varias
// pestañas. Todo pasa por /api/admin/sheet-campos*, que usa el service role.

export interface SheetCamposPayload {
  campos: SheetCampoDef[];
  vistas: SheetCampoVistaDef[];
}

export async function listSheetCampos(clienteId: string) {
  try {
    const res = await internalFetch(
      `/api/admin/sheet-campos?cliente_id=${encodeURIComponent(clienteId)}`,
      { cache: 'no-store' }
    );
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al leer los campos' };
    return {
      campos: (data.campos ?? []) as SheetCampoDef[],
      vistas: (data.vistas ?? []) as SheetCampoVistaDef[],
    };
  } catch (e: any) {
    return { error: e.message || 'Error al leer los campos' };
  }
}

/** Guarda el campo y devuelve el catálogo ya recalculado (el POST recalcula). */
export async function saveSheetCampo(clienteId: string, campo: Partial<SheetCampoDef>) {
  try {
    const res = await internalFetch(`/api/admin/sheet-campos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...campo, cliente_id: clienteId }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al guardar el campo' };
    revalidatePath(`/admin/settings/${clienteId}`);
    return {
      campo: data.campo as SheetCampoDef | null,
      campos: (data.campos ?? []) as SheetCampoDef[],
      vistas: (data.vistas ?? []) as SheetCampoVistaDef[],
      recalculo: data.recalculo as {
        campos: number;
        dias: number;
        valores: number;
        avisos: string[];
      },
    };
  } catch (e: any) {
    return { error: e.message || 'Error al guardar el campo' };
  }
}

export async function deleteSheetCampo(clienteId: string, campoId: string) {
  try {
    const url =
      `/api/admin/sheet-campos` +
      `?id=${encodeURIComponent(campoId)}&cliente_id=${encodeURIComponent(clienteId)}`;
    const res = await internalFetch(url, { method: 'DELETE', cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al borrar el campo' };
    revalidatePath(`/admin/settings/${clienteId}`);
    return { success: true };
  } catch (e: any) {
    return { error: e.message || 'Error al borrar el campo' };
  }
}

export async function saveSheetVista(clienteId: string, vista: Partial<SheetCampoVistaDef>) {
  try {
    const res = await internalFetch(`/api/admin/sheet-campos/vistas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...vista, cliente_id: clienteId }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al guardar la vista' };
    revalidatePath(`/admin/settings/${clienteId}`);
    return {
      campos: (data.campos ?? []) as SheetCampoDef[],
      vistas: (data.vistas ?? []) as SheetCampoVistaDef[],
    };
  } catch (e: any) {
    return { error: e.message || 'Error al guardar la vista' };
  }
}

export async function deleteSheetVista(clienteId: string, vistaId: string) {
  try {
    const url =
      `/api/admin/sheet-campos/vistas` +
      `?id=${encodeURIComponent(vistaId)}&cliente_id=${encodeURIComponent(clienteId)}`;
    const res = await internalFetch(url, { method: 'DELETE', cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al borrar la vista' };
    revalidatePath(`/admin/settings/${clienteId}`);
    return {
      campos: (data.campos ?? []) as SheetCampoDef[],
      vistas: (data.vistas ?? []) as SheetCampoVistaDef[],
    };
  } catch (e: any) {
    return { error: e.message || 'Error al borrar la vista' };
  }
}

/** Valores crudos detectados de un campo, para el agrupador. */
export async function listCampoValores(clienteId: string, campoId: string, limite = 500) {
  try {
    const url =
      `/api/admin/sheet-campos/valores` +
      `?cliente_id=${encodeURIComponent(clienteId)}&campo_id=${encodeURIComponent(campoId)}&limite=${limite}`;
    const res = await internalFetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al leer los valores' };
    return {
      valores: (data.valores ?? []) as CampoValorCrudo[],
      totalDistintos: (data.total_distintos ?? 0) as number,
    };
  } catch (e: any) {
    return { error: e.message || 'Error al leer los valores' };
  }
}

/** Recalcula desde `sheet_filas`. Nunca llama a Google. */
export async function recalcularSheetCampos(clienteId: string, campoId?: string) {
  try {
    const res = await internalFetch(`/api/admin/sheet-campos/recalcular`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliente_id: clienteId, campo_id: campoId }),
      cache: 'no-store',
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al recalcular' };
    revalidatePath(`/admin/settings/${clienteId}`);
    return data as { campos: number; dias: number; valores: number; avisos: string[] };
  } catch (e: any) {
    return { error: e.message || 'Error al recalcular' };
  }
}

/**
 * Campos y vistas de un cliente para el constructor de plantillas globales.
 *
 * Las plantillas de `/admin/layouts` se editan sin cliente seleccionado, así que
 * el catálogo se puebla eligiendo uno como referencia. Lo que se guarda es la
 * clave (`sf_<clave>`), que solo resuelve en los clientes que tengan ese campo.
 */
export async function getSheetCamposCatalogo(clienteId: string) {
  try {
    const db = await createAdminClient();
    const { campos, vistas } = await loadCamposClienteServer(db, clienteId, { soloActivos: true });
    return {
      campos: campos.map((c) => ({
        clave: c.clave,
        nombre: c.nombre,
        agregacion: c.agregacion,
        formato: c.formato,
      })),
      vistas: vistas.map((v) => ({
        clave: v.clave,
        nombre: v.nombre,
        agregacion: v.agregacion,
        formato: v.formato,
      })),
    };
  } catch (e: any) {
    return { error: e.message || 'Error al leer los campos del cliente' };
  }
}

/** Columnas por pestaña ya sincronizada, con muestras. No llama a Google. */
export async function listSheetColumnas(clienteId: string) {
  try {
    const res = await internalFetch(
      `/api/admin/sheet-columnas?cliente_id=${encodeURIComponent(clienteId)}`,
      { cache: 'no-store' }
    );
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Error al leer las columnas' };
    return { fuentes: (data.fuentes ?? []) as Array<FuenteColumnas & { sheet_nombre: string }> };
  } catch (e: any) {
    return { error: e.message || 'Error al leer las columnas' };
  }
}

/** Mensaje de timeout del sync: la salida es sincronizar de a un documento. */
const TIMEOUT_SYNC_SHEETS =
  'La sincronización superó el tiempo máximo del servidor. Vuelve a intentarlo; si el documento es muy grande, sincroniza los sheets de uno en uno.';

/** Una pestaña del lote, o la consolidación final. Ver la ruta del sync. */
export interface SyncTanda {
  sheetId: string;
  batchId: string;
  /** Pestaña a sincronizar. Sin esto, la petición consolida el lote. */
  tabId?: string;
  consolidar?: boolean;
  /**
   * Solo en la consolidación: alguna pestaña no pudo guardar su capa cruda, así
   * que no se retiran pestañas huérfanas. Los totales ya no viajan desde aquí:
   * el servidor los recalcula desde la base.
   */
  conservarCrudas?: boolean;
  quality?: unknown[];
  /** Solo en la consolidación: apagado mientras queden sheets por sincronizar. */
  recalcularCampos?: boolean;
}

/**
 * Sincroniza una tanda: una pestaña, o el cierre del lote.
 *
 * Partido así porque un documento de decenas de miles de filas no cabe en el
 * tiempo de una función. Cada pestaña escribe sus filas; la consolidación
 * recalcula los totales diarios del sheet.
 */
export async function syncTandaConversiones(
  clienteId: string,
  tanda: SyncTanda
): Promise<
  Partial<SyncConversionesResponse> & {
    quality?: unknown[];
    crudasIncompletas?: boolean;
    batchId?: string;
  }
> {
  try {
    const res = await internalFetch(`/api/admin/sync-conversiones-offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clienteId, ...tanda }),
      cache: 'no-store',
      signal: AbortSignal.timeout(58_000),
    });

    const leido = await leerJsonRespuesta<any>(
      res,
      'Error al sincronizar la pestaña',
      TIMEOUT_SYNC_SHEETS
    );
    if (!leido.ok) return { error: leido.error };
    if (!res.ok) return { error: leido.data.error || 'Error al sincronizar la pestaña' };

    if (tanda.consolidar) revalidatePath(`/admin/settings/${clienteId}`);
    return leido.data;
  } catch (e: any) {
    if (esTimeoutDeFetch(e)) return { error: TIMEOUT_SYNC_SHEETS };
    return { error: e.message || 'Error al sincronizar la pestaña' };
  }
}

/**
 * Sincroniza los sheets de conversiones del cliente de una vez.
 *
 * Se conserva para documentos pequeños y para el worker; la UI usa
 * `syncTandaConversiones`, que trocea por pestaña.
 */
export async function syncConversionesOffline(
  clienteId: string,
  sheetId?: string
): Promise<Partial<SyncConversionesResponse>> {
  try {
    const res = await internalFetch(`/api/admin/sync-conversiones-offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clienteId, ...(sheetId ? { sheetId } : {}) }),
      cache: 'no-store',
      // Justo por debajo del maxDuration de la ruta: así el error lo damos
      // nosotros, con un mensaje que se entiende.
      signal: AbortSignal.timeout(58_000),
    });

    const leido = await leerJsonRespuesta<SyncConversionesResponse>(
      res,
      'Error al sincronizar conversiones offline',
      TIMEOUT_SYNC_SHEETS
    );
    if (!leido.ok) return { error: leido.error };
    const data = leido.data;

    if (!res.ok) {
      return { error: data.error || 'Error al sincronizar conversiones offline' };
    }

    revalidatePath(`/admin/settings/${clienteId}`);
    // `data.success` ya dice si entró al menos un sheet; el literal que había
    // aquí quedaba pisado por el spread, así que no aportaba nada.
    return data;
  } catch (e: any) {
    console.error('Conversiones offline sync error:', e);
    if (esTimeoutDeFetch(e)) return { error: TIMEOUT_SYNC_SHEETS };
    return { error: e.message || 'Error al sincronizar conversiones offline' };
  }
}

/**
 * Guarda SOLO las claves de una pestaña de la ficha del cliente.
 *
 * `updateClienteConfig` reescribía `config_api` entero con el snapshot que el
 * navegador leyó al abrir la página, así que pisaba lo que el servidor hubiera
 * escrito entre medias: los tokens que renueva el cron de Hotmart y el
 * `meta_estado_cuentas` del vigilante de cuentas. Aquí se manda un parche y lo
 * funde `public.fusionar_config_api` (migración 066) con `||`, en una sola
 * sentencia: el resto del objeto ni se lee.
 *
 * El navegador no decide qué se escribe. El parche se filtra contra el mapa de
 * la pestaña antes de tocar la base.
 */
export async function guardarConfigPestana(
  clienteId: string,
  pestana: Pestana,
  parche: Record<string, unknown>
): Promise<{ success?: boolean; error?: string }> {
  const rol = await rolActual();
  if (!rol || rol === 'viewer') return { error: 'No autorizado' };

  const permitidas = new Set(CLAVES_POR_PESTANA[pestana]);
  for (const clave of Object.keys(parche)) {
    if (!permitidas.has(clave)) {
      return { error: `La clave «${clave}» no pertenece a la pestaña «${pestana}»` };
    }
  }

  let limpio: Record<string, unknown> = { ...parche };

  // Los secretos de Hotmart se cifran aquí, DESPUÉS de filtrar por la pestaña:
  // el navegador no puede mandar una clave `*_enc` (no es de ninguna pestaña),
  // solo el valor en claro, y lo que llegue como `SECRETO_GUARDADO` no se toca.
  if (pestana === 'hotmart') {
    try {
      limpio = prepararParcheHotmart(limpio, encrypt);
    } catch (e) {
      // Sin `RUTM_ENCRYPTION_KEY` se falla en voz alta: guardar el secreto en
      // claro creyendo que va cifrado sería peor.
      console.error('[guardarConfigPestana] cifrado de Hotmart', e);
      return {
        error:
          'No se pudieron cifrar las credenciales de Hotmart (¿falta RUTM_ENCRYPTION_KEY en el servidor?).',
      };
    }
  }

  // Misma validación de la clave privada de GA4 que hacía `updateClienteConfig`:
  // el JSON de la service account trae los saltos de línea escapados.
  if (typeof limpio.ga_private_key === 'string' && limpio.ga_private_key) {
    // `/\\n/g`: la secuencia escapada. Con `/\n/g` era un no-op (salto → salto).
    const key = limpio.ga_private_key.replace(/\\n/g, '\n');
    if (!key.includes('BEGIN PRIVATE KEY') || !key.includes('END PRIVATE KEY')) {
      return {
        error: 'El formato de la Private Key de GA4 es inválido. Sube el archivo JSON original.',
      };
    }
    limpio.ga_private_key = key;
  }

  if (Object.keys(limpio).length === 0) return { success: true };

  const supabase = await createAdminClient();

  // ¿Cambia la propiedad de GA4? Entonces hay que traer su histórico desglosado.
  let propiedadGa4Nueva: string | null = null;
  if (typeof limpio.ga_property_id === 'string' && limpio.ga_property_id.trim()) {
    const { data: previo } = await supabase
      .from('clientes')
      .select('config_api')
      .eq('id', clienteId)
      .maybeSingle();
    const antes = String((previo?.config_api as any)?.ga_property_id ?? '').trim();
    if (antes !== limpio.ga_property_id.trim()) propiedadGa4Nueva = limpio.ga_property_id.trim();
  }

  const { error } = await supabase.rpc('fusionar_config_api', {
    p_cliente_id: clienteId,
    p_parche: limpio,
  });
  if (error) {
    console.error('[guardarConfigPestana]', error);
    return { error: error.message };
  }

  if (propiedadGa4Nueva) {
    // No bloquea el guardado: si la cola rechaza el tipo (097 sin aplicar), el
    // plan diario lo recogerá igualmente para los últimos días.
    try {
      const { planGa4Backfill } = await import('@/lib/sync/planner');
      await planGa4Backfill(supabase, clienteId, { triggeredBy: 'ga4:propiedad-nueva' });
    } catch (e) {
      console.error('[guardarConfigPestana] backfill GA4', (e as Error)?.message ?? e);
    }
  }

  revalidatePath(`/admin/settings/${clienteId}`);
  revalidatePath('/admin/settings');
  return { success: true };
}

/**
 * Marca (o desmarca) un paso opcional de la «Puesta en marcha» como «No aplica».
 * Escribe solo `config_api.puesta_en_marcha_omitidos`, con la fusión atómica:
 * ninguna pestaña de la ficha manda esa clave, así que guardarlas no la pisa.
 */
export async function marcarPasoPuestaEnMarcha(clienteId: string, clave: string, omitir: boolean) {
  const rol = await rolActual();
  if (!rol || rol === 'viewer') return { error: 'No autorizado' };
  if (!/^[a-z0-9_]{1,40}$/.test(clave)) return { error: 'Paso desconocido.' };

  const admin = await createAdminClient();
  const { data, error } = await admin
    .from('clientes')
    .select('config_api')
    .eq('id', clienteId)
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: 'El cliente no existe.' };

  const actuales = (data.config_api as Record<string, unknown> | null)?.[CLAVE_OMITIDOS];
  const lista = new Set(Array.isArray(actuales) ? actuales.map(String) : []);
  if (omitir) lista.add(clave);
  else lista.delete(clave);

  const { error: e } = await admin.rpc('fusionar_config_api', {
    p_cliente_id: clienteId,
    p_parche: { [CLAVE_OMITIDOS]: [...lista] },
  });
  if (e) return { error: e.message };
  revalidatePath(`/admin/settings/${clienteId}`);
  return { success: true };
}
