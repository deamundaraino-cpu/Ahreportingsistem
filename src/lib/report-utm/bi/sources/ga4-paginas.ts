// Fuente `ga4_paginas` — `public.ga4_vistas_diarias` (migración 100).
//
// Vistas de página de todo el sitio (`screenPageViews` × `pagePath`), como el
// informe «Páginas» de GA4. Es contenido, no captación: una persona que ve cinco
// páginas suma cinco vistas. Para embudos (sesiones → leads por landing) está la
// página de ENTRADA de la fuente `ga4`.
//
// Ejes `date` y `pagina`: nada más cruza con una vista de página. La página es
// su propia dimensión (`ga4_pagina`) y no la de entrada de los leads, porque
// «vistas de /precios» y «leads que entraron por /precios» son cosas distintas.

import type { DataSource } from '../registry-types';
import { measure, dimension } from '../field-builders';

const S = 'ga4_paginas';

export const GA4_PAGINAS_SOURCE: DataSource = {
  id: S,
  label: 'Google Analytics 4 (por página)',
  location: { kind: 'table', schema: 'public', table: 'ga4_vistas_diarias' },
  clientKey: { scope: 'public', via: 'public_cliente_id' },
  grainKind: 'daily',
  grain: ['cliente_id', 'fecha', 'host', 'pagina'],
  joinAxes: ['date', 'pagina'],
  dateColumn: 'fecha',
  dateType: 'date',
  fields: [
    measure(
      S,
      'vistas',
      'Vistas de página (GA4)',
      'Veces que se cargó cada página del sitio (como el informe «Páginas» de GA4). Una persona que ve cinco páginas suma cinco vistas; por página vista, no por campaña.',
      'ga4'
    ),
    dimension(S, 'pagina', 'Página (GA4)', 'pagina', 'ga4'),
  ],
};
