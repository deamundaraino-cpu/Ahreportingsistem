import type { SupabaseClient } from '@supabase/supabase-js'
import { dedupTouches } from './attribution-resolver'
import { leerSecreto } from '@/lib/secretos'
import {
    fetchContactById,
    fetchCustomFields,
    searchContactsPaged,
    type GhlAtribucion,
    type GhlContact,
    type GhlCredenciales,
    type GhlCustomFieldDef,
    type GhlCustomFieldValue,
} from './ghl-client'

/**
 * Núcleo compartido para ingerir contactos de **GoHighLevel** en la tabla que ya
 * usan el resto de fuentes: `report_utm.lead_events`. No hay tabla nueva ni
 * fuente nueva del BI — al escribir aquí, un contacto de GHL hereda gratis
 * `leads.count`, el CPL, `utm_leads`, los campos de lead (`leadfield:`), los
 * segmentos (`leadseg:`) y las RPC `bi_leads_por_dia` / `bi_respuestas_por_dia`.
 *
 * Lo usan dos caminos, igual que Meta Lead Ads:
 *   · Polling   → /api/cron/sync-ghl-leads                  (backfill 90d + red de seguridad)
 *   · Webhook   → /api/report-utm/webhooks/ghl/[clienteId]  (tiempo real)
 *
 * ── El webhook es un AVISO, no el dato ──────────────────────────
 * El payload del Workflow de GHL lo configura el usuario y no garantiza traer
 * `attributionSource` ni los campos personalizados resueltos. Por eso el webhook
 * solo extrae el `contact_id` y **relee el contacto completo** con el PIT, como
 * hace el de Meta con `fetchLeadById`. Resultado: un único camino de mapeo para
 * webhook y polling, y atribución completa siempre.
 *
 * ── La regla de oro del cruce con el gasto ──────────────────────
 * `utm_id = campaignId ?? adId`. El `adId` de `attributionSource` es el `ad_id`
 * de Meta y entra por el paso 3 de la cascada de `campaign-resolver.ts`
 * (`utm_id === ad_id` → sube a su campaña), que es el mismo mecanismo que
 * sostiene a Meta Lead Ads.
 *
 * `mediumId` es un id de cuenta/página de Instagram, **no** de campaña ni de
 * anuncio: no cruza con nada y contaminaría el diagnóstico. Nunca va a `utm_id`.
 */

type ReportUtmDb = ReturnType<SupabaseClient['schema']>

/** Prefijo del `external_id`: hace imposible una colisión con los leadgen_id de Meta. */
export const GHL_EXTERNAL_PREFIX = 'ghl:'

/** Valor de `source` y `form_plugin` en `lead_events`. Ambas columnas son TEXT libre. */
export const GHL_SOURCE = 'gohighlevel'

const NOVENTA_DIAS_MS = 90 * 24 * 60 * 60 * 1000

// ── Utilidades puras ──────────────────────────────────────────────────

/** Texto limpio o null. Evita que un `""` o un `"  "` cuente como respuesta. */
function txt(v: unknown): string | null {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    return s === '' ? null : s
}

/** Primer valor no vacío. */
function pick(...vals: Array<string | null | undefined>): string | null {
    for (const v of vals) {
        const t = txt(v)
        if (t) return t
    }
    return null
}

/**
 * Canal declarado por GHL → `utm_source`. El `medium` de un Click-to-WhatsApp es
 * `whatsapp`, que es el canal de conversación, no la plataforma que cobró el
 * clic: el anuncio es de Meta, así que la fuente es `facebook`.
 */
const SOURCE_POR_CANAL: Record<string, string> = {
    whatsapp: 'facebook',
    'paid social': 'facebook',
    facebook: 'facebook',
    fb: 'facebook',
    messenger: 'messenger',
    instagram: 'instagram',
    ig: 'instagram',
    'social media': 'facebook',
    google: 'google',
    'google ads': 'google',
    'paid search': 'google',
    'organic search': 'google',
    tiktok: 'tiktok',
}

