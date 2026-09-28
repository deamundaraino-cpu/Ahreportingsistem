/**
 * Cuentas de Meta configuradas en un cliente. Vive aparte de `alerta-cuenta.ts`
 * para que lo usen módulos sin dependencias de notificaciones (sync de
 * conversiones, scripts).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Cuentas de Meta configuradas en un cliente, sin duplicados y con token. */
export function cuentasMetaDe(
  config: Record<string, any>
): Array<{ account_id: string; token: string }> {
  let cuentas: Array<{ account_id: string; token: string }> = [];
  if (Array.isArray(config.meta_accounts) && config.meta_accounts.length > 0) {
    cuentas = config.meta_accounts
      .filter((a: any) => a?.account_id)
      .map((a: any) => ({
        account_id: String(a.account_id),
        token: a.token || config.meta_token || '',
      }));
  } else if (config.meta_token && config.meta_account_id) {
    cuentas = [{ account_id: String(config.meta_account_id), token: String(config.meta_token) }];
  }
  const vistas = new Set<string>();
  return cuentas.filter((c) => {
    const k = c.account_id.replace(/^act_/, '');
    if (!c.token || vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}
