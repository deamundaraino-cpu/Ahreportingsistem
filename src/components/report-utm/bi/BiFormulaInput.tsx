'use client';

// Input de expresión con buscador de métricas.
//
// Escribir una fórmula obligaba a saberse de memoria la clave interna de cada
// métrica (`hotmart_revenue`, `initiates_checkout`…), que no se parece a la
// etiqueta que ve el usuario. Este componente añade un buscador que inserta la
// clave en la posición del cursor, igual que el editor de layouts del dashboard.

import { useRef, useState } from 'react';
import { Search, Plus, X } from 'lucide-react';
import {
  METRIC_META,
  humanizeFieldKey,
  fieldMetricAlias,
  offlineFieldAlias,
  sheetFieldAlias,
  sheetViewAlias,
  leadSegAlias,
  leadAnsAlias,
  metaCcAlias,
  ga4EvAlias,
} from '@/lib/report-utm/bi-metadata';
import { GA4_METRICAS } from '@/lib/ga4/metricas';
import type {
  BiMetric,
  FormFieldMeta,
  OfflineFieldMeta,
  SheetFieldMeta,
  SheetViewMeta,
  LeadSegmentoMeta,
  LeadFieldMeta,
  MetaCustomConvMeta,
  Ga4EventoMeta,
} from '@/lib/report-utm/bi-metadata';
import { refsOf } from '@/lib/report-utm/bi/expr';
import { respuestasDeCampo } from './fuentesDelCliente';
import { SIN_RESPUESTA } from '@/lib/leads/respuestas/claves';

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** Campos de formulario del cliente, para ofrecer sus alias f_sum__/f_avg__. */
  formFields?: FormFieldMeta[];
  /** Columnas adicionales de los Sheets offline, con sus alias off__. */
  offlineFields?: OfflineFieldMeta[];
  /** Campos de Sheet del cliente, con sus alias sf__. */
  sheetFields?: SheetFieldMeta[];
  /** Vistas guardadas de esos campos, con sus alias sv__. */
  sheetViews?: SheetViewMeta[];
  /** Segmentos de campo de lead, con sus alias lseg__. */
  leadSegments?: LeadSegmentoMeta[];
  /** Preguntas del catálogo: cada respuesta se ofrece con su alias lf__. */
  leadFields?: LeadFieldMeta[];
  /** Conversiones personalizadas de Meta, con sus alias mcc__. */
  customConversions?: MetaCustomConvMeta[];
  /** Eventos clave de GA4, con sus alias ga4ev__. */
  ga4Events?: Ga4EventoMeta[];
  placeholder?: string;
}

interface MetricOption {
  key: string;
  label: string;
  /**
   * Es un CONTEO de leads (respuesta o segmento): se ofrecen además los atajos
   * «CPL» (gasto ÷ esto) y «%» (esto ÷ leads × 100), que son las dos fórmulas
   * por las que existe. Así nadie tiene que escribir `spend / lf__…` a mano.
   */
  conteo?: boolean;
}

