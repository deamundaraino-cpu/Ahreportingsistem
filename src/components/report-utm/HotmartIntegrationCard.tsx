'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { RefreshCw, Power, KeyRound, Webhook, Lightbulb, ShieldCheck } from 'lucide-react';
import {
  activateHotmartIntegrationAction,
  guardarHottokHotmartAction,
  rotateHotmartSecretAction,
  setHotmartIntegrationStatusAction,
} from '@/app/(app)/admin/settings/[id]/_actions-conexiones';
import type { ReportUtmHotmartIntegracion } from '@/lib/report-utm/types';
import { CopyField, useCopyHandler } from './CopyField';
import { FeedbackLine, LastErrorAlert } from './FeedbackLine';
import { IntegrationStatusBadge } from './StatusBadge';
import { formatDateTime } from '@/lib/report-utm/formatters';
import { ACENTO } from './acento';

const ACCENT = ACENTO.badge;
const ICON_BG = ACENTO.iconoFondo;
const ICON_COLOR = ACENTO.iconoColor;
const BTN = ACENTO.boton;

/**
 * Los eventos que hay que marcar en Hotmart. Son los que el webhook trata como
 * venta (`src/lib/hotmart/eventos.ts`); el resto responde 200 y se ignora, así
 * que marcarlos solo genera tráfico.
 */
const EVENTOS_HOTMART = [
  'PURCHASE_APPROVED',
  'PURCHASE_COMPLETE',
  'PURCHASE_CANCELED',
  'PURCHASE_REFUNDED',
  'PURCHASE_CHARGEBACK',
  'PURCHASE_EXPIRED',
  'PURCHASE_DELAYED',
  'PURCHASE_BILLET_PRINTED',
] as const;

/**
 * Hotmart · Webhook, en tres pasos.
 *
 * La tarjeta anterior generaba un secreto y pedía configurarlo «como hottok o
 * secreto HMAC». Ninguna de las dos cosas es posible: el hottok lo genera
 * Hotmart (uno fijo por cuenta, no editable) y Hotmart no firma con HMAC. Por
 * eso ningún cliente llegó a recibir un solo evento. Ahora el usuario pega el
 * hottok de Hotmart y el webhook valida contra él; nuestro secreto queda en
 * «Avanzado» para HMAC y la URL heredada.
 */
