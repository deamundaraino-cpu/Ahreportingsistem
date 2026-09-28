// Fuentes del selector FUENTE → CAMPO que dependen de ESTE cliente.
//
// El catálogo del servidor (`/api/report-utm/bi/catalog`) solo conoce las
// métricas fijas. Desde el cambio a `BiFieldPicker` (commit 2292744) eso dejó
// fuera del selector principal —sin que nadie lo decidiera— todo lo que cada
// cliente configura: sus preguntas de formulario como dimensión, sus respuestas
// y segmentos como métrica, sus campos de Sheet y los campos calculados del
// informe (auditoría del 2026-09-26). Estas fuentes se arman en el navegador con
// los datos que el editor YA tiene cargados (`useBiClientFields`) y se añaden a
// las del catálogo.
//
// Puro: sin React ni fetch, para que la misma lista la use cualquier editor.

import type { CatalogField, CatalogSource } from './BiFieldPicker';
import type {
  FormFieldMeta,
  LeadFieldMeta,
  LeadSegmentoMeta,
  MetaCustomConvMeta,
  OfflineFieldMeta,
  SheetFieldMeta,
  SheetViewMeta,
  SheetCampoAgg,
  FieldAgg,
} from '@/lib/report-utm/bi-metadata';
import {
  FIELD_AGGS,
  humanizeFieldKey,
  makeFieldDim,
  makeFieldMetric,
  makeLeadFieldDim,
  makeLeadSegMetric,
  makeLeadAnsMetric,
  makeOfflineFieldMetric,
  makeSheetDim,
  makeSheetMetric,
  makeSheetView,
  sheetFieldLabel,
} from '@/lib/report-utm/bi-metadata';
import { clavesDeRespuestas, SIN_RESPUESTA } from '@/lib/leads/respuestas/claves';
import { normalizarClaveLead } from '@/lib/report-utm/lead-campos';

export interface EntradaFuentesDelCliente {
  formFields: FormFieldMeta[];
  leadFields: LeadFieldMeta[];
  leadSegments: LeadSegmentoMeta[];
  offlineFields: OfflineFieldMeta[];
  sheetFields: SheetFieldMeta[];
  sheetViews: SheetViewMeta[];
  customConversions: MetaCustomConvMeta[];
  calculatedFields: { name: string; format?: string }[];
}

const AGG_LABEL = Object.fromEntries(FIELD_AGGS.map((a) => [a.value, a.label])) as Record<
  FieldAgg,
  string
>;

function medida(
  id: string,
  label: string,
  group: string,
  extra: Partial<CatalogField> = {}
): CatalogField {
  return { id, canonicalId: id, label, help: '', kind: 'measure', group, ...extra };
}
function dimension(id: string, label: string, group: string, help = ''): CatalogField {
  return { id, canonicalId: id, label, help, kind: 'dimension', group };
}

function fuente(
  id: string,
  label: string,
  grain: CatalogSource['grain'],
  fields: CatalogField[]
): CatalogSource | null {
  if (fields.length === 0) return null;
  return {
    id,
    label,
    grain,
    grainText: '',
    joinAxes: [],
    available: true,
    fields,
  };
}

/**
 * Las respuestas de un campo, con su clave estable (`LeadFieldMeta.respuestas`,
 * que calcula el servidor) o, si no vino, derivada igual que en el servidor.
 */
export function respuestasDeCampo(f: LeadFieldMeta): { clave: string; nombre: string }[] {
  if (f.respuestas && f.respuestas.length > 0) return f.respuestas;
  const claves = clavesDeRespuestas(f.valores);
  return f.valores.map((nombre, i) => ({ clave: claves[i], nombre }));
}

