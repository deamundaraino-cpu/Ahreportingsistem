/**
 * Cliente HTTP contra la API v2 de GoHighLevel (LeadConnector).
 *
 * Solo transporte: no sabe nada de `lead_events` ni de UTMs. El mapeo vive en
 * `ghl-leads.ts`, igual que `meta-leads.ts` separa `fetchFormLeads` del
 * `buildLeadRow`.
 *
 * Autenticación: **Private Integration Token** (PIT) por location, guardado
 * cifrado en `report_utm.integrations.access_token_encrypted`. No hay OAuth ni
 * app de Marketplace: para un puñado de locations propias, el PIT evita publicar
 * y mantener una app, y se revoca desde la propia location.
 *
 * Scopes mínimos del PIT: `contacts.readonly` y `locations/customFields.readonly`.
 * Las ventas (`ghl-ventas.ts`, `ghl-oportunidades.ts`) necesitan además
 * `opportunities.readonly`: sin él la venta del webhook se sigue guardando (con la
 * hora de llegada en vez de la de cierre) y el sync de respaldo falla con 401.
 */

const BASE = 'https://services.leadconnectorhq.com';

/**
 * Versión de la API fijada a mano. GHL cambia la forma de las respuestas entre
 * versiones y el header es obligatorio: dejarlo implícito significa que una
 * versión nueva puede cambiar el contacto sin que nos enteremos.
 */
const API_VERSION = '2021-07-28';

/** Tope de páginas por pasada. 100 contactos por página → 20.000 por corrida. */
const MAX_PAGINAS = 200;

/** Máximo que acepta `POST /contacts/search` por página. */
export const PAGE_LIMIT = 100;

export type GhlAtribucion = {
  /** UTMs reales, cuando el contacto llegó por una landing con querystring. */
  utmSource?: string | null;
  utmMedium?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;
  utmKeyword?: string | null;
  campaign?: string | null;
  campaignName?: string | null;
  campaignId?: string | null;
  utm_id?: string | null;
  /** Etiquetas de canal que pone GHL ("Paid Social", "Social media", "Direct"). */
  sessionSource?: string | null;
  medium?: string | null;
  /** Id de la cuenta/página de origen. NO es una campaña: nunca va a `utm_id`. */
  mediumId?: string | null;
  /** Estructura del anuncio de Meta cuando el lead viene de un Click-to-WhatsApp. */
  adId?: string | null;
  adName?: string | null;
  adGroupId?: string | null;
  adGroupName?: string | null;
  fbclid?: string | null;
  gclid?: string | null;
  referrer?: string | null;
  url?: string | null;
};

export type GhlCustomFieldValue = {
  id?: string;
  value?: unknown;
  fieldValue?: unknown;
  fieldValueString?: unknown;
};

export type GhlContact = {
  id: string;
  locationId?: string | null;
  contactName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  city?: string | null;
  timezone?: string | null;
  /** Origen que declara GHL (nombre del formulario, "Manual", el workflow…). */
  source?: string | null;
  tags?: string[] | null;
  dateAdded?: string | null;
  dateUpdated?: string | null;
  assignedTo?: string | null;
  customFields?: GhlCustomFieldValue[] | null;
  attributionSource?: GhlAtribucion | null;
  lastAttributionSource?: GhlAtribucion | null;
  opportunities?: unknown[] | null;
  /** Cursor de paginación que devuelve el buscador en cada contacto. */
  searchAfter?: unknown[] | null;
};

export type GhlCustomFieldDef = {
  id: string;
  name: string;
  fieldKey?: string | null;
  dataType?: string | null;
  /**
   * Opciones de un desplegable, casillas o radio. GHL las devuelve en
   * `picklistOptions` (texto) y en las versiones nuevas también en `options`
   * ({key, label}). Se conservan desde la migración 091: son las respuestas
   * reales de la pregunta, que antes se tiraban.
   */
  opciones?: { valor: string; etiqueta: string | null }[];
};

export type GhlCredenciales = {
  token: string;
  locationId: string;
};

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Version: API_VERSION,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

/**
 * Lee la respuesta y lanza con el mensaje que devuelve GHL. Ese texto sube tal
 * cual a `integrations.last_error`, que es lo que ve el equipo en la tarjeta: un
 * "401" a secas no dice si el PIT está mal, caducó o le falta un scope.
 */
async function leerRespuesta(res: Response, contexto: string): Promise<Record<string, unknown>> {
  const texto = await res.text();
  let cuerpo: Record<string, unknown> = {};
  if (texto) {
    try {
      cuerpo = JSON.parse(texto) as Record<string, unknown>;
    } catch {
      cuerpo = { message: texto.slice(0, 300) };
    }
  }
  if (!res.ok) {
    const msg =
      typeof cuerpo.message === 'string'
        ? cuerpo.message
        : typeof cuerpo.error === 'string'
          ? cuerpo.error
          : `HTTP ${res.status}`;
    throw new Error(`GHL ${contexto}: ${msg}`);
  }
  return cuerpo;
}

