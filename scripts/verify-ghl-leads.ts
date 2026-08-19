/**
 * Comprobaciones del mapeo GoHighLevel → `report_utm.lead_events` (migración 074).
 *
 * Todo lo que decide la fila es puro: no hay Postgres ni red en este archivo.
 * Los fixtures reproducen las tres formas que llegan de verdad desde GHL —lead
 * de anuncio Click-to-WhatsApp, lead orgánico de Instagram y formulario en una
 * landing con UTMs— más los casos que rompen el cruce si nadie los mira.
 *
 *   npx tsx scripts/verify-ghl-leads.ts
 */

import {
    deriveUtms,
    normalizeContactFields,
    buildLeadRow,
    pasaFiltro,
    esCampoLargo,
    valorDeCampo,
    hayCamposDesconocidos,
    GHL_EXTERNAL_PREFIX,
    GHL_SOURCE,
} from '../src/lib/report-utm/ghl-leads'
import type { GhlContact, GhlCustomFieldDef } from '../src/lib/report-utm/ghl-client'
import { normalizarClaveLead, indexarRawFields, bucketDeLead } from '../src/lib/report-utm/lead-campos'
import type { LeadCampoDef } from '../src/lib/report-utm/lead-campos'
import { PLUGIN_LABELS } from '../src/lib/report-utm/leads-display'

