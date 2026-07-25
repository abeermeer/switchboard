import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { AdapterError, ModelLockout } from '@/types/core';
import {
  isAvailable,
  onFailure,
  onSuccess,
  resetBreaker,
  snapshot,
  snapshotAll,
} from '@/lib/resilience/breaker';
import { createConnection } from '@/lib/db/repos/connections';
import { getHealthRow, isLockedOut, listLockouts, upsertHealthRow } from '@/lib/db/repos/health';
import { getSettings, updateSettings } from '@/lib/db/repos/settings';
import { countRows, dropDb, freshDb } from '../helpers/db';

/**
 * Every branch in the breaker is a comparison against `Date.now()`, so the
 * clock is frozen for the whole suite. That turns "roughly a minute from now"
 * into an exact number and keeps the cooldown/lockout assertions honest.
 */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const MODEL = 'llama-3.3-70b-versatile';
const OTHER_MODEL = 'llama-3.1-8b-instant';

/** Failure kinds the breaker is supposed to count against the provider. */
const ORDINARY_KINDS: readonly AdapterError['kind'][] = ['server', 'network', 'timeout'];

function failure(kind: AdapterError['kind'], patch: Partial<AdapterError> = {}): AdapterError {
  return { kind, message: `upstream said ${kind}`, retryAfterSec: null, raw: null, ...patch };
}

