import { getAgencyAccessToken } from './google-auth';

/**
 * Una propiedad GA4 visible para la cuenta OAuth de la agencia.
 * `id` es el ID numérico que se guarda en `config_api.ga_property_id`.
 */
export interface GA4Property {
  /** ID numérico, sin el prefijo `properties/` (ej. '511475756') */
  id: string;
  /** Nombre de la propiedad en GA4 (ej. 'Sitio web — Cliente X') */
  name: string;
  /** Cuenta GA4 que contiene la propiedad (ej. 'Ads House') */
  accountName: string;
}

/**
 * Lista todas las propiedades GA4 accesibles para la cuenta OAuth de la agencia.
 *
 * Usa la Admin API v1beta (`accountSummaries`), que ya está cubierta por el scope
 * `analytics.readonly` que pide el OAuth de agencia — no hace falta reconectar ni
 * pedir permisos nuevos. Un solo endpoint devuelve cuentas + propiedades anidadas.
 */
export async function listGA4Properties(): Promise<GA4Property[]> {
  const client = await getAgencyAccessToken();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('No se pudo obtener el access token de la cuenta de la agencia');

  const properties: GA4Property[] = [];
  let pageToken: string | undefined;

  // Paginación: una agencia con muchas cuentas supera fácil los 200 por página.
  do {
    const url = new URL('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error?.message || `Analytics Admin API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      accountSummaries?: Array<{
        displayName?: string;
        propertySummaries?: Array<{ property?: string; displayName?: string }>;
      }>;
      nextPageToken?: string;
    };

    for (const account of data.accountSummaries || []) {
      for (const prop of account.propertySummaries || []) {
        // `property` viene como 'properties/511475756' → guardamos solo el ID.
        const id = (prop.property || '').replace('properties/', '');
        if (!id) continue;
        properties.push({
          id,
          name: prop.displayName || id,
          accountName: account.displayName || 'Sin cuenta',
        });
      }
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  // Orden estable: por cuenta y luego por nombre de propiedad.
  return properties.sort(
    (a, b) => a.accountName.localeCompare(b.accountName) || a.name.localeCompare(b.name)
  );
}
