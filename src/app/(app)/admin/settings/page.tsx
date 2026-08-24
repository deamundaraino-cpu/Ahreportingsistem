import { Card, CardTitle } from '@/components/ui/card';
import { getClientes, getGoogleConnectionStatus } from './_actions';
import { NewClientDialog } from './components/NewClientDialog';
import { GoogleConnectionCard } from './components/GoogleConnectionCard';
import { AtSign } from 'lucide-react';
import { ClienteCard } from './components/ClienteCard';

export default async function AdminClientesPage() {
  const [clientes, googleStatus] = await Promise.all([getClientes(), getGoogleConnectionStatus()]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Ajustes de Sistema Unificado</h2>
          <p className="text-muted-foreground">
            Configura accesos y credenciales de API para cada cliente.
          </p>
        </div>
        <NewClientDialog />
      </div>

      <GoogleConnectionCard connected={googleStatus.connected} email={googleStatus.email} />

      {!clientes || clientes.length === 0 ? (
        <Card className="bg-card border-border flex flex-col items-center justify-center p-12 text-center">
          <div className="bg-muted p-4 rounded-full mb-4">
            <AtSign className="h-8 w-8 text-muted-foreground/70" />
          </div>
          <CardTitle className="text-xl">Sin clientes registrados</CardTitle>
          <p className="text-muted-foreground mt-2 max-w-sm mb-6">
            Aún no has creado configuraciones para tus clientes. Empieza creando tu primer cliente
            para conectarlo a Meta o Hotmart.
          </p>
          <NewClientDialog />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {clientes.map((cliente: any) => (
            <ClienteCard key={cliente.id} cliente={cliente} />
          ))}
        </div>
      )}
    </div>
  );
}