/** `sessionSource` de GHL → `utm_medium` canónico. */
const MEDIUM_POR_SESION: Record<string, string> = {
    'paid social': 'paid_social',
    'social media': 'social',
    social: 'social',
    'google ads': 'cpc',
    'paid search': 'cpc',
    'organic search': 'organic',
    referral: 'referral',
    direct: 'direct',
    'direct traffic': 'direct',
    email: 'email',
    sms: 'sms',
}

function slug(v: string | null): string | null {
    if (!v) return null
    const s = v.trim().toLowerCase().replace(/\s+/g, '_')
    return s === '' ? null : s
}

/** Tipos de campo cuyo valor es prosa libre: no sirven como bucket de un campo de lead. */
const TIPOS_LARGOS = new Set(['LARGE_TEXT', 'TEXTAREA', 'TEXTBOX_LIST', 'FILE_UPLOAD', 'SIGNATURE'])

export function esCampoLargo(dataType: string | null | undefined): boolean {
    return TIPOS_LARGOS.has(String(dataType ?? '').toUpperCase())
}

export type UtmsDerivadas = {
    utm_source: string | null
    utm_medium: string | null
    utm_campaign: string | null
    utm_content: string | null
    utm_term: string | null
    utm_id: string | null
    click_id: string | null
    attribution_method: 'click_id' | 'utm_only' | 'none'
}

const SIN_UTMS: UtmsDerivadas = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    utm_id: null,
    click_id: null,
    attribution_method: 'none',
}

/**
 * Deriva las UTMs de un contacto de GHL. Espejo de `synthesizeUtms` de
 * `meta-leads.ts`, pero con cascada porque aquí sí puede haber UTMs reales.
 *
 *   1. UTMs reales (formulario en una landing con querystring) → tal cual.
 *   2. Anuncio identificado (`adId`) → es tráfico de pago aunque `sessionSource`
 *      diga "Social media", y `utm_id` garantiza el cruce exacto con el gasto.
 *   3. Solo canal (orgánico) → `utm_id = null`; el lead cae en `(sin campaña)`
 *      con gasto 0, que es lo correcto y lo que manda `docs/18`.
 *   4. Nada → todo null.
 */
export function deriveUtms(contact: GhlContact): UtmsDerivadas {
    const a = (contact.attributionSource ?? {}) as GhlAtribucion
    const b = (contact.lastAttributionSource ?? {}) as GhlAtribucion
    const g = (k: keyof GhlAtribucion): string | null => pick(a[k] as string, b[k] as string)

    const click_id = pick(g('fbclid'), g('gclid'))
    const metodo: 'click_id' | 'utm_only' = click_id ? 'click_id' : 'utm_only'

    const adId = g('adId')
    const adName = g('adName')
    const adsetName = g('adGroupName')
    const campaignId = g('campaignId')
    const campaignName = pick(g('campaign'), g('campaignName'))
    // El `adId` sirve de respaldo, pero el id de campaña manda: identifica la
    // campaña aunque el anuncio se haya borrado del índice de gasto.
    const idDeCruce = pick(g('utm_id'), campaignId, adId)

    // 1) UTMs reales.
    const utmSource = g('utmSource')
    const utmMedium = g('utmMedium')
    const utmContent = g('utmContent')
    const utmTerm = pick(g('utmTerm'), g('utmKeyword'))
    if (utmSource || utmMedium || utmContent || utmTerm || (campaignName && !adId)) {
        return {
            utm_source: utmSource,
            utm_medium: utmMedium,
            utm_campaign: campaignName,
            utm_content: pick(utmContent, adName),
            utm_term: pick(utmTerm, adsetName),
            utm_id: idDeCruce,
            click_id,
            attribution_method: metodo,
        }
    }

    // 2) Anuncio identificado: es pago, aunque la etiqueta de GHL diga otra cosa.
    if (adId) {
        const canal = pick(g('medium'), g('sessionSource'))
        return {
            utm_source: SOURCE_POR_CANAL[(canal ?? '').toLowerCase()] ?? 'facebook',
            utm_medium: 'paid_social',
            utm_campaign: campaignName,
            utm_content: adName,
            utm_term: adsetName,
            utm_id: idDeCruce,
            click_id,
            attribution_method: metodo,
        }
    }

    // 3) Solo canal: orgánico. `mediumId` NO se usa — no es un id de campaña.
    const medium = g('medium')
    const sesion = g('sessionSource')
    if (medium || sesion) {
        const canal = (medium ?? sesion ?? '').toLowerCase()
        return {
            utm_source: SOURCE_POR_CANAL[canal] ?? slug(medium) ?? slug(sesion),
            utm_medium: MEDIUM_POR_SESION[(sesion ?? '').toLowerCase()] ?? 'social',
            utm_campaign: campaignName,
            utm_content: null,
            utm_term: null,
            utm_id: null,
            click_id,
            attribution_method: click_id ? 'click_id' : 'utm_only',
        }
    }

    // 4) Sin señal alguna.
    return click_id ? { ...SIN_UTMS, click_id, attribution_method: 'click_id' } : { ...SIN_UTMS }
}