/** Trae un contacto por id. Es el camino que usa el webhook para releer el dato completo. */
export async function fetchContactById(
  contactId: string,
  cred: GhlCredenciales
): Promise<GhlContact | null> {
  const res = await fetch(`${BASE}/contacts/${encodeURIComponent(contactId)}`, {
    headers: headers(cred.token),
  });
  if (res.status === 404) return null;
  const cuerpo = await leerRespuesta(res, `GET /contacts/${contactId}`);
  const contacto = (cuerpo.contact ?? cuerpo) as GhlContact;
  return contacto?.id ? contacto : null;
}

/** Opciones de un campo de GHL, en cualquiera de sus dos formatos. */
export function opcionesDeCampoGhl(
  f: Record<string, unknown>
): { valor: string; etiqueta: string | null }[] {
  const out: { valor: string; etiqueta: string | null }[] = [];
  const pick = f.picklistOptions;
  if (Array.isArray(pick)) {
    for (const o of pick)
      if (o !== null && o !== undefined && String(o).trim())
        out.push({ valor: String(o), etiqueta: String(o) });
  }
  const opts = f.options;
  if (out.length === 0 && Array.isArray(opts)) {
    for (const o of opts as Record<string, unknown>[]) {
      const valor = String(o?.label ?? o?.key ?? '').trim();
      if (valor) out.push({ valor, etiqueta: o?.label ? String(o.label) : valor });
    }
  }
  return out;
}

/** Catálogo de campos personalizados de la location (resuelve los ids opacos del contacto). */
export async function fetchCustomFields(cred: GhlCredenciales): Promise<GhlCustomFieldDef[]> {
  const url = `${BASE}/locations/${encodeURIComponent(cred.locationId)}/customFields?model=contact`;
  const res = await fetch(url, { headers: headers(cred.token) });
  const cuerpo = await leerRespuesta(res, 'GET /locations/{id}/customFields');
  const lista = (cuerpo.customFields ?? cuerpo.customField ?? []) as GhlCustomFieldDef[];
  return (Array.isArray(lista) ? lista : [])
    .filter((f) => f?.id && f?.name)
    .map((f) => ({
      id: String(f.id),
      name: String(f.name),
      fieldKey: f.fieldKey ? String(f.fieldKey) : null,
      dataType: f.dataType ? String(f.dataType) : null,
      opciones: opcionesDeCampoGhl(f as unknown as Record<string, unknown>),
    }));
}

/**
 * Recorre los contactos creados desde `desdeIso` en **streaming**, invocando
 * `onBatch` por página (≤100). No acumula nada en memoria: el backfill de una
 * location con decenas de miles de contactos no cabe en una sola respuesta.
 *
 * Orden ascendente por `dateAdded` a propósito: el cursor que persiste el sync
 * es la fecha del último contacto visto, así que una pasada cortada por
 * presupuesto de tiempo reanuda exactamente donde quedó.
 *
 * `onBatch` puede devolver `false` para **parar la paginación**. Es lo que usa
 * el sync para respetar su presupuesto de tiempo: sin ese corte, una location de
 * 23.000 contactos seguiría pidiendo las 230 páginas restantes y la petición
 * se abortaría por timeout a mitad de un lote.
 */
