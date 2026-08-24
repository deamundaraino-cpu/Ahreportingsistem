'use client';

import { useSyncExternalStore } from 'react';
import { Table as TableIcon, LayoutGrid } from 'lucide-react';
import type { ReportUtmLeadEvent } from '@/lib/report-utm/types';
import { AttributionBadge } from '@/components/report-utm/AttributionBadge';
import { formatDateTime } from '@/lib/report-utm/formatters';
import { PLUGIN_LABELS, dec } from '@/lib/report-utm/leads-display';

type View = 'table' | 'cards';
const STORAGE_KEY = 'report-utm:leads-view';

// Store externo sobre localStorage: leído con useSyncExternalStore para evitar
// hydration mismatch (el snapshot del servidor siempre es 'table') y avisar a
// todas las instancias cuando cambia la preferencia, incluso en la misma pestaña.
const listeners = new Set<() => void>();

function readView(): View {
  if (typeof window === 'undefined') return 'table';
  return window.localStorage.getItem(STORAGE_KEY) === 'cards' ? 'cards' : 'table';
}

function writeView(v: View) {
  try {
    window.localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* storage no disponible */
  }
  listeners.forEach((l) => l());
}

function subscribeView(cb: () => void) {
  listeners.add(cb);
  window.addEventListener('storage', cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener('storage', cb);
  };
}

