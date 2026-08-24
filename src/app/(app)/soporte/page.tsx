import { getAllSoporteTickets } from '../dashboard/_actions';
import { getClientes } from '../admin/settings/_actions';
import { createClient } from '@/utils/supabase/server';
import { SoporteClient } from './SoporteClient';

export default async function SoportePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let userRole = 'viewer';
  if (user) {
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    if (profile?.role) userRole = profile.role;
  }

  const [soporteResult, clientes] = await Promise.all([getAllSoporteTickets(), getClientes()]);

  const tickets = (soporteResult.data ?? []).map((t: any) => ({
    ...t,
    cliente: t.cliente ?? null,
  }));

  const clientesList = (clientes ?? []).map((c: any) => ({ id: c.id, nombre: c.nombre }));

  return (
    <div className="space-y-6">
      <SoporteClient tickets={tickets} clientes={clientesList} userRole={userRole} />
    </div>
  );
}
