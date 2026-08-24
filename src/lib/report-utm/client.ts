import { createClient, createAdminClient } from '@/utils/supabase/server';

/**
 * Helpers que apuntan al schema `report_utm` (módulo aislado).
 * Las tablas viven en un schema separado de `public` a propósito —
 * el reporting principal y el módulo report-utm no se cruzan a nivel BD.
 *
 * IMPORTANTE: para que esto funcione, agregar `report_utm` a
 * Supabase Studio → Settings → API → Exposed schemas.
 */

export async function reportUtmClient() {
  const supabase = await createClient();
  return supabase.schema('report_utm');
}

export async function reportUtmAdminClient() {
  const supabase = await createAdminClient();
  return supabase.schema('report_utm');
}
