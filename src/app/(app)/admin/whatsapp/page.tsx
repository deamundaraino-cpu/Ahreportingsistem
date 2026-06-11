import {
  getWhatsAppStatus,
  getWhatsAppQr,
  getGroups,
  getRoutes,
  getClientesMin,
  getRecentMessages,
} from './_actions';
import { WhatsAppConfigClient } from './components/WhatsAppConfigClient';

export default async function AdminWhatsAppPage() {
  const [statusRes, qrRes, groups, routes, clientes, messages] = await Promise.all([
    getWhatsAppStatus(),
    getWhatsAppQr(),
    getGroups(),
    getRoutes(),
    getClientesMin(),
    getRecentMessages(),
  ]);

  const status = 'status' in statusRes ? (statusRes.status ?? null) : null;
  const gatewayError =
    ('error' in statusRes ? statusRes.error : 'error' in qrRes ? qrRes.error : null) ?? null;
  const qr = qrRes && 'qr' in qrRes ? (qrRes.qr ?? null) : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Notificaciones de WhatsApp</h2>
        <p className="text-muted-foreground">
          Conecta el número de la agencia y rutea grupos por cliente o por tipo de notificación.
        </p>
      </div>

      <WhatsAppConfigClient
        status={status}
        gatewayError={gatewayError}
        qr={qr}
        groups={groups}
        routes={routes as never[]}
        clientes={clientes}
        messages={messages as never[]}
      />
    </div>
  );
}
