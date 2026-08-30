/**
 * `config_api` no debe cruzar al navegador con credenciales.
 *
 * El dashboard se pinta con <DashboardClient>, que es un componente de cliente:
 * todo lo que reciba se serializa en el payload RSC. En `/p/[token]` esa página
 * es pública y sin sesión, así que devolver la fila entera del cliente publicaba
 * `ga_private_key`, `meta_access_token`, `tiktok_access_token` y el `private_key`
 * del service account de Google en el HTML de cada enlace compartido.
 *
 * Estas comprobaciones fijan el contrato del saneador para que la fuga no pueda
 * volver por descuido: lo que no está en la allowlist, no viaja.
 */
import { sanearConfigApi, sanearClienteParaUI } from '../src/lib/cliente-seguro';

let ok = 0,
  fail = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) {
    ok++;
    console.log('  ✓ ' + nombre);
  } else {
    fail++;
    console.log('  ✗ ' + nombre + (detalle ? '  → ' + detalle : ''));
  }
}

// Una config_api realista: mezcla preferencias de UI con credenciales en claro.
const CONFIG_REAL = {
  meta_keywords: ['asesoria', 'ebook'],
  meta_token: 'EAAG-token-de-meta',
  meta_access_token: 'EAAG-otro-token',
  hotmart_token: 'hm-token',
  hotmart_basic: 'hm-basic',
  ga_property_id: '123456',
  ga_private_key: '-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n',
  ga_client_email: 'svc@proyecto.iam.gserviceaccount.com',
  tiktok_access_token: 'tt-token-secreto',
  tiktok_advertiser_id: '7000000',
  tiktok_accounts: [{ advertiser_id: '7000000', name: 'Cuenta principal' }],
  google_sheets_conversiones: [
    {
      id: 'sheet_0',
      name: 'Conversiones',
      enabled: true,
      sheet_id: '1AbC',
      client_email: 'svc@proyecto.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nSECRETO\n-----END PRIVATE KEY-----\n',
      custom_columns: { ventas: { include: true, label: 'Ventas' } },
      tabs: [
        {
          id: 'tab_0',
          tab_name: 'Hoja 1',
          enabled: true,
          client_email: 'otro@svc.test',
          private_key: 'CLAVE-ANIDADA',
          custom_columns: { agendas: { include: true, label: 'Agendas' } },
        },
      ],
    },
  ],
};

/** Shape minimo de una config de Sheets ya saneada, para navegarla sin `any`. */
type Col = { include?: boolean; label?: string };
type SheetSaneado = {
  enabled?: boolean;
  custom_columns?: Record<string, Col>;
  tabs?: SheetSaneado[];
};

/** Recorre el objeto entero: una credencial escondida a cualquier profundidad cuenta. */
function serializado(v: unknown): string {
  return JSON.stringify(v ?? {});
}

console.log('\n── Ninguna credencial sobrevive al saneado ──────────────────');
const limpio = sanearConfigApi(CONFIG_REAL);
const texto = serializado(limpio);

const SECRETOS = [
  ['ga_private_key', 'BEGIN PRIVATE KEY'],
  ['private_key del sheet', 'SECRETO'],
  ['private_key anidada en tabs', 'CLAVE-ANIDADA'],
  ['meta_token', 'EAAG-token-de-meta'],
  ['meta_access_token', 'EAAG-otro-token'],
  ['tiktok_access_token', 'tt-token-secreto'],
  ['hotmart_token', 'hm-token'],
  ['hotmart_basic', 'hm-basic'],
  ['ga_client_email', 'svc@proyecto.iam.gserviceaccount.com'],
];
for (const [nombre, aguja] of SECRETOS) {
  check(`elimina ${nombre}`, !texto.includes(aguja));
}
check('no quedan claves *_token', !/"[a-z_]*token"\s*:/i.test(texto), texto.slice(0, 200));
check('no queda ninguna private_key', !/private_key/i.test(texto));
check('no queda ningún client_email', !/client_email/i.test(texto));

console.log('\n── Lo que la UI necesita sí sobrevive ───────────────────────');
check('conserva meta_keywords', JSON.stringify(limpio.meta_keywords) === '["asesoria","ebook"]');
check('conserva tiktok_accounts', serializado(limpio.tiktok_accounts).includes('Cuenta principal'));
const sheets = limpio.google_sheets_conversiones as SheetSaneado[] | undefined;
check('conserva el array de sheets', Array.isArray(sheets) && sheets.length === 1);
check('conserva enabled del sheet', sheets?.[0]?.enabled === true);
check('conserva custom_columns', sheets?.[0]?.custom_columns?.ventas?.label === 'Ventas');
check('conserva las pestañas', Array.isArray(sheets?.[0]?.tabs) && sheets[0].tabs.length === 1);
check(
  'conserva custom_columns de la pestaña',
  sheets?.[0]?.tabs?.[0]?.custom_columns?.agendas?.label === 'Agendas'
);

console.log('\n── Allowlist: una credencial nueva no se cuela sola ─────────');
const conClaveFutura = sanearConfigApi({
  ...CONFIG_REAL,
  alguna_api_key_nueva: 'valor-secreto-futuro',
  webhook_secret: 'otro-secreto',
});
check(
  'una clave desconocida no pasa aunque nadie actualice el saneador',
  !serializado(conClaveFutura).includes('valor-secreto-futuro') &&
    !serializado(conClaveFutura).includes('otro-secreto')
);

console.log('\n── Formato legacy (objeto suelto, no array) ─────────────────');
const legacy = sanearConfigApi({
  google_sheets_conversiones: {
    enabled: true,
    sheet_id: '1XyZ',
    private_key: 'SECRETO-LEGACY',
    custom_columns: { x: { include: true, label: 'X' } },
  },
});
check('sanea también el formato legacy', !serializado(legacy).includes('SECRETO-LEGACY'));
check(
  'y conserva su contenido útil',
  (legacy.google_sheets_conversiones as SheetSaneado | undefined)?.custom_columns?.x?.label === 'X'
);

console.log('\n── Entradas degeneradas ─────────────────────────────────────');
check('null devuelve objeto vacío', serializado(sanearConfigApi(null)) === '{}');
check('undefined devuelve objeto vacío', serializado(sanearConfigApi(undefined)) === '{}');
check('string devuelve objeto vacío', serializado(sanearConfigApi('texto')) === '{}');
check('array devuelve objeto vacío', serializado(sanearConfigApi([1, 2])) === '{}');
check(
  'sheets null no revienta',
  serializado(sanearConfigApi({ google_sheets_conversiones: null })) ===
    '{"google_sheets_conversiones":null}'
);

console.log('\n── sanearClienteParaUI conserva el resto de la fila ─────────');
const cliente = {
  id: 'uuid-1',
  nombre: 'Goodprop',
  public_token: 'tok',
  config_api: CONFIG_REAL,
};
const saneado = sanearClienteParaUI(cliente);
check('conserva id', saneado.id === 'uuid-1');
check('conserva nombre', saneado.nombre === 'Goodprop');
check('sanea config_api', !serializado(saneado.config_api).includes('BEGIN PRIVATE KEY'));
check(
  'no muta el original',
  (cliente.config_api as Record<string, unknown>).ga_private_key !== undefined
);
check('null pasa tal cual', sanearClienteParaUI(null) === null);
check('undefined pasa tal cual', sanearClienteParaUI(undefined) === undefined);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} comprobaciones pasadas, ${fail} fallidas\n`);
process.exit(fail === 0 ? 0 : 1);
