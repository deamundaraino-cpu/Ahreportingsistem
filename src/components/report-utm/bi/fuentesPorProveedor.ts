// Carpetas por PROVEEDOR en el selector de campos.
//
// El catálogo llega por fuente TÉCNICA —una por tabla física—, y eso dejaba a
// GA4 y a Hotmart repartidos: «Cuenta (por día)» mezclaba las sesiones de GA4
// con la facturación de Hotmart, mientras «Ventas Hotmart», «GA4 (por
// campaña)» y «Eventos clave de GA4» iban sueltas. Quien busca «algo de GA4» no
// sabe en qué tabla vive (pedido del 2026-09-29: «lo de Hotmart en Hotmart y lo
// de GA4 en Google»).
//
// Esto es SOLO presentación: las fuentes del registro no cambian, cada campo
// conserva su id, su `crossesDimension` y su ayuda, así que los avisos de «no
// se desglosa» y lo que se guarda en el informe siguen exactamente igual. Cada
// fuente técnica pasa a ser una SECCIÓN de su carpeta (la cabecera que el
// selector ya pinta por grupo), porque decir de dónde sale el dato sigue
// importando: las sesiones del sitio y las de campaña no suman lo mismo.
//
// Puro: sin React, para que lo pruebe `verify-ga4-desglose.ts`.

import type { CatalogField, CatalogSource } from './BiFieldPicker';

export const CARPETA_GA4 = 'proveedor_ga4';
export const CARPETA_HOTMART = 'proveedor_hotmart';

interface Destino {
  carpeta: string;
  seccion: string;
}

const CARPETAS: Record<string, { label: string; nota: string }> = {
  [CARPETA_GA4]: {
    label: 'Google Analytics 4',
    nota: 'Todo lo que viene de GA4. Cada sección dice por qué se puede desglosar: el total del sitio solo por fecha; por campaña, también por campaña, fuente y medio; por página, por página.',
  },
  [CARPETA_HOTMART]: {
    label: 'Hotmart',
    nota: 'Todo lo que viene de Hotmart. Por venta se reparte por campaña; los totales por día, solo por fecha.',
  },
};

/** ¿A qué carpeta y sección va un campo de esta fuente? `null` = se queda. */
function destinoDe(sourceId: string, f: CatalogField): Destino | null {
  switch (sourceId) {
    case 'cuenta':
      // `cuenta` es una sola tabla (`metricas_diarias`) con tres cosas dentro.
      if (f.group === 'ga4') return { carpeta: CARPETA_GA4, seccion: 'Todo el sitio (por día)' };
      if (f.group === 'hotmart') return { carpeta: CARPETA_HOTMART, seccion: 'Totales por día' };
      return null;
    case 'ga4':
      return { carpeta: CARPETA_GA4, seccion: 'Por campaña' };
    case 'ga4_paginas':
      return { carpeta: CARPETA_GA4, seccion: 'Por página' };
    case 'cliente_ga4ev':
      return { carpeta: CARPETA_GA4, seccion: 'Eventos clave' };
    case 'hotmart':
      return { carpeta: CARPETA_HOTMART, seccion: 'Por venta' };
    default:
      return null;
  }
}

/** Orden de las secciones dentro de cada carpeta. */
const ORDEN_SECCIONES = [
  'Todo el sitio (por día)',
  'Por campaña',
  'Por página',
  'Eventos clave',
  'Por venta',
  'Totales por día',
];

/**
 * Reagrupa las fuentes técnicas en carpetas por proveedor. La carpeta ocupa el
 * lugar de la primera fuente que aporta a ella; una fuente que se vacía (p. ej.
 * «Cuenta» sin GA4 ni Hotmart) desaparece. No pierde ni duplica campos.
 */
export function agruparPorProveedor(sources: CatalogSource[]): CatalogSource[] {
  const carpetas = new Map<
    string,
    { fields: CatalogField[]; fuentes: CatalogSource[]; joinAxes: Set<string> }
  >();
  const salida: Array<CatalogSource | { carpeta: string }> = [];

  for (const s of sources) {
    const quedan: CatalogField[] = [];
    for (const f of s.fields) {
      const d = destinoDe(s.id, f);
      if (!d) {
        quedan.push(f);
        continue;
      }
      let c = carpetas.get(d.carpeta);
      if (!c) {
        c = { fields: [], fuentes: [], joinAxes: new Set() };
        carpetas.set(d.carpeta, c);
        salida.push({ carpeta: d.carpeta });
      }
      if (!c.fuentes.includes(s)) c.fuentes.push(s);
      for (const a of s.joinAxes) c.joinAxes.add(a);
      c.fields.push({ ...f, group: d.seccion });
    }
    if (quedan.length) salida.push({ ...s, fields: quedan });
  }

  return salida.map((x) => {
    if (!('carpeta' in x)) return x;
    const c = carpetas.get(x.carpeta)!;
    const meta = CARPETAS[x.carpeta];
    const noDisponible = c.fuentes.find((s) => !s.available);
    const pos = (g: string) => {
      const i = ORDEN_SECCIONES.indexOf(g);
      return i < 0 ? ORDEN_SECCIONES.length : i;
    };
    return {
      id: x.carpeta,
      label: meta.label,
      grain: 'daily' as const,
      grainText: meta.nota,
      nota: meta.nota,
      joinAxes: [...c.joinAxes],
      // Todas cuelgan del mismo enlace de cliente: si una no se puede leer,
      // ninguna. Se muestra el motivo de la primera.
      available: !noDisponible,
      ...(noDisponible ? { unavailableReason: noDisponible.unavailableReason } : {}),
      // Orden estable por sección; dentro, el que traía cada fuente.
      fields: c.fields
        .map((f, i) => ({ f, i }))
        .sort((a, b) => pos(a.f.group) - pos(b.f.group) || a.i - b.i)
        .map(({ f }) => f),
    };
  });
}