export function fuentesDelCliente(e: EntradaFuentesDelCliente): CatalogSource[] {
  const out: (CatalogSource | null)[] = [];

  // ── Respuestas de formulario (el catálogo de Leads) ────────────────
  // Una pregunta es una DIMENSIÓN (agrupar por lo que respondieron); cada una de
  // sus respuestas —y cada segmento— es una MÉTRICA que conserva el gasto, así
  // que «CPL de los que dijeron X» es `spend / <esa métrica>`.
  const respuestas: CatalogField[] = [];
  for (const f of e.leadFields) {
    if (!f.alta_cardinalidad) {
      respuestas.push(
        dimension(
          makeLeadFieldDim(f.clave),
          f.nombre,
          'Preguntas (agrupar por respuesta)',
          'Una fila por respuesta. El gasto no se reparte por respuesta: para el CPL de una respuesta usa su métrica.'
        )
      );
    }
    for (const r of respuestasDeCampo(f)) {
      respuestas.push(
        medida(makeLeadAnsMetric(f.clave, r.clave), `${f.nombre}: ${r.nombre}`, f.nombre, {
          additive: true,
          pivotable: true,
          funnelStage: 0,
          help: `Leads que respondieron «${r.nombre}». Conserva el gasto: spend ÷ esta métrica es su CPL.`,
        })
      );
    }
    for (const s of e.leadSegments.filter((s) => s.campo_clave === f.clave)) {
      respuestas.push(
        medida(makeLeadSegMetric(s.clave), `${f.nombre}: ${s.nombre}`, f.nombre, {
          additive: true,
          pivotable: true,
          funnelStage: 0,
          help: `Segmento: leads que respondieron ${s.operador === 'not_in' ? 'cualquier cosa salvo' : ''} ${s.valores.join(', ')}.`,
        })
      );
    }
    respuestas.push(
      medida(makeLeadAnsMetric(f.clave, SIN_RESPUESTA), `${f.nombre}: (sin respuesta)`, f.nombre, {
        additive: true,
        pivotable: true,
        help: 'Leads que no respondieron esta pregunta.',
      })
    );
  }
  out.push(fuente('cliente_respuestas', 'Respuestas de formulario', 'row', respuestas));

  // ── Campos calculados del informe ───────────────────────────────────
  out.push(
    fuente(
      'cliente_calc',
      'Campos calculados',
      'row',
      e.calculatedFields.map((c) =>
        medida(c.name, c.name, 'Del informe', { format: c.format, help: 'Fórmula del informe.' })
      )
    )
  );

  // ── Campos de Sheet ─────────────────────────────────────────────────
  const sheet: CatalogField[] = [];
  for (const f of e.sheetFields) {
    if (f.rol !== 'metrica' && !f.alta_cardinalidad) {
      sheet.push(dimension(makeSheetDim(f.clave), f.nombre, 'Agrupar por'));
    }
    const aggs: SheetCampoAgg[] = f.agregacion === 'count' ? ['count'] : ['count', f.agregacion];
    for (const agg of aggs) {
      const id = makeSheetMetric(agg, f.clave);
      sheet.push(
        medida(id, sheetFieldLabel(id, e.sheetFields, e.sheetViews) ?? f.nombre, 'Campos', {
          additive: agg === 'count' || agg === 'sum',
        })
      );
    }
  }
  for (const v of e.sheetViews) {
    sheet.push(medida(makeSheetView(v.clave), v.nombre, 'Vistas guardadas'));
  }
  out.push(fuente('cliente_sheet', 'Campos de Sheet', 'row', sheet));

  // ── Preguntas sin catalogar (claves crudas de raw_fields) ───────────
  // Las que ya cubre un campo de Leads no se repiten: la misma pregunta dos
  // veces, con conteos distintos, era la trampa del selector anterior.
  const cubiertas = new Set(e.leadFields.flatMap((f) => f.claves_origen));
  const crudas: CatalogField[] = [];
  for (const f of e.formFields) {
    if (!cubiertas.has(normalizarClaveLead(f.key))) {
      crudas.push(dimension(makeFieldDim(f.key), humanizeFieldKey(f.label), 'Agrupar por'));
    }
    const aggs: FieldAgg[] =
      f.type === 'number' ? ['sum', 'avg', 'min', 'max', 'count'] : ['count'];
    for (const agg of aggs) {
      crudas.push(
        medida(
          makeFieldMetric(agg, f.key),
          `${AGG_LABEL[agg]} · ${humanizeFieldKey(f.label)}`,
          'Medir',
          { additive: agg === 'sum' || agg === 'count' }
        )
      );
    }
  }
  out.push(fuente('cliente_crudos', 'Preguntas sin catalogar', 'row', crudas));

  // ── Offline y conversiones de Meta ──────────────────────────────────
  out.push(
    fuente(
      'cliente_offline',
      'Columnas de Sheet offline',
      'daily',
      e.offlineFields.map((f) => medida(makeOfflineFieldMetric(f.type, f.key), f.label, 'Columnas'))
    )
  );
  out.push(
    fuente(
      'cliente_metacc',
      'Conversiones de Meta',
      'daily',
      e.customConversions.map((c) =>
        medida(
          `metacc:${c.key}`,
          c.label,
          c.activa === false ? 'Sin actividad (90 días)' : 'Personalizadas',
          { additive: true }
        )
      )
    )
  );

  return out.filter((s): s is CatalogSource => s !== null);
}
