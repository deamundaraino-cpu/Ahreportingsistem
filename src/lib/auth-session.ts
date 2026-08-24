import 'server-only';
import { cache } from 'react';
import { createClient } from '@/utils/supabase/server';

export interface SesionActual {
  userId: string | null;
  email: string | null;
  role: string;
}

/**
 * Usuario y rol de la petición actual, resueltos una sola vez.
 *
 * `auth.getUser()` aparecía en 56 sitios y `user_profiles` en 34, sin ninguna
 * deduplicación: una sola carga de `/dashboard/[clientId]` acababa haciendo ~4
 * llamadas a Auth y 2 lecturas del perfil, todas con el mismo resultado.
 *
 * `cache()` de React memoiza por petición de renderizado, así que layouts,
 * páginas y server actions que participan en el mismo render comparten un único
 * resultado. Entre peticiones no se comparte nada: no es un caché de datos.
 */
export const getSesionActual = cache(async (): Promise<SesionActual> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { userId: null, email: null, role: 'viewer' };

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  return {
    userId: user.id,
    email: user.email ?? null,
    role: profile?.role ?? 'viewer',
  };
});
