import type { AdapterError, ConnectionStatus, HealthSnapshot } from '@/types/core';
import {
  addLatencySample,
  getHealthRow,
  listHealthRows,
  recomputeLatency,
  setLockout,
  upsertHealthRow,
  type HealthRow,
} from '@/lib/db/repos/health';
import { getSettings } from '@/lib/db/repos/settings';
import { clamp } from '@/lib/utils';
import { logger } from '@/lib/logger';

/** However badly a provider misbehaves, we retry it at least this often. */
const MAX_COOLDOWN_MS = 900_000;
const MIN_COOLDOWN_MS = 1_000;

/** Doubling past this is pointless: the cap has long since taken over. */
const MAX_BACKOFF_EXPONENT = 20;

/** ±20%, so a fleet of clients does not stampede a provider the instant it recovers. */
const COOLDOWN_JITTER = 0.2;

const RATE_LIMIT_LOCKOUT_MS = 60_000;
const QUOTA_LOCKOUT_MS = 900_000;

/** Below this, a connection is worth reporting as degraded rather than healthy. */
const HEALTHY_SUCCESS_RATE = 0.9;

/** Bounds on how long a half-open trial may be considered still in flight. */
const MIN_TRIAL_MS = 10_000;
const MAX_TRIAL_MS = 300_000;

function successRateOf(row: HealthRow): number {
  const total = row.successCount + row.failureCount;
  // No evidence yet is not evidence of trouble — a fresh connection scores full marks.
  return total === 0 ? 1 : clamp(row.successCount / total, 0, 1);
}

function deriveStatus(row: HealthRow): ConnectionStatus {
  if (row.breaker === 'open') return 'down';
  if (successRateOf(row) < HEALTHY_SUCCESS_RATE || row.consecutiveFailures > 0) return 'degraded';
  return 'healthy';
}

/**
 * Persisting health must never be the reason a client request fails. The only
 * realistic error here is a FK violation from a connection deleted while one of
 * its requests was still in flight, and that is precisely a case where dropping
 * the write is correct.
 */
function persist(row: HealthRow): void {
  try {
    upsertHealthRow({ ...row, status: deriveStatus(row) });
  } catch {
    // Intentionally swallowed; see above.
  }
}

function sample(
  connectionId: string,
  modelId: string,
  ttftMs: number | null,
  totalMs: number,
  ok: boolean,
): void {
  try {
    addLatencySample(connectionId, modelId, ttftMs, totalMs, ok);
  } catch {
    // Same reasoning as `persist`.
  }
}

/** Exponential on repeated opens, capped, then jittered. */
function cooldownFor(openCount: number): number {
  const base = Math.max(MIN_COOLDOWN_MS, getSettings().breakerCooldownMs);
  const exponent = Math.min(Math.max(openCount - 1, 0), MAX_BACKOFF_EXPONENT);
  const capped = Math.min(base * 2 ** exponent, MAX_COOLDOWN_MS);
  const jitter = 1 + (Math.random() * 2 - 1) * COOLDOWN_JITTER;
  return Math.round(capped * jitter);
}

/** How long a half-open trial is presumed still running before we hand out another. */
function trialWindowMs(): number {
  return clamp(getSettings().defaultTimeoutMs, MIN_TRIAL_MS, MAX_TRIAL_MS);
}

function openBreaker(row: HealthRow, now: number): HealthRow {
  const openCount = row.openCount + 1;
  const cooldownUntil = now + cooldownFor(openCount);

  // A breaker opening means a provider just left the rotation. That is the
  // event an operator wants to see without watching the dashboard.
  logger.warn('circuit breaker opened', {
    connectionId: row.connectionId,
    openCount,
    cooldownMs: cooldownUntil - now,
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
  });

  return {
    ...row,
    breaker: 'open',
    openCount,
    openedAt: now,
    cooldownUntil,
  };
}

/**
 * Whether the router may send traffic here right now.
 *
 * This deliberately mutates: the open → half-open transition is what hands out
 * the single trial request, so it has to happen exactly once, on the first
 * caller to arrive after the cooldown lapses.
 */
export function isAvailable(connectionId: string): boolean {
  const row = getHealthRow(connectionId);
  const now = Date.now();

  if (row.breaker === 'closed') return true;

  if (row.breaker === 'open') {
    if (row.cooldownUntil !== null && row.cooldownUntil > now) return false;
    // Cooldown lapsed: take the trial slot and let this one caller through.
    persist({ ...row, breaker: 'half-open', cooldownUntil: now + trialWindowMs() });
    return true;
  }

  // Half-open. The trial slot is taken until its holder reports back — but a
  // process that died mid-request must not strand the connection forever, so
  // the slot is reissued once the trial window has plainly elapsed.
  if (row.cooldownUntil !== null && row.cooldownUntil > now) return false;
  persist({ ...row, cooldownUntil: now + trialWindowMs() });
  return true;
}

