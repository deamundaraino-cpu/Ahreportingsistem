import { notFound } from 'next/navigation';
import { createAdminClient } from '@/utils/supabase/server';
import { BiReportCanvas } from '@/components/report-utm/bi/BiReportCanvas';
import type { BiReport } from '@/components/report-utm/bi/BiTypes';
import { clienteDashboardDeInforme } from '@/lib/report-utm/bi/frescura';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ reportId: string }> };

export default async function ReportPage({ params }: Params) {
  const { reportId } = await params;
  const db = await createAdminClient();

  const { data, error } = await db.from('bi_reports').select('*').eq('id', reportId).maybeSingle();

  if (error || !data) notFound();

  const report: BiReport = {
    id: data.id,
    nombre: data.nombre,
    descripcion: data.descripcion,
    layout: Array.isArray(data.layout) ? data.layout : [],
    filters: typeof data.filters === 'object' && data.filters ? data.filters : {},
    calculated_fields: Array.isArray(data.calculated_fields) ? data.calculated_fields : [],
    public_token: data.public_token ?? null,
    cliente_id: data.cliente_id,
    schedule: typeof data.schedule === 'object' && data.schedule ? data.schedule : undefined,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };

  // Semáforo de última sincronización del cliente del informe (el mismo del
  // dashboard): el cliente del BI es el de report_utm; el semáforo lee el del
  // dashboard, así que se traduce aquí.
  const frescuraClienteId = await clienteDashboardDeInforme(report.cliente_id);

  return <BiReportCanvas report={report} frescuraClienteId={frescuraClienteId} />;
}
