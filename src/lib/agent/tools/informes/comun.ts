import 'server-only';

/**
 * Piezas que comparten las herramientas de informes.
 */

import { z } from 'zod';
import { ApiError } from '@/lib/error-handler';
import {
  aliasesDeCatalogo,
  camposDinamicosCliente,
  tokensDeCatalogo,
  type CamposDinamicos,
} from '@/lib/report-utm/bi/campos-cliente';
import { refsOf } from '@/lib/report-utm/bi/expr';
import type { BiFilters, BiWidget, CalculatedField } from '@/components/report-utm/bi/BiTypes';
import type { AgentContext } from '../../types';
import type { CatalogoCliente, Validacion } from './validacion';
import { todosLosWidgets } from './layout';

export const reportIdSchema = z.string().uuid().describe('Id del informe (de list_reports).');
export const clientIdSchema = z
  .string()
  .uuid()
  .describe('UUID del cliente, el que devuelven list_clients o resolve_client.');
export const fechaSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Fecha YYYY-MM-DD (zona Colombia).');

export function calcDe(valor: unknown): CalculatedField[] {
  return Array.isArray(valor) ? (valor as CalculatedField[]) : [];
}

export function filtersDe(valor: unknown): BiFilters {
  return valor && typeof valor === 'object' && !Array.isArray(valor)
    ? { ...(valor as BiFilters) }
    : {};
}

export function urlInforme(id: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/informes/${id}`;
}

export function urlPublica(token: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/report/bi/${token}`;
}

const PREFIJOS_DINAMICOS = [
  'leadfield:',
  'leadseg:',
  'leadans:',
  'offfield:',
  'metacc:',
  'ga4ev:',
  'sheetdim:',
  'sheetagg:',
  'sheetview:',
];
const ALIAS_DINAMICO = /^(lf__|lseg__|off__|sf__|sv__|ga4ev__)/i;

/** ¿Algún widget o fórmula usa campos propios del cliente? Solo entonces se carga el catálogo. */
export function usaCamposDinamicos(widgets: BiWidget[], expresiones: string[] = []): boolean {
  const tokens: string[] = [];
  for (const w of todosLosWidgets(widgets)) {
    const c = w.config ?? {};
    tokens.push(...String(c.metric ?? '').split(','), ...(c.metrics ?? []).map(String));
    if (c.dimension) tokens.push(String(c.dimension));
    if (c.dimension2) tokens.push(String(c.dimension2));
    if (c.formula) expresiones.push(c.formula);
  }
  if (tokens.some((t) => PREFIJOS_DINAMICOS.some((p) => t.trim().startsWith(p)))) return true;
  return expresiones.some((e) => refsOf(e).some((id) => ALIAS_DINAMICO.test(id)));
}

/** Catálogo del cliente para validar, o `undefined` si el informe no tiene cliente. */
export async function catalogoParaValidar(
  ctx: AgentContext,
  rtmId: string | null,
  publicId: string | null
): Promise<{ cat?: CatalogoCliente; campos?: CamposDinamicos; avisos: string[] }> {
  if (!rtmId) {
    return {
      avisos: [
        'El informe no tiene cliente: los campos propios de un cliente (preguntas, Sheets) no se pueden comprobar.',
      ],
    };
  }
  const campos = await camposDinamicosCliente(ctx.db, rtmId, publicId);
  return {
    cat: { tokens: tokensDeCatalogo(campos), aliases: aliasesDeCatalogo(campos) },
    campos,
    avisos: campos.avisos,
  };
}

/** Convierte los errores de validación en una excepción legible para el modelo. */
export function exigirValido(v: Validacion): void {
  if (v.errores.length) throw new ApiError('VALIDATION_ERROR', v.errores.join(' '), 400);
}

/** Respuesta estándar de una escritura directa. */
export function aplicado(
  datos: Record<string, unknown>,
  extra: { revisionId?: string | null; avisos?: string[] } = {}
): Record<string, unknown> {
  const avisos = [...new Set(extra.avisos ?? [])];
  return {
    estado: 'aplicado',
    ...datos,
    ...(extra.revisionId
      ? { revision_id: extra.revisionId, deshacer: 'restore_report_revision' }
      : {}),
    ...(avisos.length ? { warnings: avisos } : {}),
  };
}
