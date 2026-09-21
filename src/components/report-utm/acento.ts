/**
 * El acento de las tarjetas de captación y atribución.
 *
 * Cada una eligió su color cuando vivían en un módulo aparte con identidad
 * propia: Meta Lead Ads en sky, CAPI en azul, GoHighLevel y S2S en violeta,
 * Hotmart en esmeralda, Google Ads en amarillo. Ahora conviven en las pestañas
 * de la ficha del cliente, junto a las tarjetas del reporting, y seis acentos
 * distintos en la misma pantalla se leen como seis cosas sin relación.
 *
 * Un solo azul, el de la app. El color deja de significar «de qué módulo es»
 * —ya solo hay uno— y el estado sigue contándolo `IntegrationStatusBadge`, que
 * es quien tiene que hacerlo.
 */
export const ACENTO = {
  /** Etiquetas y píldoras informativas. */
  badge: 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-400',
  /** Fondo del cuadrado del icono de cabecera. */
  iconoFondo: 'bg-blue-50 dark:bg-blue-500/10',
  /** Color del icono de cabecera. */
  iconoColor: 'text-blue-600 dark:text-blue-400',
  /** Botón de acción principal de la tarjeta. */
  boton: 'bg-blue-600 hover:bg-blue-700',
} as const;
