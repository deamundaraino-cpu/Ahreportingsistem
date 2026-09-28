/**
 * «Puesta en marcha» de un cliente: qué le falta para reportar bien.
 *
 * Configurar un cliente es recorrer siete pestañas de su ficha y tres páginas
 * más (dashboard, usuarios, WhatsApp), y nada decía qué faltaba: las insignias
 * de la tarjeta solo miraban cuatro credenciales. Esto reúne en una lista cada
 * canal y ajuste, con su estado y a dónde ir para completarlo.
 *
 * Lo obligatorio es poco (Meta con sus cuentas, moneda y zona, una pestaña en
 * el dashboard); el resto depende del cliente, y lo que no le aplica se marca
 * «No aplica» (`config_api.puesta_en_marcha_omitidos`, que solo escribe
 * `marcarPasoPuestaEnMarcha`).
 *
 * `evaluarPuestaEnMarcha` es pura (la prueba `verify-puesta-en-marcha.ts`);
 * `cargarPuestaEnMarcha` lee la base con el cliente de servicio.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Pestana } from './config-pestanas';
import { hotmartConectado } from '../hotmart/cliente';
import { zonaValida, zonasDeCuentas } from '../zona-horaria';

type Db = any;

export const CLAVE_OMITIDOS = 'puesta_en_marcha_omitidos';

export type Destino = { pestana: Pestana } | { href: string };

export type PasoPuestaEnMarcha = {
  clave: string;
  titulo: string;
  /** Qué hacer para completarlo. */
  ayuda: string;
  estado: 'hecho' | 'pendiente' | 'omitido';
  /** Lo opcional se puede marcar «No aplica»; lo obligatorio no. */
  opcional: boolean;
  destino: Destino;
};

/** Lo que hace falta saber del cliente, ya leído. */
export type DatosPuestaEnMarcha = {
  clienteId: string;
  configApi: Record<string, unknown>;
  /** `report_utm.clientes.config` de su espejo. */
  configUtm: Record<string, unknown>;
  /** Tipos de `report_utm.integrations` con `status = 'active'`. */
  integracionesActivas: string[];
  pestanas: number;
  camposLead: number;
  camposSheet: number;
  traffickers: number;
  rutasWhatsapp: number;
};

const lista = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function evaluarPuestaEnMarcha(d: DatosPuestaEnMarcha): PasoPuestaEnMarcha[] {
  const c = d.configApi;
  const activas = new Set(d.integracionesActivas);
  const omitidos = new Set(lista(c[CLAVE_OMITIDOS]).map(String));
  const cuentasMeta = lista(c.meta_accounts).length > 0;

  const pasos: Array<Omit<PasoPuestaEnMarcha, 'estado'> & { hecho: boolean }> = [
    {
      clave: 'meta',
      titulo: 'Meta Ads conectado, con sus cuentas',
      ayuda: 'Conecta Meta y elige las cuentas publicitarias del cliente.',
      opcional: false,
      destino: { pestana: 'meta' },
      hecho: Boolean(c.meta_token) && cuentasMeta,
    },
    {
      clave: 'moneda_zona',
      titulo: 'Moneda y zona horaria',
      ayuda:
        'Salen solas de su cuenta de Meta; fíjalas en General y Meta si reporta en otra moneda o zona.',
      opcional: false,
      destino: { pestana: 'general' },
      hecho:
        (Boolean(d.configUtm.moneda_reporte) || cuentasMeta) &&
        (zonaValida(c.zona_horaria) || zonasDeCuentas(c).length > 0 || cuentasMeta),
    },
    {
      clave: 'pestanas',
      titulo: 'Pestaña de campaña en el dashboard',
      ayuda: 'Crea al menos una pestaña con sus campañas y presupuesto.',
      opcional: false,
      destino: { href: `/dashboard/${d.clienteId}` },
      hecho: d.pestanas > 0,
    },
    {
      clave: 'lead_ads',
      titulo: 'Leads de Meta en tiempo real',
      ayuda: 'Activa Meta Lead Ads para recibir cada lead de sus formularios.',
      opcional: true,
      destino: { pestana: 'meta' },
      hecho: activas.has('meta_lead_ads'),
    },
    {
      clave: 'sheets',
      titulo: 'Google Sheets de conversiones',
      ayuda: 'Enlaza el Sheet donde el cliente registra ventas o citas.',
      opcional: true,
      destino: { pestana: 'google' },
      hecho: lista(c.google_sheets_conversiones).length > 0,
    },
    {
      clave: 'ga4',
      titulo: 'Google Analytics 4',
      ayuda: 'Elige la propiedad de GA4 de su sitio.',
      opcional: true,
      destino: { pestana: 'google' },
      hecho: Boolean(c.ga_property_id),
    },
    {
      clave: 'hotmart',
      titulo: 'Hotmart',
      ayuda: 'Conecta la API de Hotmart o activa su webhook de ventas.',
      opcional: true,
      destino: { pestana: 'hotmart' },
      hecho: hotmartConectado(c) || activas.has('hotmart'),
    },
    {
      clave: 'tiktok',
      titulo: 'TikTok Ads',
      ayuda: 'Conecta TikTok y elige sus cuentas.',
      opcional: true,
      destino: { pestana: 'tiktok' },
      hecho: Boolean(c.tiktok_access_token) && lista(c.tiktok_accounts).length > 0,
    },
    {
      clave: 'ghl',
      titulo: 'GoHighLevel',
      ayuda: 'Activa la integración y crea en GHL los workflows que envían leads y ventas.',
      opcional: true,
      destino: { pestana: 'crm' },
      hecho: activas.has('gohighlevel'),
    },
    {
      clave: 'pixel',
      titulo: 'Píxel / S2S del sitio web',
      ayuda: 'Activa S2S e instala el píxel o el plugin de WordPress en su web.',
      opcional: true,
      destino: { pestana: 'crm' },
      hecho: activas.has('s2s'),
    },
    {
      clave: 'leads',
      titulo: 'Qué se mide de sus leads',
      ayuda: 'Elige las preguntas de formulario y columnas de Sheet que cuentan como métrica.',
      opcional: true,
      destino: { pestana: 'leads' },
      hecho: d.camposLead + d.camposSheet > 0,
    },
    {
      clave: 'traffickers',
      titulo: 'Trafficker asignado',
      ayuda: 'Asigna quién lleva la cuenta (los administradores ya ven todo).',
      opcional: true,
      destino: { href: '/admin/users' },
      hecho: d.traffickers > 0,
    },
    {
      clave: 'whatsapp',
      titulo: 'Grupo de WhatsApp para alertas',
      ayuda: 'Enlaza el grupo del cliente para avisos de presupuesto y sincronización.',
      opcional: true,
      destino: { href: '/admin/configuracion' },
      hecho: d.rutasWhatsapp > 0,
    },
  ];

  return pasos.map(({ hecho, ...p }) => ({
    ...p,
    estado: hecho ? 'hecho' : p.opcional && omitidos.has(p.clave) ? 'omitido' : 'pendiente',
  }));
}

