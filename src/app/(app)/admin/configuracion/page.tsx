import { getNotificationRules, getClientesAndTabs, getBrandingSettings } from './_actions';
import { ConfiguracionClient } from './components/ConfiguracionClient';
import { Settings } from 'lucide-react';
import {
  getWhatsAppStatus,
  getWhatsAppQr,
  getGroups,
  getRoutes,
  getClientesMin,
  getRecentMessages,
} from '../whatsapp/_actions';
import { getUsers, getAllClients } from '../users/_actions';
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';

export const metadata = {
  title: 'Configuración y Alertas | AdsHouse',
  description: 'Panel unificado de configuración de alertas condicionales, servidor MCP, WhatsApp y usuarios.',
};

export default async function ConfiguracionPage() {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL?.replace('//', '//app.') ??
    '';

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/');

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role ?? 'viewer';
  if (!['superadmin', 'admin'].includes(role)) redirect('/dashboard');

  const [
    rules,
    dropdowns,
    waStatusRes,
    waQrRes,
    waGroups,
    waRoutes,
    waClientes,
    waMessages,
    initialUsers,
    allClients,
    branding,
  ] = await Promise.all([
    getNotificationRules(),
    getClientesAndTabs(),
    getWhatsAppStatus(),
    getWhatsAppQr(),
    getGroups(),
    getRoutes(),
    getClientesMin(),
    getRecentMessages(),
    getUsers(),
    getAllClients(),
    getBrandingSettings(),
  ]);

  const waStatus = 'status' in waStatusRes ? ((waStatusRes as any).status ?? null) : null;
  const waGatewayError =
    ('error' in waStatusRes
      ? (waStatusRes as any).error
      : waQrRes && 'error' in waQrRes
      ? (waQrRes as any).error
      : null) ?? null;
  const waQr = waQrRes && 'qr' in waQrRes ? ((waQrRes as any).qr ?? null) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-1">
        <Settings className="h-6 w-6 text-brand-blue dark:text-brand-blue-light" />
        <div>
          <h2 className="text-2xl font-bold text-foreground">Configuración Unificada</h2>
          <p className="text-muted-foreground">
            Gestiona alertas condicionales, el servidor MCP, integraciones de WhatsApp y la administración de usuarios.
          </p>
        </div>
      </div>

      <ConfiguracionClient
        initialRules={rules}
        clientes={dropdowns.clientes}
        tabs={dropdowns.tabs}
        baseUrl={baseUrl}
        waStatus={waStatus}
        waGatewayError={waGatewayError}
        waQr={waQr}
        waGroups={waGroups as any[]}
        waRoutes={waRoutes as any[]}
        waClientes={waClientes as any[]}
        waMessages={waMessages as any[]}
        initialUsers={initialUsers as any[]}
        allClients={allClients as any[]}
        currentRole={role}
        currentUserId={user.id}
        initialBranding={branding}
      />
    </div>
  );
}

