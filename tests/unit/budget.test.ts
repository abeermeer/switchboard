import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { ApiKey } from '@/types/core';
import type { BudgetCheck } from '@/lib/auth/budget';
import { budgetFraction, checkBudget } from '@/lib/auth/budget';
import { getDb } from '@/lib/db/client';
import { createApiKey } from '@/lib/db/repos/apiKeys';
import { insertRequestLog } from '@/lib/db/repos/log';
import { recordUsageBucket } from '@/lib/db/repos/usage';
import { id } from '@/lib/utils';
import { dropDb, freshDb } from '../helpers/db';

/** Same boundary `monthToDateCostForApiKey` uses: 00:00 UTC on the 1st. */
function monthStartUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function makeKey(
  overrides: {
    monthlyBudgetUsd?: number | null;
    onBudgetExceeded?: ApiKey['onBudgetExceeded'];
  } = {},
): ApiKey {
  const { key } = createApiKey({
    name: 'budget test key',
    monthlyBudgetUsd: overrides.monthlyBudgetUsd ?? null,
    onBudgetExceeded: overrides.onBudgetExceeded ?? 'downgrade-to-free',
  });
  return key;
}

/**
 * Writes one real request-log row, which is where per-key spend is read from.
 * `usage_buckets` carries no api-key dimension, so it cannot stand in here.
 */