export function HotmartIntegrationCard({
  clienteId,
  integration,
  webhookOrigin,
}: {
  clienteId: string;
  integration: ReportUtmHotmartIntegracion | null;
  webhookOrigin: string;
}) {
  const [pending, startTransition] = useTransition();
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [hottok, setHottok] = useState('');
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const webhookUrl = `${webhookOrigin}/api/report-utm/webhooks/hotmart/${clienteId}`;
  const copyUrl = useCopyHandler(setCopiedUrl);
  const copySecret = useCopyHandler(setCopiedSecret);

  const limpiar = () => {
    setError(null);
    setSuccess(null);
  };

  const onGuardarHottok = () => {
    limpiar();
    startTransition(async () => {
      const r = await guardarHottokHotmartAction(clienteId, hottok);
      if (!r.ok) setError(r.error);
      else {
        setHottok('');
        setSuccess('Hottok guardado. El próximo evento de Hotmart ya se valida contra él.');
      }
    });
  };

  const onGenerarSecreto = () => {
    limpiar();
    startTransition(async () => {
      const r = integration
        ? await rotateHotmartSecretAction(clienteId)
        : await activateHotmartIntegrationAction(clienteId);
      if (!r.ok) setError(r.error);
      else if (r.secret) setRevealedSecret(r.secret);
    });
  };

  const onRotate = () => {
    if (!confirm('¿Rotar el secreto propio? Lo que firme con el anterior dejará de validar.'))
      return;
    onGenerarSecreto();
  };

  const onToggle = () => {
    if (!integration) return;
    const next = integration.status === 'active' ? 'inactive' : 'active';
    limpiar();
    startTransition(async () => {
      const r = await setHotmartIntegrationStatusAction(clienteId, next);
      if (!r.ok) setError(r.error);
    });
  };

  const isActive = integration?.status === 'active';
  const hottokListo = Boolean(integration?.hottok_configurado);

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm p-6 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${ICON_BG}`}>
            <Webhook className={`h-5 w-5 ${ICON_COLOR}`} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Hotmart · Webhook</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Ventas en vivo, con las UTM del checkout. La API de Hotmart sigue trayendo las
              comisiones; esto suma la atribución y la inmediatez.
            </p>
          </div>
        </div>
        {integration && <IntegrationStatusBadge status={integration.status} activeCls={ACCENT} />}
      </div>

      {/* ── Paso 1 ─────────────────────────────────────────────── */}
      <Paso n={1} titulo="Pegá esta URL en Hotmart">
        <p className="text-xs text-muted-foreground">
          En Hotmart: <strong>Herramientas → Webhook (API y notificaciones)</strong> → nueva
          configuración, con la <strong>versión 2.0.0</strong>.
        </p>
        <CopyField
          label="URL del webhook"
          value={webhookUrl}
          onCopy={() => copyUrl(webhookUrl)}
          copied={copiedUrl}
        />
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1.5">Eventos a marcar</p>
          <div className="flex flex-wrap gap-1.5">
            {EVENTOS_HOTMART.map((e) => (
              <code
                key={e}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-foreground/90"
              >
                {e}
              </code>
            ))}
          </div>
        </div>
      </Paso>

      {/* ── Paso 2 ─────────────────────────────────────────────── */}
      <Paso n={2} titulo="Pegá el hottok de Hotmart">
        <p className="text-xs text-muted-foreground">
          En esa misma pantalla de Webhook, Hotmart muestra el <strong>hottok</strong> de tu cuenta
          (uno fijo, no se puede editar). Hotmart lo manda con cada evento y así se comprueba que el
          evento es suyo. Se guarda cifrado.
        </p>
        {hottokListo && (
          <p className="text-xs flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
            <ShieldCheck className="h-3.5 w-3.5" />
            Hottok configurado{' '}
            <code className="font-mono">
              {integration?.hottok_final ? `…${integration.hottok_final}` : ''}
            </code>
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="password"
            value={hottok}
            onChange={(e) => setHottok(e.target.value)}
            placeholder={hottokListo ? 'Pegá uno nuevo para reemplazarlo' : 'Hottok de Hotmart'}
            autoComplete="off"
            aria-label="Hottok de Hotmart"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono text-foreground
                           placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-blue-500/40"
          />
          <button
            onClick={onGuardarHottok}
            disabled={pending || !hottok.trim()}
            className={`inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white shadow-sm ${BTN} transition-colors disabled:opacity-50`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            {pending ? 'Guardando…' : 'Guardar hottok'}
          </button>
        </div>
        {!hottokListo && (
          <p className="text-[11px] text-muted-foreground">
            Guardalo antes de activar el webhook en Hotmart: sin hottok los eventos se rechazan.
          </p>
        )}
      </Paso>

      {/* ── Paso 3 ─────────────────────────────────────────────── */}
      <Paso n={3} titulo="Comprobá que llegan">
        <p className="text-xs text-foreground/90">
          {integration?.last_sync_at
            ? `Último evento recibido: ${formatDateTime(integration.last_sync_at)}`
            : 'Todavía no llegó ningún evento.'}
        </p>
        {integration?.last_error && <LastErrorAlert message={integration.last_error} />}
        <p className="text-[11px] text-muted-foreground">
          Evitá el envío de prueba de Hotmart: manda una compra ficticia que entraría como venta.
          Basta con esperar al próximo evento real.
        </p>
      </Paso>

      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3">
        <Lightbulb className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        <p className="text-xs text-muted-foreground">
          Para atribuir cada venta a su anuncio, el link al checkout tiene que llevar{' '}
          <code className="font-mono px-1 py-0.5 rounded bg-muted">{'sck={{ad.id}}'}</code>, o la
          landing tiene que pasar las UTM dentro de{' '}
          <code className="font-mono px-1 py-0.5 rounded bg-muted">src</code>. Hotmart no guarda las{' '}
          <code className="font-mono px-1 py-0.5 rounded bg-muted">utm_*</code> del checkout. Sin
          ninguna de las dos, la venta solo se atribuye si el comprador dejó antes un lead con el
          mismo email o teléfono.
        </p>
      </div>

      {/* ── Avanzado ───────────────────────────────────────────── */}
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground select-none">
          Avanzado: secreto propio
        </summary>
        <div className="px-3 pb-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Un secreto nuestro, para integraciones que firman el cuerpo con HMAC-SHA256 (cabecera{' '}
            <code className="font-mono">X-Hotmart-Signature</code>). Hotmart no lo usa: no hace
            falta para el webhook de arriba.
          </p>
          {revealedSecret ? (
            <div className="rounded-lg border border-blue-200 dark:border-blue-500/30 bg-blue-50/40 dark:bg-blue-500/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-400 mb-2">
                Secreto · guardalo ahora, solo se muestra una vez
              </p>
              <CopyField
                value={revealedSecret}
                onCopy={() => copySecret(revealedSecret)}
                copied={copiedSecret}
              />
            </div>
          ) : (
            integration && (
              <p className="text-xs text-muted-foreground">
                Si existe, está guardado cifrado y no se vuelve a mostrar. Si lo perdiste, rotalo.
              </p>
            )
          )}
          <button
            onClick={integration ? onRotate : onGenerarSecreto}
            disabled={pending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                               text-foreground/90 border border-border hover:bg-accent
                               disabled:opacity-50 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {integration ? 'Rotar secreto' : 'Generar secreto'}
          </button>
        </div>
      </details>

      {integration && (
        <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
          <button
            onClick={onToggle}
            disabled={pending}
            aria-label={isActive ? 'Pausar integración' : 'Reactivar integración'}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
                                border transition-colors disabled:opacity-50 ${
                                  isActive
                                    ? 'border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10'
                                    : 'border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10'
                                }`}
          >
            <Power className="h-3.5 w-3.5" />
            {isActive ? 'Pausar' : 'Reactivar'}
          </button>
        </div>
      )}

      {error && <FeedbackLine variant="error" message={error} />}
      {success && <FeedbackLine variant="success" message={success} />}
    </div>
  );
}

function Paso({ n, titulo, children }: { n: number; titulo: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <span
          className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${ACCENT}`}
        >
          {n}
        </span>
        {titulo}
      </h4>
      <div className="space-y-2 pl-7">{children}</div>
    </section>
  );
}
