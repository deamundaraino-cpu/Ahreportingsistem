/**
 * Comprobaciones de la captura web de leads: pixel JS, endpoint del pixel,
 * S2S de WordPress y el plugin (2026-09-28).
 *
 * Cuatro agujeros que se cerraron a la vez y que este script impide reabrir:
 *
 *   1. El pixel escribía `rutm_lt` solo junto con `rutm_ft`: el «último» toque
 *      era el primero durante 90 días.
 *   2. En el S2S el body ganaba a la URL con `??`, así que un `""` tapaba la
 *      UTM de la landing.
 *   3. IP y país eran los del servidor de WordPress.
 *   4. El plugin enviaba sin mirar la respuesta (un 500 perdía el lead) y, sin
 *      `external_id`, un reintento lo habría duplicado.
 *
 * Todo es puro: no toca Postgres. El pixel se ejecuta de verdad en un `vm` con
 * un `document` y un `location` de mentira.
 *
 *   npx tsx --conditions=react-server scripts/verify-s2s-captura.ts
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  customDataConIds,
  externalIdS2S,
  ipPublica,
  paisVisitante,
  primerNoVacio,
  resolverCampos,
} from '../src/lib/report-utm/s2s-captura';

let fallos = 0;
function check(nombre: string, cond: boolean, detalle?: string) {
  if (cond) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const AD = '120212345678901234';
const CAMP = '120200000000000001';

// ── 1. Primer valor no vacío ─────────────────────────────────────────
console.log('\n── Body y URL: gana el primer valor NO VACÍO ─────────────');

check('primerNoVacio salta null, "" y espacios', primerNoVacio(null, '', '  ', 'x') === 'x');
check('primerNoVacio devuelve null si no hay nada', primerNoVacio(undefined, '') === null);

const LANDING =
  'https://sitio.com/registro/?utm_source=fb&utm_medium=paid&utm_campaign=Lanzamiento' +
  `&utm_id=${CAMP}&ad_id=${AD}&fbclid=IwAR0abc`;

const r1 = resolverCampos({ utm_source: '', utm_campaign: '  ', page_url: LANDING });
check(
  'un utm_source "" del body ya no tapa el de la URL',
  r1.utm_source === 'fb',
  r1.utm_source ?? 'null'
);
check('ni un utm_campaign de espacios', r1.utm_campaign === 'Lanzamiento');
check('utm_id sale de la URL', r1.utm_id === CAMP);
check('ad_id sale de la URL', r1.ad_id === AD);
check('click_id sale del fbclid', r1.click_id === 'IwAR0abc');
check('origen = evento', r1.origen === 'evento');

const r2 = resolverCampos({ utm_source: 'google', page_url: LANDING });
check('un valor real del body sigue ganando a la URL', r2.utm_source === 'google');

const r3 = resolverCampos({ ad_id: '{{ad.id}}', page_url: LANDING });
check('una macro sin rellenar en el body no tapa el ID bueno de la URL', r3.ad_id === AD);

const r4 = resolverCampos({ page_url: 'https://sitio.com/?fbclid=&gclid=Cj0K' });
check('un fbclid vacío no tapa el gclid', r4.click_id === 'Cj0K', r4.click_id ?? 'null');

// ── 2. Último toque cuando la URL no trae nada ───────────────────────
console.log('\n── Cookie de último toque ────────────────────────────────');

const LT = {
  source: 'ig',
  medium: 'paid',
  campaign: 'Retargeting',
  content: 'AD 7',
  term: 'Conjunto 2',
  click_id: 'IwAR_lt',
  utm_id: CAMP,
  ad_id: AD,
  ts: '2026-09-27T10:00:00.000Z',
};
const FT = { source: 'fb', campaign: 'Frio', ts: '2026-09-01T10:00:00.000Z' };

const t1 = resolverCampos({
  page_url: 'https://sitio.com/gracias/',
  last_touch: LT,
  first_touch: FT,
});
check('sin UTM en la URL se usa el último toque', t1.utm_campaign === 'Retargeting');
check('con sus IDs', t1.ad_id === AD && t1.utm_id === CAMP);
check('y su click id', t1.click_id === 'IwAR_lt');
check('origen = toque', t1.origen === 'toque');

const t2 = resolverCampos({ page_url: 'https://sitio.com/gracias/', first_touch: FT });
check('sin último toque, el primero', t2.utm_campaign === 'Frio');

const t3 = resolverCampos({ page_url: LANDING, last_touch: LT });
check('con UTM en la URL, la cookie NO se usa', t3.utm_campaign === 'Lanzamiento');
check('ni se mezcla campo a campo', t3.utm_content === null, t3.utm_content ?? 'null');

const t4 = resolverCampos({
  page_url: 'https://sitio.com/gracias/',
  last_touch: encodeURIComponent(JSON.stringify(LT)),
});
check('se acepta la cookie en crudo (JSON con percent-encoding)', t4.utm_source === 'ig');

const t5 = resolverCampos({ page_url: 'https://sitio.com/', last_touch: 'no es json' });
check('una cookie rota no rompe nada', t5.origen === 'ninguno' && t5.utm_source === null);

// ── 3. external_id ───────────────────────────────────────────────────
console.log('\n── external_id: idempotente y con prefijo ────────────────');

const minuto = new Date('2026-09-28T14:05:10Z');
const mismoMinuto = new Date('2026-09-28T14:05:59Z');
const otroMinuto = new Date('2026-09-28T14:06:00Z');
const lead = { form_id: '42', lead_email: ' Ana@Mail.com ', lead_phone: '+56 9 1234 5678' };

const e1 = externalIdS2S(lead, minuto);
check('forma s2s:<32 hex>', /^s2s:[0-9a-f]{32}$/.test(e1 ?? ''), e1 ?? 'null');
check('mismo lead, mismo minuto → mismo id', e1 === externalIdS2S(lead, mismoMinuto));
check('otro minuto → otro id', e1 !== externalIdS2S(lead, otroMinuto));
check(
  'el email se normaliza (mayúsculas y espacios)',
  e1 === externalIdS2S({ ...lead, lead_email: 'ana@mail.com' }, minuto)
);
check('otro formulario → otro id', e1 !== externalIdS2S({ ...lead, form_id: '43' }, minuto));
check(
  'sin email, el teléfono con o sin prefijo da lo mismo',
  externalIdS2S({ form_id: '42', lead_phone: '+56 9 1234 5678' }, minuto) ===
    externalIdS2S({ form_id: '42', lead_phone: '912345678' }, minuto)
);
check(
  'sin email ni teléfono no se inventa uno (fundiría leads anónimos)',
  externalIdS2S({ form_id: '42' }, minuto) === null
);
check(
  'el que manda el plugin se respeta',
  externalIdS2S({ ...lead, external_id: 's2s:abc' }, minuto) === 's2s:abc'
);
check(
  'y se le pone el prefijo si no lo trae (el índice lo comparten Meta y GHL)',
  externalIdS2S({ external_id: '123456' }, minuto) === 's2s:123456'
);
// Vector fijo: el plugin (build_external_id en class-s2s-sender.php) hace el
// mismo cálculo en PHP. Si alguien cambia el formato aquí, esto lo delata.
const esperado =
  's2s:' +
  createHash('sha256').update('42|e:ana@mail.com|2026-09-28T14:05').digest('hex').slice(0, 32);
check('formato "<form>|e:<email>|<minuto UTC>" (paridad con el plugin)', e1 === esperado);

// ── 4. IP y país del visitante ───────────────────────────────────────
console.log('\n── IP del visitante: solo públicas ───────────────────────');

for (const ip of ['181.43.12.7', '8.8.8.8', '2800:150:11c:1234::1', '2a03:2880:f10c::1']) {
  check(`acepta ${ip}`, ipPublica(ip) === ip);
}
for (const ip of [
  '10.0.0.5',
  '192.168.1.10',
  '172.16.3.4',
  '172.31.255.255',
  '127.0.0.1',
  '169.254.1.1',
  '100.64.0.1',
  '0.0.0.0',
  '255.255.255.255',
  '::1',
  'fe80::1',
  'fd12:3456::1',
  '::ffff:10.0.0.1',
  '2001:db8::1',
  'no-es-ip',
  '1.2.3',
  '',
  null,
]) {
  check(`rechaza ${JSON.stringify(ip)}`, ipPublica(ip) === null);
}
check('172.32.x es pública (fuera de 172.16/12)', ipPublica('172.32.0.1') === '172.32.0.1');
check('IPv4 mapeada pública pasa', ipPublica('::ffff:8.8.8.8') === '::ffff:8.8.8.8');
check('país CF en minúsculas se normaliza', paisVisitante('cl') === 'CL');
check('XX (desconocido de Cloudflare) no es país', paisVisitante('XX') === null);
check('basura no es país', paisVisitante('Chile') === null);

// ── 5. IDs en custom_data de pixel_events ────────────────────────────
console.log('\n── pixel_events: IDs en custom_data ──────────────────────');

const sinIds = { utm_id: null, campaign_id: null, adset_id: null, ad_id: null };
check('sin IDs no se toca custom_data', customDataConIds({ plan: 'pro' }, sinIds)?.plan === 'pro');
check('sin IDs ni datos sigue en null', customDataConIds(null, sinIds) === null);
const cd = customDataConIds({ plan: 'pro' }, { ...sinIds, utm_id: CAMP, ad_id: AD });
check(
  'con IDs van bajo _rutm_ids sin pisar los datos del sitio',
  cd?.plan === 'pro' &&
    JSON.stringify(cd?._rutm_ids) === JSON.stringify({ utm_id: CAMP, ad_id: AD })
);

// ── 6. El pixel de verdad, en un vm ──────────────────────────────────
console.log('\n── Pixel: primer toque fijo, último toque reescrito ──────');

const PIXEL = readFileSync('public/report-utm-pixel.js', 'utf8');

function visitar(search: string, cookies: Map<string, string>): Record<string, unknown>[] {
  const enviados: Record<string, unknown>[] = [];
  const document = {
    get cookie() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(s: string) {
      const par = s.split(';')[0];
      const i = par.indexOf('=');
      cookies.set(par.slice(0, i), par.slice(i + 1));
    },
    referrer: '',
    title: 'Landing',
    readyState: 'complete',
    getElementsByTagName: () => [],
    addEventListener: () => {},
    body: {},
    documentElement: {},
  };
  class BlobFalso {
    texto: string;
    constructor(partes: string[]) {
      this.texto = partes.join('');
    }
  }
  const ctx = {
    window: { RUTM_CONFIG: { cliente: 'demo', endpoint: 'https://r.example' } },
    document,
    location: {
      search,
      href: `https://sitio.com/landing/${search}`,
      origin: 'https://sitio.com',
    },
    navigator: {
      sendBeacon: (_u: string, b: BlobFalso) => {
        enviados.push(JSON.parse(b.texto));
        return true;
      },
    },
    Blob: BlobFalso,
    URLSearchParams,
    URL,
  };
  vm.runInNewContext(PIXEL, ctx);
  return enviados;
}

const leer = (c: Map<string, string>, k: string) =>
  c.has(k) ? JSON.parse(decodeURIComponent(c.get(k) as string)) : null;

const jar = new Map<string, string>();
visitar('?utm_source=fb&utm_campaign=Frio', jar);
const ft0 = leer(jar, 'rutm_ft');
check('la primera visita con UTM escribe rutm_ft', ft0?.campaign === 'Frio');
check('y rutm_lt igual', leer(jar, 'rutm_lt')?.campaign === 'Frio');

const envio = visitar(`?utm_source=ig&utm_campaign=Retargeting&utm_id=${CAMP}&ad_id=${AD}`, jar);
check('una visita con otra campaña NO toca rutm_ft', leer(jar, 'rutm_ft')?.campaign === 'Frio');
check(
  'pero SÍ reescribe rutm_lt (antes quedaba el primero 90 días)',
  leer(jar, 'rutm_lt')?.campaign === 'Retargeting'
);
check('rutm_lt guarda los IDs', leer(jar, 'rutm_lt')?.ad_id === AD);
check('el pageview manda utm_id', envio[0]?.utm_id === CAMP, JSON.stringify(envio[0]));
check('y ad_id', envio[0]?.ad_id === AD);

visitar('', jar);
check(
  'una página sin señal no pisa el último toque',
  leer(jar, 'rutm_lt')?.campaign === 'Retargeting'
);

visitar(`?ad_id=${AD}9`, jar);
check('un ID de la entidad solo ya es señal', leer(jar, 'rutm_lt')?.ad_id === `${AD}9`);
check('y el primer toque sigue siendo el primero', leer(jar, 'rutm_ft')?.ts === ft0?.ts);

const vacia = new Map<string, string>();
visitar('?utm_content=AD+2', vacia);
check('utm_content solo no es señal (sin campaña no cruza)', !vacia.has('rutm_ft'));

// ── 7. Lo que no se puede ejecutar sin base ni WordPress ─────────────
console.log('\n── Endpoints y plugin (sobre el fuente) ──────────────────');

const s2s = readFileSync('src/app/api/report-utm/pixel/s2s/route.ts', 'utf8');
const evento = readFileSync('src/app/api/report-utm/pixel/event/route.ts', 'utf8');
const sender = readFileSync('wordpress-plugin/report-utm/includes/class-s2s-sender.php', 'utf8');
const plugin = readFileSync('wordpress-plugin/report-utm/report-utm.php', 'utf8');

check(
  'S2S: el 23505 (external_id repetido) responde éxito, no 500',
  /code === '23505'\)\s*\{\s*return NextResponse\.json\(\{ ok: true, duplicate: true \}\)/.test(s2s)
);
check('S2S: el lead se guarda con external_id', /external_id: externalId,/.test(s2s));
check('S2S: la IP del body pasa por ipPublica', /ipPublica\(body\.visitor_ip\)/.test(s2s));
check('S2S: ya no hay `body.utm_x ?? url` en el fuente', !/body\.utm_\w+ \?\?/.test(s2s));
check(
  'S2S: los toques se leen pero no se guardan en el lead (ver verify-lead-adelgazado)',
  !/first_touch|last_touch/.test(s2s)
);
check(
  'pixel/event: UTMs e IDs se leen antes de normalizar page_url',
  evento.indexOf('resolverCampos(') !== -1 &&
    evento.indexOf('resolverCampos(') < evento.indexOf('normalizarPageUrl(body.page_url)')
);
check("plugin: envío bloqueante ('blocking' => true)", /'blocking'\s*=>\s*true/.test(sender));
check('plugin: ningún envío fire-and-forget', !/'blocking'\s*=>\s*(false|\$blocking)/.test(sender));
check('plugin: reintento por WP-Cron', /wp_schedule_single_event\(/.test(sender));
check(
  'plugin: el hook de reintento se registra al cargar',
  /register_retry_hook\(\);/.test(plugin)
);
check(
  'plugin: manda external_id',
  /\$body\['external_id'\] = self::build_external_id/.test(sender)
);
check('plugin: lee rutm_ft y rutm_lt', /'rutm_ft'/.test(sender) && /'rutm_lt'/.test(sender));
check(
  'plugin: la IP preferida es pública',
  /FILTER_FLAG_NO_PRIV_RANGE \| FILTER_FLAG_NO_RES_RANGE/.test(sender)
);
check(
  'plugin: versión 0.5.0 en la cabecera y en RUTM_VERSION',
  /Version:\s+0\.5\.0/.test(plugin) && /'RUTM_VERSION',\s+'0\.5\.0'/.test(plugin)
);

console.log(fallos === 0 ? '\nTodo OK.' : `\n${fallos} comprobación(es) fallida(s).`);
process.exit(fallos === 0 ? 0 : 1);