/** Valor de un campo personalizado, sea cual sea la forma en que GHL lo devuelva. */
export function valorDeCampo(cf: GhlCustomFieldValue): string {
    const v = cf.value ?? cf.fieldValue ?? cf.fieldValueString
    if (v === null || v === undefined) return ''
    if (Array.isArray(v)) {
        return v
            .filter((x) => x !== null && x !== undefined && String(x).trim() !== '')
            .map((x) => String(x).trim())
            .join(', ')
    }
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v).trim()
}

export type CamposNormalizados = {
    lead_name: string | null
    lead_email: string | null
    lead_phone: string | null
    /** Respuestas ofrecibles como campo de lead, con el NOMBRE del campo por clave. */
    raw_fields: Record<string, string>
    /** Prosa libre (transcripciones, resúmenes): fuera de `raw_fields`. */
    campos_largos: Record<string, string>
    /** Campos cuyo id no está en el catálogo. Se guardan crudos hasta poder resolverlos. */
    custom_fields_by_id: Record<string, string>
}

/**
 * Extrae contacto + respuestas. La clave de `raw_fields` es el **`name`** del
 * campo, no su `fieldKey`: `name` normalizado por `normalizarClaveLead` da la
 * misma clave canónica que ve el analista en la tarjeta de campos de lead,
 * mientras que `fieldKey` pierde acentos de forma inconsistente
 * (`Huéspedes` → `contact.huspedes`).
 *
 * Un id que no se resuelve NUNCA entra en `raw_fields`: meter
 * `7cedTg6j0qCWO0PNzmEg` como pregunta sería basura permanente en el detector.
 */
export function normalizeContactFields(
    contact: GhlContact,
    defs: Map<string, GhlCustomFieldDef>,
): CamposNormalizados {
    const raw_fields: Record<string, string> = {}
    const campos_largos: Record<string, string> = {}
    const custom_fields_by_id: Record<string, string> = {}

    for (const cf of contact.customFields ?? []) {
        if (!cf?.id) continue
        const valor = valorDeCampo(cf)
        if (valor === '') continue
        const def = defs.get(String(cf.id))
        if (!def?.name) {
            custom_fields_by_id[String(cf.id)] = valor
            continue
        }
        if (esCampoLargo(def.dataType)) {
            campos_largos[def.name] = valor
            continue
        }
        raw_fields[def.name] = valor
    }

    const nombreCompuesto = [txt(contact.firstName), txt(contact.lastName)]
        .filter(Boolean)
        .join(' ')
        .trim()

    return {
        lead_name: pick(contact.contactName, nombreCompuesto || null),
        lead_email: txt(contact.email),
        lead_phone: txt(contact.phone),
        raw_fields,
        campos_largos,
        custom_fields_by_id,
    }
}

export type GhlFiltro = {
    /** El contacto debe traer AL MENOS una de estas etiquetas. Vacío = no filtra. */
    tags?: string[]
    /** El contacto queda fuera si trae CUALQUIERA de estas. */
    excluir_tags?: string[]
} | null

function normTag(v: unknown): string {
    return String(v ?? '').trim().toLowerCase()
}