export function LeadsView({
  leads,
  clienteMap,
}: {
  leads: ReportUtmLeadEvent[];
  clienteMap: Record<string, string>;
}) {
  const view = useSyncExternalStore(subscribeView, readView, () => 'table');
  const changeView = (v: View) => writeView(v);

  const clienteNombre = (lead: ReportUtmLeadEvent) =>
    clienteMap[lead.cliente_id] ?? lead.cliente_id;

  return (
    <div className="space-y-3">
      {/* Toggle de vista */}
      <div className="flex justify-end">
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
          <ViewButton
            active={view === 'table'}
            onClick={() => changeView('table')}
            icon={<TableIcon className="h-3.5 w-3.5" />}
            label="Tabla"
          />
          <ViewButton
            active={view === 'cards'}
            onClick={() => changeView('cards')}
            icon={<LayoutGrid className="h-3.5 w-3.5" />}
            label="Tarjetas"
          />
        </div>
      </div>

      {view === 'table' ? (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full">
              <thead className="sticky top-0 z-10 bg-muted">
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3">Fecha</th>
                  <th className="px-4 py-3">Lead</th>
                  <th className="px-4 py-3">Formulario</th>
                  <th className="px-4 py-3">Cliente</th>
                  <th className="px-4 py-3">UTM Source</th>
                  <th className="px-4 py-3">UTM Medium</th>
                  <th className="px-4 py-3">UTM Campaign</th>
                  <th className="px-4 py-3">UTM Content</th>
                  <th className="px-4 py-3">UTM Term</th>
                  <th className="px-4 py-3">UTM ID</th>
                  <th className="px-4 py-3">Atribución</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {leads.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} clienteNombre={clienteNombre(lead)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {leads.map((lead) => (
            <LeadCard key={lead.id} lead={lead} clienteNombre={clienteNombre(lead)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        active ? 'bg-emerald-600 text-white' : 'text-muted-foreground hover:bg-accent'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// Vista tabla
// ─────────────────────────────────────────────────────────────

function LeadRow({ lead, clienteNombre }: { lead: ReportUtmLeadEvent; clienteNombre: string }) {
  const hasRawFields = lead.raw_fields && Object.keys(lead.raw_fields).length > 0;

  return (
    <>
      <tr className="hover:bg-accent/50 group">
        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap align-top">
          {formatDateTime(lead.created_at)}
        </td>
        <td className="px-4 py-3 align-top">
          <div className="space-y-0.5">
            {lead.lead_name && (
              <p className="text-xs font-medium text-foreground">{lead.lead_name}</p>
            )}
            {lead.lead_email && (
              <p className="text-[11px] text-muted-foreground font-mono">{lead.lead_email}</p>
            )}
            {lead.lead_phone && (
              <p className="text-[11px] text-muted-foreground">{lead.lead_phone}</p>
            )}
            {!lead.lead_name && !lead.lead_email && !lead.lead_phone && (
              <p className="text-[11px] text-muted-foreground italic">Sin datos de contacto</p>
            )}
          </div>
        </td>
        <td className="px-4 py-3 align-top">
          {lead.form_name && (
            <p className="text-xs font-medium text-foreground">{lead.form_name}</p>
          )}
          {lead.form_plugin && (
            <p className="text-[10px] text-muted-foreground">
              {PLUGIN_LABELS[lead.form_plugin] ?? lead.form_plugin}
            </p>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-muted-foreground align-top">{clienteNombre}</td>
        <UtmCell value={lead.utm_source} accent />
        <UtmCell value={lead.utm_medium} />
        <UtmCell value={lead.utm_campaign} />
        <UtmCell value={lead.utm_content} />
        <UtmCell value={lead.utm_term} />
        <UtmCell value={lead.utm_id} mono />
        <td className="px-4 py-3 align-top">
          <AttributionBadge method={lead.attribution_method ?? 'none'} />
        </td>
      </tr>
      {/* Detalle expandible: click_id, landing, país + campos del formulario */}
      <tr className="bg-muted/30">
        <td colSpan={11} className="px-4 py-2">
          <details className="text-[11px]">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
              Ver detalle
              {hasRawFields
                ? ` · ${Object.keys(lead.raw_fields!).length} campos del formulario`
                : ''}
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                <DetailItem label="Click ID" value={lead.click_id} mono />
                <DetailItem label="País" value={lead.ip_country} />
                <DetailItem label="Página de destino" value={lead.page_url} mono span />
              </div>
              {hasRawFields && (
                <div>
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                    Campos del formulario
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                    {Object.entries(lead.raw_fields!).map(([key, val]) => (
                      <DetailItem key={key} label={key} value={String(val ?? '')} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}

/** Celda compacta para un UTM: decodifica, trunca y muestra el valor completo en tooltip. */
function UtmCell({
  value,
  accent,
  mono,
}: {
  value: string | null;
  accent?: boolean;
  mono?: boolean;
}) {
  const v = dec(value);
  if (!v) return <td className="px-4 py-3 text-xs text-muted-foreground align-top">—</td>;
  return (
    <td className="px-4 py-3 align-top max-w-[180px]">
      <span
        className={`block text-xs truncate ${mono ? 'font-mono' : ''} ${
          accent ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-foreground'
        }`}
        title={v}
      >
        {v}
      </span>
    </td>
  );
}

function DetailItem({
  label,
  value,
  mono,
  span,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  span?: boolean;
}) {
  return (
    <div
      className={`bg-card rounded-lg border border-border px-2 py-1.5 ${span ? 'col-span-2 md:col-span-3 lg:col-span-4' : ''}`}
    >
      <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide truncate">
        {label}
      </p>
      <p
        className={`text-xs text-foreground ${span ? 'break-all' : 'truncate'} ${mono ? 'font-mono' : ''}`}
        title={value ?? ''}
      >
        {value || '—'}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Vista tarjetas
// ─────────────────────────────────────────────────────────────

function LeadCard({ lead, clienteNombre }: { lead: ReportUtmLeadEvent; clienteNombre: string }) {
  const hasRawFields = lead.raw_fields && Object.keys(lead.raw_fields).length > 0;
  const hasContact = lead.lead_name || lead.lead_email || lead.lead_phone;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3">
      {/* Cabecera: nombre + fecha */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {lead.lead_name ? (
            <p className="text-sm font-semibold text-foreground truncate">{lead.lead_name}</p>
          ) : (
            <p className="text-sm font-semibold text-muted-foreground italic">Sin nombre</p>
          )}
          <div className="mt-0.5 space-y-0.5">
            {lead.lead_email && (
              <p className="text-[11px] text-muted-foreground font-mono break-all">
                {lead.lead_email}
              </p>
            )}
            {lead.lead_phone && (
              <p className="text-[11px] text-muted-foreground">{lead.lead_phone}</p>
            )}
            {!hasContact && (
              <p className="text-[11px] text-muted-foreground italic">Sin datos de contacto</p>
            )}
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-muted-foreground whitespace-nowrap">
          {formatDateTime(lead.created_at)}
        </span>
      </div>

      {/* Formulario + cliente */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground border-t border-border pt-3">
        {lead.form_name && <span className="font-medium text-foreground">{lead.form_name}</span>}
        {lead.form_plugin && <span>· {PLUGIN_LABELS[lead.form_plugin] ?? lead.form_plugin}</span>}
        <span>· {clienteNombre}</span>
      </div>

      {/* UTMs como chips etiquetados */}
      <div className="flex flex-wrap gap-1.5">
        <UtmChip label="source" value={lead.utm_source} accent />
        <UtmChip label="medium" value={lead.utm_medium} />
        <UtmChip label="campaign" value={lead.utm_campaign} />
        <UtmChip label="content" value={lead.utm_content} />
        <UtmChip label="term" value={lead.utm_term} />
        <UtmChip label="id" value={lead.utm_id} mono />
      </div>

      {/* Atribución */}
      <div>
        <AttributionBadge method={lead.attribution_method ?? 'none'} />
      </div>

      {/* Detalle expandible */}
      <details className="text-[11px] border-t border-border pt-3">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
          Ver detalle
          {hasRawFields ? ` · ${Object.keys(lead.raw_fields!).length} campos del formulario` : ''}
        </summary>
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <DetailItem label="Click ID" value={lead.click_id} mono />
            <DetailItem label="País" value={lead.ip_country} />
            <DetailItem label="Página de destino" value={lead.page_url} mono span />
          </div>
          {hasRawFields && (
            <div>
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">
                Campos del formulario
              </p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(lead.raw_fields!).map(([key, val]) => (
                  <DetailItem key={key} label={key} value={String(val ?? '')} />
                ))}
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/** Chip con etiqueta del parámetro UTM y su valor decodificado. */
function UtmChip({
  label,
  value,
  accent,
  mono,
}: {
  label: string;
  value: string | null;
  accent?: boolean;
  mono?: boolean;
}) {
  const v = dec(value);
  if (!v) return null;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] ${
        accent ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'bg-muted/50'
      }`}
      title={`${label}: ${v}`}
    >
      <span className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={`truncate ${mono ? 'font-mono' : ''} ${accent ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-foreground'}`}
      >
        {v}
      </span>
    </span>
  );
}
