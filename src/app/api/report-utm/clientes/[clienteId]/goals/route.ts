// Metas del cliente (CPL objetivo, ROAS mínimo, etc.), usadas por los semáforos
// de los scorecards.
//
//   GET   → público a propósito: los informes compartidos (link público y links
//           de entrega) necesitan las metas para pintar los semáforos, y las
//           metas son los mismos objetivos que el cliente ya ve en su informe.
//           Solo se expone `goals`, nunca el resto de `config` (tokens, etc.).
//   PATCH → requiere sesión con rol de escritura.

import { NextRequest, NextResponse } from 'next/server';
import { reportUtmAdminClient } from '@/lib/report-utm/client';
import { checkWriteRole } from '@/lib/report-utm/auth';
import type { ClienteGoals } from '@/lib/report-utm/bi-metadata';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ clienteId: string }> };

const GOAL_KEYS: (keyof ClienteGoals)[] = [
  'cpl_max',
  'cpa_max',
  'roas_min',
  'leads_target',
  'budget',
];

/** Deja solo las claves de meta conocidas, con números finitos y positivos. */
function sanitizeGoals(raw: unknown): ClienteGoals {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out: ClienteGoals = {};
  for (const k of GOAL_KEYS) {
    const n = Number(src[k]);
    if (Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { clienteId } = await params;
  const rtm = await reportUtmAdminClient();
  const { data, error } = await rtm
    .from('clientes')
    .select('config')
    .eq('id', clienteId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const config = (data?.config ?? {}) as { goals?: unknown };
  return NextResponse.json({ data: sanitizeGoals(config.goals) });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { ok, role } = await checkWriteRole();
  if (!ok) {
    return NextResponse.json(
      { error: role ? 'Tu rol no permite editar metas' : 'Unauthorized' },
      { status: role ? 403 : 401 }
    );
  }

  const { clienteId } = await params;
  const body = await req.json().catch(() => ({}));
  const goals = sanitizeGoals(body?.goals);

  const rtm = await reportUtmAdminClient();
  const { data: current, error: readError } = await rtm
    .from('clientes')
    .select('config')
    .eq('id', clienteId)
    .maybeSingle();

  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });

  // Merge: no pisar el resto de la config del cliente.
  const config = { ...((current?.config ?? {}) as Record<string, unknown>), goals };

  const { error } = await rtm.from('clientes').update({ config }).eq('id', clienteId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ data: goals });
}