let fallos = 0
function check(nombre: string, cond: boolean, detalle?: string) {
    if (cond) {
        console.log(`  ✓ ${nombre}`)
    } else {
        fallos++
        console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`)
    }
}

const CLIENTE = '11111111-1111-1111-1111-111111111111'

// ── Catálogo de campos personalizados de la location ──────────────────
const DEFS_LISTA: GhlCustomFieldDef[] = [
    { id: 'f_huespedes', name: 'Huéspedes', fieldKey: 'contact.huspedes', dataType: 'TEXT' },
    { id: 'f_rango', name: 'Rango de ingresos', fieldKey: 'contact.rango', dataType: 'SINGLE_OPTIONS' },
    { id: 'f_resumen', name: 'Resumen IA', fieldKey: 'contact.resumen_ia', dataType: 'LARGE_TEXT' },
]
const DEFS = new Map(DEFS_LISTA.map((d) => [d.id, d]))

// ── Fixtures ──────────────────────────────────────────────────────────

/** Click-to-WhatsApp desde un anuncio de Meta. GHL lo etiqueta "Paid Social". */
const CTWA: GhlContact = {
    id: 'XTYuz69fWsNx5r9yTHW6',
    locationId: 'sWSeAhElmT7anfpZSqXS',
    contactName: 'Ana Pérez',
    email: 'ana@example.com',
    phone: '+573001234567',
    country: 'CO',
    city: 'Medellín',
    source: 'Anuncio WhatsApp',
    tags: ['lead-web'],
    dateAdded: '2026-08-10T14:32:00.000Z',
    customFields: [
        { id: 'f_huespedes', value: '4' },
        { id: 'f_rango', value: 'Más de $2.000.000' },
        { id: 'f_resumen', value: 'El usuario pregunta por el proceso y pide llamada mañana.' },
        { id: 'id_no_catalogado', value: 'algo' },
    ],
    attributionSource: {
        sessionSource: 'Paid Social',
        medium: 'whatsapp',
        adId: '120239585076400410',
        adName: '🚨 ¿Reportado en centrales?',
        url: 'https://fb.me/abc',
    },
    lastAttributionSource: {
        sessionSource: 'Paid Social',
        medium: 'whatsapp',
        adId: '120239585076400410',
        adName: '🚨 ¿Reportado en centrales?',
        url: 'https://fb.me/abc',
    },
}

/** El mismo tipo de lead, pero GHL lo etiqueta "Social media" aunque trae adId. */
const CTWA_MAL_ETIQUETADO: GhlContact = {
    id: 'contacto-2',
    dateAdded: '2026-08-11T09:00:00.000Z',
    attributionSource: {
        sessionSource: 'Social media',
        medium: 'whatsapp',
        adId: '120249141702310410',
        adName: 'Elimina tus reportes negativos',
    },
}

/** Orgánico de Instagram: `mediumId` es la cuenta, no una campaña. */
const ORGANICO_IG: GhlContact = {
    id: 'contacto-3',
    dateAdded: '2026-08-12T18:05:00.000Z',
    attributionSource: {
        sessionSource: 'Social media',
        medium: 'instagram',
        mediumId: '1061818546315500',
    },
}

/** Formulario en una landing con UTMs de verdad. */
const LANDING: GhlContact = {
    id: 'contacto-4',
    firstName: 'Luis',
    lastName: 'Gómez',
    dateAdded: '2026-08-13T11:00:00.000Z',
    attributionSource: {
        utmSource: 'google',
        utmMedium: 'cpc',
        campaign: 'Marca — Búsqueda',
        campaignId: '2098371',
        utmContent: 'anuncio-1',
        utmTerm: 'reportes negativos',
        gclid: 'CjwKCAjw',
        url: 'https://cliente.com/lp?utm_source=google',
    },
}

/** Contacto sin ninguna señal de atribución. */
const SIN_SENAL: GhlContact = { id: 'contacto-5', dateAdded: '2026-08-14T07:00:00.000Z' }

// ════════════════════════════════════════════════════════════════
console.log('\n── Derivación de UTMs ────────────────────────────────────')

const utmCtwa = deriveUtms(CTWA)
check('un lead de anuncio pone el adId en utm_id (cruza por el paso 3 de la cascada)',
    utmCtwa.utm_id === '120239585076400410')
check('y lo marca como tráfico de pago', utmCtwa.utm_medium === 'paid_social')
check('la fuente de un Click-to-WhatsApp es facebook, no whatsapp',
    utmCtwa.utm_source === 'facebook')
check('el nombre del anuncio va a utm_content', utmCtwa.utm_content === '🚨 ¿Reportado en centrales?')
check('sin click_id la atribución es utm_only', utmCtwa.attribution_method === 'utm_only')

const utmMal = deriveUtms(CTWA_MAL_ETIQUETADO)
check('un adId manda sobre la etiqueta "Social media" de GHL',
    utmMal.utm_medium === 'paid_social', `dio ${utmMal.utm_medium}`)
check('y ese lead también cruza por utm_id', utmMal.utm_id === '120249141702310410')

const utmOrg = deriveUtms(ORGANICO_IG)
check('un lead orgánico se queda sin utm_id (cae en «(sin campaña)» con gasto 0)',
    utmOrg.utm_id === null)
check('el orgánico conserva su canal como fuente', utmOrg.utm_source === 'instagram')
check('y su medio es social', utmOrg.utm_medium === 'social')

// La regla que más fácil se rompe: mediumId parece un id bueno y no cruza con nada.
const camposUtmOrg = Object.entries(utmOrg).filter(([k]) => k.startsWith('utm_') || k === 'click_id')
check('mediumId NO aparece en ningún campo utm_* ni en click_id',
    camposUtmOrg.every(([, v]) => v !== '1061818546315500'),
    JSON.stringify(utmOrg))

const utmLanding = deriveUtms(LANDING)
check('unas UTMs reales se respetan tal cual', utmLanding.utm_source === 'google' && utmLanding.utm_medium === 'cpc')
check('el nombre de campaña real llega a utm_campaign', utmLanding.utm_campaign === 'Marca — Búsqueda')
check('el id de campaña manda sobre el del anuncio en utm_id', utmLanding.utm_id === '2098371')
check('un gclid convierte la atribución en click_id', utmLanding.attribution_method === 'click_id')
check('y el gclid queda en click_id', utmLanding.click_id === 'CjwKCAjw')

const utmVacio = deriveUtms(SIN_SENAL)
check('sin ninguna señal, todos los utm quedan en null',
    [utmVacio.utm_source, utmVacio.utm_medium, utmVacio.utm_campaign, utmVacio.utm_id].every((v) => v === null))
check('y el método es none', utmVacio.attribution_method === 'none')

// ════════════════════════════════════════════════════════════════
console.log('\n── Campos personalizados ─────────────────────────────────')

const campos = normalizeContactFields(CTWA, DEFS)
check('un campo normal entra en raw_fields con el NOMBRE del campo',
    campos.raw_fields['Huéspedes'] === '4')
check('y conserva el acento (fieldKey lo pierde: contact.huspedes)',
    Object.keys(campos.raw_fields).includes('Huéspedes'))
check('un campo de texto largo NO entra en raw_fields',
    campos.raw_fields['Resumen IA'] === undefined)
check('pero se conserva en campos_largos', typeof campos.campos_largos['Resumen IA'] === 'string')
check('un id que el catálogo no conoce no ensucia raw_fields',
    !Object.keys(campos.raw_fields).includes('id_no_catalogado'))
check('y queda guardado por id para poder resolverlo después',
    campos.custom_fields_by_id['id_no_catalogado'] === 'algo')

check('esCampoLargo reconoce LARGE_TEXT y TEXTAREA',
    esCampoLargo('LARGE_TEXT') && esCampoLargo('textarea'))
check('y no se dispara con un campo normal', !esCampoLargo('SINGLE_OPTIONS'))

check('un valor de opción múltiple se une con comas',
    valorDeCampo({ id: 'x', value: ['A', 'B'] }) === 'A, B')
check('un valor vacío no cuenta como respuesta', valorDeCampo({ id: 'x', value: '   ' }) === '')
check('se acepta la forma alternativa fieldValue',
    valorDeCampo({ id: 'x', fieldValue: 7 }) === '7')

check('se detecta que hay un id fuera del catálogo (dispara el refresco)',
    hayCamposDesconocidos([CTWA], DEFS))
check('y no se dispara cuando están todos', !hayCamposDesconocidos([ORGANICO_IG], DEFS))

// El contacto y el nombre.
check('el nombre compuesto se arma si no viene contactName',
    normalizeContactFields(LANDING, DEFS).lead_name === 'Luis Gómez')
check('y se prefiere contactName cuando existe', campos.lead_name === 'Ana Pérez')

// ════════════════════════════════════════════════════════════════
console.log('\n── La promesa de los campos de lead ──────────────────────')

// Lo que hace útil la integración: un campo del catálogo unifica la respuesta de
// GHL con la del formulario web / Meta, aunque la clave venga con acentos.
const campoRango: LeadCampoDef = {
    id: 'campo-1',
    cliente_id: CLIENTE,
    clave: 'rango_de_ingresos',
    nombre: 'Rango de ingresos',
    descripcion: null,
    claves_origen: [normalizarClaveLead('Rango de ingresos')],
    valores_map: {},
    valores_orden: [],
    sin_mapear: 'crudo',
    max_valores: 200,
    activo: true,
    orden: 0,
}
const idx = indexarRawFields(campos.raw_fields)
check('un campo de lead encuentra la respuesta que vino de GHL',
    bucketDeLead(campoRango, idx) !== null,
    JSON.stringify(Array.from(idx.keys())))

const campoHuespedes: LeadCampoDef = {
    ...campoRango,
    clave: 'huespedes',
    claves_origen: [normalizarClaveLead('Huespedes')],
}
check('y la encuentra aunque el catálogo se escribiera sin acento',
    bucketDeLead(campoHuespedes, idx) === '4')

// ════════════════════════════════════════════════════════════════
console.log('\n── Filtro: qué contacto cuenta como lead ─────────────────')

check('sin filtro entra todo', pasaFiltro(CTWA, null))
check('un filtro vacío tampoco descarta nada', pasaFiltro(CTWA, { tags: [], excluir_tags: [] }))
check('con lista de inclusión, entra el que trae la etiqueta',
    pasaFiltro(CTWA, { tags: ['lead-web'] }))
check('y queda fuera el que no la trae', !pasaFiltro(ORGANICO_IG, { tags: ['lead-web'] }))
check('la comparación ignora mayúsculas y espacios',
    pasaFiltro(CTWA, { tags: ['  LEAD-WEB '] }))
check('la exclusión gana sobre la inclusión',
    !pasaFiltro(CTWA, { tags: ['lead-web'], excluir_tags: ['lead-web'] }))
check('un contacto sin etiquetas pasa si solo hay exclusiones',
    pasaFiltro(ORGANICO_IG, { excluir_tags: ['gestionado_por_chatbot'] }))

// ════════════════════════════════════════════════════════════════
console.log('\n── La fila de lead_events ────────────────────────────────')

const fila = buildLeadRow(CLIENTE, CTWA, DEFS)

check('external_id lleva el prefijo que evita chocar con Meta',
    fila.external_id === `${GHL_EXTERNAL_PREFIX}XTYuz69fWsNx5r9yTHW6`)
check('source y form_plugin identifican la fuente',
    fila.source === GHL_SOURCE && fila.form_plugin === GHL_SOURCE)
check('el plugin tiene etiqueta legible en la UI',
    typeof PLUGIN_LABELS[GHL_SOURCE] === 'string')
check('created_at es dateAdded, no la fecha de ingesta',
    fila.created_at === '2026-08-10T14:32:00.000Z')
check('el país ISO-2 alimenta la dimensión País', fila.ip_country === 'CO')
check('los datos de contacto se mapean',
    fila.lead_email === 'ana@example.com' && fila.lead_phone === '+573001234567')
check('form_name usa el origen que declara GHL', fila.form_name === 'Anuncio WhatsApp')
check('no se inventan datos de navegación',
    fila.visitor_id === undefined && fila.page_url === undefined)

const custom = fila.custom_data as Record<string, unknown>
check('custom_data guarda el id del contacto para poder volver a GHL',
    custom.ghl_contact_id === 'XTYuz69fWsNx5r9yTHW6')
check('y la atribución cruda, por si hay que auditar el cruce',
    custom.attribution_source !== null)
check('el texto largo vive en custom_data, no en raw_fields',
    typeof (custom.campos_largos as Record<string, string>)['Resumen IA'] === 'string')

check('los dos touches idénticos no se duplican (last_touch queda en null)',
    fila.first_touch !== null && fila.last_touch === null)

const filaSinFecha = buildLeadRow(CLIENTE, { id: 'x' }, DEFS)
check('sin dateAdded no se fuerza created_at (lo pone el DEFAULT de la tabla)',
    filaSinFecha.created_at === undefined)
check('un contacto sin atribución no inventa touches',
    filaSinFecha.first_touch === null && filaSinFecha.last_touch === null)

const filaOrganica = buildLeadRow(CLIENTE, ORGANICO_IG, DEFS)
check('la fila orgánica tampoco lleva el mediumId en utm_id',
    filaOrganica.utm_id === null)

// ════════════════════════════════════════════════════════════════
console.log(
    fallos === 0
        ? '\n✅ Leads de GoHighLevel: todas las comprobaciones pasan\n'
        : `\n❌ ${fallos} comprobación(es) fallaron\n`,
)
process.exit(fallos === 0 ? 0 : 1)