/** Agrupa el catálogo por origen, para que la lista sea navegable. */
function buildGroups(
  formFields: FormFieldMeta[],
  offlineFields: OfflineFieldMeta[],
  sheetFields: SheetFieldMeta[],
  sheetViews: SheetViewMeta[],
  leadSegments: LeadSegmentoMeta[],
  leadFields: LeadFieldMeta[] = [],
  customConversions: MetaCustomConvMeta[] = [],
  ga4Events: Ga4EventoMeta[] = []
): { title: string; items: MetricOption[] }[] {
  const of = (keys: string[]): MetricOption[] =>
    keys
      .filter((k) => METRIC_META[k as BiMetric])
      .map((k) => ({ key: k, label: METRIC_META[k as BiMetric].label }));

  const nucleo = of([
    'leads_count',
    'sales_count',
    'revenue',
    'spend',
    'meta_spend',
    'tiktok_spend',
    'clicks',
    'impressions',
    'cpl',
    'cpa',
    'roas',
    'conversion_rate',
    'cpc',
    'cpm',
  ]);
  const hotmart = of([
    'hotmart_revenue',
    'hotmart_sales',
    'hotmart_roas',
    'hotmart_cpa',
    'hotmart_roi',
    'hotmart_pagos_iniciados',
    'ventas_principal',
    'ventas_bump',
    'ventas_upsell',
    'ventas_principal_count',
    'ventas_bump_count',
    'ventas_upsell_count',
    'ventas_principal_bruto',
    'ventas_bump_bruto',
    'ventas_upsell_bruto',
    'ventas_cerradas',
    // Ventas por transacción (public.hotmart_ventas). Sin listarlas aquí caían
    // por descarte en el grupo de «campaña» (eventos de Meta/TikTok).
    'hm_ventas',
    'hm_compras',
    'hm_bumps',
    'hm_neto',
    'hm_bruto',
    'hm_reembolsos',
    'hm_neto_reembolsado',
    'hm_tasa_reembolso',
    'hm_roas',
    'hm_cpa',
    'hm_cpa_compra',
    'hm_ticket_medio',
    'hm_ticket_compra',
    'hm_tasa_bump',
    'hm_conversion',
    'hm_neto_usd',
    'hm_bruto_usd',
    'hm_tasa_cambio',
  ]);
  const ga = of([
    'ga_sessions',
    'ga_bounce_rate',
    'ga_avg_session_duration',
    // GA4 por campaña (migración 097): se reparten por campaña y UTM.
    ...GA4_METRICAS,
  ]);
  const offline = of(['offline_leads', 'offline_ventas', 'offline_revenue', 'offline_total']);
  const subs = of(['subs_active', 'subs_delayed', 'subs_canceled', 'subs_total', 'subs_mrr']);

  // El resto (métricas de campaña de Meta y TikTok) se agrupa por descarte.
  const used = new Set([...nucleo, ...hotmart, ...ga, ...offline, ...subs].map((m) => m.key));
  const campana = (Object.keys(METRIC_META) as BiMetric[])
    .filter((k) => !used.has(k))
    .map((k) => ({ key: k, label: METRIC_META[k].label }));

  const campos: MetricOption[] = formFields
    .filter((f) => f.type === 'number')
    .flatMap((f) => [
      { key: fieldMetricAlias('sum', f.key), label: `Suma de ${humanizeFieldKey(f.label)}` },
      { key: fieldMetricAlias('avg', f.key), label: `Promedio de ${humanizeFieldKey(f.label)}` },
    ])
    .filter((o) => !!o.key) as MetricOption[];

  // Columnas adicionales de los Sheets offline (alias off__<clave>).
  const columnasSheet: MetricOption[] = offlineFields.map((f) => ({
    key: offlineFieldAlias(f.key),
    label: `${f.label} (Sheet)`,
  }));

  // Campos de Sheet (alias sf__<clave>): el alias agrega con la agregación por
  // defecto del campo, que es la lectura natural al escribir una fórmula.
  const camposSheet: MetricOption[] = sheetFields.map((f) => ({
    key: sheetFieldAlias(f.clave),
    label: f.nombre,
  }));

  // Vistas guardadas (alias sv__<clave>): "Leads 20-100" y compañía.
  const vistasSheet: MetricOption[] = sheetViews.map((v) => ({
    key: sheetViewAlias(v.clave),
    label: v.nombre,
  }));

  // Segmentos de campo de lead (alias lseg__<clave>): «Rango de ingresos: Desde
  // 2M». Dividir el gasto por uno de estos da el CPL de ese tipo de lead, que es
  // la fórmula por la que existe toda la familia.
  const segmentosLead: MetricOption[] = leadSegments.map((s) => ({
    key: leadSegAlias(s.clave),
    label: s.campo_nombre ? `${s.campo_nombre}: ${s.nombre}` : s.nombre,
    conteo: true,
  }));

  // Cada respuesta de cada pregunta (alias lf__<campo>__<respuesta>), sin
  // necesidad de crear un segmento por respuesta.
  const respuestasLead: MetricOption[] = leadFields.flatMap((f) => [
    ...respuestasDeCampo(f).map((r) => ({
      key: leadAnsAlias(f.clave, r.clave),
      label: `${f.nombre}: ${r.nombre}`,
      conteo: true,
    })),
    {
      key: leadAnsAlias(f.clave, SIN_RESPUESTA),
      label: `${f.nombre}: (sin respuesta)`,
      conteo: true,
    },
  ]);

  // Eventos clave de GA4 (alias ga4ev__<evento>): «gasto ÷ esto» es el coste
  // por ese evento, repartible por campaña.
  const eventosGa4: MetricOption[] = ga4Events.map((ev) => ({
    key: ev.alias ?? ga4EvAlias(ev.key),
    label: `Evento clave: ${ev.label} (GA4)`,
    conteo: true,
  }));

  // Conversiones personalizadas de Meta (alias mcc__<clave>): «gasto ÷ esto» es
  // el coste por conversión. Las antiguas (90 días sin actividad) no se ofrecen,
  // pero una fórmula que ya las use sigue funcionando.
  const conversionesMeta: MetricOption[] = customConversions
    .filter((c) => c.activa !== false)
    .map((c) => ({
      key: c.alias ?? metaCcAlias(c.key),
      label: `${c.label} (Meta · conversión)`,
      conteo: true,
    }));

  return [
    { title: 'Núcleo', items: nucleo },
    { title: 'Campaña (Meta / TikTok)', items: campana },
    { title: 'Conversiones personalizadas de Meta', items: conversionesMeta },
    { title: 'Hotmart', items: hotmart },
    { title: 'Google Analytics', items: ga },
    { title: 'Eventos clave de GA4', items: eventosGa4 },
    { title: 'Offline', items: offline },
    { title: 'Respuestas de formulario', items: respuestasLead },
    { title: 'Segmentos de lead', items: segmentosLead },
    { title: 'Campos de Sheet', items: camposSheet },
    { title: 'Vistas de Sheet', items: vistasSheet },
    { title: 'Columnas de Sheets', items: columnasSheet },
    { title: 'Suscripciones', items: subs },
    { title: 'Campos del formulario', items: campos },
  ].filter((g) => g.items.length > 0);
}

