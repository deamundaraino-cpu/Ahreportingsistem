import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAttribution } from './attribution-resolver'

/**
 * Núcleo compartido para ingerir leads de **Meta Lead Ads** (formularios
 * instantáneos / "meta forms") en `report_utm.lead_events`.
 *
 * Lo usan dos caminos:
 *   · Polling   → /api/cron/sync-meta-leads        (red de seguridad + backfill)
 *   · Webhook   → /api/report-utm/webhooks/meta     (tiempo real)
 *
 * Los formularios instantáneos NO llevan UTMs reales (no hay navegación a una
 * landing). Por eso sintetizamos las UTMs desde la estructura de campaña, con
 * `utm_id = campaign_id` para que el lead cruce de forma exacta con el gasto en
 * el BI Builder (ver src/lib/report-utm/campaign-data.ts).
 *
 * El token de Meta y las cuentas viven en `public.clientes.config_api`; el
 * puente es `report_utm.clientes.public_cliente_id`.
 */

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION ?? 'v19.0'}`

// Campos que pedimos en el nodo del lead: traen el registro + la estructura de campaña.
const LEAD_FIELDS =
    'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,platform,is_organic,field_data'

export type MetaAccount = { account_id: string; token: string }
export type MetaLeadForm = { id: string; name: string }

export type MetaLeadRecord = {
    id: string
    created_time?: string
    ad_id?: string
    ad_name?: string
    adset_id?: string
    adset_name?: string
    campaign_id?: string
    campaign_name?: string
    form_id?: string
    platform?: string
    is_organic?: boolean
    field_data?: Array<{ name: string; values?: string[] }>
}

type ReportUtmDb = ReturnType<SupabaseClient['schema']>
type GraphRow = Record<string, unknown>
type GraphResponse = { data?: GraphRow[]; paging?: { next?: string }; error?: { message?: string } }

function normalizeActId(rawAccountId: string): string {
    return rawAccountId.startsWith('act_') ? rawAccountId : `act_${rawAccountId}`
}

/**
 * Resuelve las cuentas + tokens de Meta de un cliente del módulo report_utm.
 * Misma lógica multi-cuenta / legacy que el worker (`fetchMeta`).
 */
export async function getMetaAccountsForCliente(
    supabase: SupabaseClient,
    reportClienteId: string,
): Promise<{ accounts: MetaAccount[]; error?: string }> {
    const { data: rc } = await supabase
        .schema('report_utm')
        .from('clientes')
        .select('public_cliente_id')
        .eq('id', reportClienteId)
        .maybeSingle()

    if (!rc?.public_cliente_id) {
        return { accounts: [], error: 'Cliente sin vínculo a un cliente del reporting (public_cliente_id). Conectá Meta primero.' }
    }

    const { data: pc } = await supabase
        .from('clientes')
        .select('config_api')
        .eq('id', rc.public_cliente_id)
        .maybeSingle()

    const config = (pc?.config_api ?? {}) as Record<string, unknown>
    let accounts: MetaAccount[] = []

    const metaAccounts = config.meta_accounts
    if (Array.isArray(metaAccounts) && metaAccounts.length > 0) {
        accounts = (metaAccounts as GraphRow[])
            .filter((a) => a?.account_id)
            .map((a) => ({ account_id: String(a.account_id), token: String(a.token || config.meta_token || '') }))
    } else if (config.meta_token && config.meta_account_id) {
        accounts = [{ account_id: String(config.meta_account_id), token: String(config.meta_token) }]
    }

    accounts = accounts.filter((a) => a.account_id && a.token)
    if (accounts.length === 0) {
        return { accounts: [], error: 'Cliente sin Meta conectado (sin token/cuenta publicitaria).' }
    }
    return { accounts }
}

/** Paginación genérica del Graph API siguiendo `paging.next`. */
async function fetchAllPages(firstUrl: string): Promise<GraphRow[]> {
    const out: GraphRow[] = []
    let next: string | null = firstUrl
    let guard = 0
    while (next && guard < 50) {
        guard++
        const res: Response = await fetch(next)
        const data = (await res.json()) as GraphResponse
        if (data.error) {
            throw new Error(`Graph API: ${data.error.message ?? JSON.stringify(data.error)}`)
        }
        if (Array.isArray(data.data)) out.push(...data.data)
        next = data.paging?.next ?? null
    }
    return out
}

/** Lista TODOS los formularios de leads de una cuenta publicitaria. */
export async function listLeadForms(account: MetaAccount): Promise<MetaLeadForm[]> {
    const actId = normalizeActId(account.account_id)
    const url = new URL(`${GRAPH}/${actId}/leadgen_forms`)
    url.searchParams.append('access_token', account.token)
    url.searchParams.append('fields', 'id,name')
    url.searchParams.append('limit', '200')
    const rows = await fetchAllPages(url.toString())
    return rows
        .filter((f) => f.id)
        .map((f) => ({ id: String(f.id), name: String(f.name ?? f.id) }))
}

/**
 * Trae los leads de un formulario. Si `sinceUnix` se pasa, solo los creados
 * después de ese timestamp (cursor incremental); si no, todos los que Meta
 * conserve (~90 días) para el backfill.
 */
export async function fetchFormLeads(
    formId: string,
    token: string,
    sinceUnix?: number | null,
): Promise<MetaLeadRecord[]> {
    const url = new URL(`${GRAPH}/${formId}/leads`)
    url.searchParams.append('access_token', token)
    url.searchParams.append('fields', LEAD_FIELDS)
    url.searchParams.append('limit', '200')
    if (sinceUnix && sinceUnix > 0) {
        url.searchParams.append(
            'filtering',
            JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }]),
        )
    }
    return (await fetchAllPages(url.toString())) as MetaLeadRecord[]
}

export type MetaPage = { page_id: string; page_token: string; name?: string }

/**
 * Descubre las Páginas de Facebook del cliente (vía el token de usuario de cada
 * cuenta) y las suscribe al campo `leadgen` de la app, para recibir el webhook
 * en tiempo real. Devuelve las páginas con su page token (para leer el lead).
 *
 * Best-effort: si el token no tiene permiso de Páginas, devuelve lista vacía y
 * el error; el polling sigue cubriendo el caso.
 */
export async function discoverAndSubscribePages(
    supabase: SupabaseClient,
    clienteId: string,
): Promise<{ pages: MetaPage[]; error?: string }> {
    const { accounts, error } = await getMetaAccountsForCliente(supabase, clienteId)
    if (error) return { pages: [], error }

    const pagesMap = new Map<string, MetaPage>()
    let lastError: string | undefined
    for (const account of accounts) {
        try {
            const url = new URL(`${GRAPH}/me/accounts`)
            url.searchParams.append('access_token', account.token)
            url.searchParams.append('fields', 'id,name,access_token')
            url.searchParams.append('limit', '200')
            const rows = await fetchAllPages(url.toString())
            for (const p of rows) {
                if (p.id && p.access_token) {
                    pagesMap.set(String(p.id), {
                        page_id: String(p.id),
                        page_token: String(p.access_token),
                        name: p.name ? String(p.name) : undefined,
                    })
                }
            }
        } catch (e) {
            lastError = e instanceof Error ? e.message : String(e)
        }
    }

    const pages = Array.from(pagesMap.values())
    for (const page of pages) {
        try {
            await fetch(`${GRAPH}/${page.page_id}/subscribed_apps`, {
                method: 'POST',
                body: new URLSearchParams({ subscribed_fields: 'leadgen', access_token: page.page_token }),
            })
        } catch { /* no fatal — el polling cubre */ }
    }

    if (pages.length === 0 && lastError) return { pages, error: lastError }
    return { pages }
}

/** Trae un lead puntual por su leadgen_id (usado por el webhook en tiempo real). */
export async function fetchLeadById(leadgenId: string, token: string): Promise<MetaLeadRecord | null> {
    const url = new URL(`${GRAPH}/${leadgenId}`)
    url.searchParams.append('access_token', token)
    url.searchParams.append('fields', LEAD_FIELDS)
    const res = await fetch(url.toString())
    const data = await res.json()
    if (data.error || !data.id) return null
    return data as MetaLeadRecord
}

/**
 * Extrae datos de contacto + todos los campos del registro.
 * `raw_fields` queda como objeto plano {campo: valor} (lo que consume el export CSV).
 */
export function normalizeLeadFields(fieldData: MetaLeadRecord['field_data']): {
    lead_name: string | null
    lead_email: string | null
    lead_phone: string | null
    raw_fields: Record<string, string>
} {
    const raw: Record<string, string> = {}
    const byName: Record<string, string> = {}
    for (const f of fieldData ?? []) {
        if (!f?.name) continue
        const value = Array.isArray(f.values) ? f.values.join(', ') : ''
        raw[f.name] = value
        byName[f.name.toLowerCase()] = value
    }

    const pick = (...keys: string[]): string | null => {
        for (const k of keys) {
            if (byName[k]) return byName[k]
        }
        return null
    }

    let name = pick('full_name', 'name', 'nombre', 'nombre_completo')
    if (!name) {
        const first = pick('first_name', 'nombre')
        const last = pick('last_name', 'apellido', 'apellidos')
        const joined = [first, last].filter(Boolean).join(' ').trim()
        name = joined || null
    }

    return {
        lead_name: name,
        lead_email: pick('email', 'correo', 'correo_electronico', 'e-mail'),
        lead_phone: pick('phone_number', 'phone', 'telefono', 'celular', 'whatsapp_number'),
        raw_fields: raw,
    }
}

const PLATFORM_SOURCE: Record<string, string> = {
    fb: 'facebook',
    facebook: 'facebook',
    ig: 'instagram',
    instagram: 'instagram',
    an: 'audience_network',
    msg: 'messenger',
    messenger: 'messenger',
}

/**
 * Sintetiza UTMs desde la estructura de campaña del lead.
 * `utm_id = campaign_id` → cruza exacto con el gasto en el BI (cascada de campaign-data.ts).
 */
export function synthesizeUtms(lead: MetaLeadRecord) {
    const source = lead.platform ? (PLATFORM_SOURCE[lead.platform.toLowerCase()] ?? lead.platform) : 'facebook'
    return {
        utm_source: source,
        utm_medium: lead.is_organic ? 'social' : 'paid_social',
        utm_campaign: lead.campaign_name ?? null,
        utm_content: lead.ad_name ?? null,
        utm_term: lead.adset_name ?? null,
        utm_id: lead.campaign_id ?? null,
        click_id: null as string | null,
    }
}

/** Timestamp unix (segundos) del lead, a partir de created_time. */
export function leadCreatedUnix(lead: MetaLeadRecord): number | null {
    if (!lead.created_time) return null
    const ms = new Date(lead.created_time).getTime()
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/**
 * Inserta un lead de Meta en `lead_events` (dedup por external_id) y resuelve
 * atribución multi-touch, igual que el endpoint S2S.
 */
export async function ingestMetaLead(
    db: ReportUtmDb,
    clienteId: string,
    lead: MetaLeadRecord,
    formName?: string | null,
): Promise<{ inserted: boolean; error?: string }> {
    const utm = synthesizeUtms(lead)
    const { lead_name, lead_email, lead_phone, raw_fields } = normalizeLeadFields(lead.field_data)

    const createdAt = lead.created_time && !Number.isNaN(new Date(lead.created_time).getTime())
        ? new Date(lead.created_time).toISOString()
        : undefined

    const row: Record<string, unknown> = {
        cliente_id: clienteId,
        external_id: lead.id,
        form_name: formName ?? null,
        form_id: lead.form_id ?? null,
        form_plugin: 'meta_lead_ads',
        lead_name,
        lead_email,
        lead_phone,
        utm_source: utm.utm_source,
        utm_medium: utm.utm_medium,
        utm_campaign: utm.utm_campaign,
        utm_content: utm.utm_content,
        utm_term: utm.utm_term,
        utm_id: utm.utm_id,
        click_id: utm.click_id,
        raw_fields,
        source: 'meta_lead_ads',
    }
    if (createdAt) row.created_at = createdAt

    const { data: insertedLead, error } = await db
        .from('lead_events')
        .insert(row)
        .select('id')
        .single()

    if (error) {
        // 23505 = unique_violation → ya existía (webhook/poll lo metió antes). No es error.
        if ((error as { code?: string }).code === '23505') return { inserted: false }
        return { inserted: false, error: error.message }
    }

    // Resolver atribución multi-touch (mismo patrón que el S2S).
    try {
        const now = new Date().toISOString()
        const attribution = await resolveAttribution(db, {
            id: insertedLead.id,
            cliente_id: clienteId,
            click_id: utm.click_id,
            utm_source: utm.utm_source,
            utm_medium: utm.utm_medium,
            utm_campaign: utm.utm_campaign,
            utm_content: utm.utm_content,
            utm_term: utm.utm_term,
            sale_timestamp: createdAt ?? now,
            received_at: now,
        })

        // Si no hubo historia de pixel, reflejar la señal propia (UTMs sintetizadas).
        let method = attribution.attribution_method
        if (method === 'none' || method === 'utm_only') {
            if (utm.utm_source || utm.utm_campaign) method = 'utm_only'
        }

        await db
            .from('lead_events')
            .update({
                first_touch: attribution.first_touch as unknown as Record<string, unknown>,
                last_touch: attribution.last_touch as unknown as Record<string, unknown>,
                attribution_method: method,
                attribution_resolved_at: now,
                visitor_id: attribution.visitor_id ?? null,
            })
            .eq('id', insertedLead.id)
    } catch (err) {
        console.error('[meta-leads] attribution resolve error', err)
    }

    return { inserted: true }
}

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60

export type MetaLeadsSyncSummary = {
    imported: number
    scanned: number
    forms: number
    backfill: boolean
    error?: string
}

/**
 * Sincroniza (vía polling) los leads de Meta de UN cliente y persiste el cursor
 * incremental en la integración. Reutilizado por el cron y por el botón
 * "Sincronizar ahora" de la UI. La dedup por external_id evita duplicar leads
 * que el webhook ya haya insertado.
 *
 * `integration` es la fila `report_utm.integrations` (tipo='meta_lead_ads').
 */
export async function syncMetaLeadsForCliente(
    supabase: SupabaseClient,
    integration: { id: string; cliente_id: string; config: Record<string, unknown> | null },
): Promise<MetaLeadsSyncSummary> {
    const db = supabase.schema('report_utm')
    const clienteId = integration.cliente_id
    const config = (integration.config ?? {}) as Record<string, unknown>
    const isBackfill = config.backfill_done !== true
    const cursor: number | null = typeof config.sync_cursor === 'number' ? config.sync_cursor : null
    const nowUnix = Math.floor(Date.now() / 1000)
    // Desde el cursor incremental; si no hay (primera corrida/backfill), lo máximo que Meta conserva (~90d).
    const sinceUnix = cursor ?? nowUnix - NINETY_DAYS_SECONDS

    let imported = 0
    let scanned = 0
    let maxSeen = cursor ?? 0
    let formCount = 0

    try {
        const { accounts, error: accError } = await getMetaAccountsForCliente(supabase, clienteId)
        if (accError) {
            await db.from('integrations')
                .update({ status: 'error', last_error: accError, last_sync_at: new Date().toISOString() })
                .eq('id', integration.id)
            return { imported, scanned, forms: 0, backfill: isBackfill, error: accError }
        }

        for (const account of accounts) {
            const forms = await listLeadForms(account)
            formCount += forms.length
            for (const form of forms) {
                const leads = await fetchFormLeads(form.id, account.token, sinceUnix)
                for (const lead of leads) {
                    scanned++
                    const { inserted } = await ingestMetaLead(db, clienteId, lead, form.name)
                    if (inserted) imported++
                    const u = leadCreatedUnix(lead)
                    if (u && u > maxSeen) maxSeen = u
                }
            }
        }

        await db.from('integrations')
            .update({
                status: 'active',
                last_error: null,
                last_sync_at: new Date().toISOString(),
                config: {
                    ...config,
                    backfill_done: true,
                    sync_cursor: maxSeen > 0 ? maxSeen : (cursor ?? nowUnix),
                    last_imported: imported,
                    last_forms_detected: formCount,
                },
            })
            .eq('id', integration.id)

        return { imported, scanned, forms: formCount, backfill: isBackfill }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await db.from('integrations')
            .update({ status: 'error', last_error: msg.slice(0, 500), last_sync_at: new Date().toISOString() })
            .eq('id', integration.id)
        return { imported, scanned, forms: formCount, backfill: isBackfill, error: msg }
    }
}
