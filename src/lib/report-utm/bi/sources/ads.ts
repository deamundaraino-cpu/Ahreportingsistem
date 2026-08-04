// Fuente `ads` — publicidad (Meta + TikTok).
//
// Hoy se lee de los 6 JSONB de `public.metricas_diarias`
// (meta_campaigns/meta_ads/meta_adsets, tiktok_campaigns/tiktok_ads/
// tiktok_adgroups) más las columnas escalares meta_spend/tiktok_spend. La
// migración 063 la mueve a `public.ads_daily`, que es la misma fuente con otro
// almacenamiento: el registro no cambia, solo el lector.
//
// `joinAxes` NO incluye `lead_column` ni `lead_raw`: `metricas_diarias` no tiene
// columnas UTM, así que el gasto no se puede repartir por país, formulario ni
// respuesta de formulario. Eso es lo que hace que estas métricas caigan en la
// fila "(total)" al agrupar por esas dimensiones — y ahora está declarado en un
// sitio en vez de repetido a mano en `breakdown: 'campaign'` 40 veces.

import type { DataSource } from '../registry-types'
import { measure, derived, dimension, pixelEvent, money } from '../field-builders'

const S = 'ads'

export const ADS_SOURCE: DataSource = {
    id: S,
    label: 'Anuncios (Meta / TikTok)',
    location: { kind: 'jsonb', schema: 'public', table: 'metricas_diarias', column: 'meta_campaigns' },
    clientKey: { scope: 'public', via: 'public_cliente_id' },
    grainKind: 'daily',
    grain: ['cliente_id', 'fecha', 'plataforma', 'nivel', 'entidad'],
    joinAxes: ['date', 'platform', 'campaign', 'adset', 'ad'],
    dateColumn: 'fecha',
    dateType: 'date',
    fields: [
        // ── Dimensiones de entidad ───────────────────────────────────────
        // OJO con la separación entre `joinAxes` y `fields`:
        //
        //  · `joinAxes` (arriba) declara los ejes por los que esta fuente PUEDE
        //    emitir una clave. Incluye `campaign` y `platform`.
        //  · `fields` declara lo que el usuario puede ELEGIR en el selector.
        //
        // «Campaña» y «Plataforma» NO se declaran aquí aunque el gasto cruce por
        // ellas, porque ya existen una sola vez —`leads.campaign` y
        // `sales.platform`— y son la MISMA dimensión: el motor tiene un único
        // `utm_campaign` que resuelve el cruce con la cascada de 7 pasos de
        // `campaign-resolver.ts`. Declararlas dos veces las duplicaría en el
        // selector y, peor, se guardarían con un id que el motor no reconoce.
        //
        // `ad` y `adset` sí viven aquí: son los únicos ejes que no existen como
        // columna en `lead_events`, y sus ids históricos (`ad`, `adset`) apuntan
        // justamente a esta fuente.
        dimension(S, 'adset', 'Conjunto de anuncios', 'adset', 'rendimiento', { resolve: 'entity' }),
        dimension(S, 'ad', 'Anuncio', 'ad', 'rendimiento', { resolve: 'entity' }),

        // ── Inversión ────────────────────────────────────────────────────
        money(S, 'spend', 'Gasto total', 'Dinero invertido en publicidad (Meta + TikTok) durante el período.', 'inversion',
            { recommended: true, direction: 'down', goal: 'budget' }),
        money(S, 'spend_meta', 'Gasto Meta', 'Dinero invertido en anuncios de Meta (Facebook e Instagram).', 'inversion',
            { column: 'meta_spend', direction: 'down' }),
        money(S, 'spend_tiktok', 'Gasto TikTok', 'Dinero invertido en anuncios de TikTok.', 'inversion',
            { column: 'tiktok_spend', direction: 'down' }),

        // ── Rendimiento ──────────────────────────────────────────────────
        measure(S, 'clicks', 'Clics', 'Veces que alguien hizo clic en un anuncio.', 'rendimiento',
            { recommended: true, funnelStage: 30 }),
        measure(S, 'impressions', 'Impresiones', 'Veces que se mostró un anuncio (una misma persona puede verlo varias veces).', 'rendimiento',
            { recommended: true, funnelStage: 10 }),
        // `reach` cuenta personas ÚNICAS: sumar el alcance de varias campañas
        // cuenta dos veces a quien vio ambas. De ahí `dedup`, que es lo que lo
        // saca de la fila de totales.
        measure(S, 'reach', 'Alcance', 'Personas distintas que vieron los anuncios.', 'rendimiento',
            { dedup: true, funnelStage: 20 }),
        measure(S, 'link_clicks', 'Clics de enlace', 'Clics que llevaron a la página de destino.', 'rendimiento',
            { funnelStage: 40 }),

        // Ratios de rendimiento. Antes eran líneas `if (metrics.includes(...))`
        // dentro de `mergeResults` Y otra vez en el bloque `baseValues`, con
        // nulos distintos en cada sitio.
        derived(S, 'ctr', 'CTR', 'Porcentaje de personas que hicieron clic tras ver el anuncio. Mide qué tan atractivo es el anuncio.', 'rendimiento',
            'ads.clicks / ads.impressions', { format: 'percent', nullUnless: ['ads.impressions'], recommended: true }),
        derived(S, 'cpc', 'CPC', 'Costo por clic: cuánto se paga, en promedio, por cada clic.', 'rendimiento',
            'ads.spend / ads.clicks', { format: 'currency', nullUnless: ['ads.clicks'], recommended: true, direction: 'down' }),
        derived(S, 'cpm', 'CPM', 'Costo por cada mil impresiones del anuncio.', 'rendimiento',
            'ads.spend / ads.impressions * 1000', { format: 'currency', nullUnless: ['ads.impressions'], recommended: true, direction: 'down' }),
        derived(S, 'frequency', 'Frecuencia', 'Cuántas veces vio el anuncio, en promedio, cada persona. Si sube mucho, el público se está saturando.', 'rendimiento',
            'ads.impressions / ads.reach', { format: 'ratio', nullUnless: ['ads.reach'], direction: 'down' }),

        // ── Eventos de campaña (JSONB) ───────────────────────────────────
        // `leads_form` mide LO MISMO que `leads.count` desde otro sistema: los
        // mismos contactos pueden estar en ambas, así que no son sumables.
        // `conflictsWith` lo hace legible por máquina en vez de dejarlo solo en
        // la prosa de la etiqueta.
        pixelEvent(S, 'leads_form', 'Leads del píxel de Meta',
            'Leads que reporta el píxel de Meta desde sus propios formularios. Puede no coincidir con “Leads (contactos)”: mide otra cosa, en otro sistema, y los mismos contactos pueden estar en ambas. No las sumes.',
            { conflictsWith: ['leads.count', 'offline.leads'], funnelStage: 70 }),
        pixelEvent(S, 'purchases', 'Compras',
            'Compras que registra el píxel de Meta. Es la lectura de Meta, no la de la pasarela de pago.',
            { conflictsWith: ['sales.count'], funnelStage: 90 }),
        pixelEvent(S, 'landing_page_views', 'Vistas de landing',
            'Veces que la página de destino se cargó por completo tras un clic.', { funnelStage: 50 }),
        pixelEvent(S, 'complete_registration', 'Registros',
            'Registros completados que reporta el píxel de Meta.', { funnelStage: 75 }),
        pixelEvent(S, 'results', 'Resultados',
            'Resultados según el objetivo de cada campaña (suma de leads, compras e inicios de pago).'),
        pixelEvent(S, 'video_views', 'Reproducciones',
            'Reproducciones de video de los anuncios.', { funnelStage: 55 }),
        pixelEvent(S, 'video_thruplay', 'ThruPlay',
            'Reproducciones que llegaron a 15 segundos o al final del video. Mide interés real, no un scroll.', { funnelStage: 57 }),
        pixelEvent(S, 'messaging_conversations', 'Conversaciones',
            'Conversaciones iniciadas por mensaje (WhatsApp, Messenger, Instagram) desde los anuncios.'),
        pixelEvent(S, 'post_engagement', 'Interacciones',
            'Interacciones totales con los anuncios: reacciones, comentarios, compartidos y clics.'),
        pixelEvent(S, 'post_reactions', 'Reacciones', 'Reacciones (me gusta y similares) en los anuncios.'),
        pixelEvent(S, 'post_shares', 'Compartidos', 'Veces que alguien compartió un anuncio.'),
        pixelEvent(S, 'post_comments', 'Comentarios', 'Comentarios recibidos en los anuncios.'),
        pixelEvent(S, 'adds_to_cart', 'Añadir al carrito',
            'Veces que alguien añadió un producto al carrito, según el píxel.', { funnelStage: 80 }),
        // "(Meta)" en la etiqueta: `cuenta.hotmart_pagos_iniciados` se llamaba
        // igual y eran dos métricas de fuentes distintas indistinguibles.
        pixelEvent(S, 'initiates_checkout', 'Iniciar pago (Meta)',
            'Veces que alguien empezó un pago en la web, según el píxel de Meta.', { funnelStage: 85 }),
        // 78 y no 60: en el embudo del catálogo actual «Ver contenido» va DESPUÉS
        // de los registros y antes del carrito. Se conserva ese orden en vez de
        // reordenarlo por intuición — reordenar el embudo es una decisión de
        // producto, no un efecto colateral del refactor.
        pixelEvent(S, 'view_content', 'Ver contenido',
            'Veces que alguien vio una página de producto o contenido clave, según el píxel.', { funnelStage: 78 }),
        pixelEvent(S, 'search', 'Búsquedas', 'Búsquedas hechas en el sitio, según el píxel.'),
        pixelEvent(S, 'add_to_wishlist', 'Añadir a lista deseos', 'Veces que alguien guardó un producto en su lista de deseos.'),
        pixelEvent(S, 'contact', 'Contactos',
            'Veces que alguien inició un contacto (chat, llamada, formulario), según el píxel.'),
        pixelEvent(S, 'schedule', 'Agendamientos', 'Citas o reservas agendadas, según el píxel.'),
        pixelEvent(S, 'subscribe', 'Suscripciones (píxel)', 'Suscripciones registradas por el píxel de Meta.'),
        pixelEvent(S, 'start_trial', 'Inicio de prueba', 'Veces que alguien empezó un período de prueba.'),
        pixelEvent(S, 'submit_application', 'Solicitudes', 'Solicitudes enviadas, según el píxel.'),
        pixelEvent(S, 'page_engagement', 'Interacción con página', 'Interacciones con la página, según el píxel.'),
        pixelEvent(S, 'post_saves', 'Guardados', 'Veces que alguien guardó una publicación.'),
        pixelEvent(S, 'video_3s', 'Video 3s', 'Reproducciones de al menos 3 segundos.'),
        // Única métrica de conversión propia de TikTok. Es columna escalar en
        // `metricas_diarias` pero se desglosa por campaña desde `tiktok_campaigns`.
        pixelEvent(S, 'conversions_tiktok', 'Conversiones TikTok',
            'Conversiones que reporta TikTok para sus anuncios.', { column: 'tiktok_conversions' }),
    ],
}