describe('resilience/breaker', () => {
  let dir: string;
  let connectionId: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dir = freshDb();
    connectionId = createConnection({ providerId: 'groq', label: 'Groq (test)' }).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    dropDb(dir);
  });

  /**
   * Writes a breaker state straight into the health row, so a state-machine
   * test does not have to reproduce the failure history that would have
   * produced it.
   */
  function forceOpen(cooldownUntil: number | null, openCount = 1): void {
    upsertHealthRow({
      ...getHealthRow(connectionId),
      breaker: 'open',
      openedAt: Date.now(),
      cooldownUntil,
      openCount,
    });
  }

  function forceHalfOpen(cooldownUntil: number | null, openCount = 1): void {
    upsertHealthRow({
      ...getHealthRow(connectionId),
      breaker: 'half-open',
      openedAt: Date.now(),
      cooldownUntil,
      openCount,
    });
  }

  /** How long the current open period will last, straight from the row. */
  function cooldownMs(): number {
    const { openedAt, cooldownUntil } = getHealthRow(connectionId);
    if (openedAt === null || cooldownUntil === null) {
      throw new Error('cooldownMs called while the breaker was not open');
    }
    return cooldownUntil - openedAt;
  }

  function fail(kind: AdapterError['kind'], patch: Partial<AdapterError> = {}): void {
    onFailure(connectionId, MODEL, failure(kind, patch), 120);
  }

  function onlyLockout(): ModelLockout {
    const lockouts = listLockouts();
    expect(lockouts).toHaveLength(1);
    const lockout = lockouts[0];
    if (lockout === undefined) throw new Error('expected exactly one lockout');
    return lockout;
  }

  // ─── State machine ─────────────────────────────────────────────────────────

  describe('state machine', () => {
    it('lets traffic through while the breaker is closed', () => {
      expect(isAvailable(connectionId)).toBe(true);
      expect(snapshot(connectionId).breaker).toBe('closed');
    });

    it('is available for a connection that has never been touched', () => {
      // No health row exists yet. Failing closed here would black-hole every
      // brand-new connection the moment it was created.
      expect(countRows('health')).toBe(0);
      expect(isAvailable(connectionId)).toBe(true);
    });

    it('refuses traffic while an open breaker is still cooling down', () => {
      forceOpen(NOW + 30_000);
      expect(isAvailable(connectionId)).toBe(false);
      expect(isAvailable(connectionId)).toBe(false);
    });

    it('leaves an open breaker open when it refuses traffic', () => {
      forceOpen(NOW + 30_000);
      isAvailable(connectionId);
      const snap = snapshot(connectionId);
      expect(snap.breaker).toBe('open');
      expect(snap.cooldownUntil).toBe(NOW + 30_000);
    });

    it('still refuses one millisecond before the cooldown expires', () => {
      forceOpen(NOW + 1);
      expect(isAvailable(connectionId)).toBe(false);
    });

    it('treats the cooldown deadline itself as expired', () => {
      // `cooldownUntil > now` — at exactly the deadline the connection is
      // eligible again, which is what "eligible at cooldownUntil" means.
      forceOpen(NOW);
      expect(isAvailable(connectionId)).toBe(true);
      expect(snapshot(connectionId).breaker).toBe('half-open');
    });

    it('flips an open breaker whose cooldown has lapsed to half-open', () => {
      forceOpen(NOW - 1);
      expect(isAvailable(connectionId)).toBe(true);
      expect(snapshot(connectionId).breaker).toBe('half-open');
    });

    it('treats an open breaker with no recorded cooldown as eligible', () => {
      forceOpen(null);
      expect(isAvailable(connectionId)).toBe(true);
      expect(snapshot(connectionId).breaker).toBe('half-open');
    });

    it('hands the half-open trial to exactly one caller', () => {
      // The whole point of the design: past the cooldown, the first caller
      // takes the trial slot and everyone behind it is turned away.
      forceOpen(NOW - 1);
      expect(isAvailable(connectionId)).toBe(true);
      expect(isAvailable(connectionId)).toBe(false);
      expect(isAvailable(connectionId)).toBe(false);
    });

    it('holds the trial slot for the configured attempt timeout', () => {
      updateSettings({ defaultTimeoutMs: 45_000 });
      forceOpen(NOW - 1);
      isAvailable(connectionId);
      expect(snapshot(connectionId).cooldownUntil).toBe(NOW + 45_000);
    });

    it('never holds the trial slot for less than ten seconds', () => {
      updateSettings({ defaultTimeoutMs: 0 });
      forceOpen(NOW - 1);
      isAvailable(connectionId);
      expect(snapshot(connectionId).cooldownUntil).toBe(NOW + 10_000);
    });

    it('never holds the trial slot for more than five minutes', () => {
      updateSettings({ defaultTimeoutMs: 600_000 });
      forceOpen(NOW - 1);
      isAvailable(connectionId);
      expect(snapshot(connectionId).cooldownUntil).toBe(NOW + 300_000);
    });

    it('refuses a second trial while the first one is still in flight', () => {
      forceHalfOpen(NOW + 5_000);
      expect(isAvailable(connectionId)).toBe(false);
      expect(snapshot(connectionId).breaker).toBe('half-open');
    });

    it('reissues a stranded trial slot once its window has plainly elapsed', () => {
      // A process that died mid-request must not wedge the connection forever.
      updateSettings({ defaultTimeoutMs: 30_000 });
      forceHalfOpen(NOW + 30_000);
      expect(isAvailable(connectionId)).toBe(false);

      vi.setSystemTime(NOW + 30_001);
      expect(isAvailable(connectionId)).toBe(true);
      expect(snapshot(connectionId).breaker).toBe('half-open');
      expect(snapshot(connectionId).cooldownUntil).toBe(NOW + 30_001 + 30_000);
    });

    it('gives the reissued trial slot to exactly one caller too', () => {
      forceHalfOpen(NOW - 1);
      expect(isAvailable(connectionId)).toBe(true);
      expect(isAvailable(connectionId)).toBe(false);
    });

    it('closes the breaker when the half-open trial succeeds', () => {
      forceHalfOpen(NOW + 60_000, 3);
      fail('server');
      onSuccess(connectionId, MODEL, 25, 300);

      const snap = snapshot(connectionId);
      expect(snap.breaker).toBe('closed');
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.openedAt).toBeNull();
      expect(snap.cooldownUntil).toBeNull();
      expect(snap.lastError).toBeNull();
      expect(isAvailable(connectionId)).toBe(true);
    });

    it('hands back one open of backoff credit when a trial succeeds', () => {
      // A provider that comes back and stays back earns its patience back one
      // recovery at a time, rather than all at once.
      forceHalfOpen(NOW + 60_000, 3);
      onSuccess(connectionId, MODEL, 25, 300);
      expect(getHealthRow(connectionId).openCount).toBe(2);
    });

    it('never drives the backoff credit below zero', () => {
      forceHalfOpen(NOW + 60_000, 0);
      onSuccess(connectionId, MODEL, 25, 300);
      expect(getHealthRow(connectionId).openCount).toBe(0);
    });

    it('does not hand back backoff credit for a success on a closed breaker', () => {
      forceOpen(NOW - 1, 4);
      isAvailable(connectionId);
      onSuccess(connectionId, MODEL, 25, 300);
      expect(getHealthRow(connectionId).openCount).toBe(3);

      onSuccess(connectionId, MODEL, 25, 300);
      expect(getHealthRow(connectionId).openCount).toBe(3);
    });

    it('re-opens the breaker when the half-open trial fails', () => {
      forceHalfOpen(NOW + 60_000, 1);
      fail('server');

      const snap = snapshot(connectionId);
      expect(snap.breaker).toBe('open');
      expect(snap.status).toBe('down');
      expect(snap.openedAt).toBe(NOW);
      expect(isAvailable(connectionId)).toBe(false);
    });

    it('re-opens on a failed trial even when the failure threshold is far away', () => {
      // A failed trial is the provider telling us the cooldown was too short,
      // so the consecutive-failure count is irrelevant here.
      updateSettings({ breakerFailureThreshold: 50 });
      forceHalfOpen(NOW + 60_000, 1);
      fail('server');

      expect(snapshot(connectionId).breaker).toBe('open');
      expect(snapshot(connectionId).consecutiveFailures).toBe(1);
    });

    it('re-opens a failed trial with a longer cooldown than the previous open', () => {
      updateSettings({ breakerCooldownMs: 10_000 });
      forceHalfOpen(NOW + 60_000, 1);
      fail('server');

      // openCount 1 → 2, so the base doubles. Even at the extremes of the ±20%
      // jitter the second wait cannot overlap the first.
      expect(cooldownMs()).toBeGreaterThan(12_000);
      expect(cooldownMs()).toBeGreaterThanOrEqual(16_000);
      expect(cooldownMs()).toBeLessThanOrEqual(24_000);
    });
  });

  // ─── Error classification ──────────────────────────────────────────────────

  describe('error classification', () => {
    it("opens the breaker immediately on an 'auth' failure", () => {
      // A bad credential does not heal on its own, so it never waits for the
      // threshold.
      updateSettings({ breakerFailureThreshold: 10 });
      fail('auth', { message: '401 invalid api key' });

      const snap = snapshot(connectionId);
      expect(snap.breaker).toBe('open');
      expect(snap.status).toBe('down');
      expect(snap.consecutiveFailures).toBe(1);
      expect(snap.openedAt).toBe(NOW);
      expect(snap.lastError).toBe('401 invalid api key');
      expect(isAvailable(connectionId)).toBe(false);
    });

    it("records an 'auth' failure as a real failure sample", () => {
      fail('auth');
      expect(countRows('latency_samples')).toBe(1);
      expect(snapshot(connectionId).successRate).toBe(0);
    });

    it("ignores a 'bad_request' failure entirely", () => {
      // One broken client must not be able to take a healthy connection
      // offline, so a malformed request is not the provider's fault.
      updateSettings({ breakerFailureThreshold: 1 });
      for (let i = 0; i < 5; i += 1) fail('bad_request');

      const snap = snapshot(connectionId);
      expect(snap.breaker).toBe('closed');
      expect(snap.status).toBe('healthy');
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.successRate).toBe(1);
      expect(snap.lastError).toBeNull();
      expect(isAvailable(connectionId)).toBe(true);
    });

    it("writes nothing at all for a 'bad_request' failure", () => {
      updateSettings({ breakerFailureThreshold: 1 });
      fail('bad_request');
      expect(countRows('health')).toBe(0);
      expect(countRows('latency_samples')).toBe(0);
      expect(countRows('model_lockouts')).toBe(0);
    });

    it("does not let a 'bad_request' erase the record of a real failure", () => {
      fail('server', { message: 'upstream exploded' });
      fail('bad_request', { message: 'missing field "messages"' });

      const snap = snapshot(connectionId);
      expect(snap.lastError).toBe('upstream exploded');
      expect(snap.consecutiveFailures).toBe(1);
      expect(countRows('latency_samples')).toBe(1);
    });

    it("locks out only the throttled model on a 'rate_limit' failure", () => {
      // Opening the whole connection would throw away every other model the
      // provider is still happy to serve.
      updateSettings({ breakerFailureThreshold: 1 });
      fail('rate_limit');

      expect(isLockedOut(connectionId, MODEL)).toBe(true);
      expect(isLockedOut(connectionId, OTHER_MODEL)).toBe(false);
      expect(snapshot(connectionId).breaker).toBe('closed');
      expect(isAvailable(connectionId)).toBe(true);
    });

    it("does not count a 'rate_limit' toward the failure threshold", () => {
      updateSettings({ breakerFailureThreshold: 2 });
      fail('rate_limit');
      fail('rate_limit');
      fail('rate_limit');

      expect(snapshot(connectionId).consecutiveFailures).toBe(0);
      expect(snapshot(connectionId).breaker).toBe('closed');
    });

    it("still counts a 'rate_limit' against the success rate", () => {
      fail('rate_limit');
      const snap = snapshot(connectionId);
      expect(snap.successRate).toBe(0);
      expect(snap.status).toBe('degraded');
      expect(countRows('latency_samples')).toBe(1);
    });

    it("honours retryAfterSec on a 'rate_limit'", () => {
      fail('rate_limit', { retryAfterSec: 5 });
      expect(onlyLockout().until).toBe(NOW + 5_000);
    });

    it('rounds a fractional retryAfterSec to whole milliseconds', () => {
      fail('rate_limit', { retryAfterSec: 2.5 });
      expect(onlyLockout().until).toBe(NOW + 2_500);
    });

    it("falls back to a minute when a 'rate_limit' carries no retryAfterSec", () => {
      fail('rate_limit', { retryAfterSec: null });
      expect(onlyLockout().until).toBe(NOW + 60_000);
    });

    it('floors a zero retryAfterSec at one second', () => {
      fail('rate_limit', { retryAfterSec: 0 });
      expect(onlyLockout().until).toBe(NOW + 1_000);
    });

    it('floors a negative retryAfterSec at one second', () => {
      fail('rate_limit', { retryAfterSec: -30 });
      expect(onlyLockout().until).toBe(NOW + 1_000);
    });

    it('extends a lockout but never shortens it', () => {
      // A provider that answers a long wall with a stray "retry in 5s" must not
      // talk us into hammering it again early.
      fail('rate_limit', { retryAfterSec: 300, message: 'daily cap reached' });
      fail('rate_limit', { retryAfterSec: 5, message: 'retry shortly' });

      const lockout = onlyLockout();
      expect(lockout.until).toBe(NOW + 300_000);
      expect(lockout.reason).toBe('daily cap reached');
    });

    it('labels a lockout with the error kind when the message is empty', () => {
      fail('rate_limit', { message: '' });
      expect(onlyLockout().reason).toBe('rate_limit');
    });

    it("locks a model out for fifteen minutes on 'quota_exceeded'", () => {
      fail('quota_exceeded');
      expect(onlyLockout().until).toBe(NOW + 900_000);
      expect(isLockedOut(connectionId, MODEL)).toBe(true);
    });

    it("leaves the breaker closed on 'quota_exceeded'", () => {
      updateSettings({ breakerFailureThreshold: 1 });
      fail('quota_exceeded');

      expect(snapshot(connectionId).breaker).toBe('closed');
      expect(snapshot(connectionId).consecutiveFailures).toBe(0);
      expect(isAvailable(connectionId)).toBe(true);
      expect(isLockedOut(connectionId, OTHER_MODEL)).toBe(false);
    });

    it("honours retryAfterSec on 'quota_exceeded' too", () => {
      fail('quota_exceeded', { retryAfterSec: 30 });
      expect(onlyLockout().until).toBe(NOW + 30_000);
    });

    it('keeps lockouts separate per model on the same connection', () => {
      onFailure(connectionId, MODEL, failure('rate_limit', { retryAfterSec: 10 }), 50);
      onFailure(connectionId, OTHER_MODEL, failure('rate_limit', { retryAfterSec: 20 }), 50);

      expect(listLockouts()).toHaveLength(2);
      expect(isLockedOut(connectionId, MODEL)).toBe(true);
      expect(isLockedOut(connectionId, OTHER_MODEL)).toBe(true);

      vi.setSystemTime(NOW + 15_000);
      expect(isLockedOut(connectionId, MODEL)).toBe(false);
      expect(isLockedOut(connectionId, OTHER_MODEL)).toBe(true);
    });

    for (const kind of ORDINARY_KINDS) {
      it(`opens the breaker on the threshold-th consecutive '${kind}' failure`, () => {
        updateSettings({ breakerFailureThreshold: 3 });

        fail(kind);
        expect(snapshot(connectionId).breaker).toBe('closed');
        fail(kind);
        expect(snapshot(connectionId).breaker).toBe('closed');
        expect(isAvailable(connectionId)).toBe(true);

        fail(kind);
        expect(snapshot(connectionId).breaker).toBe('open');
        expect(snapshot(connectionId).consecutiveFailures).toBe(3);
        expect(isAvailable(connectionId)).toBe(false);
      });
    }

    it('accumulates unlike ordinary failure kinds toward the same threshold', () => {
      updateSettings({ breakerFailureThreshold: 3 });
      fail('server');
      fail('timeout');
      expect(snapshot(connectionId).breaker).toBe('closed');
      fail('network');
      expect(snapshot(connectionId).breaker).toBe('open');
    });

    it('opens exactly on the configured threshold, whatever it is set to', () => {
      const threshold = getSettings().breakerFailureThreshold;
      expect(threshold).toBeGreaterThan(1);

      for (let i = 1; i < threshold; i += 1) {
        fail('server');
        expect(snapshot(connectionId).breaker).toBe('closed');
      }
      fail('server');
      expect(snapshot(connectionId).breaker).toBe('open');
    });

    it('opens on the very first failure when the threshold is one', () => {
      updateSettings({ breakerFailureThreshold: 1 });
      fail('server');
      expect(snapshot(connectionId).breaker).toBe('open');
    });

    it('treats a threshold of zero as one rather than opening on nothing', () => {
      updateSettings({ breakerFailureThreshold: 0 });
      expect(snapshot(connectionId).breaker).toBe('closed');
      fail('server');
      expect(snapshot(connectionId).breaker).toBe('open');
    });

    it('restarts the failure count after a success', () => {
      updateSettings({ breakerFailureThreshold: 3 });
      fail('server');
      fail('server');
      onSuccess(connectionId, MODEL, 30, 400);
      expect(snapshot(connectionId).consecutiveFailures).toBe(0);

      fail('server');
      fail('server');
      expect(snapshot(connectionId).breaker).toBe('closed');
    });

    it('never lets a health write fail the request that triggered it', () => {
      // The realistic cause is a connection deleted while one of its requests
      // was still in flight, and dropping the write is the right answer there.
      expect(() => onFailure('conn_deleted', MODEL, failure('server'), 40)).not.toThrow();
      expect(() => onFailure('conn_deleted', MODEL, failure('rate_limit'), 40)).not.toThrow();
      expect(() => onSuccess('conn_deleted', MODEL, 10, 40)).not.toThrow();

      expect(countRows('health')).toBe(0);
      expect(countRows('model_lockouts')).toBe(0);
    });
  });

  // ─── Cooldown math ─────────────────────────────────────────────────────────

  describe('cooldown math', () => {
    beforeEach(() => {
      updateSettings({ breakerFailureThreshold: 1, breakerCooldownMs: 10_000 });
    });

    it('waits longer on the second open than on the first', () => {
      fail('server');
      const first = cooldownMs();
      fail('server');
      const second = cooldownMs();

      expect(second).toBeGreaterThan(first);
      expect(first).toBeGreaterThanOrEqual(8_000);
      expect(first).toBeLessThanOrEqual(12_000);
      expect(second).toBeGreaterThanOrEqual(16_000);
      expect(second).toBeLessThanOrEqual(24_000);
    });

    it('doubles the base wait on every subsequent open', () => {
      const bounds = [
        [8_000, 12_000],
        [16_000, 24_000],
        [32_000, 48_000],
        [64_000, 96_000],
      ] as const;

      for (const [low, high] of bounds) {
        fail('server');
        expect(cooldownMs()).toBeGreaterThanOrEqual(low);
        expect(cooldownMs()).toBeLessThanOrEqual(high);
      }
    });

    it('caps the wait at fifteen minutes however many times it has opened', () => {
      updateSettings({ breakerCooldownMs: 600_000 });
      for (let i = 0; i < 25; i += 1) fail('server');

      expect(cooldownMs()).toBeGreaterThanOrEqual(720_000);
      expect(cooldownMs()).toBeLessThanOrEqual(1_080_000);
    });

    it('reaches exactly the fifteen-minute cap with the jitter neutralised', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      updateSettings({ breakerCooldownMs: 600_000 });

      for (let i = 0; i < 25; i += 1) fail('server');
      expect(cooldownMs()).toBe(900_000);
    });

    it('applies exactly -20% at the bottom of the jitter range', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      fail('server');
      expect(cooldownMs()).toBe(8_000);
    });

    it('applies no jitter at the middle of the range', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      fail('server');
      expect(cooldownMs()).toBe(10_000);
    });

    it('keeps every jittered wait inside ±20% of the base, and does vary it', () => {
      const seen = new Set<number>();
      for (let i = 0; i < 40; i += 1) {
        // Resetting drops openCount back to zero, so each open is the first one
        // again and every sample is drawn against the same base.
        resetBreaker(connectionId);
        fail('server');
        const waited = cooldownMs();
        expect(waited).toBeGreaterThanOrEqual(8_000);
        expect(waited).toBeLessThanOrEqual(12_000);
        seen.add(waited);
      }
      expect(seen.size).toBeGreaterThan(1);
    });

    it('waits the one-second floor when the configured cooldown is zero', () => {
      updateSettings({ breakerCooldownMs: 0 });
      fail('server');
      expect(cooldownMs()).toBeGreaterThanOrEqual(800);
      expect(cooldownMs()).toBeLessThanOrEqual(1_200);
    });

    it('sets cooldownUntil relative to the moment the breaker opened', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      vi.setSystemTime(NOW + 5_000);
      fail('server');

      const snap = snapshot(connectionId);
      expect(snap.openedAt).toBe(NOW + 5_000);
      expect(snap.cooldownUntil).toBe(NOW + 15_000);
    });
  });

  // ─── Snapshot derivation ───────────────────────────────────────────────────

  describe('snapshot derivation', () => {
    it('reports a pristine connection as healthy with a perfect success rate', () => {
      // No evidence yet is not evidence of trouble.
      expect(snapshot(connectionId)).toEqual({
        connectionId,
        status: 'healthy',
        breaker: 'closed',
        successRate: 1,
        p50LatencyMs: null,
        p95LatencyMs: null,
        consecutiveFailures: 0,
        openedAt: null,
        cooldownUntil: null,
        lastCheckedAt: null,
        lastError: null,
      });
    });

    it('reports an unknown connection id as a healthy default instead of throwing', () => {
      expect(snapshot('conn_never_existed').status).toBe('healthy');
      expect(snapshot('conn_never_existed').successRate).toBe(1);
    });

    it('reports the real ratio once there is data', () => {
      onSuccess(connectionId, MODEL, 10, 100);
      onSuccess(connectionId, MODEL, 10, 100);
      onSuccess(connectionId, MODEL, 10, 100);
      fail('server');
      expect(snapshot(connectionId).successRate).toBe(0.75);
    });

    it("is 'down' whenever the breaker is open", () => {
      forceOpen(NOW + 30_000);
      const snap = snapshot(connectionId);
      expect(snap.status).toBe('down');
      expect(snap.breaker).toBe('open');
    });

    it("is 'down' even with a spotless success rate behind it", () => {
      updateSettings({ breakerFailureThreshold: 50 });
      for (let i = 0; i < 20; i += 1) onSuccess(connectionId, MODEL, 10, 100);
      fail('auth');

      const snap = snapshot(connectionId);
      expect(snap.successRate).toBeGreaterThan(0.9);
      expect(snap.status).toBe('down');
    });

    it("is 'degraded' below a 0.9 success rate", () => {
      fail('server');
      for (let i = 0; i < 8; i += 1) onSuccess(connectionId, MODEL, 10, 100);

      const snap = snapshot(connectionId);
      expect(snap.successRate).toBeCloseTo(8 / 9, 10);
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.status).toBe('degraded');
    });

    it("is 'healthy' at exactly a 0.9 success rate", () => {
      fail('server');
      for (let i = 0; i < 9; i += 1) onSuccess(connectionId, MODEL, 10, 100);

      const snap = snapshot(connectionId);
      expect(snap.successRate).toBe(0.9);
      expect(snap.status).toBe('healthy');
    });

    it("is 'degraded' after a single failure however good the ratio is", () => {
      for (let i = 0; i < 20; i += 1) onSuccess(connectionId, MODEL, 10, 100);
      expect(snapshot(connectionId).status).toBe('healthy');

      fail('server');
      const snap = snapshot(connectionId);
      expect(snap.consecutiveFailures).toBe(1);
      expect(snap.successRate).toBeGreaterThan(0.9);
      expect(snap.breaker).toBe('closed');
      expect(snap.status).toBe('degraded');
    });

    it('returns to healthy once a success clears the consecutive failures', () => {
      for (let i = 0; i < 20; i += 1) onSuccess(connectionId, MODEL, 10, 100);
      fail('server');
      onSuccess(connectionId, MODEL, 10, 100);
      expect(snapshot(connectionId).status).toBe('healthy');
    });

    it('withholds latency percentiles until there are three samples', () => {
      onSuccess(connectionId, MODEL, 10, 500);
      expect(snapshot(connectionId).p50LatencyMs).toBeNull();
      onSuccess(connectionId, MODEL, 30, 500);
      expect(snapshot(connectionId).p50LatencyMs).toBeNull();

      onSuccess(connectionId, MODEL, 20, 500);
      const snap = snapshot(connectionId);
      expect(snap.p50LatencyMs).toBe(20);
      expect(snap.p95LatencyMs).toBe(30);
    });

    it('ignores failed requests when computing latency', () => {
      // Regression: failures are recorded as samples too, and they return fast
      // — a refused connection or an instant 401 takes single-digit
      // milliseconds. Counting them made a broken provider post the best p50 in
      // the fleet, so the `fastest` strategy actively preferred whatever was
      // most reliably down.
      onSuccess(connectionId, MODEL, 400, 400);
      onSuccess(connectionId, MODEL, 400, 400);
      onSuccess(connectionId, MODEL, 400, 400);
      expect(snapshot(connectionId).p50LatencyMs).toBe(400);

      // Twenty instant failures must not drag the measured latency down.
      for (let i = 0; i < 20; i += 1) {
        onFailure(connectionId, MODEL, failure('server'), 3);
      }

      expect(snapshot(connectionId).p50LatencyMs).toBe(400);
    });

    it('reports no latency at all for a connection that has only ever failed', () => {
      // Null is the honest answer: nothing has successfully served a request,
      // so there is no latency to report. Scoring treats an unmeasured
      // candidate as mid-pack rather than fastest.
      for (let i = 0; i < 10; i += 1) {
        onFailure(connectionId, MODEL, failure('network'), 2);
      }

      const snap = snapshot(connectionId);
      expect(snap.p50LatencyMs).toBeNull();
      expect(snap.p95LatencyMs).toBeNull();
    });

    it('exposes the open window so the dashboard can count down', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      updateSettings({ breakerFailureThreshold: 1, breakerCooldownMs: 20_000 });
      fail('server', { message: 'HTTP 503 from upstream' });

      const snap = snapshot(connectionId);
      expect(snap.openedAt).toBe(NOW);
      expect(snap.cooldownUntil).toBe(NOW + 20_000);
      expect(snap.lastError).toBe('HTTP 503 from upstream');
    });

    it('keys snapshotAll by connection id', () => {
      const second = createConnection({ providerId: 'cerebras', label: 'Cerebras (test)' }).id;
      onSuccess(connectionId, MODEL, 10, 100);
      onFailure(second, MODEL, failure('auth'), 40);

      const all = snapshotAll();
      expect(Object.keys(all).sort()).toEqual([connectionId, second].sort());
      expect(all[connectionId]?.status).toBe('healthy');
      expect(all[connectionId]?.connectionId).toBe(connectionId);
      expect(all[second]?.status).toBe('down');
      expect(all[second]?.breaker).toBe('open');
    });

    it('omits connections nothing has ever recorded from snapshotAll', () => {
      createConnection({ providerId: 'together', label: 'Untouched' });
      onSuccess(connectionId, MODEL, 10, 100);

      const all = snapshotAll();
      expect(Object.keys(all)).toEqual([connectionId]);
    });

    it('returns an empty map when no connection has any health yet', () => {
      expect(snapshotAll()).toEqual({});
    });
  });

  // ─── Operator override ─────────────────────────────────────────────────────

  describe('resetBreaker', () => {
    it('closes an open breaker and makes the connection available again', () => {
      updateSettings({ breakerFailureThreshold: 1 });
      fail('auth');
      expect(isAvailable(connectionId)).toBe(false);

      resetBreaker(connectionId);
      const snap = snapshot(connectionId);
      expect(snap.breaker).toBe('closed');
      expect(snap.consecutiveFailures).toBe(0);
      expect(snap.openedAt).toBeNull();
      expect(snap.cooldownUntil).toBeNull();
      expect(snap.lastError).toBeNull();
      expect(isAvailable(connectionId)).toBe(true);
    });

    it('forgives the backoff history, so the next open starts from the base wait', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      updateSettings({ breakerFailureThreshold: 1, breakerCooldownMs: 10_000 });

      fail('server');
      fail('server');
      fail('server');
      expect(cooldownMs()).toBe(40_000);

      resetBreaker(connectionId);
      expect(getHealthRow(connectionId).openCount).toBe(0);

      fail('server');
      expect(cooldownMs()).toBe(10_000);
    });

    it('keeps the accumulated success and failure counts', () => {
      onSuccess(connectionId, MODEL, 10, 100);
      onSuccess(connectionId, MODEL, 10, 100);
      onSuccess(connectionId, MODEL, 10, 100);
      fail('server');
      resetBreaker(connectionId);

      // Forgiving the breaker is not the same as rewriting history: the
      // dashboard should still show what this connection has actually done.
      expect(snapshot(connectionId).successRate).toBe(0.75);
    });

    it('is a no-op on a connection that has never failed', () => {
      expect(() => resetBreaker('conn_never_existed')).not.toThrow();
      expect(countRows('health')).toBe(0);
    });
  });
});
