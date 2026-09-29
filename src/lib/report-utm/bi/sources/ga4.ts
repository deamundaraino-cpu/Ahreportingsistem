// Fuente `ga4` — `public.ga4_sesiones_diarias` (migración 097).
//
// ── Qué desbloquea ──────────────────────────────────────────────
// El GA4 de `cuenta` son tres totales por día del sitio entero: solo cruzan por
// fecha. Aquí cada fila es día × tupla UTM de la sesión (fuente, medio, campaña,
// utm_id), así que GA4 se reparte POR CAMPAÑA con el mismo resolver que los
// leads: `utm_id` = id de campaña de Meta cruza exacto. Eso da el coste por
// sesión de cada campaña, la tasa sesión → lead y los eventos clave frente a los
// leads que registró la plataforma.
//
// ── Ejes ────────────────────────────────────────────────────────
// `campaign` y `utm`, sin `adset` ni `ad`: GA4 no guarda `utm_content` ni
// `utm_term` por sesión en lo que se descarga. Tampoco `platform` ni
// `lead_column`: una sesión no tiene formulario ni país de lead.
//
// ── Por qué NO sustituye a `cuenta.ga_*` ───────────────────────
// Por umbrales de privacidad y la fila «(other)», la suma por campaña no tiene
// por qué coincidir con el total de la propiedad. Son dos conceptos: «GA4 del
// sitio» (cuenta) y «GA4 por campaña» (esta). Informes ya entregados siguen
// leyendo `ga_sessions` como siempre.

import type { DataSource } from '../registry-types';
import { measure, derived, money } from '../field-builders';

const S = 'ga4';

export const GA4_SOURCE: DataSource = {
  id: S,
  label: 'Google Analytics 4 (por campaña)',
  location: { kind: 'table', schema: 'public', table: 'ga4_sesiones_diarias' },
  clientKey: { scope: 'public', via: 'public_cliente_id' },
  grainKind: 'daily',
  grain: ['cliente_id', 'fecha', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_id'],
  // `landing` (migración 100): las métricas de sesión salen de
  // `ga4_landing_diarios` cuando se agrupa o filtra por página de entrada.
  joinAxes: ['date', 'campaign', 'utm', 'landing'],
  dateColumn: 'fecha',
  dateType: 'date',
  fields: [
    // ── Medidas físicas ──────────────────────────────────────────────
    measure(
      S,
      'sesiones',
      'Sesiones GA4 (por campaña)',
      'Visitas al sitio medidas por Google Analytics, repartidas por la campaña, fuente y medio con los que llegó cada visita. Las visitas directas u orgánicas quedan en «(sin campaña)». Puede no coincidir con el total del sitio por los umbrales de privacidad de GA4.',
      'ga4'
    ),
    measure(
      S,
      'sesiones_interaccion',
      'Sesiones con interacción (GA4)',
      'Visitas que duraron más de 10 segundos, vieron dos o más páginas o dispararon un evento clave. Es la base de la tasa de rebote de GA4.',
      'ga4'
    ),
    measure(
      S,
      'eventos_clave',
      'Eventos clave (GA4)',
      'Conversiones que el sitio registra en Google Analytics (compras, formularios enviados…), todas sumadas. Para una en concreto usa su métrica «Evento clave: …».',
      'ga4'
    ),
    measure(
      S,
      'visitantes',
      'Visitantes (GA4, suma diaria)',
      'Personas distintas que visitaron el sitio cada día, sumadas: quien vuelve otro día cuenta dos veces, así que en un periodo largo es mayor que las personas únicas. No se suma en el Total de una tabla.',
      'ga4',
      { dedup: true }
    ),
    money(
      S,
      'ingresos',
      'Ingresos (GA4)',
      'Ingresos que registra Google Analytics (compras con valor). Se convierten a la moneda del cliente si la propiedad usa otra.',
      'ga4'
    ),

    // ── Derivadas ────────────────────────────────────────────────────
    derived(
      S,
      'tasa_interaccion',
      'Tasa de interacción (GA4)',
      'Qué porcentaje de las visitas interactuó con el sitio (sesiones con interacción ÷ sesiones).',
      'ga4',
      'ga4.sesiones_interaccion / ga4.sesiones',
      { format: 'percent', nullUnless: ['ga4.sesiones'] }
    ),
    derived(
      S,
      'tasa_rebote',
      'Tasa de rebote (GA4, por campaña)',
      'Qué porcentaje de las visitas se fue sin interactuar (1 − tasa de interacción). Cuanto MÁS BAJO, mejor.',
      'ga4',
      '(ga4.sesiones - ga4.sesiones_interaccion) / ga4.sesiones',
      { format: 'percent', nullUnless: ['ga4.sesiones'], direction: 'down' }
    ),
    derived(
      S,
      'tasa_evento_clave',
      'Tasa de eventos clave (GA4)',
      'Eventos clave por cada 100 visitas (eventos clave ÷ sesiones).',
      'ga4',
      'ga4.eventos_clave / ga4.sesiones',
      { format: 'percent', nullUnless: ['ga4.sesiones'] }
    ),
    derived(
      S,
      'coste_sesion',
      'Coste por sesión (GA4)',
      'Cuánto costó cada visita que trajo la campaña (gasto ÷ sesiones de GA4). Cuanto MÁS BAJO, mejor.',
      'ga4',
      'ads.spend / ga4.sesiones',
      { format: 'currency', nullUnless: ['ads.spend', 'ga4.sesiones'], direction: 'down' }
    ),
    derived(
      S,
      'coste_evento_clave',
      'Coste por evento clave (GA4)',
      'Cuánto costó cada evento clave registrado por GA4 (gasto ÷ eventos clave). Cuanto MÁS BAJO, mejor.',
      'ga4',
      'ads.spend / ga4.eventos_clave',
      { format: 'currency', nullUnless: ['ads.spend', 'ga4.eventos_clave'], direction: 'down' }
    ),
    derived(
      S,
      'tasa_sesion_lead',
      'Conversión sesión → lead',
      'Qué porcentaje de las visitas terminó en un lead registrado (leads ÷ sesiones de GA4). Compara volúmenes del mismo período, no sigue a cada persona.',
      'ga4',
      'leads.count / ga4.sesiones',
      { format: 'percent', nullUnless: ['ga4.sesiones'] }
    ),
    derived(
      S,
      'roas',
      'ROAS (GA4)',
      'Ingresos que registra GA4 por cada unidad invertida (ingresos GA4 ÷ gasto).',
      'ga4',
      'ga4.ingresos / ads.spend',
      { format: 'ratio', nullUnless: ['ads.spend', 'ga4.ingresos'] }
    ),
  ],
};