export async function searchContactsPaged(
  cred: GhlCredenciales,
  desdeIso: string,
  onBatch: (contactos: GhlContact[]) => Promise<boolean | void>
): Promise<void> {
  let searchAfter: unknown[] | null = null;
  let pagina = 0;

  while (pagina < MAX_PAGINAS) {
    pagina++;
    const body: Record<string, unknown> = {
      locationId: cred.locationId,
      pageLimit: PAGE_LIMIT,
      filters: [{ field: 'dateAdded', operator: 'range', value: { gte: desdeIso } }],
      sort: [{ field: 'dateAdded', direction: 'asc' }],
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const res = await fetch(`${BASE}/contacts/search`, {
      method: 'POST',
      headers: headers(cred.token),
      body: JSON.stringify(body),
    });
    const cuerpo = await leerRespuesta(res, 'POST /contacts/search');
    const contactos = (cuerpo.contacts ?? cuerpo.items ?? []) as GhlContact[];
    if (!Array.isArray(contactos) || contactos.length === 0) return;

    const seguir = await onBatch(contactos);
    if (seguir === false) return;

    const ultimo = contactos[contactos.length - 1];
    const siguiente = Array.isArray(ultimo?.searchAfter) ? ultimo.searchAfter : null;
    // Sin cursor no se puede avanzar: repetir la misma página sería un bucle.
    if (!siguiente || contactos.length < PAGE_LIMIT) return;
    searchAfter = siguiente;
  }
}

/**
 * Prueba de conexión: una página de un solo contacto. Devuelve el total que
 * declara GHL, que es lo que avisa al equipo del tamaño real del backfill antes
 * de lanzarlo.
 */
export async function testConnection(cred: GhlCredenciales): Promise<{ total: number }> {
  const res = await fetch(`${BASE}/contacts/search`, {
    method: 'POST',
    headers: headers(cred.token),
    body: JSON.stringify({ locationId: cred.locationId, pageLimit: 1 }),
  });
  const cuerpo = await leerRespuesta(res, 'POST /contacts/search');
  return { total: Number(cuerpo.total ?? 0) };
}

// ── Oportunidades (ventas del CRM) ────────────────────────────────────

/** Oportunidad tal como la devuelven `GET /opportunities/search` y `/opportunities/{id}`. */
export type GhlOportunidad = {
  id: string;
  name?: string | null;
  monetaryValue?: number | string | null;
  pipelineId?: string | null;
  pipelineStageId?: string | null;
  /** `open` | `won` | `lost` | `abandoned`. */
  status?: string | null;
  source?: string | null;
  contactId?: string | null;
  locationId?: string | null;
  /** Para una ganada, el instante en que pasó a `won`. */
  lastStatusChangeAt?: string | null;
  lastStageChangeAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  contact?: {
    id?: string | null;
    name?: string | null;
    email?: string | null;
    phone?: string | null;
    tags?: string[] | null;
  } | null;
};

/** Máximo que acepta `GET /opportunities/search` por página. */
export const OPP_PAGE_LIMIT = 100;
/** Tope de páginas por pasada del sync: 50 × 100 = 5.000 oportunidades. */
const MAX_PAGINAS_OPP = 50;

/** Una oportunidad por id. `null` si GHL dice 404 (borrada o de otra location). */
export async function fetchOpportunityById(
  oportunidadId: string,
  cred: GhlCredenciales
): Promise<GhlOportunidad | null> {
  const res = await fetch(`${BASE}/opportunities/${encodeURIComponent(oportunidadId)}`, {
    headers: headers(cred.token),
  });
  if (res.status === 404) return null;
  const cuerpo = await leerRespuesta(res, `GET /opportunities/${oportunidadId}`);
  const o = (cuerpo.opportunity ?? cuerpo) as GhlOportunidad;
  return o?.id ? o : null;
}

/**
 * Recorre las oportunidades de un estado, de la más RECIENTE a la más antigua
 * por fecha de creación (el orden por defecto de GHL), invocando `onBatch` por
 * página.
 *
 * Paginación por cursor (`startAfter` + `startAfterId` que devuelve `meta`), no
 * por `page`: el cursor no se desplaza si entra una oportunidad nueva a mitad
 * del recorrido.
 *
 * No se usa el filtro `date` de la API a propósito: filtra por CREACIÓN, y una
 * oportunidad creada hace cuatro meses puede ganarse ayer. Quien llama decide
 * cuándo parar devolviendo `false` (al salir de su ventana de creación, o por
 * presupuesto de tiempo). `completo` dice si se recorrió la lista entera.
 */
export async function searchOpportunitiesPaged(
  cred: GhlCredenciales,
  status: 'open' | 'won' | 'lost' | 'abandoned' | 'all',
  onBatch: (oportunidades: GhlOportunidad[]) => Promise<boolean | void>
): Promise<{ completo: boolean }> {
  let startAfter: string | null = null;
  let startAfterId: string | null = null;

  for (let pagina = 1; pagina <= MAX_PAGINAS_OPP; pagina++) {
    const qs = new URLSearchParams({
      location_id: cred.locationId,
      status,
      limit: String(OPP_PAGE_LIMIT),
    });
    if (startAfter && startAfterId) {
      qs.set('startAfter', startAfter);
      qs.set('startAfterId', startAfterId);
    }
    const res = await fetch(`${BASE}/opportunities/search?${qs}`, {
      headers: headers(cred.token),
    });
    const cuerpo = await leerRespuesta(res, 'GET /opportunities/search');
    const lista = (cuerpo.opportunities ?? []) as GhlOportunidad[];
    if (!Array.isArray(lista) || lista.length === 0) return { completo: true };

    const seguir = await onBatch(lista);
    if (seguir === false) return { completo: false };

    const meta = (cuerpo.meta ?? {}) as Record<string, unknown>;
    const sigAfter = meta.startAfter ?? null;
    const sigId = meta.startAfterId ?? null;
    // Sin cursor no se puede avanzar: pedir la misma página sería un bucle.
    if (lista.length < OPP_PAGE_LIMIT || sigAfter === null || sigId === null) {
      return { completo: true };
    }
    startAfter = String(sigAfter);
    startAfterId = String(sigId);
  }
  return { completo: false };
}