/**
 * ¿Este contacto cuenta como lead? Un lead es un contacto creado, pero una
 * location con chatbot mete miles de contactos que no son captación: el filtro
 * por etiqueta es lo que evita hundir el CPL con ruido.
 */
export function pasaFiltro(contact: GhlContact, filtro: GhlFiltro): boolean {
    if (!filtro) return true
    const incluir = (filtro.tags ?? []).map(normTag).filter(Boolean)
    const excluir = (filtro.excluir_tags ?? []).map(normTag).filter(Boolean)
    if (incluir.length === 0 && excluir.length === 0) return true

    const tags = new Set((contact.tags ?? []).map(normTag).filter(Boolean))
    if (excluir.some((t) => tags.has(t))) return false
    if (incluir.length > 0 && !incluir.some((t) => tags.has(t))) return false
    return true
}

/** Objeto `touch` a partir de una atribución de GHL, con la forma que ya usa la tabla. */
function touchDe(a: GhlAtribucion | null | undefined, ts: string): Record<string, unknown> | null {
    if (!a || typeof a !== 'object' || Object.keys(a).length === 0) return null
    const touch = {
        source: pick(a.utmSource, a.sessionSource),
        medium: pick(a.utmMedium, a.medium),
        campaign: pick(a.campaign, a.campaignName),
        content: pick(a.utmContent, a.adName),
        term: pick(a.utmTerm, a.adGroupName),
        click_id: pick(a.fbclid, a.gclid),
        referrer: txt(a.referrer),
        page_url: txt(a.url),
        ts,
    }
    const tieneSenal = Object.entries(touch).some(([k, v]) => k !== 'ts' && v !== null)
    return tieneSenal ? touch : null
}

/**
 * Construye la fila de `lead_events` para un contacto de GHL, con la atribución
 * resuelta **inline**: estos contactos no tienen historia de píxel, así que no
 * hace falta `resolveAttribution` ni un UPDATE extra por lead.
 */
export function buildLeadRow(
    clienteId: string,
    contact: GhlContact,
    defs: Map<string, GhlCustomFieldDef>,
    formNameFallback?: string | null,
): Record<string, unknown> {
    const utm = deriveUtms(contact)
    const campos = normalizeContactFields(contact, defs)

    // `dateAdded`, nunca `now()`: `bi_leads_por_dia` agrupa en America/Bogota y
    // sellar la fecha de ingesta movería el lead de día.
    const createdAt =
        contact.dateAdded && !Number.isNaN(new Date(contact.dateAdded).getTime())
            ? new Date(contact.dateAdded).toISOString()
            : undefined
    const ts = createdAt ?? new Date().toISOString()

    const touches = dedupTouches(
        touchDe(contact.attributionSource, ts),
        touchDe(contact.lastAttributionSource, ts),
    )

    const row: Record<string, unknown> = {
        cliente_id: clienteId,
        external_id: `${GHL_EXTERNAL_PREFIX}${contact.id}`,
        form_name: pick(contact.source, formNameFallback),
        form_id: null,
        form_plugin: GHL_SOURCE,
        lead_name: campos.lead_name,
        lead_email: campos.lead_email,
        lead_phone: campos.lead_phone,
        utm_source: utm.utm_source,
        utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign,
        utm_content: utm.utm_content,
        utm_term: utm.utm_term,
        utm_id: utm.utm_id,
        click_id: utm.click_id,
        // País ISO-2: alimenta la dimensión "País" de los informes sin trabajo extra.
        ip_country: txt(contact.country),
        raw_fields: campos.raw_fields,
        source: GHL_SOURCE,
        ...touches,
        attribution_method: utm.attribution_method,
        attribution_resolved_at: new Date().toISOString(),
        custom_data: {
            ghl_contact_id: contact.id,
            location_id: txt(contact.locationId),
            tags: contact.tags ?? [],
            opportunities: contact.opportunities ?? [],
            attribution_source: contact.attributionSource ?? null,
            last_attribution_source: contact.lastAttributionSource ?? null,
            custom_fields_by_id: campos.custom_fields_by_id,
            campos_largos: campos.campos_largos,
            date_updated: txt(contact.dateUpdated),
            assigned_to: txt(contact.assignedTo),
            city: txt(contact.city),
            timezone: txt(contact.timezone),
        },
    }
    if (createdAt) row.created_at = createdAt
    return row
}