export function onSuccess(
  connectionId: string,
  modelId: string,
  ttftMs: number | null,
  totalMs: number,
): void {
  sample(connectionId, modelId, ttftMs, totalMs, true);

  const row = getHealthRow(connectionId);
  const { p50, p95 } = recomputeLatency(connectionId);

  const recovered = row.breaker !== 'closed';
  if (recovered) {
    logger.info('circuit breaker closed', {
      connectionId,
      modelId,
      from: row.breaker,
      ttftMs,
    });
  }

  persist({
    ...row,
    breaker: 'closed',
    successCount: row.successCount + 1,
    consecutiveFailures: 0,
    openedAt: null,
    cooldownUntil: null,
    // Repeated flapping should still escalate, but a provider that comes back
    // and stays back earns its patience back one recovery at a time.
    openCount: recovered ? Math.max(0, row.openCount - 1) : row.openCount,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    lastError: null,
  });
}

export function onFailure(
  connectionId: string,
  modelId: string,
  err: AdapterError,
  totalMs: number,
): void {
  // A malformed request is the caller's mistake. Counting it against the
  // provider would let one broken client take a healthy connection offline.
  if (err.kind === 'bad_request') return;

  sample(connectionId, modelId, null, totalMs, false);

  const row = getHealthRow(connectionId);
  const now = Date.now();
  const { p50, p95 } = recomputeLatency(connectionId);

  const base: HealthRow = {
    ...row,
    failureCount: row.failureCount + 1,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    lastError: err.message,
  };

  if (err.kind === 'rate_limit' || err.kind === 'quota_exceeded') {
    // Throttling is per-model and temporary. Opening the whole connection would
    // throw away every other model the provider is still happy to serve.
    const fallbackMs = err.kind === 'quota_exceeded' ? QUOTA_LOCKOUT_MS : RATE_LIMIT_LOCKOUT_MS;
    const waitMs = err.retryAfterSec !== null ? Math.round(err.retryAfterSec * 1_000) : fallbackMs;
    try {
      setLockout(connectionId, modelId, now + Math.max(1_000, waitMs), err.message || err.kind);
      logger.info('model locked out', {
        connectionId,
        modelId,
        kind: err.kind,
        forMs: Math.max(1_000, waitMs),
        // Whether the provider told us how long, or we guessed, is the first
        // thing worth knowing when a lockout looks wrong.
        source: err.retryAfterSec !== null ? 'retry-after' : 'default',
      });
    } catch {
      // Connection deleted mid-flight; nothing left to lock out.
    }
    persist(base);
    return;
  }

  const consecutiveFailures = row.consecutiveFailures + 1;
  const withFailure: HealthRow = { ...base, consecutiveFailures };

  // A bad credential does not heal on its own, and a half-open trial that fails
  // is the provider telling us the cooldown was too short.
  const threshold = Math.max(1, getSettings().breakerFailureThreshold);
  const shouldOpen =
    err.kind === 'auth' || row.breaker === 'half-open' || consecutiveFailures >= threshold;

  persist(shouldOpen ? openBreaker(withFailure, now) : withFailure);
}

function toSnapshot(row: HealthRow): HealthSnapshot {
  return {
    connectionId: row.connectionId,
    status: deriveStatus(row),
    breaker: row.breaker,
    successRate: successRateOf(row),
    p50LatencyMs: row.p50LatencyMs,
    p95LatencyMs: row.p95LatencyMs,
    consecutiveFailures: row.consecutiveFailures,
    openedAt: row.openedAt,
    cooldownUntil: row.cooldownUntil,
    lastCheckedAt: row.lastCheckedAt,
    lastError: row.lastError,
  };
}

export function snapshot(connectionId: string): HealthSnapshot {
  return toSnapshot(getHealthRow(connectionId));
}

export function snapshotAll(): Record<string, HealthSnapshot> {
  const out: Record<string, HealthSnapshot> = {};
  for (const [connectionId, row] of Object.entries(listHealthRows())) {
    out[connectionId] = toSnapshot(row);
  }
  return out;
}

/** Operator override: forgive everything, including the backoff history. */
export function resetBreaker(connectionId: string): void {
  const row = getHealthRow(connectionId);
  persist({
    ...row,
    breaker: 'closed',
    consecutiveFailures: 0,
    openedAt: null,
    cooldownUntil: null,
    openCount: 0,
    lastError: null,
  });
}
