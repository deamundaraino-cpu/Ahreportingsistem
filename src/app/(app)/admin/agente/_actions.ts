'use server';

/**
 * Acciones del panel del agente.
 *
 * Contrato del proyecto: devuelven `{ success: true }` o `{ error: string }`, y
 * llaman a `revalidatePath` tras escribir.
 */

import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/utils/supabase/server';
import { getSesionActual } from '@/lib/auth-session';

type Resultado<T = unknown> = { success: true; data?: T } | { error: string };

/**
 * Guard compartido.
 *
 * `requireAdmin()` está duplicado con dos firmas distintas en otros dos
 * `_actions.ts` del proyecto; aquí se usa `getSesionActual()`, que ya está
 * memoizado por petición.
 */
async function exigirAdmin(): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const sesion = await getSesionActual();
  if (!sesion.userId) return { ok: false, error: 'Hay que iniciar sesión.' };
  if (!['superadmin', 'admin'].includes(sesion.role)) {
    return { ok: false, error: 'Solo un administrador puede hacer esto.' };
  }
  return { ok: true, userId: sesion.userId };
}

// ─── Conversaciones ─────────────────────────────────────────────────────────

export type ConversacionResumen = {
  id: string;
  titulo: string | null;
  channel: string;
  last_activity_at: string;
};

export async function listarConversaciones(): Promise<ConversacionResumen[]> {
  const sesion = await getSesionActual();
  if (!sesion.userId) return [];

  const db = await createAdminClient();
  const { data } = await db
    .from('agent_conversations')
    .select('id, titulo, channel, last_activity_at')
    .eq('user_id', sesion.userId)
    .order('last_activity_at', { ascending: false })
    .limit(40);

  return (data ?? []) as ConversacionResumen[];
}

export type MensajeConversacion = {
  id: string;
  role: string;
  content: unknown;
  tool_calls: unknown;
  model_used: string | null;
  cost_usd: number | null;
  created_at: string;
};

export async function leerConversacion(id: string): Promise<MensajeConversacion[]> {
  const sesion = await getSesionActual();
  if (!sesion.userId) return [];

  const db = await createAdminClient();
  const { data: conv } = await db
    .from('agent_conversations')
    .select('user_id')
    .eq('id', id)
    .maybeSingle();

  // Una conversación ajena no se lee, aunque se conozca su identificador.
  if (!conv || (conv as { user_id: string | null }).user_id !== sesion.userId) return [];

  const { data } = await db
    .from('agent_messages')
    .select('id, role, content, tool_calls, model_used, cost_usd, created_at')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })
    .limit(200);

  return (data ?? []) as MensajeConversacion[];
}

export async function borrarConversacion(id: string): Promise<Resultado> {
  const sesion = await getSesionActual();
  if (!sesion.userId) return { error: 'Hay que iniciar sesión.' };

  const db = await createAdminClient();
  const { error } = await db
    .from('agent_conversations')
    .delete()
    .eq('id', id)
    .eq('user_id', sesion.userId);

  if (error) return { error: error.message };
  revalidatePath('/admin/agente');
  return { success: true };
}

// ─── Catálogo de estrategias ────────────────────────────────────────────────

export type EstrategiaTipoRow = {
  id: string;
  categoria: string;
  subcategoria: string;
  nombre: string;
  descripcion: string | null;
  alcance: 'hasta_lead' | 'hasta_venta';
  temporal: boolean;
  metricas_clave: string[];
  metricas_na: string[];
  guia: string | null;
  activo: boolean;
  orden: number;
};

export async function listarEstrategias(): Promise<EstrategiaTipoRow[]> {
  const db = await createAdminClient();
  const { data } = await db.from('estrategia_tipos').select('*').order('orden');
  return (data ?? []) as EstrategiaTipoRow[];
}

export type PayloadEstrategia = {
  categoria: string;
  subcategoria: string;
  nombre: string;
  descripcion?: string | null;
  alcance: 'hasta_lead' | 'hasta_venta';
  temporal: boolean;
  metricas_clave: string[];
  metricas_na: string[];
  guia?: string | null;
  activo?: boolean;
  orden?: number;
};

export async function crearEstrategia(payload: PayloadEstrategia): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();
  const { error } = await db.from('estrategia_tipos').insert(payload);

  if (error) {
    // 23505 = ya existe esa combinación de categoría y subcategoría.
    if (error.code === '23505') {
      return { error: `Ya existe un tipo "${payload.categoria}/${payload.subcategoria}".` };
    }
    return { error: error.message };
  }
  revalidatePath('/admin/agente');
  return { success: true };
}

export async function actualizarEstrategia(
  id: string,
  payload: Partial<PayloadEstrategia>
): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();
  const { error } = await db
    .from('estrategia_tipos')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) return { error: error.message };
  revalidatePath('/admin/agente');
  return { success: true };
}