// ── Persistencia ──────────────────────────────────────────────────────

/** Inserta UN contacto (dedup por external_id). Lo usa el webhook. */
export async function ingestGhlContact(
    db: ReportUtmDb,
    clienteId: string,
    contact: GhlContact,
    defs: Map<string, GhlCustomFieldDef>,
    formNameFallback?: string | null,
): Promise<{ inserted: boolean; error?: string }> {
    const row = buildLeadRow(clienteId, contact, defs, formNameFallback)
    const { error } = await db.from('lead_events').insert(row)
    if (error) {
        // 23505 = unique_violation → el polling ya lo metió. No es un error.
        if ((error as { code?: string }).code === '23505') return { inserted: false }
        return { inserted: false, error: error.message }
    }
    return { inserted: true }
}

/**
 * Inserta un LOTE (usado por el polling), con la misma estrategia que Meta:
 *  1. Construye las filas (atribución inline, sin queries por contacto).
 *  2. Una sola consulta para saber cuáles `external_id` ya existen.
 *  3. Un solo INSERT con los nuevos; si falla (carrera con el webhook), cae a
 *     inserción fila por fila tolerando duplicados.
 */
export async function ingestGhlContactsBatch(
    db: ReportUtmDb,
    clienteId: string,
    contactos: GhlContact[],
    defs: Map<string, GhlCustomFieldDef>,
): Promise<number> {
    if (contactos.length === 0) return 0

    const byId = new Map<string, Record<string, unknown>>()
    for (const c of contactos) {
        if (!c?.id) continue
        byId.set(`${GHL_EXTERNAL_PREFIX}${c.id}`, buildLeadRow(clienteId, c, defs))
    }
    const rows = Array.from(byId.values())
    if (rows.length === 0) return 0

    const ids = Array.from(byId.keys())
    const { data: existing } = await db
        .from('lead_events')
        .select('external_id')
        .eq('cliente_id', clienteId)
        .in('external_id', ids)
    const existentes = new Set((existing ?? []).map((e: { external_id: string }) => e.external_id))
    const aInsertar = rows.filter((r) => !existentes.has(r.external_id as string))
    if (aInsertar.length === 0) return 0

    const { error } = await db.from('lead_events').insert(aInsertar)
    if (!error) return aInsertar.length

    let n = 0
    for (const r of aInsertar) {
        const { error: e } = await db.from('lead_events').insert(r)
        if (!e) n++
        else if ((e as { code?: string }).code !== '23505') {
            console.error('[ghl-leads] batch fallback insert error', e.message)
        }
    }
    return n
}

export type GhlIntegrationRow = {
    id: string
    cliente_id: string
    access_token_encrypted: string | null
    config: Record<string, unknown> | null
}

/** Lee PIT + location de la integración. Devuelve el motivo si falta algo. */
export function credencialesDe(integration: GhlIntegrationRow): {
    cred?: GhlCredenciales
    error?: string
} {
    const config = (integration.config ?? {}) as Record<string, unknown>
    const locationId = txt(config.location_id)
    if (!locationId) return { error: 'La integración no tiene Location ID configurado.' }

    const token = leerSecreto(integration.access_token_encrypted, null).valor
    if (!token) {
        return { error: 'La integración no tiene Private Integration Token (o no se pudo descifrar).' }
    }
    return { cred: { token, locationId } }
}

/** Cache de campos personalizados guardado en `config.custom_fields`. */
type CacheCampos = { fetched_at?: string; items?: GhlCustomFieldDef[] }

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

function mapaDe(items: GhlCustomFieldDef[]): Map<string, GhlCustomFieldDef> {
    return new Map(items.filter((f) => f?.id).map((f) => [String(f.id), f]))
}

/**
 * Resuelve el catálogo de campos personalizados, cacheado en la integración.
 * Se refresca si el cache pasa de 24 h, si está vacío o si `forzar` lo pide
 * (por ejemplo, cuando aparece un id desconocido en un contacto).
 */
