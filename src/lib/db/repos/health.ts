import type { BreakerState, ConnectionStatus, ModelLockout } from '@/types/core';
import { getDb, toInt } from '@/lib/db/client';
import { asRow, asRows, num, numOrNull, oneOf, str, strOrNull } from '@/lib/db/rows';

const STATUSES: readonly ConnectionStatus[] = [
  'healthy',
  'degraded',
  'down',
  'disabled',
  'unconfigured',
];

const BREAKER_STATES: readonly BreakerState[] = ['closed', 'open', 'half-open'];

/** How far back `recomputeLatency` will look, and how many samples it will read. */
const LATENCY_WINDOW_MS = 3_600_000;
const LATENCY_SAMPLE_LIMIT = 200;

/** Percentiles from one or two data points are noise, not signal. */
const MIN_SAMPLES_FOR_PERCENTILES = 3;

export interface HealthRow {
  connectionId: string;
  status: ConnectionStatus;
  breaker: BreakerState;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  openedAt: number | null;
  cooldownUntil: number | null;
  openCount: number;
  lastCheckedAt: number | null;
  lastError: string | null;
}

const COLUMNS = `
  connection_id, status, breaker, success_count, failure_count, consecutive_failures,
  p50_latency_ms, p95_latency_ms, opened_at, cooldown_until, open_count,
  last_checked_at, last_error
`;

/**
 * The shape a connection has before anything has ever touched it. Callers treat
 * a missing row and a pristine row identically, so this is never null.
 */
export function defaultHealthRow(connectionId: string): HealthRow {
  return {
    connectionId,
    status: 'unconfigured',
    breaker: 'closed',
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    p50LatencyMs: null,
    p95LatencyMs: null,
    openedAt: null,
    cooldownUntil: null,
    openCount: 0,
    lastCheckedAt: null,
    lastError: null,
  };
}

function toHealthRow(raw: Record<string, unknown>): HealthRow {
  return {
    connectionId: str(raw.connection_id),
    status: oneOf<ConnectionStatus>(raw.status, STATUSES, 'unconfigured'),
    breaker: oneOf<BreakerState>(raw.breaker, BREAKER_STATES, 'closed'),
    successCount: num(raw.success_count),
    failureCount: num(raw.failure_count),
    consecutiveFailures: num(raw.consecutive_failures),
    p50LatencyMs: numOrNull(raw.p50_latency_ms),
    p95LatencyMs: numOrNull(raw.p95_latency_ms),
    openedAt: numOrNull(raw.opened_at),
    cooldownUntil: numOrNull(raw.cooldown_until),
    openCount: num(raw.open_count),
    lastCheckedAt: numOrNull(raw.last_checked_at),
    lastError: strOrNull(raw.last_error),
  };
}

export function getHealthRow(connectionId: string): HealthRow {
  const raw = asRow(
    getDb().prepare(`SELECT ${COLUMNS} FROM health WHERE connection_id = ?`).get(connectionId),
  );
  return raw === null ? defaultHealthRow(connectionId) : toHealthRow(raw);
}

export function upsertHealthRow(row: HealthRow): void {
  getDb()
    .prepare(
      `INSERT INTO health
         (connection_id, status, breaker, success_count, failure_count, consecutive_failures,
          p50_latency_ms, p95_latency_ms, opened_at, cooldown_until, open_count,
          last_checked_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connection_id) DO UPDATE SET
         status               = excluded.status,
         breaker              = excluded.breaker,
         success_count        = excluded.success_count,
         failure_count        = excluded.failure_count,
         consecutive_failures = excluded.consecutive_failures,
         p50_latency_ms       = excluded.p50_latency_ms,
         p95_latency_ms       = excluded.p95_latency_ms,
         opened_at            = excluded.opened_at,
         cooldown_until       = excluded.cooldown_until,
         open_count           = excluded.open_count,
         last_checked_at      = excluded.last_checked_at,
         last_error           = excluded.last_error`,
    )
    .run(
      row.connectionId,
      row.status,
      row.breaker,
      Math.trunc(row.successCount),
      Math.trunc(row.failureCount),
      Math.trunc(row.consecutiveFailures),
      row.p50LatencyMs,
      row.p95LatencyMs,
      row.openedAt === null ? null : Math.trunc(row.openedAt),
      row.cooldownUntil === null ? null : Math.trunc(row.cooldownUntil),
      Math.trunc(row.openCount),
      row.lastCheckedAt === null ? null : Math.trunc(row.lastCheckedAt),
      row.lastError === null ? null : row.lastError.slice(0, 2_000),
    );
}

