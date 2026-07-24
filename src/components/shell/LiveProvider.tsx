'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { HealthSnapshot, RequestLogEntry, UsageRollup } from '@/types/core';

interface LiveState {
  health: Record<string, HealthSnapshot>;
  usage: UsageRollup | null;
  logs: RequestLogEntry[];
  connected: boolean;
}

const LiveContext = createContext<LiveState>({
  health: {},
  usage: null,
  logs: [],
  connected: false,
});

const MAX_LOGS = 60;

/**
 * Holds the single EventSource the whole dashboard reads from.
 *
 * Every live widget subscribes through this context rather than opening its own
 * connection — the overview page alone has four of them, and a socket each
 * would mean four copies of the server-side poll loop.
 */
export function LiveProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [state, setState] = useState<LiveState>({
    health: {},
    usage: null,
    logs: [],
    connected: false,
  });

  const retry = useRef(0);
  const source = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled) return;

      const es = new EventSource('/api/events');
      source.current = es;

      es.addEventListener('open', () => {
        retry.current = 0;
        setState((s) => ({ ...s, connected: true }));
      });

      es.addEventListener('health', (event) => {
        try {
          const health = JSON.parse((event as MessageEvent<string>).data) as Record<string, HealthSnapshot>;
          setState((s) => ({ ...s, health }));
        } catch {
          // A malformed frame should not tear down a working stream.
        }
      });

      es.addEventListener('usage', (event) => {
        try {
          const usage = JSON.parse((event as MessageEvent<string>).data) as UsageRollup;
          setState((s) => ({ ...s, usage }));
        } catch {
          /* ignore */
        }
      });

      es.addEventListener('log', (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as {
            rows: RequestLogEntry[];
            initial: boolean;
          };
          setState((s) => ({
            ...s,
            logs: payload.initial
              ? payload.rows
              : [...payload.rows, ...s.logs].slice(0, MAX_LOGS),
          }));
        } catch {
          /* ignore */
        }
      });

      es.addEventListener('error', () => {
        es.close();
        setState((s) => ({ ...s, connected: false }));
        if (cancelled) return;

        // Exponential backoff capped at 30s, so a stopped gateway does not get
        // hammered by a dashboard left open in a background tab.
        retry.current += 1;
        const delay = Math.min(30_000, 1_000 * 2 ** (retry.current - 1));
        timer = setTimeout(connect, delay);
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      source.current?.close();
    };
  }, []);

  const value = useMemo(() => state, [state]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  return useContext(LiveContext);
}