export function BiFormulaInput({
  value,
  onChange,
  formFields = [],
  offlineFields = [],
  sheetFields = [],
  sheetViews = [],
  leadSegments = [],
  leadFields = [],
  customConversions = [],
  ga4Events = [],
  placeholder,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const groups = buildGroups(
    formFields,
    offlineFields,
    sheetFields,
    sheetViews,
    leadSegments,
    leadFields,
    customConversions,
    ga4Events
  );
  // Lectura en lenguaje natural de la fórmula: «Inversión ÷ Rango de ingresos:
  // $2M a $3M». Es la forma de comprobar que se eligió lo que se quería sin
  // tener que descifrar las claves internas.
  const etiquetaDe = new Map(groups.flatMap((g) => g.items.map((i) => [i.key, i.label])));
  const lectura = (() => {
    if (!value.trim()) return '';
    let refs: string[] = [];
    try {
      refs = refsOf(value);
    } catch {
      return '';
    }
    if (!refs.some((id) => etiquetaDe.has(id))) return '';
    return value
      .replace(/[a-z_][a-z0-9_.]*/gi, (id) => etiquetaDe.get(id) ?? id)
      .replace(/\//g, ' ÷ ')
      .replace(/\*/g, ' × ')
      .replace(/\s+/g, ' ')
      .trim();
  })();
  const q = search.trim().toLowerCase();
  const filtered = q
    ? groups
        .map((g) => ({
          ...g,
          items: g.items.filter((i) => i.label.toLowerCase().includes(q) || i.key.includes(q)),
        }))
        .filter((g) => g.items.length > 0)
    : groups;

  /** Inserta la clave donde está el cursor (o al final si el input perdió el foco). */
  function insert(key: string) {
    const el = inputRef.current;
    const pos = el?.selectionStart ?? value.length;
    const before = value.slice(0, pos);
    const after = value.slice(pos);
    // Espacio de cortesía si se pega justo después de un operador o texto.
    const sep = before && !/[\s(+\-*/]$/.test(before) ? ' ' : '';
    const next = `${before}${sep}${key}${after}`;
    onChange(next);
    setOpen(false);
    setSearch('');
    requestAnimationFrame(() => {
      el?.focus();
      const caret = before.length + sep.length + key.length;
      el?.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'revenue / sales_count'}
          className="flex-1 px-2.5 py-1.5 text-xs font-mono rounded-lg bg-muted border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          title="Insertar métrica"
          className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium border transition-colors ${
            open
              ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-border bg-muted text-muted-foreground hover:bg-accent'
          }`}
        >
          <Plus className="h-3 w-3" />
          Métrica
        </button>
      </div>
      {lectura && (
        <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
          Se lee como: <span className="text-foreground/80">{lectura}</span>
        </p>
      )}

      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-border bg-card shadow-xl overflow-hidden">
          <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <input
              autoFocus
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar métrica…"
              className="flex-1 bg-transparent text-xs text-foreground focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSearch('');
              }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                Sin coincidencias
              </p>
            ) : (
              filtered.map((g) => (
                <div key={g.title}>
                  <p className="px-3 pt-2 pb-1 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground bg-muted/40">
                    {g.title}
                  </p>
                  {g.items.map((i) => (
                    <div
                      key={i.key}
                      className="flex items-center gap-1 px-3 py-1 hover:bg-accent transition-colors"
                    >
                      {/* La clave interna solo al pasar el ratón: lo que se
                          elige es la etiqueta, no el identificador. */}
                      <button
                        type="button"
                        onClick={() => insert(i.key)}
                        title={i.key}
                        className="flex-1 min-w-0 text-left py-0.5"
                      >
                        <span className="block text-[11px] text-foreground truncate">
                          {i.label}
                        </span>
                      </button>
                      {i.conteo && (
                        <>
                          <button
                            type="button"
                            onClick={() => insert(`spend / ${i.key}`)}
                            title={`Costo por lead de «${i.label}»: inversión ÷ estos leads`}
                            className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 hover:bg-emerald-100"
                          >
                            CPL
                          </button>
                          <button
                            type="button"
                            onClick={() => insert(`${i.key} / leads_count * 100`)}
                            title={`Porcentaje de los leads que son «${i.label}»`}
                            className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-500/10 hover:bg-sky-100"
                          >
                            %
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
