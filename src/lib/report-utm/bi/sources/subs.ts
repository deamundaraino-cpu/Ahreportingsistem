// Fuente `subs` — último snapshot de `public.hotmart_subscriptions_snapshot`.
//
// Es una FOTO, no una serie: `grainKind: 'snapshot'` y `joinAxes: []`. Con
// cualquier dimensión —incluida Fecha— no hay nada que repartir, y por eso solo
// tiene sentido en el total del período. Antes esto se escribía a mano como
// `breakdown: 'global'` en las cinco métricas; ahora se deriva de no tener ejes.

import type { DataSource } from '../registry-types';
import { measure, money } from '../field-builders';

const S = 'subs';

export const SUBS_SOURCE: DataSource = {
  id: S,
  label: 'Suscripciones (foto actual)',
  location: { kind: 'table', schema: 'public', table: 'hotmart_subscriptions_snapshot' },
  clientKey: { scope: 'public', via: 'public_cliente_id' },
  grainKind: 'snapshot',
  grain: ['cliente_id', 'captured_date'],
  joinAxes: [],
  // Sin `dateColumn`: el rango del informe NO recorta un snapshot, solo decide
  // cuál es la última foto disponible (`captured_date <= date_to`).
  fields: [
    measure(
      S,
      'active',
      'Suscripciones activas',
      'Suscripciones activas en la última foto disponible. Es un estado del momento, no algo que ocurriera durante el período: no cambia si mueves las fechas ni se puede repartir por campaña o por día.',
      'subs',
      { agg: 'last' }
    ),
    measure(
      S,
      'delayed',
      'Suscripciones atrasadas',
      'Suscripciones con el pago atrasado en la última foto disponible.',
      'subs',
      { agg: 'last' }
    ),
    measure(
      S,
      'canceled',
      'Suscripciones canceladas',
      'Suscripciones canceladas en la última foto disponible.',
      'subs',
      { agg: 'last' }
    ),
    measure(
      S,
      'total',
      'Suscripciones (total)',
      'Total de suscripciones registradas en la última foto disponible.',
      'subs',
      { agg: 'last' }
    ),
    money(
      S,
      'mrr',
      'MRR (valor recurrente)',
      'Dinero recurrente que generan las suscripciones activas, en la última foto disponible.',
      'subs',
      { agg: 'last' }
    ),
  ],
};
