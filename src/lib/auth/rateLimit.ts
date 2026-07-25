import { getDb } from '@/lib/db/client';

/**
 * Per-key sliding-window rate limiter, persisted in SQLite.
 *
 * It was in-memory, which meant a restart handed every key a fresh allowance —
 * so anything that crash-looped, or any operator restarting to apply a setting,
 * silently lifted the limit. For a gateway holding real spend that is the wrong
 * failure mode.
 *
 * Hits are counted per second rather than per request, so a key doing 10k
 * requests a minute writes at most 60 rows in a window instead of 10,000. That
 * is what makes persisting this cheap enough for the hot path: one UPSERT and
 * one indexed SUM per request.
 */

const WINDOW_MS = 60_000;
const WINDOW_SECONDS = WINDOW_MS / 1_000;

/** A timer would need a scheduler; once a minute on the way through is enough. */
const SWEEP_INTERVAL_MS = 60_000;

interface SweepState {
  lastSweep: number;
}

// Next re-evaluates modules across HMR boundaries in dev, so the sweep clock
// lives on globalThis — a fresh module instance would otherwise reset it on
// every edit and sweep far more often than intended.
const globalRef = globalThis as { __switchboardRateSweep?: SweepState };
const sweepState: SweepState = (globalRef.__switchboardRateSweep ??= { lastSweep: 0 });

function currentSecond(now: number): number {
  return Math.floor(now / 1_000);
}

export function checkRateLimit(
  keyId: string,
  perMinute: number | null,
): { allowed: boolean; retryAfterSec: number } {
  // Guard before flooring, not after. `0.5` would otherwise pass a `<= 0`
  // check, floor to a limit of 0, and block the key permanently — and since a
  // blocked call records no hit, it could never recover.
  if (perMinute === null || !Number.isFinite(perMinute) || perMinute < 1) {
    return { allowed: true, retryAfterSec: 0 };
  }

  const limit = Math.floor(perMinute);
  const now = Date.now();
  const second = currentSecond(now);
  const oldestSecond = second - WINDOW_SECONDS;

  const db = getDb();

  const usedRow = db
    .prepare(
      `SELECT COALESCE(SUM(hits), 0) AS used, MIN(second_ts) AS oldest
         FROM rate_limit_hits
        WHERE key_id = ? AND second_ts > ?`,
    )
    .get(keyId, oldestSecond) as { used: number; oldest: number | null } | undefined;

  const used = Number(usedRow?.used ?? 0);

  if (used >= limit) {
    // Room opens when the oldest second still inside the window ages out of it.
    // The window keeps rows where `second_ts > now - 60`, so a hit at second S
    // stops counting exactly when the clock reaches S + 60 — not S + 61.
    const oldest = usedRow?.oldest ?? second;
    const freeAtMs = (oldest + WINDOW_SECONDS) * 1_000;
    return {
      allowed: false,
      // Never 0: that would tell the client to retry instantly, into the same
      // wall it just hit.
      retryAfterSec: Math.max(1, Math.ceil((freeAtMs - now) / 1_000)),
    };
  }

  db.prepare(
    `INSERT INTO rate_limit_hits (key_id, second_ts, hits)
     VALUES (?, ?, 1)
     ON CONFLICT (key_id, second_ts) DO UPDATE SET hits = hits + 1`,
  ).run(keyId, second);

  sweep(now);
  return { allowed: true, retryAfterSec: 0 };
}

/** Current usage for the dashboard, without recording a hit. */
export function rateLimitUsage(keyId: string): number {
  const oldestSecond = currentSecond(Date.now()) - WINDOW_SECONDS;
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(hits), 0) AS used
         FROM rate_limit_hits
        WHERE key_id = ? AND second_ts > ?`,
    )
    .get(keyId, oldestSecond) as { used: number } | undefined;

  return Number(row?.used ?? 0);
}

/** Forgets one key's window, or every key when called with no argument. */
export function clearRateLimit(keyId?: string): void {
  const db = getDb();
  if (keyId === undefined) db.prepare('DELETE FROM rate_limit_hits').run();
  else db.prepare('DELETE FROM rate_limit_hits WHERE key_id = ?').run(keyId);
}

/**
 * Drops rows that have aged out of every possible window. Bounded work — the
 * index on `second_ts` makes it a range delete rather than a table scan.
 */
function sweep(now: number): void {
  if (now - sweepState.lastSweep < SWEEP_INTERVAL_MS) return;
  sweepState.lastSweep = now;

  try {
    getDb()
      .prepare('DELETE FROM rate_limit_hits WHERE second_ts <= ?')
      .run(currentSecond(now) - WINDOW_SECONDS);
  } catch {
    // Housekeeping must never fail a request that was otherwise allowed.
  }
}