export async function resolveCustomFieldMap(
    integration: GhlIntegrationRow,
    cred: GhlCredenciales,
    opts?: { forzar?: boolean },
): Promise<{ defs: Map<string, GhlCustomFieldDef>; items: GhlCustomFieldDef[]; refrescado: boolean }> {
    const config = (integration.config ?? {}) as Record<string, unknown>
    const cache = (config.custom_fields ?? {}) as CacheCampos
    const items = Array.isArray(cache.items) ? cache.items : []
    const edadMs = cache.fetched_at ? Date.now() - new Date(cache.fetched_at).getTime() : Infinity
    const vigente = items.length > 0 && edadMs < CACHE_TTL_MS

    if (vigente && !opts?.forzar) {
        return { defs: mapaDe(items), items, refrescado: false }
    }

    try {
        const frescos = await fetchCustomFields(cred)
        return { defs: mapaDe(frescos), items: frescos, refrescado: true }
    } catch (e) {
        // Sin catálogo NO se cae la ingesta: el contacto entra igual y sus campos
        // quedan en `custom_data.custom_fields_by_id` hasta el próximo refresco.
        console.error('[ghl-leads] no se pudo leer el catálogo de campos', e)
        return { defs: mapaDe(items), items, refrescado: false }
    }
}

/** ¿Algún contacto trae un id de campo que el catálogo cacheado no conoce? */
export function hayCamposDesconocidos(
    contactos: GhlContact[],
    defs: Map<string, GhlCustomFieldDef>,
): boolean {
    for (const c of contactos) {
        for (const cf of c.customFields ?? []) {
            if (cf?.id && !defs.has(String(cf.id))) return true
        }
    }
    return false
}

export type GhlLeadsSyncSummary = {
    imported: number
    scanned: number
    filtered: number
    backfill: boolean
    campos: number
    error?: string
}

/**
 * Sincroniza (vía polling) los contactos de UN cliente y persiste el cursor
 * incremental. Reutilizado por el cron y por el botón "Sincronizar ahora".
 * La dedup por `external_id` evita duplicar lo que el webhook ya insertó.
 */
