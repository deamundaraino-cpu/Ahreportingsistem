/**
 * Comprueba el selector de operador del filtro «Campaña» (CampaignFilterPicker).
 *
 * El operador se deducía solo de `value`, y un filtro sin texto se guarda como
 * `undefined`: elegir «Inicia con» con el buscador vacío volvía a «Incluye» al
 * instante, y en «Entre estas» desmarcar la última campaña cerraba el panel.
 *
 * Se ejecuta SIN `--conditions=react-server`: con ese flag React no exporta
 * `useState` y el componente no se puede montar. A cambio se neutralizan
 * `server-only` y las server actions, que el modal importa pero el picker no usa.
 *
 *   npx tsx scripts/verify-campaign-filter-picker.ts
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import Module from 'node:module';

// jsdom no trae tipos (no hay @types/jsdom); basta con lo que usa este script.
const { JSDOM } = require('jsdom') as {
  JSDOM: new (
    html: string,
    opts?: { pretendToBeVisual?: boolean; url?: string }
  ) => { window: Window & typeof globalThis };
};

const modAny = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
const originalLoad = modAny._load;
modAny._load = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return {};
  if (request === '../_actions' || request.endsWith('/dashboard/_actions')) return {};
  return originalLoad.call(this, request, ...rest);
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const g = globalThis as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  // Node ya trae Event/CustomEvent/EventTarget propios, pero jsdom rechaza en
  // dispatchEvent los que no son suyos (Radix los crea con el global).
  const esEvento = key === 'EventTarget' || key.endsWith('Event');
  if (key in globalThis && !esEvento) continue;
  try {
    g[key] = (dom.window as unknown as Record<string, unknown>)[key];
  } catch {
    /* propiedad de solo lectura */
  }
}
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
g.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
g.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react') as typeof import('react');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { CampaignFilterPicker } =
  require('../src/app/(app)/dashboard/components/LayoutConfigModal') as typeof import('../src/app/(app)/dashboard/components/LayoutConfigModal');
type Spec = import('../src/lib/layout-types').CampaignFilterSpec;

let fallos = 0;
function check(nombre: string, ok: boolean, detalle = '') {
  if (ok) console.log(`  ✓ ${nombre}`);
  else {
    fallos++;
    console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  }
}

const CAMPANAS = ['Camp A', 'Camp B'];

function montar(inicial?: Spec) {
  const estado: { value: Spec | undefined } = { value: inicial };
  const registrar = (nv: Spec | undefined) => {
    estado.value = nv;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    const [v, setV] = React.useState<Spec | undefined>(inicial);
    return React.createElement(CampaignFilterPicker, {
      value: v,
      onChange: (nv: Spec | undefined) => {
        registrar(nv);
        setV(nv);
      },
      campaignGroups: [],
      campaignNames: CAMPANAS,
    });
  }

  React.act(() => root.render(React.createElement(Harness)));

  const select = () => {
    // El select de operador es el que contiene la opción «starts_with».
    const s = Array.from(container.querySelectorAll('select')).find((el) =>
      el.querySelector('option[value="starts_with"]')
    );
    if (!s) throw new Error('No se encontró el select de operador');
    return s as HTMLSelectElement;
  };

  const elegir = (op: string) =>
    React.act(() => {
      const s = select();
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(
        s,
        op
      );
      s.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });

  const escribir = (texto: string) =>
    React.act(() => {
      const input = container.querySelector('input') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        texto
      );
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });

  // Las opciones del panel múltiple se pintan en un portal (document.body).
  const opcionPanel = (nombre: string) =>
    Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === nombre
    ) as HTMLButtonElement | undefined;

  const clic = (el: Element) =>
    React.act(() => {
      el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

  const desmontar = () => {
    React.act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  };

  return { estado, select, elegir, escribir, opcionPanel, clic, container, desmontar };
}

console.log('\n1. Operadores simples con el buscador vacío conservan la selección');
{
  const p = montar();
  for (const op of ['excludes', 'exact', 'not_exact', 'starts_with', 'ends_with', 'includes']) {
    p.elegir(op);
    check(`«${op}» queda seleccionado`, p.select().value === op, `muestra «${p.select().value}»`);
    check(`«${op}» sin texto no guarda filtro`, p.estado.value === undefined);
  }
  p.desmontar();
}

console.log('\n2. «Inicia con» + texto guarda el spec con ese operador');
{
  const p = montar();
  p.elegir('starts_with');
  p.escribir('Camp');
  const v = p.estado.value;
  check(
    'spec { keyword, starts_with, "Camp" }',
    v?.type === 'keyword' && v.operator === 'starts_with' && v.value === 'Camp',
    JSON.stringify(v)
  );
  check('el select sigue en «starts_with»', p.select().value === 'starts_with');
  p.escribir('');
  check('borrar el texto anula el filtro', p.estado.value === undefined);
  check('…pero conserva el operador', p.select().value === 'starts_with');
  p.desmontar();
}

console.log('\n3. «Entre estas»: desmarcar la última campaña no cierra el panel');
{
  const p = montar();
  p.elegir('any_of');
  check('el select queda en «any_of»', p.select().value === 'any_of');
  const a = p.opcionPanel('Camp A');
  check('el panel múltiple está abierto', !!a);
  if (a) {
    p.clic(a);
    const v = p.estado.value;
    check(
      'marcar guarda ["Camp A"]',
      v?.operator === 'any_of' && Array.isArray(v.value) && v.value.join() === 'Camp A',
      JSON.stringify(v)
    );
    p.clic(p.opcionPanel('Camp A')!);
    check('desmarcar la última anula el filtro', p.estado.value === undefined);
    check('el operador sigue en «any_of»', p.select().value === 'any_of');
    check('el panel sigue abierto', !!p.opcionPanel('Camp B'));
  }
  p.desmontar();
}

console.log('\n4. La X limpia el filtro y vuelve a «Incluye»');
{
  const p = montar();
  p.elegir('excludes');
  p.escribir('Camp');
  const x = p.container.querySelector('button[title="Limpiar filtro de campaña"]');
  check('la X aparece con filtro activo', !!x);
  if (x) {
    p.clic(x);
    check('filtro anulado', p.estado.value === undefined);
    check('el select vuelve a «includes»', p.select().value === 'includes');
    const input = p.container.querySelector('input') as HTMLInputElement | null;
    check('el buscador queda vacío', input?.value === '');
  }
  p.desmontar();
}

console.log('\n5. Un filtro guardado «Fuera de estas» conserva su operador al vaciarse');
{
  const p = montar({ type: 'keyword', operator: 'none_of', value: ['Camp B'] });
  check('arranca en «none_of»', p.select().value === 'none_of');
  p.clic(
    p.container.querySelector('button') as HTMLButtonElement // abre el panel
  );
  const b = p.opcionPanel('Camp B');
  check('el panel muestra «Camp B»', !!b);
  if (b) {
    p.clic(b);
    check('desmarcarla anula el filtro', p.estado.value === undefined);
    check('el operador sigue en «none_of»', p.select().value === 'none_of');
  }
  p.desmontar();
}

console.log(fallos === 0 ? '\nOK: todas las comprobaciones pasan.\n' : `\n${fallos} fallo(s).\n`);
process.exit(fallos === 0 ? 0 : 1);
