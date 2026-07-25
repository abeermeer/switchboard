/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { LiveProvider, useLive } from '@/components/shell/LiveProvider';

/**
 * A controllable stand-in for the browser's EventSource.
 *
 * The reconnection logic is the whole point of the component and it cannot be
 * exercised against a real one — there is no server here, and the backoff is
 * measured in seconds. Every instance registers itself so a test can drive the
 * events the real transport would deliver.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private listeners = new Map<string, Array<(event: MessageEvent | Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (event: MessageEvent | Event) => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(handler);
    this.listeners.set(type, existing);
  }

  removeEventListener(): void {
    /* not exercised */
  }

  close(): void {
    this.closed = true;
  }

  /** Delivers a named event with a JSON payload, as the server does. */
  emit(type: string, data: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }

  /** Delivers a raw event with no payload (`open`, `error`). */
  signal(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler(new Event(type));
  }

  static latest(): FakeEventSource {
    const last = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (last === undefined) throw new Error('no EventSource was opened');
    return last;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }
}

/** Renders the live state as text so assertions read against the DOM. */
function Probe(): React.ReactElement {
  const { connected, health, logs, usage } = useLive();
  return (
    <div>
      <span data-testid="connected">{String(connected)}</span>
      <span data-testid="health-count">{Object.keys(health).length}</span>
      <span data-testid="log-count">{logs.length}</span>
      <span data-testid="log-ids">{logs.map((row) => row.id).join(',')}</span>
      <span data-testid="usage-requests">{usage === null ? 'none' : String(usage.requests)}</span>
    </div>
  );
}

function renderLive(): void {
  render(
    <LiveProvider>
      <Probe />
    </LiveProvider>,
  );
}

const logRow = (id: string) => ({
  id,
  ts: 1_700_000_000_000,
  apiKeyId: null,
  modality: 'chat',
  requestedModel: 'auto',
  resolvedConnectionId: 'conn_1',
  resolvedProviderId: 'groq',
  resolvedModelId: 'llama-3.1-8b-instant',
  status: 'success',
  httpStatus: 200,
  durationMs: 120,
  ttftMs: 40,
  streamed: false,
  usage: null,
  costUsd: 0,
  attemptCount: 1,
  error: null,
  clientIp: null,
  userAgent: null,
});

describe('LiveProvider', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens exactly one connection for the whole tree', () => {
    // Every live widget subscribes through this context. One socket per widget
    // would mean the server runs a copy of its poll loop for each of them.
    render(
      <LiveProvider>
        <Probe />
        <Probe />
        <Probe />
      </LiveProvider>,
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.latest().url).toBe('/api/events');
  });

  it('starts disconnected and flips on open', () => {
    renderLive();
    expect(screen.getByTestId('connected').textContent).toBe('false');

    act(() => FakeEventSource.latest().signal('open'));
    expect(screen.getByTestId('connected').textContent).toBe('true');
  });

  it('fans health snapshots out to subscribers', () => {
    renderLive();

    act(() => {
      FakeEventSource.latest().emit('health', {
        conn_1: { connectionId: 'conn_1', status: 'healthy' },
        conn_2: { connectionId: 'conn_2', status: 'down' },
      });
    });

    expect(screen.getByTestId('health-count').textContent).toBe('2');
  });

  it('replaces the log list on the initial frame', () => {
    renderLive();

    act(() => {
      FakeEventSource.latest().emit('log', { rows: [logRow('a'), logRow('b')], initial: true });
    });

    expect(screen.getByTestId('log-ids').textContent).toBe('a,b');
  });

  it('prepends later frames so the newest request is first', () => {
    renderLive();
    const source = FakeEventSource.latest();

    act(() => source.emit('log', { rows: [logRow('old')], initial: true }));
    act(() => source.emit('log', { rows: [logRow('new')], initial: false }));

    expect(screen.getByTestId('log-ids').textContent).toBe('new,old');
  });

  it('caps the log buffer so a long-lived tab cannot grow without bound', () => {
    renderLive();
    const source = FakeEventSource.latest();

    act(() => {
      for (let i = 0; i < 200; i += 1) {
        source.emit('log', { rows: [logRow(`row-${i}`)], initial: false });
      }
    });

    const count = Number(screen.getByTestId('log-count').textContent);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(60);
  });

  it('surfaces the usage rollup', () => {
    renderLive();

    act(() => {
      FakeEventSource.latest().emit('usage', {
        requests: 42,
        successes: 40,
        failures: 2,
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.01,
        savedUsd: 0.2,
      });
    });

    expect(screen.getByTestId('usage-requests').textContent).toBe('42');
  });

  it('ignores a malformed frame instead of tearing down the stream', () => {
    renderLive();
    const source = FakeEventSource.latest();

    act(() => source.emit('health', { conn_1: { connectionId: 'conn_1', status: 'healthy' } }));

    act(() => {
      // Hand-rolled so the payload is not valid JSON.
      for (const handler of (source as unknown as {
        listeners: Map<string, Array<(e: MessageEvent) => void>>;
      }).listeners.get('health') ?? []) {
        handler(new MessageEvent('health', { data: '{not json' }));
      }
    });

    // The earlier state survives, which is the point: one bad frame must not
    // blank the dashboard.
    expect(screen.getByTestId('health-count').textContent).toBe('1');
  });

  it('marks itself disconnected and closes the socket on error', () => {
    renderLive();
    const source = FakeEventSource.latest();

    act(() => source.signal('open'));
    act(() => source.signal('error'));

    expect(screen.getByTestId('connected').textContent).toBe('false');
    expect(source.closed).toBe(true);
  });

  it('reconnects after a backoff rather than giving up', () => {
    vi.useFakeTimers();
    renderLive();

    act(() => FakeEventSource.latest().signal('error'));
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it('backs off further on each successive failure', () => {
    // A stopped gateway must not be hammered by a dashboard left open in a
    // background tab.
    vi.useFakeTimers();
    renderLive();

    act(() => FakeEventSource.latest().signal('error'));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.latest().signal('error'));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    // The second retry waits longer than a second, so nothing new opened yet.
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('resets the backoff once a connection succeeds', () => {
    vi.useFakeTimers();
    renderLive();

    act(() => FakeEventSource.latest().signal('error'));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    act(() => FakeEventSource.latest().signal('open'));
    act(() => FakeEventSource.latest().signal('error'));

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    // Back to the first, shortest delay rather than continuing to escalate.
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('closes the socket when the tree unmounts', () => {
    const { unmount } = render(
      <LiveProvider>
        <Probe />
      </LiveProvider>,
    );

    const source = FakeEventSource.latest();
    unmount();

    expect(source.closed).toBe(true);
  });

  it('does not reconnect after unmounting', () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <LiveProvider>
        <Probe />
      </LiveProvider>,
    );

    act(() => FakeEventSource.latest().signal('error'));
    unmount();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // A leaked reconnect loop would keep polling a page nobody is looking at.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