/** Pasos resueltos (hechos u omitidos) sobre el total. */
export function progreso(pasos: PasoPuestaEnMarcha[]): { resueltos: number; total: number } {
  return {
    resueltos: pasos.filter((p) => p.estado !== 'pendiente').length,
    total: pasos.length,
  };
}

/**
 * Lee y evalúa varios clientes a la vez: una consulta por tabla, no por
 * cliente (la lista de Ajustes muestra el progreso de todos, y la instancia es
 * pequeña). Las tablas contadas tienen pocas filas por cliente.
 */
export async function cargarPuestaEnMarchaVarios(
  admin: Db,
  clienteIds: string[]
): Promise<Map<string, PasoPuestaEnMarcha[]>> {
  const salida = new Map<string, PasoPuestaEnMarcha[]>();
  if (clienteIds.length === 0) return salida;
  const rtm = admin.schema('report_utm');
  const filas = async (q: any): Promise<any[]> => {
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  };

  const [clientes, espejos] = await Promise.all([
    filas(admin.from('clientes').select('id, config_api').in('id', clienteIds)),
    filas(
      rtm
        .from('clientes')
        .select('id, public_cliente_id, config')
        .in('public_cliente_id', clienteIds)
    ),
  ]);
  const rtmIds = espejos.map((e) => e.id as string);
  const rtmDe = new Map<string, string>(espejos.map((e) => [e.id, e.public_cliente_id]));

  const [integraciones, pestanas, camposLead, camposSheet, asignaciones, rutas] = await Promise.all(
    [
      rtmIds.length
        ? filas(
            rtm
              .from('integrations')
              .select('cliente_id, tipo')
              .in('cliente_id', rtmIds)
              .eq('status', 'active')
          )
        : [],
      filas(admin.from('cliente_tabs').select('cliente_id').in('cliente_id', clienteIds)),
      rtmIds.length
        ? filas(rtm.from('lead_campos').select('cliente_id').in('cliente_id', rtmIds))
        : [],
      filas(admin.from('sheet_campos').select('cliente_id').in('cliente_id', clienteIds)),
      filas(admin.from('user_client_assignments').select('client_id').in('client_id', clienteIds)),
      filas(admin.from('whatsapp_routes').select('cliente_id').in('cliente_id', clienteIds)),
    ]
  );

  const contar = (xs: any[], col: string, id: string, mapa?: Map<string, string>) =>
    xs.filter((x) => (mapa ? mapa.get(x[col]) : x[col]) === id).length;

  for (const c of clientes) {
    const espejo = espejos.find((e) => e.public_cliente_id === c.id);
    salida.set(
      c.id,
      evaluarPuestaEnMarcha({
        clienteId: c.id,
        configApi: (c.config_api ?? {}) as Record<string, unknown>,
        configUtm: (espejo?.config ?? {}) as Record<string, unknown>,
        integracionesActivas: integraciones
          .filter((i) => rtmDe.get(i.cliente_id) === c.id)
          .map((i) => String(i.tipo)),
        pestanas: contar(pestanas, 'cliente_id', c.id),
        camposLead: contar(camposLead, 'cliente_id', c.id, rtmDe),
        camposSheet: contar(camposSheet, 'cliente_id', c.id),
        traffickers: contar(asignaciones, 'client_id', c.id),
        rutasWhatsapp: contar(rutas, 'cliente_id', c.id),
      })
    );
  }
  return salida;
}

/** La de un cliente, para su ficha. `null` si no existe. */
export async function cargarPuestaEnMarcha(
  admin: Db,
  clienteId: string
): Promise<PasoPuestaEnMarcha[] | null> {
  return (await cargarPuestaEnMarchaVarios(admin, [clienteId])).get(clienteId) ?? null;
}
