import { getLayouts } from '../settings/_actions';
import { LayoutBuilderClient } from './LayoutBuilderClient';
import { TabTemplatesManager } from './TabTemplatesManager';
import { listTabTemplates } from '../../dashboard/_actions';
import { createClient } from '@/utils/supabase/server';
import { redirect } from 'next/navigation';

export default async function LayoutsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = profile?.role ?? 'viewer';
  const isAdmin = ['superadmin', 'admin'].includes(role);

  // Los clientes solo se usan para elegir de cuál listar los campos de Sheet
  // en el catálogo de métricas: una plantilla global no pertenece a ninguno.
  const [layouts, tabTemplatesRes, clientesRes] = await Promise.all([
    getLayouts(),
    listTabTemplates(),
    supabase.from('clientes').select('id, nombre').order('nombre'),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-foreground">
          Constructor de Layouts
        </h2>
        <p className="text-muted-foreground">
          Crea y edita plantillas de métricas para asignarlas a tus clientes.
        </p>
      </div>
      <LayoutBuilderClient layouts={layouts} isAdmin={isAdmin} clientes={clientesRes.data || []} />
      <TabTemplatesManager templates={tabTemplatesRes.data || []} isAdmin={isAdmin} />
    </div>
  );
}
