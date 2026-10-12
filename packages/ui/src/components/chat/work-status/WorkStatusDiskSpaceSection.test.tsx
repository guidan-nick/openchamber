import { afterEach, beforeEach, describe, expect, test, jest } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { formatDiskBytes } from './diskSpace';
import { sessionEvents } from '@/lib/sessionEvents';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { themes } from '@/lib/theme/themes';

let Section: typeof import('./WorkStatusDiskSpaceSection').WorkStatusDiskSpaceSection;
const globals = ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'fetch'] as const;

describe('disk space widget', () => {
  let root: Root;
  let container: HTMLDivElement;
  let win: Window;
  let previous: Array<readonly [typeof globals[number], PropertyDescriptor | undefined]>;
  let requests: Array<{ url: string; resolve: (response: Response) => void }>;
  const originalStore = useUIStore.getState();
  const render = async (directory: string | null = '/repo', visible = true, active = true) => {
    await act(async () => root.render(
      <I18nProvider>{visible ? <Section key={directory} directory={directory} active={active} /> : null}</I18nProvider>,
    ));
  };
  const answer = async (index: number, body: { totalBytes?: number; availableBytes?: number }, status = 200) => {
    await act(async () => requests[index].resolve(Response.json(body, { status })));
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    previous = globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    requests = [];
    const values = {
      window: win, document: win.document, navigator: win.navigator, Element: win.Element,
      HTMLElement: win.HTMLElement, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
      fetch: (input: string | URL | Request) => new Promise<Response>((resolve) => {
        requests.push({ url: input instanceof Request ? input.url : String(input), resolve });
      }),
    };
    for (const name of globals) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    ({ WorkStatusDiskSpaceSection: Section } = await import('./WorkStatusDiskSpaceSection'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useUIStore.setState({ workStatusExpandedSections: {} });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    // Settle controlled requests so the shared background gate releases slots.
    await act(async () => { for (const request of requests) request.resolve(Response.json({}, { status: 503 })); });
    useUIStore.setState(originalStore);
    jest.useRealTimers();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await win.happyDOM.close();
  });

  test('renders used capacity and available bytes, including a full disk', async () => {
    await render();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('directory=%2Frepo');
    await answer(0, { totalBytes: 128 * 1024 ** 3, availableBytes: 42 * 1024 ** 3 });
    expect(container.textContent).toContain('67% used');
    expect(container.textContent).toContain('42 GB available · 128 GB total');
    expect(Number(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow'))).toBe(67.1875);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh disk space"]')?.click());
    await answer(1, { totalBytes: 128 * 1024 ** 3, availableBytes: 0 });
    expect(container.textContent).toContain('0 B available');
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('100');
  });

  test('failure and malformed capacity show Unavailable without a misleading bar', async () => {
    await render();
    await answer(0, {}, 503);
    expect(container.textContent).toContain('Unavailable');
    expect(container.querySelector('[role="meter"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh disk space"]')?.click());
    await answer(1, { totalBytes: 100, availableBytes: 101 });
    expect(container.textContent).toContain('Unavailable');
    expect(container.querySelector('[role="meter"]')).toBeNull();
  });

  test('animates only pending reads and preserves the bar during refresh', async () => {
    await render();
    const button = () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh disk space"]');
    const icon = () => button()?.querySelector('svg');
    expect(button()?.disabled).toBe(true);
    expect(icon()?.classList.contains('animate-spin')).toBe(true);
    expect(icon()?.classList.contains('motion-reduce:animate-none')).toBe(true);
    await answer(0, { totalBytes: 100, availableBytes: 40 });
    expect(button()?.disabled).toBe(false);
    expect(icon()?.classList.contains('animate-spin')).toBe(false);
    await act(async () => button()?.click());
    expect(button()?.getAttribute('aria-busy')).toBe('true');
    expect(icon()?.classList.contains('animate-spin')).toBe(true);
    expect(container.textContent).toContain('60% used');
    expect(container.querySelector('[role="meter"]')).not.toBeNull();
    await answer(1, {}, 503);
    expect(button()?.disabled).toBe(false);
    expect(icon()?.classList.contains('animate-spin')).toBe(false);
    expect(container.textContent).toContain('Unavailable');
    await act(async () => button()?.click());
    await render('/repo', true, false);
    expect(icon()?.classList.contains('animate-spin')).toBe(false);
  });

  test('discards a late read after project change', async () => {
    await render('/old');
    await render('/new');
    await answer(1, { totalBytes: 100, availableBytes: 20 });
    await answer(0, { totalBytes: 100, availableBytes: 90 });
    expect(container.textContent).toContain('80% used');
    expect(container.textContent).not.toContain('10% used');
  });

  test('runtime changes invalidate pending reads even with the same project path', async () => {
    await render();
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed')));
    await answer(1, { totalBytes: 100, availableBytes: 40 });
    await answer(0, { totalBytes: 100, availableBytes: 90 });
    expect(container.textContent).toContain('60% used');
  });

  test('clears a completed reading when switching runtime', async () => {
    await render();
    await answer(0, { totalBytes: 100, availableBytes: 40 });
    await act(async () => window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed')));
    expect(container.textContent).toContain('Loading');
    expect(container.querySelector('[role="meter"]')).toBeNull();
    await answer(1, { totalBytes: 100, availableBytes: 80 });
    expect(container.textContent).toContain('20% used');
  });

  test('coalesces activity reads and does no idle work', async () => {
    jest.useFakeTimers();
    await render();
    await answer(0, { totalBytes: 100, availableBytes: 40 });
    await act(async () => {
      for (let i = 0; i < 100; i += 1) sessionEvents.requestGitRefresh({ directory: '/repo' });
      jest.advanceTimersByTime(29_999);
    });
    expect(requests).toHaveLength(1);
    await act(async () => jest.advanceTimersByTime(1));
    expect(requests).toHaveLength(2);
    expect(container.textContent).toContain('60% used');
    await answer(1, { totalBytes: 100, availableBytes: 20 });
    await act(async () => jest.advanceTimersByTime(300_000));
    expect(requests).toHaveLength(2);
    expect(container.textContent).toContain('80% used');
  });

  test('ignores other projects and cancels queued activity when the panel is hidden', async () => {
    jest.useFakeTimers();
    await render();
    await answer(0, { totalBytes: 100, availableBytes: 40 });
    await act(async () => {
      sessionEvents.requestGitRefresh({ directory: '/other' });
      jest.advanceTimersByTime(30_000);
    });
    expect(requests).toHaveLength(1);
    await act(async () => sessionEvents.requestGitRefresh({ directory: '/repo' }));
    await render('/repo', true, false);
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event('focus'));
      sessionEvents.requestGitRefresh({ directory: '/repo' });
    });
    expect(requests).toHaveLength(1);
  });

  test('hidden browser tabs ignore activity and cancel a queued read', async () => {
    jest.useFakeTimers();
    await render();
    await answer(0, { totalBytes: 100, availableBytes: 40 });
    await act(async () => {
      sessionEvents.requestGitRefresh({ directory: '/repo' });
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(30_000);
      sessionEvents.requestGitRefresh({ directory: '/repo' });
      window.dispatchEvent(new Event('focus'));
      jest.advanceTimersByTime(30_000);
    });
    expect(requests).toHaveLength(1);
  });

  test('uses live semantic variables defined by every shipped theme', async () => {
    await render();
    await answer(0, { totalBytes: 100, availableBytes: 40 });
    const generator = new CSSVariableGenerator();
    const fill = container.querySelector<HTMLElement>('[role="meter"] > div');
    expect(fill?.style.backgroundColor).toBe('var(--surface-muted-foreground)');
    for (const theme of themes) {
      generator.apply(theme);
      const css = document.getElementById('opencode-theme-variables')?.textContent;
      for (const variable of ['--surface-muted-foreground:', '--surface-subtle:', '--status-warning:', '--status-error:']) {
        expect(css).toContain(variable);
      }
      expect(fill?.style.backgroundColor).toBe('var(--surface-muted-foreground)');
    }
    expect(requests).toHaveLength(1);
  });

  test('disabled or directory-less widgets perform no reads and remove listeners', async () => {
    await render(null);
    expect(requests).toHaveLength(0);
    await render();
    await answer(0, { totalBytes: 100, availableBytes: 20 });
    await render('/repo', false);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new CustomEvent('openchamber:runtime-endpoint-changed'));
    });
    expect(requests).toHaveLength(1);
    expect(container.textContent).toBe('');
  });

  test('formats disk-sized quantities and zero without losing units', () => {
    expect(formatDiskBytes(0, 'en')).toBe('0 B');
    expect(formatDiskBytes(1024 ** 4, 'en')).toBe('1 TB');
    expect(formatDiskBytes(1.5 * 1024 ** 3, 'de')).toBe('1,5 GB');
  });
});