function spend(apiKeyId: string | null, costUsd: number, ts: number = Date.now()): void {
  insertRequestLog({
    id: id('req'),
    ts,
    apiKeyId,
    modality: 'chat',
    requestedModel: 'auto',
    resolvedConnectionId: 'conn_test',
    resolvedProviderId: 'groq',
    resolvedModelId: 'llama-3.3-70b-versatile',
    status: 'success',
    httpStatus: 200,
    durationMs: 412,
    ttftMs: 88,
    streamed: false,
    usage: {
      promptTokens: 1_200,
      completionTokens: 340,
      totalTokens: 1_540,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
    costUsd,
    attemptCount: 1,
    error: null,
    clientIp: null,
    userAgent: null,
  });
}

describe('auth/budget', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
  });

  afterEach(() => {
    dropDb(dir);
  });

  describe('no ceiling', () => {
    it('reports ok with a null limit when monthlyBudgetUsd is null', () => {
      const key = makeKey({ monthlyBudgetUsd: null });
      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: null });
    });

    it('reports zero spend even when the key has spent real money', () => {
      // The implementation deliberately skips the aggregate when there is no
      // ceiling: this runs on every proxied request and the number would go
      // unused. A spentUsd of 0 here is the observable proof of that skip.
      const key = makeKey({ monthlyBudgetUsd: null });
      spend(key.id, 5.5);

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: null });
    });

    it('never issues the spend query at all when there is no ceiling', () => {
      // Sharpest proof available without mocking: with the table gone, any
      // attempt to read spend would throw. This fails the moment someone hoists
      // the lookup above the early return.
      const key = makeKey({ monthlyBudgetUsd: null });
      spend(key.id, 42);
      getDb().exec('DROP TABLE request_payloads');
      getDb().exec('DROP TABLE request_log');

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: null });
    });

    it('treats a ceiling of 0 as no ceiling rather than as "spend nothing"', () => {
      // Same reasoning as the rate limiter: a blank or zeroed field in the UI
      // must not turn into a key that refuses every request.
      const key = makeKey({ monthlyBudgetUsd: 0, onBudgetExceeded: 'block' });
      spend(key.id, 1.25);

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: null });
    });

    it('treats a negative ceiling as no ceiling', () => {
      const key = makeKey({ monthlyBudgetUsd: -25, onBudgetExceeded: 'block' });
      spend(key.id, 3);

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: null });
    });

    it('treats an infinite ceiling as no ceiling', () => {
      const key: ApiKey = {
        ...makeKey({ monthlyBudgetUsd: 10 }),
        monthlyBudgetUsd: Number.POSITIVE_INFINITY,
      };
      spend(key.id, 999);

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: null });
    });

    it('treats a NaN ceiling as no ceiling', () => {
      const key: ApiKey = {
        ...makeKey({ monthlyBudgetUsd: 10 }),
        monthlyBudgetUsd: Number.NaN,
      };
      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: null });
    });
  });

  describe('under the ceiling', () => {
    it('reports ok with zero spend for a brand new key', () => {
      const key = makeKey({ monthlyBudgetUsd: 20 });
      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: 20 });
    });

    it('sums every logged request into spentUsd', () => {
      const key = makeKey({ monthlyBudgetUsd: 10 });
      spend(key.id, 2.5);
      spend(key.id, 1.25);

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 3.75, limitUsd: 10 });
    });

    it('stays ok a fraction of a cent below the ceiling', () => {
      const key = makeKey({ monthlyBudgetUsd: 10, onBudgetExceeded: 'block' });
      spend(key.id, 9.999999);

      const check = checkBudget(key);
      expect(check.state).toBe('ok');
      expect(check.spentUsd).toBeCloseTo(9.999999, 9);
    });

    it('ignores spend belonging to a different key', () => {
      const key = makeKey({ monthlyBudgetUsd: 10 });
      const other = makeKey({ monthlyBudgetUsd: 10 });
      spend(other.id, 8);
      spend(key.id, 1);

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 1, limitUsd: 10 });
      expect(checkBudget(other)).toEqual({ state: 'ok', spentUsd: 8, limitUsd: 10 });
    });

    it('ignores unattributed spend logged with a null key', () => {
      const key = makeKey({ monthlyBudgetUsd: 10 });
      spend(null, 7);
      spend(key.id, 2);

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 2, limitUsd: 10 });
    });

    it('ignores spend from before the first of the month', () => {
      // The ceiling is monthly, so last month's bill must not follow the key
      // into the new one.
      const key = makeKey({ monthlyBudgetUsd: 10, onBudgetExceeded: 'block' });
      spend(key.id, 99, monthStartUtc() - 1);
      spend(key.id, 1, monthStartUtc());

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 1, limitUsd: 10 });
    });

    it('counts spend at the exact first millisecond of the month', () => {
      const key = makeKey({ monthlyBudgetUsd: 10 });
      spend(key.id, 4, monthStartUtc());

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 4, limitUsd: 10 });
    });

    it('does not count usage_buckets rows toward a key ceiling', () => {
      // usage_buckets has no api-key column, so a connection-level rollup can
      // never be attributed to a key. If this ever starts counting, per-key
      // budgets would be enforced against every key's traffic at once.
      const key = makeKey({ monthlyBudgetUsd: 10, onBudgetExceeded: 'block' });
      recordUsageBucket({
        ts: Date.now(),
        connectionId: 'conn_test',
        modelId: 'llama-3.3-70b-versatile',
        ok: true,
        promptTokens: 1_000,
        completionTokens: 500,
        costUsd: 50,
        savedUsd: 0,
      });

      expect(checkBudget(key)).toEqual({ state: 'ok', spentUsd: 0, limitUsd: 10 });
    });
  });

  describe('at and over the ceiling', () => {
    it('treats spend exactly equal to the ceiling as having hit it', () => {
      // The comparison is `spent < limit`, so landing on the number exactly is
      // already over. Flipping it to `<=` would let a key spend one extra
      // request's worth past its stated cap.
      const key = makeKey({ monthlyBudgetUsd: 10, onBudgetExceeded: 'block' });
      spend(key.id, 10);

      expect(checkBudget(key)).toEqual({ state: 'blocked', spentUsd: 10, limitUsd: 10 });
    });

    it('hits the ceiling on an exact match assembled from several requests', () => {
      const key = makeKey({ monthlyBudgetUsd: 5, onBudgetExceeded: 'downgrade-to-free' });
      spend(key.id, 2.5);
      spend(key.id, 2.5);

      expect(checkBudget(key)).toEqual({ state: 'downgrade', spentUsd: 5, limitUsd: 5 });
    });

    it('blocks when onBudgetExceeded is block', () => {
      const key = makeKey({ monthlyBudgetUsd: 10, onBudgetExceeded: 'block' });
      spend(key.id, 12.5);

      expect(checkBudget(key)).toEqual({ state: 'blocked', spentUsd: 12.5, limitUsd: 10 });
    });

    it('downgrades when onBudgetExceeded is downgrade-to-free', () => {
      // The friendlier default: the request still runs, restricted to free
      // connections, so the client's integration keeps working while the bill
      // stops growing.
      const key = makeKey({ monthlyBudgetUsd: 10, onBudgetExceeded: 'downgrade-to-free' });
      spend(key.id, 12.5);

      expect(checkBudget(key)).toEqual({ state: 'downgrade', spentUsd: 12.5, limitUsd: 10 });
    });

    it('reports the real overspend rather than clamping to the ceiling', () => {
      const key = makeKey({ monthlyBudgetUsd: 1, onBudgetExceeded: 'block' });
      spend(key.id, 40);

      expect(checkBudget(key).spentUsd).toBe(40);
    });

    it('tips over on the request that crosses the line, not before', () => {
      const key = makeKey({ monthlyBudgetUsd: 3, onBudgetExceeded: 'block' });
      spend(key.id, 1);
      expect(checkBudget(key).state).toBe('ok');
      spend(key.id, 1);
      expect(checkBudget(key).state).toBe('ok');
      spend(key.id, 1);
      expect(checkBudget(key).state).toBe('blocked');
    });

    it('handles a tiny ceiling that a single sub-cent request exceeds', () => {
      const key = makeKey({ monthlyBudgetUsd: 0.0001, onBudgetExceeded: 'block' });
      spend(key.id, 0.0002);

      const check = checkBudget(key);
      expect(check.state).toBe('blocked');
      expect(check.limitUsd).toBe(0.0001);
    });
  });

  describe('budgetFraction', () => {
    it('is 0 when there is no limit to divide by', () => {
      const key = makeKey({ monthlyBudgetUsd: null });
      spend(key.id, 30);

      expect(budgetFraction(checkBudget(key))).toBe(0);
    });

    it('is 0 for a zero limit rather than Infinity or NaN', () => {
      // A meter cannot divide by zero, and a NaN would render as a broken bar.
      const check: BudgetCheck = { state: 'ok', spentUsd: 5, limitUsd: 0 };
      expect(budgetFraction(check)).toBe(0);
    });

    it('is 0 for a negative limit', () => {
      const check: BudgetCheck = { state: 'ok', spentUsd: 5, limitUsd: -10 };
      expect(budgetFraction(check)).toBe(0);
    });

    it('is 0 when nothing has been spent', () => {
      const key = makeKey({ monthlyBudgetUsd: 10 });
      expect(budgetFraction(checkBudget(key))).toBe(0);
    });

    it('is the real ratio under the ceiling', () => {
      const key = makeKey({ monthlyBudgetUsd: 10 });
      spend(key.id, 2.5);

      expect(budgetFraction(checkBudget(key))).toBe(0.25);
    });

    it('is exactly 1 when spend lands on the ceiling', () => {
      const key = makeKey({ monthlyBudgetUsd: 8, onBudgetExceeded: 'block' });
      spend(key.id, 8);

      expect(budgetFraction(checkBudget(key))).toBe(1);
    });

    it('clamps to 1 rather than overflowing the meter when over', () => {
      const key = makeKey({ monthlyBudgetUsd: 10, onBudgetExceeded: 'block' });
      spend(key.id, 250);

      expect(budgetFraction(checkBudget(key))).toBe(1);
    });
  });
});
