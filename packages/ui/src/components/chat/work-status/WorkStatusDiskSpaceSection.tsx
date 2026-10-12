import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { normalizePath } from '@/lib/pathNormalization';
import { sessionEvents } from '@/lib/sessionEvents';
import { WorkStatusCollapsibleSection } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { formatDiskBytes, readDiskSpace, type DiskSpace } from './diskSpace';

type Reading = { status: 'loading' } | { status: 'unavailable' } | { status: 'ready'; data: DiskSpace };

const ACTIVITY_REFRESH_WINDOW_MS = 30_000;

export const WorkStatusDiskSpaceSection: React.FC<{ directory: string | null; active: boolean }> = ({ directory, active }) => {
  const { t, locale } = useI18n();
  const [reading, setReading] = React.useState<Reading>({ status: 'loading' });
  const refreshRef = React.useRef<() => void>(() => undefined);
  useReportWorkStatusPresence('diskSpace', Boolean(directory));

  React.useEffect(() => {
    if (!directory || !active) return;
    let controller: AbortController | null = null;
    let activityTimer: number | undefined;
    let lastReadAt = 0;
    const refresh = () => {
      window.clearTimeout(activityTimer);
      activityTimer = undefined;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      lastReadAt = Date.now();
      // Keep a successful reading on screen during a background refresh.
      setReading((current) => current.status === 'ready' ? current : { status: 'loading' });
      void runBackgroundNetworkTask(async () => {
        if (request.signal.aborted) return;
        try {
          const data = await readDiskSpace(directory, request.signal);
          if (!request.signal.aborted) setReading((current) =>
            current.status === 'ready'
            && current.data.totalBytes === data.totalBytes
            && current.data.availableBytes === data.availableBytes
              ? current
              : { status: 'ready', data });
        } catch {
          if (!request.signal.aborted) setReading({ status: 'unavailable' });
        }
      });
    };
    refreshRef.current = refresh;
    refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', onFocus);
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      setReading({ status: 'loading' });
      refresh();
    });
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        window.clearTimeout(activityTimer);
        activityTimer = undefined;
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const unsubscribeActivity = sessionEvents.onGitRefreshHint((hint) => {
      if (document.visibilityState !== 'visible'
        || normalizePath(hint.directory) !== normalizePath(directory)
        || activityTimer !== undefined) return;
      // One trailing read after a burst, never a recurring idle timer.
      const delay = Math.max(0, ACTIVITY_REFRESH_WINDOW_MS - (Date.now() - lastReadAt));
      activityTimer = window.setTimeout(() => {
        activityTimer = undefined;
        if (document.visibilityState === 'visible') refresh();
      }, delay);
    });
    return () => {
      controller?.abort();
      window.clearTimeout(activityTimer);
      refreshRef.current = () => undefined;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribe();
      unsubscribeActivity();
    };
  }, [directory, active]);

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
