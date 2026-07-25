import { toast as sonnerToast } from 'sonner';
import { CheckCircle2, XCircle } from 'lucide-react';

import { cn } from './utils';

const DEFAULT_DURATION = 4000;

function ToastCard({
  message,
  variant,
  duration,
}: {
  message: string;
  variant: 'success' | 'error';
  duration: number;
}): React.JSX.Element {
  const Icon = variant === 'success' ? CheckCircle2 : XCircle;
  return (
    <div
      className="relative flex w-full max-w-2xl items-center gap-2.5 overflow-hidden rounded-card bg-surface px-4 py-3 text-sm text-ink shadow-card"
      style={{ boxShadow: 'var(--shadow-card), var(--rim-light)' }}
    >
      <Icon className={cn('size-4 shrink-0', variant === 'success' ? 'text-success' : 'text-danger')} />
      <span className="flex-1">{message}</span>
      {/* Receding left-to-right progress bar showing time until auto-dismiss. */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 h-0.5 origin-left',
          variant === 'success' ? 'bg-success' : 'bg-danger'
        )}
        style={{ animation: `toast-progress ${duration}ms linear forwards` }}
      />
    </div>
  );
}

function notify(message: string, variant: 'success' | 'error', duration = DEFAULT_DURATION): void {
  sonnerToast.custom(() => <ToastCard message={message} variant={variant} duration={duration} />, {
    duration,
  });
}

export const notifySuccess = (message: string, duration?: number): void => notify(message, 'success', duration);
export const notifyError = (message: string, duration?: number): void => notify(message, 'error', duration);