export function listHealthRows(): Record<string, HealthRow> {
  const out: Record<string, HealthRow> = {};
  for (const raw of asRows(getDb().prepare(`SELECT ${COLUMNS} FROM health`).all())) {
    const row = toHealthRow(raw);
    if (row.connectionId !== '') out[row.connectionId] = row;
  }
  return out;
}

// ─── Latency samples ─────────────────────────────────────────────────────────

export function addLatencySample(
  connectionId: string,
  modelId: string,
  ttftMs: number | null,
  totalMs: number,
  ok: boolean,
): void {
  const total = Number.isFinite(totalMs) ? Math.max(0, totalMs) : 0;
  const ttft = ttftMs !== null && Number.isFinite(ttftMs) ? Math.max(0, ttftMs) : null;

  getDb()
    .prepare(
      `INSERT INTO latency_samples (connection_id, model_id, ts, ttft_ms, total_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(connectionId, modelId, Date.now(), ttft, total, toInt(ok));
}

/** Nearest-rank percentile over an already-sorted ascending list. */
function percentile(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index] ?? null;
}

/**
 * Percentiles over the recent window. Time-to-first-token is what a user
 * actually waits for, so it wins over total duration whenever the sample
 * carries one — a long streamed answer is not a slow provider.
 */
export function recomputeLatency(connectionId: string): { p50: number | null; p95: number | null } {
  const rows = asRows(
    getDb()
      .prepare(
        // `ok = 1` is load-bearing, not a tidy-up. Failures are recorded as
        // samples too, and a connection-refused or an instant 401 returns in a
        // few milliseconds — so without this filter a completely broken
        // provider posts the fastest p50 in the fleet, and the `fastest`
        // strategy actively prefers it. Latency means "how quickly it served a
        // request", which only successes can answer.
        `SELECT ttft_ms, total_ms FROM latency_samples
         WHERE connection_id = ? AND ts >= ? AND ok = 1
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(connectionId, Date.now() - LATENCY_WINDOW_MS, LATENCY_SAMPLE_LIMIT),
  );

  const values: number[] = [];
  for (const row of rows) {
    const ttft = numOrNull(row.ttft_ms);
    const value = ttft ?? numOrNull(row.total_ms);
    if (value !== null && Number.isFinite(value)) values.push(value);
  }

  if (values.length < MIN_SAMPLES_FOR_PERCENTILES) return { p50: null, p95: null };

  values.sort((a, b) => a - b);
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

/** Drops samples older than `olderThanMs` milliseconds ago. */
export function pruneLatencySamples(olderThanMs: number): void {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) return;
  getDb()
    .prepare('DELETE FROM latency_samples WHERE ts < ?')
    .run(Date.now() - Math.trunc(olderThanMs));
}

// ─── Per-model lockouts ──────────────────────────────────────────────────────

/**
 * A lockout only ever extends. A provider that answers a 15-minute quota wall
 * with a stray "retry in 5s" must not talk us into hammering it again early.
 */
export function setLockout(
  connectionId: string,
  modelId: string,
  until: number,
  reason: string,
): void {
  if (!Number.isFinite(until)) return;

  getDb()
    .prepare(
      `INSERT INTO model_lockouts (connection_id, model_id, until, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(connection_id, model_id) DO UPDATE SET
         until  = MAX(model_lockouts.until, excluded.until),
         reason = CASE
                    WHEN excluded.until >= model_lockouts.until THEN excluded.reason
                    ELSE model_lockouts.reason
                  END`,
    )
    .run(connectionId, modelId, Math.trunc(until), reason.slice(0, 500));
}

export function isLockedOut(connectionId: string, modelId: string): boolean {
  const row = asRow(
    getDb()
      .prepare(
        `SELECT 1 AS locked FROM model_lockouts
         WHERE connection_id = ? AND model_id = ? AND until > ?`,
      )
      .get(connectionId, modelId, Date.now()),
  );
  return row !== null;
}

/** Only lockouts still in force; expired rows are noise to every caller. */
export function listLockouts(): ModelLockout[] {
  const rows = asRows(
    getDb()
      .prepare(
        `SELECT connection_id, model_id, until, reason FROM model_lockouts
         WHERE until > ?
         ORDER BY until ASC`,
      )
      .all(Date.now()),
  );

  return rows.map((row) => ({
    connectionId: str(row.connection_id),
    modelId: str(row.model_id),
    until: num(row.until),
    reason: str(row.reason),
  }));
}

export function clearExpiredLockouts(): void {
  getDb().prepare('DELETE FROM model_lockouts WHERE until <= ?').run(Date.now());
}
