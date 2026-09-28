/**
 * ¿Quién usa esta conversión personalizada de Meta?
 *
 * Antes de archivarla hay que saber qué informes y qué pestañas se quedarían
 * sin ella: archivar solo la oculta de los selectores, pero quien la busque
 * para editar un widget ya no la encontraría. Mismo patrón que
 * `report-utm/lead-campo-referencias.ts`, por TOKEN EXACTO (con `includes`, la
 * clave `lead` daría por usada `lead_webinar`).
 *
 * Formas:  `metacc:<clave>` (widget BI) · `mcc__<clave saneada>` (fórmula BI)
 *          · `meta_custom_<clave>` (fórmula de reportes).
 *
 * Se consulta bajo demanda (al archivar), nunca al cargar un selector: recorre
 * todos los informes y layouts, y la instancia es pequeña.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { aliasFormulaCc } from './conversiones-personalizadas';
import type { ReferenciaCampo, OrigenReferencia } from '@/lib/report-utm/lead-campo-referencias';

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Motivo si el texto referencia la conversión; `null` si no. Puro. */
export function motivoReferenciaConversion(texto: string, clave: string): string | null {
  const metacc = `metacc:${clave}`;
  // El token de widget va como string JSON completo: termina en comilla.
  if (texto.includes(`"${metacc}"`)) return `usa \`${metacc}\``;
  for (const ident of [aliasFormulaCc(clave), `meta_custom_${clave}`]) {
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapar(ident)}(?![A-Za-z0-9_])`);
    if (re.test(texto)) return `usa \`${ident}\``;
  }
  return null;
}

const TABLAS_LAYOUT: { tabla: string; origen: OrigenReferencia; porCliente: boolean }[] = [
  { tabla: 'cliente_tabs', origen: 'pestaña', porCliente: true },
  { tabla: 'clientes_layouts', origen: 'layout', porCliente: true },
  { tabla: 'tab_templates', origen: 'plantilla', porCliente: false },
  { tabla: 'layouts_reporte', origen: 'plantilla', porCliente: false },
];

/**
 * Informes y layouts que usan la conversión. `publicClienteId` es el id de
 * `public.clientes` (el del catálogo); los informes van por el id de report_utm.
 */
export async function buscarReferenciasConversion(
  db: any,
  publicClienteId: string,
  clave: string
): Promise<ReferenciaCampo[]> {
  const out: ReferenciaCampo[] = [];

  const { data: rtm } = await db
    .schema('report_utm')
    .from('clientes')
    .select('id')
    .eq('public_cliente_id', publicClienteId)
    .limit(1);
  const rtmId = (rtm as any[] | null)?.[0]?.id as string | undefined;

  if (rtmId) {
    const { data: informes, error } = await db
      .from('bi_reports')
      .select('id,nombre,layout,filters,calculated_fields')
      .eq('cliente_id', rtmId);
    if (!error) {
      for (const r of (informes ?? []) as any[]) {
        const motivo = motivoReferenciaConversion(
          JSON.stringify([r.layout ?? [], r.filters ?? {}, r.calculated_fields ?? []]),
          clave
        );
        if (motivo) {
          out.push({
            origen: 'informe',
            id: r.id,
            nombre: String(r.nombre ?? 'sin nombre'),
            motivo,
          });
        }
      }
    }
  }

  for (const { tabla, origen, porCliente } of TABLAS_LAYOUT) {
    let q = db.from(tabla).select('*');
    if (porCliente) q = q.eq('cliente_id', publicClienteId);
    const { data, error } = await q;
    if (error) continue;
    for (const fila of (data ?? []) as any[]) {
      const motivo = motivoReferenciaConversion(JSON.stringify(fila), clave);
      if (motivo) {
        out.push({
          origen,
          id: String(fila.id),
          nombre: String(
            fila?.nombre ?? fila?.title ?? `${origen} ${String(fila?.id ?? '').slice(0, 8)}`
          ),
          motivo,
        });
      }
    }
  }
  return out;
}
