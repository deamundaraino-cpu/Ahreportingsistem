'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';
import type { ComponentProps } from 'react';
import type { ConversionesOfflineCard as Card } from './ConversionesOfflineCard';

/**
 * Envoltorio cliente de `ConversionesOfflineCard`.
 *
 * La tarjeta trae recharts (~375 KB). `next/dynamic` con `ssr: false` es la
 * forma de mantenerlo fuera de la entrada de la ruta, pero esa opción no se
 * puede usar desde un Server Component — y `dashboard/[clientId]/page.tsx` lo
 * es. De ahí este componente intermedio: es la frontera de cliente donde
 * `ssr: false` sí es válido.
 *
 * Renderizar la tarjeta en servidor no aportaba nada: recharts mide el
 * contenedor para dibujar, así que en SSR sale vacía igualmente.
 */
const ConversionesOfflineCardInner = dynamic(
  () => import('./ConversionesOfflineCard').then((m) => ({ default: m.ConversionesOfflineCard })),
  { ssr: false, loading: () => <Skeleton className="h-72 rounded-xl" /> }
);

export function ConversionesOfflineCardLazy(props: ComponentProps<typeof Card>) {
  return <ConversionesOfflineCardInner {...props} />;
}