export async function borrarEstrategia(id: string): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();

  // Una estrategia en uso no se borra: las pestañas que la tengan asignada se
  // quedarían sin contexto y el análisis volvería a ser genérico sin avisar.
  const { count } = await db
    .from('cliente_tabs')
    .select('id', { count: 'exact', head: true })
    .eq('estrategia_tipo_id', id);

  if ((count ?? 0) > 0) {
    return {
      error: `No se puede borrar: ${count} pestaña(s) la usan. Desactívala en su lugar.`,
    };
  }

  const { error } = await db.from('estrategia_tipos').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/agente');
  return { success: true };
}

// ─── Canales y contactos de WhatsApp ────────────────────────────────────────

export type CanalRow = {
  id: string;
  external_id: string;
  kind: 'group' | 'dm';
  nombre: string | null;
  max_level: string;
  cliente_id: string | null;
  require_mention: boolean;
  learning_mode: boolean;
  is_active: boolean;
  created_at: string;
};

export async function listarCanales(): Promise<CanalRow[]> {
  const db = await createAdminClient();
  const { data } = await db
    .from('agent_channels')
    .select('*')
    .eq('channel', 'whatsapp')
    .order('created_at', { ascending: false });
  return (data ?? []) as CanalRow[];
}

export async function actualizarCanal(
  id: string,
  payload: Partial<
    Pick<
      CanalRow,
      'is_active' | 'max_level' | 'require_mention' | 'learning_mode' | 'cliente_id' | 'nombre'
    >
  >
): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();
  const { error } = await db.from('agent_channels').update(payload).eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/agente');
  return { success: true };
}

export type ContactoRow = {
  id: string;
  user_id: string;
  display_name: string | null;
  level: string;
  client_scope: string[] | null;
  is_active: boolean;
};

export type ContactoConIdentidades = ContactoRow & {
  identidades: { id: string; kind: string; external_id: string }[];
  rol_app: string;
  /** El menor entre su nivel y el techo de su rol: es el que manda de verdad. */
  nivel_efectivo: string;
};

export async function listarContactos(): Promise<ContactoConIdentidades[]> {
  const db = await createAdminClient();
  const { TECHO_POR_ROL, nivelEfectivo } = await import('@/lib/agent/types');

  const [contactos, identidades, perfiles] = await Promise.all([
    db.from('agent_contacts').select('*').order('display_name'),
    db.from('agent_contact_identities').select('id, contact_id, kind, external_id'),
    db.from('user_profiles').select('id, role, full_name'),
  ]);

  const porContacto = new Map<string, { id: string; kind: string; external_id: string }[]>();
  for (const i of identidades.data ?? []) {
    const r = i as { id: string; contact_id: string; kind: string; external_id: string };
    porContacto.set(r.contact_id, [
      ...(porContacto.get(r.contact_id) ?? []),
      { id: r.id, kind: r.kind, external_id: r.external_id },
    ]);
  }

  const rolDe = new Map<string, string>();
  const nombreDe = new Map<string, string>();
  for (const u of perfiles.data ?? []) {
    const r = u as { id: string; role: string; full_name: string | null };
    rolDe.set(r.id, r.role);
    if (r.full_name) nombreDe.set(r.id, r.full_name);
  }

  return ((contactos.data ?? []) as ContactoRow[]).map((c) => {
    const rol = (rolDe.get(c.user_id) ?? 'viewer') as keyof typeof TECHO_POR_ROL;
    return {
      ...c,
      display_name: c.display_name ?? nombreDe.get(c.user_id) ?? null,
      identidades: porContacto.get(c.id) ?? [],
      rol_app: rol,
      // Se muestra calculado para evitar el "le puse admin y no puede hacer nada".
      nivel_efectivo: nivelEfectivo(TECHO_POR_ROL[rol], c.level as never),
    };
  });
}

export async function guardarContacto(payload: {
  id?: string;
  user_id: string;
  display_name?: string | null;
  level: string;
  client_scope?: string[] | null;
  is_active?: boolean;
}): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();
  const fila = {
    user_id: payload.user_id,
    display_name: payload.display_name ?? null,
    level: payload.level,
    client_scope: payload.client_scope?.length ? payload.client_scope : null,
    is_active: payload.is_active ?? true,
  };

  const { error } = payload.id
    ? await db.from('agent_contacts').update(fila).eq('id', payload.id)
    : await db.from('agent_contacts').upsert(fila, { onConflict: 'user_id' });

  if (error) return { error: error.message };
  revalidatePath('/admin/agente');
  return { success: true };
}

export async function borrarContacto(id: string): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();
  const { error } = await db.from('agent_contacts').delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/agente');
  return { success: true };
}

export type RemitenteVisto = {
  id: string;
  channel_id: string | null;
  lid: string | null;
  participant_pn: string | null;
  push_name: string | null;
  last_seen_at: string;
  linked_contact_id: string | null;
};

export async function listarRemitentesVistos(): Promise<RemitenteVisto[]> {
  const db = await createAdminClient();
  const { data } = await db
    .from('whatsapp_seen_senders')
    .select('*')
    .is('linked_contact_id', null)
    .order('last_seen_at', { ascending: false })
    .limit(50);
  return (data ?? []) as RemitenteVisto[];
}

