'use client';

import { useState } from 'react';
import { FileDown } from 'lucide-react';
import { exportReportPdf } from './exportPdf';

interface Props {
  agencyLogo?: string;
  agencyName?: string;
  accent?: string; // color de acento del cliente (hex)
  clienteName?: string;
  clienteLogo?: string;
  reportName: string;
  /** Período de la entrega. Ej. "Semana 2 de Julio 2026". */
  periodLabel?: string;
}

export function BiPublicHeader({
  agencyLogo,
  agencyName = 'Ad House Reporting',
  accent,
  clienteName,
  clienteLogo,
  reportName,
  periodLabel,
}: Props) {
  const [exporting, setExporting] = useState(false);
  const brand = accent || '#10b981';

  async function handlePdf() {
    setExporting(true);
    try {
      await exportReportPdf('bi-canvas-grid', reportName);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      className="mb-6 rounded-2xl border border-border bg-card px-5 py-4"
      style={{ borderTop: `3px solid ${brand}` }}
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        {/* Agencia */}
        <div className="flex items-center gap-3">
          {agencyLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={agencyLogo}
              alt={agencyName}
              className="h-8 w-auto max-w-[160px] object-contain"
            />
          ) : (
            <span className="text-sm font-bold tracking-tight text-foreground">{agencyName}</span>
          )}
          {periodLabel && (
            <span
              className="px-2.5 py-1 rounded-full text-[11px] font-semibold"
              style={{ backgroundColor: `${brand}1f`, color: brand }}
            >
              {periodLabel}
            </span>
          )}
        </div>

        {/* Cliente + acciones */}
        <div className="flex items-center gap-3">
          {clienteName && (
            <div className="flex items-center gap-2">
              {clienteLogo && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={clienteLogo}
                  alt={clienteName}
                  className="h-7 w-auto max-w-[120px] object-contain"
                />
              )}
              <div className="text-right leading-tight">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Informe para
                </p>
                <p className="text-sm font-semibold" style={{ color: brand }}>
                  {clienteName}
                </p>
              </div>
            </div>
          )}
          <button
            onClick={handlePdf}
            disabled={exporting}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium bg-muted text-foreground hover:bg-accent transition-colors disabled:opacity-50"
          >
            <FileDown className="h-3.5 w-3.5" />
            {exporting ? 'Generando…' : 'Descargar PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}
