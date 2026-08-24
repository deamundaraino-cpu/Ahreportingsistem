import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { createClient as createSSRClient } from '@/utils/supabase/server';
import { notifyUsers } from '@/lib/notifications/notify';

const GRAPH = 'https://graph.facebook.com/v19.0';

// Umbral: refrescar tokens que vencen en menos de N días.
const REFRESH_THRESHOLD_DAYS = 10;

// Cron de auto-refresh de tokens long-lived de Meta.
// Re-intercambia el token vigente por uno nuevo (~60 días) antes de que caduque,
// de modo que la conexión rueda indefinidamente sin re-login del cliente.
// Protegido por CRON_SECRET (mismo patrón que /api/worker).
export async function GET(request: Request) {
  const authError = requireCronAuth(request);
  if (authError) return authError;

  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    return NextResponse.json(
      { error: 'META_APP_ID/META_APP_SECRET no configurados' },
      { status: 500 }
    );
  }

  let supabase: any;
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  } else {
    supabase = await createSSRClient();
  }

  const { data: clientes, error } = await supabase
    .from('clientes')
    .select('id, nombre, config_api');
  if (error || !clientes) {
    return NextResponse.json({ error: 'Failed to fetch clients' }, { status: 500 });
  }

  const now = Date.now();
  const thresholdMs = REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  const results: { id: string; nombre: string; status: string; detail?: string }[] = [];

  for (const cliente of clientes) {
    const config = cliente.config_api || {};
    const token: string | undefined = config.meta_token;
    const expiresAt: string | undefined = config.meta_token_expires_at;

    // Solo procesar clientes con token OAuth y fecha de expiración registrada.
    if (!token || !expiresAt) continue;

    const expiresMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expiresMs)) continue;

    // Aún lejos de vencer → omitir.
    if (expiresMs - now > thresholdMs) {
      results.push({ id: cliente.id, nombre: cliente.nombre, status: 'skipped_valid' });
      continue;
    }

    try {
      const url = new URL(`${GRAPH}/oauth/access_token`);
      url.searchParams.set('grant_type', 'fb_exchange_token');
      url.searchParams.set('client_id', appId);
      url.searchParams.set('client_secret', appSecret);
      url.searchParams.set('fb_exchange_token', token);
      const res = await fetch(url.toString());
      const data = await res.json();

      if (data.error || !data.access_token) {
        // Token vencido o revocado: marcar para que la UI pida reconexión.
        await supabase
          .from('clientes')
          .update({ config_api: { ...config, meta_connection_status: 'expired' } })
          .eq('id', cliente.id);
        results.push({
          id: cliente.id,
          nombre: cliente.nombre,
          status: 'failed',
          detail: data.error?.message || 'Sin access_token',
        });
        continue;
      }

      const newToken: string = data.access_token;
      const expiresIn: number = data.expires_in ?? 60 * 24 * 60 * 60;
      const newExpiresAt = new Date(now + expiresIn * 1000).toISOString();

      await supabase
        .from('clientes')
        .update({
          config_api: {
            ...config,
            meta_token: newToken,
            meta_token_expires_at: newExpiresAt,
            meta_connection_status: 'connected',
          },
        })
        .eq('id', cliente.id);

      results.push({
        id: cliente.id,
        nombre: cliente.nombre,
        status: 'refreshed',
        detail: newExpiresAt,
      });
    } catch (err: any) {
      results.push({
        id: cliente.id,
        nombre: cliente.nombre,
        status: 'error',
        detail: err.message,
      });
    }
  }

  const refreshed = results.filter((r) => r.status === 'refreshed').length;
  const failures = results.filter((r) => r.status === 'failed' || r.status === 'error');

  // Aviso in-app a admins si algún token no pudo refrescarse (un solo aviso por corrida)
  if (failures.length > 0 && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    await notifyUsers({
      db: supabase,
      type: 'token_expiring',
      severity: 'error',
      audience: 'admins',
      title: `Fallo al refrescar tokens de Meta (${failures.length})`,
      message: failures
        .map((f) => `${f.nombre}: ${f.detail ?? f.status}`)
        .join(' · ')
        .slice(0, 300),
      link: '/admin/settings',
      metadata: { failures: failures.map((f) => ({ id: f.id, status: f.status })) },
    });
  }

  return NextResponse.json({
    ok: true,
    refreshed,
    failed: failures.length,
    total: results.length,
    results,
  });
}