/**
 * Vincula un remitente visto a un contacto.
 *
 * Es el paso que resuelve el problema del LID: en un grupo, WhatsApp identifica
 * a la persona con un código opaco que no se puede traducir a su número de forma
 * fiable. Dar de alta a alguien por su número lo deja funcionando en privado
 * pero invisible en los grupos, y este es el remedio.
 */
export async function vincularRemitente(
  remitenteId: string,
  contactoId: string
): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();
  const { data: r } = await db
    .from('whatsapp_seen_senders')
    .select('lid, participant_pn')
    .eq('id', remitenteId)
    .maybeSingle();

  if (!r) return { error: 'Ese remitente ya no está en la lista.' };
  const fila = r as { lid: string | null; participant_pn: string | null };

  // Se registran ambas identidades si las hay: el LID sirve en los grupos y el
  // número en el chat privado.
  const nuevas: { contact_id: string; channel: string; kind: string; external_id: string }[] = [];
  if (fila.lid) {
    nuevas.push({
      contact_id: contactoId,
      channel: 'whatsapp',
      kind: 'lid',
      external_id: fila.lid,
    });
  }
  if (fila.participant_pn) {
    nuevas.push({
      contact_id: contactoId,
      channel: 'whatsapp',
      kind: 'pn',
      external_id: fila.participant_pn,
    });
  }
  if (nuevas.length === 0)
    return { error: 'Ese remitente no trae ningún identificador utilizable.' };

  const { error } = await db
    .from('agent_contact_identities')
    .upsert(nuevas, { onConflict: 'channel,external_id' });

  if (error) return { error: error.message };

  await db
    .from('whatsapp_seen_senders')
    .update({ linked_contact_id: contactoId })
    .eq('id', remitenteId);

  revalidatePath('/admin/agente');
  return { success: true };
}

// ─── Estado de la puesta en marcha ──────────────────────────────────────────

export type EstadoAgente = {
  tieneClaveLlm: boolean;
  tieneSecretoEntrante: boolean;
  turnosPendientes: number;
  turnosConError: number;
  propuestasPendientes: number;
};

/**
 * Qué está configurado y qué no.
 *
 * `turnosPendientes` es el indicador que importa: si sube y no baja, el bucle
 * que procesa la cola no está corriendo en el VPS. Es el fallo más probable al
 * abrir el canal de WhatsApp y desde fuera parece que el agente está muerto.
 */
export async function leerEstadoAgente(): Promise<EstadoAgente> {
  const db = await createAdminClient();

  const [pend, err, prop] = await Promise.all([
    db.from('agent_turns').select('id', { count: 'exact', head: true }).eq('estado', 'pending'),
    db.from('agent_turns').select('id', { count: 'exact', head: true }).eq('estado', 'error'),
    db
      .from('agent_action_approvals')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pendiente'),
  ]);

  return {
    tieneClaveLlm: Boolean(process.env.OPENROUTER_API_KEY),
    tieneSecretoEntrante: Boolean(process.env.AGENT_INBOUND_SECRET),
    turnosPendientes: pend.count ?? 0,
    turnosConError: err.count ?? 0,
    propuestasPendientes: prop.count ?? 0,
  };
}

// ─── Política de modelos ────────────────────────────────────────────────────

export async function leerPoliticaModelos(): Promise<Record<string, unknown>> {
  const db = await createAdminClient();
  const { POLITICA_POR_DEFECTO } = await import('@/lib/agent/llm/client');

  const { data } = await db
    .from('system_settings')
    .select('key, value')
    .in('key', ['agent_tier_nano', 'agent_tier_work', 'agent_tier_power']);

  const guardadas: Record<string, unknown> = {};
  for (const r of data ?? []) {
    const row = r as { key: string; value: unknown };
    guardadas[row.key.replace('agent_tier_', '')] = row.value;
  }

  return {
    nano: guardadas.nano ?? POLITICA_POR_DEFECTO.nano,
    work: guardadas.work ?? POLITICA_POR_DEFECTO.work,
    power: guardadas.power ?? POLITICA_POR_DEFECTO.power,
    porDefecto: POLITICA_POR_DEFECTO,
  };
}

export async function guardarPoliticaModelos(
  tier: 'nano' | 'work' | 'power',
  politica: { primary: string; fallbacks: string[]; maxTokens: number }
): Promise<Resultado> {
  const guard = await exigirAdmin();
  if (!guard.ok) return { error: guard.error };

  const db = await createAdminClient();
  const { error } = await db.from('system_settings').upsert(
    {
      key: `agent_tier_${tier}`,
      // `allowTools` no se guarda: en `nano` se fuerza a false pase lo que pase.
      value: politica,
    },
    { onConflict: 'key' }
  );

  if (error) return { error: error.message };
  revalidatePath('/admin/agente');
  return { success: true };
}
