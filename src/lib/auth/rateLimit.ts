/**
 * Per-key sliding-window rate limiter.
 *
 * In memory on purpose: Switchboard is a single local process, and writing a
 * row per request just to count them would cost more than the proxying does.
 * The tradeoff is that limits reset on restart, which for a personal gateway is
 * the right side of the trade.
 */

const WINDOW_MS = 60_000;
/** Cheapest place to drop keys that stopped calling: once a minute, on the way through. */
const SWEEP_INTERVAL_MS = 60_000;

interface Store {
  hits: Map<string, number[]>;
  lastSweep: number;
}

// Next re-evaluates modules across HMR boundaries in dev; a module-scope Map
// would silently reset the window on every edit.
const globalRef = globalThis as { __switchboardRateLimit?: Store };
const store: Store = (globalRef.__switchboardRateLimit ??= { hits: new Map(), lastSweep: 0 });

export function checkRateLimit(
  keyId: string,
  perMinute: number | null,
): { allowed: boolean; retryAfterSec: number } {
  // null is "unlimited"; 0 and negatives are treated the same way rather than
  // as "allow nothing", because a blank field in the UI must not brick a key.
  if (perMinute === null || !Number.isFinite(perMinute) || perMinute <= 0) {
    return { allowed: true, retryAfterSec: 0 };
  }

  const limit = Math.floor(perMinute);
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const previous = store.hits.get(keyId);
  const recent: number[] = [];
  if (previous) {
    for (const ts of previous) if (ts > cutoff) recent.push(ts);
  }

  if (recent.length >= limit) {
    store.hits.set(keyId, recent);
    // The oldest hit in the window is the one that has to age out before there
    // is room again.
    const oldest = recent[0] ?? now;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1_000)),
    };
  }

  recent.push(now);
  store.hits.set(keyId, recent);
  sweep(now);
  return { allowed: true, retryAfterSec: 0 };
}

/** Current usage for the dashboard, without recording a hit. */
export function rateLimitUsage(keyId: string): number {
  const cutoff = Date.now() - WINDOW_MS;
  const hits = store.hits.get(keyId);
  if (!hits) return 0;
  let count = 0;
  for (const ts of hits) if (ts > cutoff) count += 1;
  return count;
}

/** Forgets one key's window, or every key when called with no argument. */
export function clearRateLimit(keyId?: string): void {
  if (keyId === undefined) store.hits.clear();
  else store.hits.delete(keyId);
}

function sweep(now: number): void {
  if (now - store.lastSweep < SWEEP_INTERVAL_MS) return;
  store.lastSweep = now;

  const cutoff = now - WINDOW_MS;
  for (const [keyId, hits] of store.hits) {
    const last = hits[hits.length - 1];
    if (last === undefined || last <= cutoff) store.hits.delete(keyId);
  }
}
