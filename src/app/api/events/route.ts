import { snapshotAll } from '@/lib/resilience/breaker';
import { listRequestLogs } from '@/lib/db/repos/log';
import { usageTotals } from '@/lib/db/repos/usage';
import { requireLocalOrToken } from '@/lib/auth/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TICK_MS = 2_000;

/**
 * One SSE stream feeding the whole dashboard.
 *
 * Every widget subscribes through a single client-side context rather than
 * opening its own connection — a page with eight live panels would otherwise
 * hold eight sockets and run eight copies of this query loop.
 */
export function GET(req: Request): Response {
  const denied = requireLocalOrToken(req);
  if (denied !== null) return denied;

  const encoder = new TextEncoder();
  let lastLogId: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const send = (type: string, data: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const tick = (): void => {
        if (closed) return;
        try {
          send('health', snapshotAll());

          const hourAgo = Date.now() - 60 * 60 * 1000;
          send('usage', usageTotals(hourAgo));

          // Only rows newer than the last one sent, so a long-lived connection
          // does not re-transmit the same page of logs every two seconds.
          const { rows } = listRequestLogs({ limit: 25 });
          if (rows.length > 0) {
            const newest = rows[0]!;
            if (lastLogId === null) {
              lastLogId = newest.id;
              send('log', { rows: rows.slice(0, 12), initial: true });
            } else if (newest.id !== lastLogId) {
              const index = rows.findIndex((row) => row.id === lastLogId);
              const fresh = index === -1 ? rows : rows.slice(0, index);
              lastLogId = newest.id;
              if (fresh.length > 0) send('log', { rows: fresh, initial: false });
            }
          }
        } catch (err) {
          send('error', { message: err instanceof Error ? err.message : 'poll failed' });
        }
      };

      const timer = setInterval(tick, TICK_MS);
      tick();

      // A leaked interval per reconnect would compound quickly during dev
      // hot-reloads, so teardown is wired to the request signal.
      const close = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the platform.
        }
      };

      req.signal.addEventListener('abort', close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
