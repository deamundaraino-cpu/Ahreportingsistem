import { AlertCircle, CheckCircle2 } from 'lucide-react';

type Variant = 'error' | 'success' | 'warning';

const VARIANT_CLS: Record<Variant, string> = {
  error: 'text-red-600 dark:text-red-400',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
};

const VARIANT_ICON: Record<Variant, typeof AlertCircle> = {
  error: AlertCircle,
  success: CheckCircle2,
  warning: AlertCircle,
};

export function FeedbackLine({ variant, message }: { variant: Variant; message: string }) {
  const Icon = VARIANT_ICON[variant];
  return (
    <p className={`mt-3 text-xs flex items-center gap-1.5 ${VARIANT_CLS[variant]}`}>
      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
      {message}
    </p>
  );
}

export function LastErrorAlert({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2">
      <p className="text-xs font-mono text-amber-800 dark:text-amber-300 flex items-start gap-2">
        <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
        <span>Último error: {message}</span>
      </p>
    </div>
  );
}
