import { Settings } from 'lucide-react';
import { PhaseStub } from '@/components/report-utm/PhaseStub';

export default function IntegracionesPage() {
  return (
    <PhaseStub
      icon={Settings}
      title="Integraciones"
      phase="Fase 1-2"
      description="Conectar plataformas externas por cliente del módulo. Cada integración guarda sus credenciales aisladas en report_utm.integrations (no se mezcla con la config_api del reporting principal)."
      bullets={[
        'Hotmart — webhook secret HMAC + endpoint dedicado',
        'Meta Ads — OAuth + sync de campaigns',
        'Google Ads — OAuth + sync de campaigns',
        'CartPanda / Shopify — webhooks adicionales',
      ]}
    />
  );
}
