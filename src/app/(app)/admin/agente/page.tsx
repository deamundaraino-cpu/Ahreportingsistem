import { redirect } from 'next/navigation';
import { Bot } from 'lucide-react';

import { createClient, createAdminClient } from '@/utils/supabase/server';
import { AgenteClient } from './components/AgenteClient';
import {
  listarConversaciones,
  listarEstrategias,
  listarCanales,
  listarContactos,
  listarRemitentesVistos,
  leerEstadoAgente,
  leerPoliticaModelos,
} from './_actions';

export default async function AgentePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: perfil } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  const role = (perfil?.role as string) ?? 'viewer';
  // Un `viewer` no tiene nada que hacer aquí: el agente responde sobre clientes
  // y ese rol no tiene ninguno asignado.
  if (role === 'viewer') redirect('/dashboard');

  const esAdmin = ['superadmin', 'admin'].includes(role);
  const db = await createAdminClient();

  const [conversaciones, estrategias, canales, contactos, remitentes, estado, politica, clientes] =
    await Promise.all([
      listarConversaciones(),
      listarEstrategias(),
      esAdmin ? listarCanales() : Promise.resolve([]),
      esAdmin ? listarContactos() : Promise.resolve([]),
      esAdmin ? listarRemitentesVistos() : Promise.resolve([]),
      leerEstadoAgente(),
      leerPoliticaModelos(),
      db.from('clientes').select('id, nombre').order('nombre'),
    ]);

  const { data: usuarios } = esAdmin
    ? await db.from('user_profiles').select('id, role, full_name').order('role')
    : { data: [] };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Bot className="text-brand-blue dark:text-brand-blue-light h-6 w-6" />
        <div>
          <h2 className="text-foreground text-2xl font-bold tracking-tight">Agente</h2>
          <p className="text-muted-foreground">
            Pregunta por tus clientes en lenguaje natural y configura lo que el agente sabe de
            ellos.
          </p>
        </div>
      </div>

      <AgenteClient
        esAdmin={esAdmin}
        conversacionesIniciales={conversaciones}
        estrategiasIniciales={estrategias}
        canalesIniciales={canales}
        contactosIniciales={contactos}
        remitentesIniciales={remitentes}
        estado={estado}
        politica={politica}
        clientes={(clientes.data ?? []) as { id: string; nombre: string }[]}
        usuarios={(usuarios ?? []) as { id: string; role: string; full_name: string | null }[]}
      />
    </div>
  );
}
