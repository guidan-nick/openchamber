import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { WorkStatusCollapsibleSection } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { formatDiskBytes, readDiskSpace, type DiskSpace } from './diskSpace';

type Reading = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; data: DiskSpace };

export const WorkStatusDiskSpaceSection: React.FC<{ directory: string | null }> = ({ directory }) => {
  const { t, locale } = useI18n();
  const [reading, setReading] = React.useState<Reading>({ status: 'loading' });
  const refreshRef = React.useRef<() => void>(() => undefined);
  useReportWorkStatusPresence('diskSpace', Boolean(directory));

  React.useEffect(() => {
    if (!directory) return;
    let controller: AbortController | null = null;
    const refresh = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setReading({ status: 'loading' });
      void runBackgroundNetworkTask(async () => {
        if (request.signal.aborted) return;
        try {
          const data = await readDiskSpace(directory, request.signal);
          if (!request.signal.aborted) setReading({ status: 'ready', data });
        } catch {
          if (!request.signal.aborted) setReading({ status: 'unavailable' });
        }
      });
    };
    refreshRef.current = refresh;
    refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', onFocus);
    const unsubscribe = subscribeRuntimeEndpointChanged(refresh);
    return () => {
      controller?.abort();
      refreshRef.current = () => undefined;
      window.removeEventListener('focus', onFocus);
      unsubscribe();
    };
  }, [directory]);

  if (!directory) return null;
  const data = reading.status === 'ready' ? reading.data : null;
  const usedPercent = data ? (1 - data.availableBytes / data.totalBytes) * 100 : 0;
  const usedLabel = t('chat.workStatus.diskSpace.used', {
    percent: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(usedPercent),
  });
  const statusLabel = reading.status === 'loading'
    ? t('chat.workStatus.diskSpace.loading')
    : t('chat.workStatus.diskSpace.unavailable');

  return (
    <WorkStatusCollapsibleSection
      id="diskSpace"
      title={t('chat.workStatus.section.diskSpace')}
      icon="hard-drive"
      defaultExpanded
      summary={data ? usedLabel : statusLabel}
      action={(
        <Button
          size="icon"
          variant="ghost"
          className="size-6 shrink-0 text-muted-foreground"
          onClick={() => refreshRef.current()}
          aria-label={t('chat.workStatus.diskSpace.refresh')}
          disabled={reading.status === 'loading'}
        >
          <Icon name="refresh" className="size-3.5" />
        </Button>
      )}
    >
      {data ? (
        <div className="flex flex-col gap-1.5 px-1 py-1">
          <div
            role="meter"
            aria-label={t('chat.workStatus.section.diskSpace')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usedPercent}
            aria-valuetext={usedLabel}
            className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-subtle)]"
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${usedPercent}%`, backgroundColor: usedPercent >= 95 ? 'var(--status-error)' : usedPercent >= 85 ? 'var(--status-warning)' : 'var(--surface-muted-foreground)' }}
            />
          </div>
          <span dir="auto" className="text-xs text-muted-foreground tabular-nums">
            {t('chat.workStatus.diskSpace.available', {
              available: formatDiskBytes(data.availableBytes, locale),
              total: formatDiskBytes(data.totalBytes, locale),
            })}
          </span>
        </div>
      ) : null}
    </WorkStatusCollapsibleSection>
  );
};
