'use client';

import { useState, useTransition } from 'react';
import { BarChart3, Eye, EyeOff, Save, FlaskConical } from 'lucide-react';
import {
  saveGoogleAdsConfigAction,
  testGoogleAdsAction,
} from '@/app/(report-utm)/report-utm/clientes/[clienteId]/_actions';
import { FeedbackLine, LastErrorAlert } from './FeedbackLine';
import { IntegrationStatusBadge } from './StatusBadge';

const ACCENT = 'bg-yellow-50 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-400';
const ICON_BG = 'bg-yellow-50 dark:bg-yellow-500/10';
const ICON_COLOR = 'text-yellow-600 dark:text-yellow-400';

type Integration = {
  id: string;
  status: 'active' | 'inactive' | 'error';
  config: Record<string, unknown>;
  last_sync_at: string | null;
  last_error: string | null;
} | null;

export function GoogleAdsCard({
  clienteId,
  integration,
}: {
  clienteId: string;
  integration: Integration;
}) {
  const [pending, startTransition] = useTransition();
  const [customerId, setCustomerId] = useState(String(integration?.config?.customer_id ?? ''));
  const [conversionAction, setConversionAction] = useState(
    String(integration?.config?.conversion_action ?? '')
  );
  const [loginCustomerId, setLoginCustomerId] = useState(
    String(integration?.config?.login_customer_id ?? '')
  );
  const [accessToken, setAccessToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const onSave = () => {
    if (!customerId.trim()) {
      setError('Customer ID requerido');
      return;
    }
    if (!conversionAction.trim()) {
      setError('Conversion Action requerido');
      return;
    }
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const r = await saveGoogleAdsConfigAction(clienteId, {
        customerId: customerId.trim(),
        conversionAction: conversionAction.trim(),
        loginCustomerId: loginCustomerId.trim() || null,
        accessToken: accessToken.trim() || null,
      });
      if (!r.ok) setError(r.error);
      else {
        setSuccess('Configuración guardada');
        setAccessToken('');
      }
    });
  };

  const onTest = () => {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const r = await testGoogleAdsAction(clienteId);
      if (!r.ok) setError(r.error);
      else setSuccess('Conexión con Google Ads verificada');
    });
  };

  const isConfigured = Boolean(
    integration?.config?.customer_id && integration?.config?.conversion_action
  );

  return (
    <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
            <BarChart3 className={`h-5 w-5 ${ICON_COLOR}`} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Google Ads · Conversiones Offline
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isConfigured
                ? `Customer ${String(integration?.config?.customer_id)} · Conversiones automáticas activas`
                : 'Envía conversiones offline a Google Ads cuando llegue una venta con gclid'}
            </p>
          </div>
        </div>
        {isConfigured && (
          <IntegrationStatusBadge status={integration?.status ?? 'active'} activeCls={ACCENT} />
        )}
      </div>

      {integration?.last_error && <LastErrorAlert message={integration.last_error} />}

      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-muted-foreground mb-1">
              Customer ID
            </span>
            <input
              type="text"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              placeholder="1234567890"
              className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-yellow-500/40 font-mono"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-muted-foreground mb-1">
              Login Customer ID <span className="text-muted-foreground/60">(MCC, opcional)</span>
            </span>
            <input
              type="text"
              value={loginCustomerId}
              onChange={(e) => setLoginCustomerId(e.target.value)}
              placeholder="9876543210"
              className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-yellow-500/40 font-mono"
            />
          </label>
        </div>

        <label className="block">
          <span className="block text-xs font-medium text-muted-foreground mb-1">
            Conversion Action Resource Name
          </span>
          <input
            type="text"
            value={conversionAction}
            onChange={(e) => setConversionAction(e.target.value)}
            placeholder="customers/1234567890/conversionActions/987654321"
            className="w-full px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-yellow-500/40 font-mono"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">
            Encontralo en Google Ads → Herramientas → Conversiones → Acción → Details
          </p>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-muted-foreground mb-1">
            Access Token OAuth2{' '}
            {isConfigured && (
              <span className="text-muted-foreground/60">(dejá vacío para mantener el actual)</span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <input
              type={showToken ? 'text' : 'password'}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={isConfigured ? '••••••••••••' : 'ya29.xxxxxxxxxxxx...'}
              className="flex-1 px-3 py-2 text-xs rounded-lg border border-border bg-muted text-foreground focus:outline-none focus:ring-2 focus:ring-yellow-500/40 font-mono"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              aria-label={showToken ? 'Ocultar token' : 'Mostrar token'}
              className="p-2 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </div>
        </label>
      </div>

      <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
        <button
          onClick={onSave}
          disabled={pending || !customerId.trim() || !conversionAction.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                               text-white bg-yellow-600 hover:bg-yellow-700
                               disabled:opacity-50 transition-colors"
        >
          <Save className="h-3.5 w-3.5" />
          {pending ? 'Guardando…' : 'Guardar configuración'}
        </button>
        {isConfigured && (
          <button
            onClick={onTest}
            disabled={pending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                                   border border-yellow-200 dark:border-yellow-500/30
                                   text-yellow-700 dark:text-yellow-400
                                   hover:bg-yellow-50 dark:hover:bg-yellow-500/10
                                   disabled:opacity-50 transition-colors"
          >
            <FlaskConical className="h-3.5 w-3.5" />
            Verificar conexión
          </button>
        )}
      </div>

      {error && <FeedbackLine variant="error" message={error} />}
      {success && <FeedbackLine variant="success" message={success} />}

      <div className="text-xs text-muted-foreground space-y-1 pt-1">
        <p>
          Las ventas <strong>aprobadas con gclid</strong> se envían automáticamente como conversión
          offline.
        </p>
        <p>
          El gclid se captura via pixel JS o S2S cuando el visitante viene de Google Ads y luego
          convierte en Hotmart, CartPanda o Shopify.
        </p>
      </div>
    </div>
  );
}
