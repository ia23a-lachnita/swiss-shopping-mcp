import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle } from 'lucide-react';

import { ALL_CHAINS, CHAIN_LABELS, metrics, sourceStatus, type CapabilityStatusValue } from '../api';
import { cn } from '../lib/utils';
import { Card, CardContent } from './ui/card';
import { Skeleton } from './ui/skeleton';

const CAPABILITY_LABELS: Record<string, string> = {
  productSearch: 'Produktsuche',
  storeSearch: 'Filialsuche',
  availability: 'Verfügbarkeit',
  promotions: 'Angebote',
  nutrition: 'Nährwerte',
};

function statusDotClass(status: CapabilityStatusValue): string {
  if (status === 'live-beta' || status === 'live-stable') return 'bg-success';
  if (status === 'degraded' || status === 'source-auditing') return 'bg-accent2';
  return 'bg-faint';
}

export function StatusView(): React.JSX.Element {
  const { data: statuses, isLoading: statusLoading, error: statusError } = useQuery({
    queryKey: ['source-status'],
    queryFn: sourceStatus,
    staleTime: 5 * 60_000,
  });
  const { data: snapshot, isLoading: metricsLoading } = useQuery({
    queryKey: ['metrics'],
    queryFn: metrics,
    staleTime: 30_000,
  });

  const loading = statusLoading || metricsLoading;

  return (
    <div className="space-y-4 pt-3">
      <div>
        <h2 className="text-base font-bold">Quellen &amp; Leistung</h2>
        <p className="mt-1 text-xs text-faint">
          Fähigkeiten sind deklariert (hand-gepflegt), nicht live geprüft. Latenz und Cache-Werte
          unten stammen aus echten, laufenden Messungen.
        </p>
      </div>

      {statusError instanceof Error && (
        <Card>
          <CardContent className="flex items-center gap-3 text-sm text-danger">
            <AlertTriangle className="size-5 shrink-0" /> {statusError.message}
          </CardContent>
        </Card>
      )}

      {loading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-card" />
          ))}
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {ALL_CHAINS.map((chain) => {
            const rows = statuses?.filter((s) => s.chain === chain) ?? [];
            const latency = snapshot?.latency.byChain[chain];
            return (
              <div key={chain} className="rounded-card bg-surface p-3.5 shadow-card">
                <p className="mb-2 font-semibold">{CHAIN_LABELS[chain]}</p>
                <ul className="space-y-1">
                  {rows.map((r) => (
                    <li key={r.capability} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5">
                        <span className={cn('size-1.5 shrink-0 rounded-full', statusDotClass(r.status))} />
                        {CAPABILITY_LABELS[r.capability] ?? r.capability}
                      </span>
                      <span className="text-faint">{r.status}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-2.5 border-t border-line pt-2.5">
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Activity className="size-3 shrink-0" />
                    <span>Ø Latenz</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{ width: latency ? `${Math.min(100, (latency.avg / 2000) * 100)}%` : '0%' }}
                      />
                    </div>
                    <span className="font-mono font-semibold text-ink">
                      {latency ? `${Math.round(latency.avg)}ms` : '—'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!loading && snapshot && (
        <div className="rounded-card bg-surface p-3.5 shadow-card">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">System</p>
          <dl className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded bg-surface-sunken p-2 shadow-inset">
              <dt className="text-faint">Cache (frisch)</dt>
              <dd className="font-mono font-semibold">{snapshot.cacheHits.fresh}</dd>
            </div>
            <div className="rounded bg-surface-sunken p-2 shadow-inset">
              <dt className="text-faint">Hydration OK</dt>
              <dd className="font-mono font-semibold">{snapshot.hydration.successes}</dd>
            </div>
            <div className="rounded bg-surface-sunken p-2 shadow-inset">
              <dt className="text-faint">Katalog</dt>
              <dd className="font-mono font-semibold">{snapshot.catalog.totalProducts}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
