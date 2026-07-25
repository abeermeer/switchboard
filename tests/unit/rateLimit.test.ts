import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { checkRateLimit, clearRateLimit, rateLimitUsage } from '@/lib/auth/rateLimit';
import { closeDb } from '@/lib/db/client';

/** A fixed instant, so every window calculation below is exact rather than approximate. */
const T0 = Date.UTC(2026, 2, 14, 9, 0, 0);

/** Mirrors WINDOW_MS in the implementation. Hard-coded so a change to it fails here. */
const WINDOW_MS = 60_000;

describe('auth/rateLimit', () => {
  beforeEach(() => {
    // State is persisted now, so it outlives the process as well as the test.
    // Every case starts by forgetting everything, otherwise the suite would
    // depend on file order.
    clearRateLimit();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearRateLimit();
  });

  describe('limits that mean "unlimited"', () => {
    it('allows an unbounded number of calls when perMinute is null', () => {
      const results = Array.from({ length: 500 }, () => checkRateLimit('key-null', null));
      expect(results.filter((result) => !result.allowed)).toEqual([]);
      expect(results.filter((result) => result.retryAfterSec !== 0)).toEqual([]);
    });

    it('treats 0 as unlimited, because a blank field in the UI must not brick a key', () => {
      // This is the branch the implementation comment calls out by name. If
      // someone "simplified" it to `perMinute === null`, a key saved with an
      // empty rate-limit box would refuse every request it ever received.
      const results = Array.from({ length: 200 }, () => checkRateLimit('key-zero', 0));
      expect(results.filter((result) => !result.allowed)).toEqual([]);
    });

    it('treats a negative limit as unlimited rather than as deny-everything', () => {
      const results = Array.from({ length: 200 }, () => checkRateLimit('key-negative', -10));
      expect(results.filter((result) => !result.allowed)).toEqual([]);
    });

    it('treats NaN as unlimited', () => {
      expect(checkRateLimit('key-nan', Number.NaN)).toEqual({ allowed: true, retryAfterSec: 0 });
    });

    it('treats Infinity as unlimited', () => {
      const result = checkRateLimit('key-infinity', Number.POSITIVE_INFINITY);
      expect(result).toEqual({ allowed: true, retryAfterSec: 0 });
    });

    it('records no hits at all when there is no limit to enforce', () => {
      // The early return happens before the push, so an unlimited key never
      // accumulates a window — which is what keeps the Map from growing without
      // bound for the common "no limit set" case.
      for (let i = 0; i < 50; i += 1) checkRateLimit('key-unmetered', null);
      expect(rateLimitUsage('key-unmetered')).toBe(0);
    });
  });

  describe('enforcing the limit', () => {
    it('allows exactly N calls and blocks the N+1th', () => {
      const limit = 5;
      const allowed = Array.from({ length: limit }, () => checkRateLimit('key-exact', limit));
      expect(allowed.filter((result) => !result.allowed)).toEqual([]);

      expect(checkRateLimit('key-exact', limit).allowed).toBe(false);
    });

    it('allows a single call when the limit is 1', () => {
      expect(checkRateLimit('key-one', 1)).toEqual({ allowed: true, retryAfterSec: 0 });
      expect(checkRateLimit('key-one', 1).allowed).toBe(false);
    });

    it('floors a non-integer limit: 2.9 allows two calls, not three', () => {
      expect(checkRateLimit('key-fractional', 2.9).allowed).toBe(true);
      expect(checkRateLimit('key-fractional', 2.9).allowed).toBe(true);
      expect(checkRateLimit('key-fractional', 2.9).allowed).toBe(false);
    });

    it('floors 1.999 down to one allowed call', () => {
      expect(checkRateLimit('key-almost-two', 1.999).allowed).toBe(true);
      expect(checkRateLimit('key-almost-two', 1.999).allowed).toBe(false);
    });

    it('treats a fractional limit below 1 as unlimited rather than bricking the key', () => {
      // Regression: the guard used to run before the floor, so 0.5 passed a
      // `> 0` check and then floored to a limit of 0 — refusing every call. And
      // because a blocked call records no hit, nothing ever aged out of the
      // window, so the key could never recover. A nonsensical limit must fail
      // open, exactly like a blank field.
      for (let i = 0; i < 5; i += 1) {
        expect(checkRateLimit('key-sub-one', 0.5).allowed).toBe(true);
      }
      expect(checkRateLimit('key-sub-one', 0.999).allowed).toBe(true);
    });

    it('reports a retryAfterSec of at least 1 on a block, never 0', () => {
      // 0 would tell the client "retry instantly", which is both wrong and a
      // recipe for a hot loop against a key that is already over its limit.
      checkRateLimit('key-retry', 1);
      const blocked = checkRateLimit('key-retry', 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    });

    it('reports the full window as retryAfterSec when the oldest hit is brand new', () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      checkRateLimit('key-fresh', 1);
      expect(checkRateLimit('key-fresh', 1)).toEqual({
        allowed: false,
        retryAfterSec: WINDOW_MS / 1_000,
      });
    });

    it('does not record a hit when it blocks, so a lockout cannot extend itself', () => {
      checkRateLimit('key-no-selfharm', 2);
      checkRateLimit('key-no-selfharm', 2);
      expect(rateLimitUsage('key-no-selfharm')).toBe(2);

      for (let i = 0; i < 10; i += 1) {
        expect(checkRateLimit('key-no-selfharm', 2).allowed).toBe(false);
      }
      expect(rateLimitUsage('key-no-selfharm')).toBe(2);
    });

    it('respects a limit that shrinks between calls', () => {
      // The limit is read per call, not captured, so lowering a key's limit in
      // the dashboard takes effect on the very next request.
      checkRateLimit('key-shrink', 10);
      checkRateLimit('key-shrink', 10);
      expect(checkRateLimit('key-shrink', 2).allowed).toBe(false);
    });

    it('lets an already-recorded key through again when the limit is raised', () => {
      checkRateLimit('key-grow', 1);
      expect(checkRateLimit('key-grow', 1).allowed).toBe(false);
      expect(checkRateLimit('key-grow', 3).allowed).toBe(true);
    });
  });

  describe('durability', () => {
    it('survives a restart', () => {
      // The whole reason this moved out of memory. A limiter that forgets on
      // restart means a crash-looping client, or an operator restarting to
      // apply a setting, silently lifts the cap.
      checkRateLimit('key-restart', 2);
      checkRateLimit('key-restart', 2);
      expect(checkRateLimit('key-restart', 2).allowed).toBe(false);

      // Drop the handle and every module-scope cache with it; the next call
      // reopens the database from disk.
      closeDb();

      expect(checkRateLimit('key-restart', 2).allowed).toBe(false);
      expect(rateLimitUsage('key-restart')).toBe(2);
    });

    it('counts a burst within one second as separate hits', () => {
      // Rows are keyed by second to keep the write volume sane, so the counter
      // has to increment within a second rather than collapsing to one row.
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      for (let i = 0; i < 5; i += 1) checkRateLimit('key-burst', 10);
      expect(rateLimitUsage('key-burst')).toBe(5);
    });
  });

  describe('isolation between keys', () => {
    it('does not let one exhausted key block another', () => {
      expect(checkRateLimit('key-a', 1).allowed).toBe(true);
      expect(checkRateLimit('key-a', 1).allowed).toBe(false);

      expect(checkRateLimit('key-b', 1).allowed).toBe(true);
      expect(rateLimitUsage('key-a')).toBe(1);
      expect(rateLimitUsage('key-b')).toBe(1);
    });

    it('keeps a separate window per key even under the same limit', () => {
      checkRateLimit('key-c', 3);
      checkRateLimit('key-c', 3);
      checkRateLimit('key-d', 3);

      expect(rateLimitUsage('key-c')).toBe(2);
      expect(rateLimitUsage('key-d')).toBe(1);
    });
  });

  describe('the window slides', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
    });

    it('lets a blocked key through once the oldest hit ages out', () => {
      checkRateLimit('key-slide', 2);
      checkRateLimit('key-slide', 2);
      expect(checkRateLimit('key-slide', 2).allowed).toBe(false);

      vi.advanceTimersByTime(WINDOW_MS + 1);
      expect(checkRateLimit('key-slide', 2)).toEqual({ allowed: true, retryAfterSec: 0 });
    });

    it('still blocks one millisecond before the window closes', () => {
      checkRateLimit('key-edge', 1);
      vi.advanceTimersByTime(WINDOW_MS - 1);

      const blocked = checkRateLimit('key-edge', 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSec).toBe(1);
    });

    it('allows the call exactly one window after the hit', () => {
      // The cutoff is exclusive (`ts > cutoff`), so a hit that is exactly
      // WINDOW_MS old has already left the window.
      checkRateLimit('key-boundary', 1);
      vi.advanceTimersByTime(WINDOW_MS);
      expect(checkRateLimit('key-boundary', 1).allowed).toBe(true);
    });

    it('expires hits one at a time, the way a sliding window does', () => {
      // A fixed bucket would hand back the whole allowance at the top of the
      // next minute. A sliding window only returns the capacity that actually
      // aged out — one call here, not two.
      checkRateLimit('key-sliding', 2);
      vi.advanceTimersByTime(30_000);
      checkRateLimit('key-sliding', 2);
      expect(checkRateLimit('key-sliding', 2).allowed).toBe(false);

      vi.advanceTimersByTime(30_001);
      expect(checkRateLimit('key-sliding', 2).allowed).toBe(true);
      expect(checkRateLimit('key-sliding', 2).allowed).toBe(false);
    });

    it('counts retryAfterSec down as the oldest hit ages', () => {
      checkRateLimit('key-countdown', 1);
      expect(checkRateLimit('key-countdown', 1).retryAfterSec).toBe(60);

      vi.advanceTimersByTime(30_000);
      expect(checkRateLimit('key-countdown', 1).retryAfterSec).toBe(30);

      vi.advanceTimersByTime(29_500);
      expect(checkRateLimit('key-countdown', 1).retryAfterSec).toBe(1);
    });

    it('keeps enforcing the limit across many consecutive windows', () => {
      // Exercises the once-a-minute sweep repeatedly: an active key must never
      // be swept out from under itself, and a swept key must not gain capacity.
      for (let window = 0; window < 5; window += 1) {
        expect(checkRateLimit('key-longlived', 2).allowed).toBe(true);
        expect(checkRateLimit('key-longlived', 2).allowed).toBe(true);
        expect(checkRateLimit('key-longlived', 2).allowed).toBe(false);
        vi.advanceTimersByTime(WINDOW_MS + 1);
      }
    });

    it('does not resurrect hits from a key that went quiet for hours', () => {
      checkRateLimit('key-quiet', 1);
      vi.advanceTimersByTime(6 * 60 * 60 * 1_000);

      expect(rateLimitUsage('key-quiet')).toBe(0);
      expect(checkRateLimit('key-quiet', 1).allowed).toBe(true);
    });
  });

  describe('rateLimitUsage', () => {
    it('returns 0 for a key that has never called', () => {
      expect(rateLimitUsage('key-unknown')).toBe(0);
    });

    it('reports the count without recording a hit of its own', () => {
      checkRateLimit('key-observe', 3);
      checkRateLimit('key-observe', 3);

      for (let i = 0; i < 20; i += 1) expect(rateLimitUsage('key-observe')).toBe(2);

      // Reading usage 20 times must not have consumed the third slot.
      expect(checkRateLimit('key-observe', 3).allowed).toBe(true);
      expect(checkRateLimit('key-observe', 3).allowed).toBe(false);
    });

    it('drops to 0 once the window passes, without any call to prompt it', () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      checkRateLimit('key-decay', 5);
      checkRateLimit('key-decay', 5);
      expect(rateLimitUsage('key-decay')).toBe(2);

      vi.advanceTimersByTime(WINDOW_MS + 1);
      expect(rateLimitUsage('key-decay')).toBe(0);
    });

    it('counts only the hits still inside the window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);

      checkRateLimit('key-partial', 10);
      vi.advanceTimersByTime(WINDOW_MS - 5_000);
      checkRateLimit('key-partial', 10);
      expect(rateLimitUsage('key-partial')).toBe(2);

      vi.advanceTimersByTime(5_001);
      expect(rateLimitUsage('key-partial')).toBe(1);
    });
  });

  describe('clearRateLimit', () => {
    it('forgets one key and leaves the others untouched', () => {
      checkRateLimit('key-keep', 1);
      checkRateLimit('key-drop', 1);

      clearRateLimit('key-drop');

      expect(rateLimitUsage('key-drop')).toBe(0);
      expect(rateLimitUsage('key-keep')).toBe(1);
      expect(checkRateLimit('key-keep', 1).allowed).toBe(false);
      expect(checkRateLimit('key-drop', 1).allowed).toBe(true);
    });

    it('forgets every key when called with no argument', () => {
      checkRateLimit('key-all-1', 1);
      checkRateLimit('key-all-2', 1);
      checkRateLimit('key-all-3', 1);

      clearRateLimit();

      expect(rateLimitUsage('key-all-1')).toBe(0);
      expect(rateLimitUsage('key-all-2')).toBe(0);
      expect(rateLimitUsage('key-all-3')).toBe(0);
    });

    it('releases a key that was already blocked', () => {
      checkRateLimit('key-released', 1);
      expect(checkRateLimit('key-released', 1).allowed).toBe(false);

      clearRateLimit('key-released');
      expect(checkRateLimit('key-released', 1)).toEqual({ allowed: true, retryAfterSec: 0 });
    });

    it('is a no-op for a key that was never seen', () => {
      checkRateLimit('key-present', 2);
      clearRateLimit('key-never-existed');
      expect(rateLimitUsage('key-present')).toBe(1);
    });
  });
});