export async function syncGhlLeadsForCliente(
    supabase: SupabaseClient,
    integration: GhlIntegrationRow,
): Promise<GhlLeadsSyncSummary> {
    const db = supabase.schema('report_utm')
    const clienteId = integration.cliente_id
    const config = (integration.config ?? {}) as Record<string, unknown>
    const isBackfill = config.backfill_done !== true
    const filtro = (config.filtro ?? null) as GhlFiltro

    let imported = 0
    let scanned = 0
    let filtered = 0
    let campos = 0

    const { cred, error: credError } = credencialesDe(integration)
    if (!cred) {
        await db
            .from('integrations')
            .update({ status: 'error', last_error: credError, last_sync_at: new Date().toISOString() })
            .eq('id', integration.id)
        return { imported, scanned, filtered, backfill: isBackfill, campos, error: credError }
    }

    const cursor = txt(config.sync_cursor)
    // Sin cursor (primera corrida) se traen 90 días, el mismo criterio que Meta.
    const desdeIso = cursor ?? new Date(Date.now() - NOVENTA_DIAS_MS).toISOString()

    let maxVisto = cursor
    const startedAt = Date.now()
    // Margen frente al maxDuration de 60s del plan Hobby. El cursor se persiste al
    // cortar, así que el backfill continúa en la siguiente corrida sin perder nada.
    const BUDGET_MS = Number(process.env.GHL_LEADS_BUDGET_MS) || 40_000

    try {
        const catalogo = await resolveCustomFieldMap(integration, cred)
        let defs = catalogo.defs
        let items = catalogo.items
        campos = items.length

        let partial = false
        await searchContactsPaged(cred, desdeIso, async (batch) => {
            scanned += batch.length

            // Un id desconocido significa que alguien creó un campo nuevo en GHL:
            // se refresca el catálogo UNA vez y el lote entra ya resuelto.
            if (hayCamposDesconocidos(batch, defs)) {
                const fresco = await resolveCustomFieldMap(integration, cred, { forzar: true })
                if (fresco.refrescado) {
                    defs = fresco.defs
                    items = fresco.items
                    campos = items.length
                }
            }

            const elegibles = batch.filter((c) => pasaFiltro(c, filtro))
            filtered += batch.length - elegibles.length
            imported += await ingestGhlContactsBatch(db, clienteId, elegibles, defs)

            for (const c of batch) {
                const d = txt(c.dateAdded)
                if (d && (!maxVisto || d > maxVisto)) maxVisto = d
            }

            // Devolver `false` corta la paginación: marcar la bandera sin parar
            // dejaría al backfill pidiendo todas las páginas restantes.
            if (Date.now() - startedAt > BUDGET_MS) {
                partial = true
                return false
            }
            return true
        })

        // El cursor avanza AUNQUE la pasada quede parcial, y aquí sí es seguro:
        // `searchContactsPaged` devuelve un único flujo ordenado por `dateAdded`
        // ascendente, así que todo lo anterior a `maxVisto` ya se ingirió. Meta
        // conserva el cursor previo al cortar porque itera varios formularios en
        // paralelo y su marca de agua no es comparable entre ellos; con un solo
        // flujo, no avanzar significaría que un backfill de decenas de miles de
        // contactos re-escanea siempre las mismas páginas y nunca termina.
        //
        // El filtro es `gte`, así que el contacto del borde se vuelve a pedir en
        // la corrida siguiente y lo descarta la dedup por `external_id`.
        const nextCursor = maxVisto ?? cursor ?? new Date().toISOString()

        await db
            .from('integrations')
            .update({
                status: 'active',
                last_error: partial
                    ? 'Sincronización parcial por límite de tiempo; continúa en la próxima corrida.'
                    : null,
                last_sync_at: new Date().toISOString(),
                config: {
                    ...config,
                    backfill_done: partial ? config.backfill_done === true : true,
                    sync_cursor: nextCursor,
                    last_imported: imported,
                    last_scanned: scanned,
                    last_filtered: filtered,
                    custom_fields: { fetched_at: new Date().toISOString(), items },
                },
            })
            .eq('id', integration.id)

        return { imported, scanned, filtered, backfill: isBackfill, campos }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await db
            .from('integrations')
            .update({
                status: 'error',
                last_error: msg.slice(0, 500),
                last_sync_at: new Date().toISOString(),
            })
            .eq('id', integration.id)
        return { imported, scanned, filtered, backfill: isBackfill, campos, error: msg }
    }
}

/**
 * Camino del webhook: relee el contacto completo con el PIT y lo ingiere.
 * Devuelve por qué NO entró cuando corresponde, para que el log diga algo útil.
 */
export async function ingestGhlContactById(
    supabase: SupabaseClient,
    integration: GhlIntegrationRow,
    contactId: string,
    formNameFallback?: string | null,
): Promise<{ inserted: boolean; motivo?: string }> {
    const { cred, error: credError } = credencialesDe(integration)
    if (!cred) return { inserted: false, motivo: credError }

    const contacto = await fetchContactById(contactId, cred)
    if (!contacto) return { inserted: false, motivo: 'El contacto no existe o el PIT no lo ve.' }

    const config = (integration.config ?? {}) as Record<string, unknown>
    if (!pasaFiltro(contacto, (config.filtro ?? null) as GhlFiltro)) {
        return { inserted: false, motivo: 'El contacto no pasa el filtro de etiquetas.' }
    }

    let { defs } = await resolveCustomFieldMap(integration, cred)
    if (hayCamposDesconocidos([contacto], defs)) {
        defs = (await resolveCustomFieldMap(integration, cred, { forzar: true })).defs
    }

    const db = supabase.schema('report_utm')
    const r = await ingestGhlContact(db, integration.cliente_id, contacto, defs, formNameFallback)
    if (r.error) return { inserted: false, motivo: r.error }
    return { inserted: r.inserted, motivo: r.inserted ? undefined : 'Ya existía (dedup por external_id).' }
}
