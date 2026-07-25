import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type {
  Combo,
  CostTier,
  RouteCandidate,
  RoutingStrategy,
  ScoreFactor,
} from '@/types/core';
import { scoreCandidates, STRATEGY_WEIGHTS, type FactorName } from '@/lib/router/score';
import { createConnection } from '@/lib/db/repos/connections';
import { defaultHealthRow, upsertHealthRow, type HealthRow } from '@/lib/db/repos/health';
import { dropDb, freshDb } from '../helpers/db';

/**
 * The runtime spelling of the `RoutingStrategy` union.
 *
 * `STRATEGY_WEIGHTS` is typed `Record<RoutingStrategy, …>`, so the compiler
 * already guarantees a row per strategy. What it cannot guarantee is that this
 * list still *is* the union — hence the first test below, which pins the two
 * together. Every later loop over this array is therefore a loop over the union.
 */
const ALL_STRATEGIES: readonly RoutingStrategy[] = [
  'free-first',
  'cost-optimized',
  'fastest',
  'quality-first',
  'priority',
  'round-robin',
  'failover',
];

/** The order `scoreCandidates` pushes factors in — the dashboard renders it. */
const FACTOR_ORDER: readonly FactorName[] = [
  'health',
  'latency',
  'cost',
  'tier',
  'priority',
  'quota',
  'throughput',
  'stability',
];

/** The factor each strategy's name promises to optimise for. */
const HEADLINE_FACTOR: Record<RoutingStrategy, FactorName> = {
  'free-first': 'tier',
  'cost-optimized': 'cost',
  fastest: 'latency',
  'quality-first': 'cost',
  priority: 'priority',
  'round-robin': 'health',
  failover: 'priority',
};

// Real catalog entries, picked for their throughput priors.
const MODEL = 'llama-3.1-8b-instant'; // groq, 840 tok/s prior
const BIG_MODEL = 'llama-3.3-70b-versatile'; // groq, 275 tok/s prior
const AT_LIMIT_MODEL = 'openai/gpt-oss-20b'; // groq, exactly 1,000 tok/s prior
const OVER_LIMIT_MODEL = 'gpt-oss-120b'; // cerebras, 3,000 tok/s prior

describe('router/score', () => {
  let dir: string;

  beforeEach(() => {
    dir = freshDb();
  });

  afterEach(() => {
    dropDb(dir);
  });

  // ─── Fixtures ──────────────────────────────────────────────────────────────

  /** A real connection row, because the scorer reads priority and budget. */
  function connect(
    over: { priority?: number; monthlyBudgetUsd?: number | null; providerId?: string } = {},
  ): string {
    return createConnection({
      providerId: over.providerId ?? 'groq',
      priority: over.priority ?? 100,
      monthlyBudgetUsd: over.monthlyBudgetUsd ?? null,
    }).id;
  }

  /** Writes health straight into the row so a test need not replay its history. */
  function setHealth(connectionId: string, patch: Partial<HealthRow>): void {
    upsertHealthRow({ ...defaultHealthRow(connectionId), ...patch });
  }

  function candidate(
    connectionId: string,
    over: {
      providerId?: string;
      modelId?: string;
      tier?: CostTier;
      projectedCostUsd?: number;
      excludedReason?: string | null;
      score?: number;
    } = {},
  ): RouteCandidate {
    return {
      connectionId,
      providerId: over.providerId ?? 'groq',
      modelId: over.modelId ?? MODEL,
      tier: over.tier ?? 'standard',
      score: over.score ?? 0,
      factors: [],
      excludedReason: over.excludedReason ?? null,
      projectedCostUsd: over.projectedCostUsd ?? 0.01,
    };
  }

  function comboWith(
    members: ReadonlyArray<{ connectionId: string; modelId: string; order: number }>,
  ): Combo {
    return {
      id: 'combo_test',
      slug: 'test',
      name: 'Test combo',
      description: '',
      modality: 'chat',
      strategy: 'priority',
      members: members.map((m) => ({ ...m, weight: 1, enabled: true })),
      requires: [],
      maxCostPerMTok: null,
      maxAttempts: 4,
      timeoutMs: 120_000,
      enabled: true,
      isDefault: false,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  function rank(
    candidates: RouteCandidate[],
    strategy: RoutingStrategy,
    over: { combo?: Combo | null; rotation?: number } = {},
  ): RouteCandidate[] {
    return scoreCandidates(candidates, strategy, {
      strategy,
      combo: over.combo ?? null,
      rotation: over.rotation ?? 0,
    });
  }

  const ids = (list: RouteCandidate[]): string[] => list.map((c) => c.connectionId);

  function pick(list: RouteCandidate[], connectionId: string): RouteCandidate {
    const found = list.find((c) => c.connectionId === connectionId);
    if (found === undefined) throw new Error(`no candidate for ${connectionId} in the result`);
    return found;
  }

  function factor(c: RouteCandidate, name: FactorName): ScoreFactor {
    const found = c.factors.find((f) => f.name === name);
    if (found === undefined) throw new Error(`candidate ${c.connectionId} has no '${name}' factor`);
    return found;
  }

  /** One eligible candidate, scored, with no distractions around it. */
  function only(connectionId: string, strategy: RoutingStrategy = 'free-first'): RouteCandidate {
    return pick(rank([candidate(connectionId)], strategy), connectionId);
  }

  /**
   * Three candidates that differ on every factor at once: distinct tiers,
   * costs, models, connection priorities, budgets and health — including one
   * connection with no health row at all.
   */
  function mixedBag(): RouteCandidate[] {
    const proven = connect({ priority: 1, monthlyBudgetUsd: 25 });
    const shaky = connect({ priority: 40 });
    const cold = connect({ providerId: 'cerebras', priority: 200 });

    setHealth(proven, { successCount: 90, failureCount: 10, p50LatencyMs: 120 });
    setHealth(shaky, {
      successCount: 40,
      failureCount: 60,
      p50LatencyMs: 900,
      consecutiveFailures: 2,
      breaker: 'half-open',
    });

    return [
      candidate(proven, { tier: 'free', projectedCostUsd: 0 }),
      candidate(shaky, { tier: 'premium', projectedCostUsd: 0.5, modelId: BIG_MODEL }),
      candidate(cold, {
        tier: 'cheap',
        projectedCostUsd: 0.02,
        providerId: 'cerebras',
        modelId: OVER_LIMIT_MODEL,
      }),
    ];
  }

  // ─── The weights table ─────────────────────────────────────────────────────

  describe('STRATEGY_WEIGHTS', () => {
    it('has exactly one row per routing strategy in the union', () => {
      // Pins the local ALL_STRATEGIES list to the shipped table, so every later
      // loop over ALL_STRATEGIES really is a loop over the whole union.
      expect(Object.keys(STRATEGY_WEIGHTS).sort()).toEqual([...ALL_STRATEGIES].sort());
    });

    for (const strategy of ALL_STRATEGIES) {
      it(`gives '${strategy}' an own entry for all eight factors`, () => {
        // The routing page renders this table verbatim. An absent key would both
        // silently zero the factor and leave a hole in the UI, so presence is
        // asserted at runtime rather than trusted to the Record type.
        const row = STRATEGY_WEIGHTS[strategy];
        for (const name of FACTOR_ORDER) {
          expect(Object.hasOwn(row, name)).toBe(true);
          expect(Number.isFinite(row[name])).toBe(true);
        }
        expect(Object.keys(row).sort()).toEqual([...FACTOR_ORDER].sort());
      });

      it(`keeps every '${strategy}' weight inside [0, 1]`, () => {
        const row = STRATEGY_WEIGHTS[strategy];
        for (const name of FACTOR_ORDER) {
          expect(row[name]).toBeGreaterThanOrEqual(0);
          expect(row[name]).toBeLessThanOrEqual(1);
        }
      });

      it(`sums the '${strategy}' weights to 1`, () => {
        // Weights summing to 1, with every factor value in [0, 1], is what makes
        // the final score comparable across strategies.
        const total = FACTOR_ORDER.reduce((sum, name) => sum + STRATEGY_WEIGHTS[strategy][name], 0);
        expect(total).toBeCloseTo(1, 10);
      });

      it(`weights '${HEADLINE_FACTOR[strategy]}' highest under '${strategy}'`, () => {
        const row = STRATEGY_WEIGHTS[strategy];
        const headline = row[HEADLINE_FACTOR[strategy]];
        for (const name of FACTOR_ORDER) {
          if (name === HEADLINE_FACTOR[strategy]) continue;
          expect(headline).toBeGreaterThan(row[name]);
        }
      });
    }

    it('spells out a deliberate zero instead of omitting the key', () => {
      // `throughput: 0` and no `throughput` key score identically, but only one
      // of them tells a user reading the table that the factor was considered.
      expect(STRATEGY_WEIGHTS.failover.throughput).toBe(0);
      expect(STRATEGY_WEIGHTS.failover.quota).toBe(0);
      expect(STRATEGY_WEIGHTS['round-robin'].throughput).toBe(0);
      expect(STRATEGY_WEIGHTS.priority.throughput).toBe(0);
    });

    it("puts more weight on cost under 'cost-optimized' than any other strategy", () => {
      for (const strategy of ALL_STRATEGIES) {
        if (strategy === 'cost-optimized') continue;
        expect(STRATEGY_WEIGHTS['cost-optimized'].cost).toBeGreaterThan(
          STRATEGY_WEIGHTS[strategy].cost,
        );
      }
    });

    it("puts more weight on latency under 'fastest' than any other strategy", () => {
      for (const strategy of ALL_STRATEGIES) {
        if (strategy === 'fastest') continue;
        expect(STRATEGY_WEIGHTS.fastest.latency).toBeGreaterThan(STRATEGY_WEIGHTS[strategy].latency);
      }
    });

    it("trusts the chain more under 'failover' than under 'priority'", () => {
      // Failover is the stricter of the two: the first member, others only on
      // failure. Its priority weight has to reflect that.
      expect(STRATEGY_WEIGHTS.failover.priority).toBeGreaterThan(STRATEGY_WEIGHTS.priority.priority);
    });
  });

  // ─── Result shape ──────────────────────────────────────────────────────────

  describe('result shape', () => {
    for (const strategy of ALL_STRATEGIES) {
      it(`returns an empty array for an empty candidate list under '${strategy}'`, () => {
        expect(rank([], strategy)).toEqual([]);
      });
    }

    it('returns every candidate exactly once', () => {
      const bag = mixedBag();
      const out = rank(bag, 'free-first');
      expect(out).toHaveLength(bag.length);
      expect(ids(out).sort()).toEqual(ids(bag).sort());
    });

    it('leaves the input candidates untouched', () => {
      // The scorer copies rather than mutates, so a caller can score the same
      // list under two strategies and compare the results.
      const bag = mixedBag();
      const before = structuredClone(bag);
      rank(bag, 'free-first');
      expect(bag).toEqual(before);
    });

    it('is deterministic for the same input', () => {
      const bag = mixedBag();
      expect(ids(rank(bag, 'free-first'))).toEqual(ids(rank(bag, 'free-first')));
    });

    for (const strategy of ALL_STRATEGIES) {
      it(`attaches all eight factors, in the documented order, under '${strategy}'`, () => {
        for (const scored of rank(mixedBag(), strategy)) {
          expect(scored.factors.map((f) => f.name)).toEqual([...FACTOR_ORDER]);
        }
      });

      it(`gives every factor a non-empty human note under '${strategy}'`, () => {
        // The dashboard renders these strings verbatim on hover; an empty one is
        // a blank tooltip.
        for (const scored of rank(mixedBag(), strategy)) {
          for (const f of scored.factors) {
            expect(typeof f.note).toBe('string');
            expect(f.note.trim().length).toBeGreaterThan(0);
          }
        }
      });

      it(`copies each factor's weight straight from the table under '${strategy}'`, () => {
        for (const scored of rank(mixedBag(), strategy)) {
          for (const name of FACTOR_ORDER) {
            expect(factor(scored, name).weight).toBe(STRATEGY_WEIGHTS[strategy][name]);
          }
        }
      });

      it(`keeps every factor value inside [0, 1] under '${strategy}'`, () => {
        for (const scored of rank(mixedBag(), strategy)) {
          for (const f of scored.factors) {
            expect(f.value).toBeGreaterThanOrEqual(0);
            expect(f.value).toBeLessThanOrEqual(1);
          }
        }
      });

      it(`scores each candidate as the sum of value × weight under '${strategy}'`, () => {
        for (const scored of rank(mixedBag(), strategy)) {
          const expected = scored.factors.reduce((sum, f) => sum + f.value * f.weight, 0);
          expect(scored.score).toBeCloseTo(expected, 12);
        }
      });

      it(`keeps every score inside [0, 1] under '${strategy}'`, () => {
        for (const scored of rank(mixedBag(), strategy)) {
          expect(scored.score).toBeGreaterThan(0);
          expect(scored.score).toBeLessThanOrEqual(1);
        }
      });
    }
  });

  // ─── Exclusions ────────────────────────────────────────────────────────────

  describe('excluded candidates', () => {
    it('returns them unscored and in input order when nothing is eligible', () => {
      const a = candidate(connect(), { excludedReason: 'Connection is disabled' });
      const b = candidate(connect(), { excludedReason: 'No API key configured' });

      const out = rank([a, b], 'free-first');
      expect(out).toEqual([a, b]);
      expect(out[0]?.factors).toEqual([]);
      expect(out[0]?.score).toBe(0);
      expect(out[1]?.excludedReason).toBe('No API key configured');
    });

    for (const strategy of ALL_STRATEGIES) {
      it(`ranks an excluded candidate last under '${strategy}', whatever score it arrived with`, () => {
        // An excluded candidate carries a stale `score` from a previous pass. It
        // must never be able to buy its way back into the running with it.
        const eligible = connect({ priority: 199 });
        const barred = connect({ priority: 1 });

        const out = rank(
          [candidate(barred, { excludedReason: 'Breaker open', score: 1 }), candidate(eligible)],
          strategy,
        );

        expect(ids(out)).toEqual([eligible, barred]);
        expect(out[1]?.score).toBe(1);
        expect(out[1]?.factors).toEqual([]);
        expect(out[1]?.excludedReason).toBe('Breaker open');
      });
    }

    it('puts every eligible candidate ahead of every excluded one', () => {
      const eligible = [connect(), connect(), connect()];
      const barred = [connect(), connect()];

      const out = rank(
        [
          candidate(barred[0]!, { excludedReason: 'Model is locked out', score: 1 }),
          candidate(eligible[0]!, { projectedCostUsd: 0.4 }),
          candidate(barred[1]!, { excludedReason: 'Over monthly budget', score: 1 }),
          candidate(eligible[1]!, { projectedCostUsd: 0.2 }),
          candidate(eligible[2]!, { projectedCostUsd: 0.1 }),
        ],
        'cost-optimized',
      );

      const firstExcluded = out.findIndex((c) => c.excludedReason !== null);
      expect(firstExcluded).toBe(3);
      expect(out.slice(3).every((c) => c.excludedReason !== null)).toBe(true);
    });

    it('keeps excluded candidates in their input order at the tail', () => {
      const barred = [connect(), connect(), connect()];
      const out = rank(
        [
          candidate(barred[0]!, { excludedReason: 'first' }),
          candidate(connect()),
          candidate(barred[1]!, { excludedReason: 'second' }),
          candidate(barred[2]!, { excludedReason: 'third' }),
        ],
        'free-first',
      );
      expect(out.slice(1).map((c) => c.excludedReason)).toEqual(['first', 'second', 'third']);
    });

    it('keeps excluded candidates last even when round-robin rotates the head', () => {
      const a = connect();
      const b = connect();
      const barred = connect();
      const cands = [
        candidate(a, { projectedCostUsd: 0 }),
        candidate(barred, { excludedReason: 'Breaker open', score: 1 }),
        candidate(b, { projectedCostUsd: 1 }),
      ];

      for (const rotation of [0, 1, 2, 3]) {
        const out = rank(cands, 'round-robin', { rotation });
        expect(out[2]?.connectionId).toBe(barred);
        expect(out[2]?.excludedReason).toBe('Breaker open');
      }
    });

    it('normalises cost against the eligible candidates only', () => {
      // An excluded candidate is not on offer, so letting its price stretch the
      // cost scale would make the real options look artificially similar.
      const cheap = connect();
      const dear = connect();
      const out = rank(
        [
          candidate(cheap, { projectedCostUsd: 0.1 }),
          candidate(dear, { projectedCostUsd: 0.2 }),
          candidate(connect(), { projectedCostUsd: 99, excludedReason: 'Over monthly budget' }),
        ],
        'cost-optimized',
      );

      expect(factor(pick(out, cheap), 'cost').value).toBe(1);
      expect(factor(pick(out, dear), 'cost').value).toBe(0);
    });
  });

  // ─── Cost normalisation ────────────────────────────────────────────────────

  describe('cost normalisation', () => {
    it('scores the cheaper of two candidates higher on cost', () => {
      const cheap = connect();
      const dear = connect();
      const out = rank(
        [candidate(dear, { projectedCostUsd: 0.5 }), candidate(cheap, { projectedCostUsd: 0.05 })],
        'free-first',
      );

      expect(factor(pick(out, cheap), 'cost').value).toBe(1);
      expect(factor(pick(out, dear), 'cost').value).toBe(0);
    });

    it('places a middle candidate proportionally between the extremes', () => {
      const a = connect();
      const b = connect();
      const c = connect();
      const out = rank(
        [
          candidate(a, { projectedCostUsd: 0 }),
          candidate(b, { projectedCostUsd: 0.25 }),
          candidate(c, { projectedCostUsd: 1 }),
        ],
        'cost-optimized',
      );

      expect(factor(pick(out, a), 'cost').value).toBe(1);
      expect(factor(pick(out, b), 'cost').value).toBe(0.75);
      expect(factor(pick(out, c), 'cost').value).toBe(0);
    });

    it('scores cost against this candidate set, not an absolute scale', () => {
      // The same $0.10 option is the worst price on offer in one set and the
      // best in another. "Cheapest available" is the only comparison that means
      // anything at routing time.
      const subject = connect();
      const other = connect();

      const amongCheaper = rank(
        [candidate(subject, { projectedCostUsd: 0.1 }), candidate(other, { projectedCostUsd: 0.01 })],
        'cost-optimized',
      );
      const amongDearer = rank(
        [candidate(subject, { projectedCostUsd: 0.1 }), candidate(other, { projectedCostUsd: 1 })],
        'cost-optimized',
      );

      expect(factor(pick(amongCheaper, subject), 'cost').value).toBe(0);
      expect(factor(pick(amongDearer, subject), 'cost').value).toBe(1);
    });

    it('punishes nobody when every candidate costs the same', () => {
      const a = connect();
      const b = connect();
      const c = connect();
      const out = rank(
        [
          candidate(a, { projectedCostUsd: 0.03 }),
          candidate(b, { projectedCostUsd: 0.03 }),
          candidate(c, { projectedCostUsd: 0.03 }),
        ],
        'cost-optimized',
      );

      // A flat 0.5 for all: no candidate is dragged to zero just because the
      // spread happened to be empty.
      expect(out.map((s) => factor(s, 'cost').value)).toEqual([0.5, 0.5, 0.5]);
      expect(new Set(out.map((s) => s.score)).size).toBe(1);
    });

    it('gives full cost marks when every candidate is free', () => {
      const a = connect();
      const b = connect();
      const out = rank(
        [candidate(a, { projectedCostUsd: 0 }), candidate(b, { projectedCostUsd: 0 })],
        'free-first',
      );
      expect(out.map((s) => factor(s, 'cost').value)).toEqual([1, 1]);
    });

    it('gives a lone paid candidate the neutral 0.5 rather than either extreme', () => {
      const solo = connect();
      expect(factor(only(solo, 'cost-optimized'), 'cost').value).toBe(0.5);
    });

    it('gives a lone free candidate full cost marks', () => {
      const solo = connect();
      const out = rank([candidate(solo, { projectedCostUsd: 0 })], 'cost-optimized');
      expect(factor(pick(out, solo), 'cost').value).toBe(1);
    });

    it('labels a zero-cost candidate as free', () => {
      const free = connect();
      const paid = connect();
      const out = rank(
        [candidate(free, { projectedCostUsd: 0 }), candidate(paid, { projectedCostUsd: 0.25 })],
        'free-first',
      );
      expect(factor(pick(out, free), 'cost').note).toBe('Free — $0.00 projected for this request');
    });

    it('names the cheapest paid candidate in its note', () => {
      const cheap = connect();
      const dear = connect();
      const out = rank(
        [candidate(cheap, { projectedCostUsd: 0.05 }), candidate(dear, { projectedCostUsd: 0.5 })],
        'free-first',
      );
      expect(factor(pick(out, cheap), 'cost').note).toBe('$0.05 projected — cheapest candidate');
      expect(factor(pick(out, dear), 'cost').note).toBe('$0.50 projected');
    });

    it('keeps sub-cent precision in the cost note', () => {
      const conn = connect();
      const out = rank([candidate(conn, { projectedCostUsd: 0.001 })], 'free-first');
      expect(factor(pick(out, conn), 'cost').note).toBe('$0.001 projected — cheapest candidate');
    });
  });

  // ─── Latency normalisation ─────────────────────────────────────────────────

  describe('latency normalisation', () => {
    it('scores the faster candidate higher on latency', () => {
      const quick = connect();
      const slow = connect();
      setHealth(quick, { p50LatencyMs: 100 });
      setHealth(slow, { p50LatencyMs: 800 });

      const out = rank([candidate(slow), candidate(quick)], 'fastest');
      expect(factor(pick(out, quick), 'latency').value).toBe(1);
      expect(factor(pick(out, slow), 'latency').value).toBe(0);
    });

    it('places a middle p50 proportionally between the extremes', () => {
      const quick = connect();
      const mid = connect();
      const slow = connect();
      setHealth(quick, { p50LatencyMs: 100 });
      setHealth(mid, { p50LatencyMs: 300 });
      setHealth(slow, { p50LatencyMs: 500 });

      const out = rank([candidate(quick), candidate(mid), candidate(slow)], 'fastest');
      expect(factor(pick(out, mid), 'latency').value).toBe(0.5);
    });

    it('scores latency against this candidate set, not an absolute scale', () => {
      const subject = connect();
      const other = connect();
      setHealth(subject, { p50LatencyMs: 400 });
      setHealth(other, { p50LatencyMs: 100 });

      const amongFaster = rank([candidate(subject), candidate(other)], 'fastest');
      expect(factor(pick(amongFaster, subject), 'latency').value).toBe(0);

      setHealth(other, { p50LatencyMs: 4_000 });
      const amongSlower = rank([candidate(subject), candidate(other)], 'fastest');
      expect(factor(pick(amongSlower, subject), 'latency').value).toBe(1);
    });

    it('gives a candidate with no latency samples the neutral 0.5', () => {
      // Optimistic enough to earn a first request, not so optimistic that it
      // displaces a proven fast provider.
      const quick = connect();
      const unmeasured = connect();
      setHealth(quick, { p50LatencyMs: 100 });

      const out = rank([candidate(quick), candidate(unmeasured)], 'fastest');
      const latency = factor(pick(out, unmeasured), 'latency');
      expect(latency.value).toBe(0.5);
      expect(latency.note).toBe('No latency samples yet — neutral placeholder');
    });

    it('lets an unmeasured candidate beat a proven slow one but not a proven fast one', () => {
      // This is the whole point of the 0.5 placeholder, stated as an ordering.
      const quick = connect();
      const unmeasured = connect();
      const slow = connect();
      setHealth(quick, { p50LatencyMs: 100 });
      setHealth(slow, { p50LatencyMs: 5_000 });

      const out = rank([candidate(slow), candidate(unmeasured), candidate(quick)], 'fastest');
      expect(ids(out)).toEqual([quick, unmeasured, slow]);
      expect(factor(pick(out, quick), 'latency').value).toBe(1);
      expect(factor(pick(out, unmeasured), 'latency').value).toBe(0.5);
      expect(factor(pick(out, slow), 'latency').value).toBe(0);
    });

    it('treats a health row with no percentiles as unmeasured', () => {
      // A connection can have plenty of successes and still no p50: percentiles
      // are withheld until there are three samples.
      const measured = connect();
      const noPercentiles = connect();
      setHealth(measured, { p50LatencyMs: 200 });
      setHealth(noPercentiles, { successCount: 2, p50LatencyMs: null });

      const out = rank([candidate(measured), candidate(noPercentiles)], 'fastest');
      expect(factor(pick(out, noPercentiles), 'latency').value).toBe(0.5);
    });

    it('gives everyone the placeholder when nobody has samples', () => {
      const a = connect();
      const b = connect();
      const out = rank([candidate(a), candidate(b)], 'fastest');
      expect(out.map((s) => factor(s, 'latency').value)).toEqual([0.5, 0.5]);
      expect(new Set(out.map((s) => s.score)).size).toBe(1);
    });

    it('gives everyone full latency marks when every p50 is identical', () => {
      const a = connect();
      const b = connect();
      setHealth(a, { p50LatencyMs: 250 });
      setHealth(b, { p50LatencyMs: 250 });

      const out = rank([candidate(a), candidate(b)], 'fastest');
      expect(out.map((s) => factor(s, 'latency').value)).toEqual([1, 1]);
      expect(factor(pick(out, a), 'latency').note).toBe('250ms p50, all candidates equal');
    });

    it('gives a lone measured candidate full latency marks', () => {
      const solo = connect();
      setHealth(solo, { p50LatencyMs: 1_500 });
      const out = rank([candidate(solo)], 'fastest');
      expect(factor(pick(out, solo), 'latency').value).toBe(1);
      expect(factor(pick(out, solo), 'latency').note).toBe('1.50s p50, all candidates equal');
    });

    it('names the fastest candidate in its note and compares the rest to it', () => {
      const quick = connect();
      const slow = connect();
      setHealth(quick, { p50LatencyMs: 120 });
      setHealth(slow, { p50LatencyMs: 2_400 });

      const out = rank([candidate(quick), candidate(slow)], 'fastest');
      expect(factor(pick(out, quick), 'latency').note).toBe('120ms p50 — fastest healthy candidate');
      expect(factor(pick(out, slow), 'latency').note).toBe('2.40s p50 vs 120ms best');
    });

    it('treats a zero-millisecond p50 as a real measurement, not a missing one', () => {
      const instant = connect();
      const slow = connect();
      setHealth(instant, { p50LatencyMs: 0 });
      setHealth(slow, { p50LatencyMs: 400 });

      const out = rank([candidate(instant), candidate(slow)], 'fastest');
      expect(factor(pick(out, instant), 'latency').value).toBe(1);
      expect(factor(pick(out, instant), 'latency').note).toBe('0ms p50 — fastest healthy candidate');
    });
  });

  // ─── Health ────────────────────────────────────────────────────────────────

  describe('health factor', () => {
    it('assumes a connection with no history is healthy', () => {
      const fresh = connect();
      const health = factor(only(fresh), 'health');
      expect(health.value).toBe(1);
      expect(health.note).toBe('No history yet, assumed healthy');
    });

    it('reports the measured success rate once a row exists', () => {
      const conn = connect();
      setHealth(conn, { successCount: 8, failureCount: 2 });

      const health = factor(only(conn), 'health');
      expect(health.value).toBe(0.8);
      expect(health.note).toBe('80.0% success over the recent window');
    });

    it('distinguishes an empty health row from no health row at all', () => {
      // Both score 1, but only one of them can honestly claim "no history yet".
      const touched = connect();
      setHealth(touched, { successCount: 0, failureCount: 0 });

      const health = factor(only(touched), 'health');
      expect(health.value).toBe(1);
      expect(health.note).toBe('100.0% success over the recent window');
    });

    it('scores a connection that has only ever failed at zero', () => {
      const conn = connect();
      setHealth(conn, { successCount: 0, failureCount: 5 });
      expect(factor(only(conn), 'health').value).toBe(0);
    });

    it('halves the health of a half-open breaker', () => {
      // Deprioritised until one request proves it recovered — not excluded, so
      // the trial request can still be handed out.
      const conn = connect();
      setHealth(conn, { successCount: 10, failureCount: 0, breaker: 'half-open' });

      const health = factor(only(conn), 'health');
      expect(health.value).toBe(0.5);
      expect(health.note).toBe(
        'Breaker half-open — deprioritised until one request proves it recovered',
      );
    });

    it('compounds the half-open penalty with an already poor success rate', () => {
      const conn = connect();
      setHealth(conn, { successCount: 6, failureCount: 4, breaker: 'half-open' });
      expect(factor(only(conn), 'health').value).toBeCloseTo(0.3, 12);
    });

    it('does not penalise a closed breaker', () => {
      const conn = connect();
      setHealth(conn, { successCount: 10, failureCount: 0, breaker: 'closed' });
      expect(factor(only(conn), 'health').value).toBe(1);
    });

    it('ranks a healthy candidate above a half-open one, all else equal', () => {
      const healthy = connect();
      const recovering = connect();
      setHealth(healthy, { successCount: 10, failureCount: 0 });
      setHealth(recovering, { successCount: 10, failureCount: 0, breaker: 'half-open' });

      expect(ids(rank([candidate(recovering), candidate(healthy)], 'round-robin'))).toEqual([
        healthy,
        recovering,
      ]);
    });
  });

  // ─── Tier ──────────────────────────────────────────────────────────────────

  describe('tier factor', () => {
    const TIER_SCORES: ReadonlyArray<readonly [CostTier, number]> = [
      ['free', 1],
      ['cheap', 0.7],
      ['standard', 0.4],
      ['premium', 0.15],
    ];

    for (const [tier, expected] of TIER_SCORES) {
      it(`scores the '${tier}' tier at ${expected}`, () => {
        const conn = connect();
        const out = rank([candidate(conn, { tier })], 'free-first');
        const scored = factor(pick(out, conn), 'tier');
        expect(scored.value).toBe(expected);
        expect(scored.note).toBe(`${tier} tier`);
      });
    }

    it('orders the tiers free > cheap > standard > premium', () => {
      const conns = TIER_SCORES.map(() => connect());
      const out = rank(
        TIER_SCORES.map(([tier], i) => candidate(conns[i]!, { tier })),
        'free-first',
      );
      expect(ids(out)).toEqual(conns);
    });
  });

  // ─── Priority ──────────────────────────────────────────────────────────────

  describe('priority factor', () => {
    it('gives the head of the policy chain a perfect priority score', () => {
      const conn = connect({ priority: 100 });
      const combo = comboWith([{ connectionId: conn, modelId: MODEL, order: 0 }]);

      const out = rank([candidate(conn)], 'priority', { combo });
      const scored = factor(pick(out, conn), 'priority');
      expect(scored.value).toBe(1);
      expect(scored.note).toBe('Position 1 in the policy chain');
    });

    it('decays priority one two-hundredth per chain position', () => {
      const conn = connect();
      const combo = comboWith([{ connectionId: conn, modelId: MODEL, order: 3 }]);

      const out = rank([candidate(conn)], 'priority', { combo });
      const scored = factor(pick(out, conn), 'priority');
      expect(scored.value).toBe(0.985);
      expect(scored.note).toBe('Position 4 in the policy chain');
    });

    it('falls back to connection priority when there is no policy chain', () => {
      const conn = connect({ priority: 100 });
      const scored = factor(only(conn), 'priority');
      expect(scored.value).toBe(0.5);
      expect(scored.note).toBe('Connection priority 100');
    });

    it('scores a connection priority of zero at 1', () => {
      const conn = connect({ priority: 0 });
      expect(factor(only(conn), 'priority').value).toBe(1);
    });

    it('scores a connection priority of exactly 200 at 0', () => {
      const conn = connect({ priority: 200 });
      expect(factor(only(conn), 'priority').value).toBe(0);
    });

    it('clamps a connection priority past 200 to 0 rather than going negative', () => {
      // 200 covers the usable range of either scale; 999 is the highest the API
      // will accept and must not produce a negative factor.
      const conn = connect({ priority: 999 });
      expect(factor(only(conn), 'priority').value).toBe(0);
    });

    it('assumes the default priority when the connection row has gone', () => {
      // A connection deleted while a decision was still being rendered must not
      // take the scorer down with it.
      const scored = factor(only('conn_never_existed'), 'priority');
      expect(scored.value).toBe(0.5);
      expect(scored.note).toBe('Connection priority 100');
    });

    it('lets the chain position override the connection priority', () => {
      const conn = connect({ priority: 200 });
      const combo = comboWith([{ connectionId: conn, modelId: MODEL, order: 0 }]);

      const out = rank([candidate(conn)], 'priority', { combo });
      expect(factor(pick(out, conn), 'priority').value).toBe(1);
    });

    it('matches a chain position on connection and model together', () => {
      // A combo can name one model on a connection without adopting every other
      // model that connection serves.
      const conn = connect({ priority: 100 });
      const combo = comboWith([{ connectionId: conn, modelId: MODEL, order: 0 }]);

      const out = rank(
        [candidate(conn, { modelId: MODEL }), candidate(conn, { modelId: BIG_MODEL })],
        'priority',
        { combo },
      );

      const named = out.find((c) => c.modelId === MODEL);
      const unnamed = out.find((c) => c.modelId === BIG_MODEL);
      expect(factor(named!, 'priority').note).toBe('Position 1 in the policy chain');
      expect(factor(unnamed!, 'priority').note).toBe('Connection priority 100');
    });

    it('ignores the chain entirely when no combo is supplied', () => {
      const conn = connect({ priority: 20 });
      const scored = factor(only(conn), 'priority');
      expect(scored.value).toBe(0.9);
      expect(scored.note).toBe('Connection priority 20');
    });
  });

  // ─── Quota headroom ────────────────────────────────────────────────────────

  describe('quota factor', () => {
    it('gives full headroom when no budget cap is set', () => {
      const conn = connect({ monthlyBudgetUsd: null });
      const scored = factor(only(conn), 'quota');
      expect(scored.value).toBe(1);
      expect(scored.note).toBe('No budget cap set');
    });

    it('shades the ranking of a capped connection', () => {
      // Candidates are already excluded once the budget is spent, so this only
      // needs to nudge the ranking as the cap approaches.
      const conn = connect({ monthlyBudgetUsd: 25 });
      const scored = factor(only(conn), 'quota');
      expect(scored.value).toBe(0.5);
      expect(scored.note).toBe('Under a $25.00/mo cap');
    });

    it('treats a budget of exactly zero as no cap at all', () => {
      // A $0 cap would otherwise read as "infinitely constrained" when it
      // actually means the user cleared the field.
      const conn = connect({ monthlyBudgetUsd: 0 });
      const scored = factor(only(conn), 'quota');
      expect(scored.value).toBe(1);
      expect(scored.note).toBe('No budget cap set');
    });

    it('treats a negative budget as no cap at all', () => {
      const conn = connect({ monthlyBudgetUsd: -10 });
      expect(factor(only(conn), 'quota').value).toBe(1);
    });

    it('renders a sub-dollar cap to two decimal places', () => {
      const conn = connect({ monthlyBudgetUsd: 0.5 });
      expect(factor(only(conn), 'quota').note).toBe('Under a $0.50/mo cap');
    });

    it('gives full headroom when the connection row has gone', () => {
      expect(factor(only('conn_never_existed'), 'quota').value).toBe(1);
    });

    it('ranks an uncapped connection above a capped one, all else equal', () => {
      const uncapped = connect();
      const capped = connect({ monthlyBudgetUsd: 5 });
      expect(ids(rank([candidate(capped), candidate(uncapped)], 'cost-optimized'))).toEqual([
        uncapped,
        capped,
      ]);
    });
  });

  // ─── Throughput prior ──────────────────────────────────────────────────────

  describe('throughput factor', () => {
    it('scores a known model against a 1,000 tok/s reference', () => {
      const conn = connect();
      const out = rank([candidate(conn, { modelId: MODEL })], 'fastest');
      const scored = factor(pick(out, conn), 'throughput');
      expect(scored.value).toBeCloseTo(0.84, 12);
      expect(scored.note).toBe('~840 tok/s typical');
    });

    it('scores a model at exactly the reference throughput at 1', () => {
      const conn = connect();
      const out = rank([candidate(conn, { modelId: AT_LIMIT_MODEL })], 'fastest');
      expect(factor(pick(out, conn), 'throughput').value).toBe(1);
    });

    it('caps a model faster than the reference at 1 rather than above it', () => {
      const conn = connect({ providerId: 'cerebras' });
      const out = rank(
        [candidate(conn, { providerId: 'cerebras', modelId: OVER_LIMIT_MODEL })],
        'fastest',
      );
      const scored = factor(pick(out, conn), 'throughput');
      expect(scored.value).toBe(1);
      expect(scored.note).toBe('~3000 tok/s typical');
    });

    it('scores an unknown model at zero and says so', () => {
      const conn = connect();
      const out = rank([candidate(conn, { modelId: 'not-in-the-catalog' })], 'fastest');
      const scored = factor(pick(out, conn), 'throughput');
      expect(scored.value).toBe(0);
      expect(scored.note).toBe('Throughput unknown');
    });

    it('scores a model on the wrong provider at zero', () => {
      // findModel is keyed by provider, so a Groq model id under Cerebras is
      // simply unknown.
      const conn = connect({ providerId: 'cerebras' });
      const out = rank([candidate(conn, { providerId: 'cerebras', modelId: MODEL })], 'fastest');
      expect(factor(pick(out, conn), 'throughput').value).toBe(0);
    });
  });

  // ─── Stability ─────────────────────────────────────────────────────────────

  describe('stability factor', () => {
    it('gives a connection with no recent failures full marks', () => {
      const conn = connect();
      setHealth(conn, { consecutiveFailures: 0 });
      const scored = factor(only(conn), 'stability');
      expect(scored.value).toBe(1);
      expect(scored.note).toBe('No recent failures');
    });

    it('docks a quarter for a single consecutive failure, in the singular', () => {
      const conn = connect();
      setHealth(conn, { consecutiveFailures: 1 });
      const scored = factor(only(conn), 'stability');
      expect(scored.value).toBe(0.75);
      expect(scored.note).toBe('1 consecutive failure since last success');
    });

    it('pluralises from the second consecutive failure', () => {
      const conn = connect();
      setHealth(conn, { consecutiveFailures: 2 });
      const scored = factor(only(conn), 'stability');
      expect(scored.value).toBe(0.5);
      expect(scored.note).toBe('2 consecutive failures since last success');
    });

    it('reaches zero at exactly four consecutive failures', () => {
      const conn = connect();
      setHealth(conn, { consecutiveFailures: 4 });
      expect(factor(only(conn), 'stability').value).toBe(0);
    });

    it('clamps past four failures at zero rather than going negative', () => {
      const conn = connect();
      setHealth(conn, { consecutiveFailures: 12 });
      const scored = factor(only(conn), 'stability');
      expect(scored.value).toBe(0);
      expect(scored.note).toBe('12 consecutive failures since last success');
    });

    it('ranks a steady connection above a flapping one, all else equal', () => {
      const steady = connect();
      const flapping = connect();
      setHealth(steady, { consecutiveFailures: 0 });
      setHealth(flapping, { consecutiveFailures: 3 });

      expect(ids(rank([candidate(flapping), candidate(steady)], 'round-robin'))).toEqual([
        steady,
        flapping,
      ]);
    });
  });

  // ─── Strategy behaviour ────────────────────────────────────────────────────

  describe("strategy 'free-first'", () => {
    it('ranks a free-tier candidate above a cheaper paid one', () => {
      // Tier outweighs cost here, which is the entire premise of the strategy:
      // a free allowance is worth more than this request's list price.
      const free = connect();
      const paid = connect();
      const cands = [
        candidate(paid, { tier: 'premium', projectedCostUsd: 0.001 }),
        candidate(free, { tier: 'free', projectedCostUsd: 0.02 }),
      ];

      expect(ids(rank(cands, 'free-first'))).toEqual([free, paid]);
    });

    it('flips to the cheaper paid candidate under cost-optimized on the same input', () => {
      // The same two candidates, two strategies, opposite answers — proof the
      // weighting is doing the work rather than the input.
      const free = connect();
      const paid = connect();
      const cands = [
        candidate(paid, { tier: 'premium', projectedCostUsd: 0.001 }),
        candidate(free, { tier: 'free', projectedCostUsd: 0.02 }),
      ];

      expect(ids(rank(cands, 'free-first'))).toEqual([free, paid]);
      expect(ids(rank(cands, 'cost-optimized'))).toEqual([paid, free]);
    });

    it('prefers the cheaper of two free-tier candidates', () => {
      const cheap = connect();
      const dear = connect();
      const cands = [
        candidate(dear, { tier: 'free', projectedCostUsd: 0.4 }),
        candidate(cheap, { tier: 'free', projectedCostUsd: 0 }),
      ];
      expect(ids(rank(cands, 'free-first'))).toEqual([cheap, dear]);
    });
  });

  describe("strategy 'cost-optimized'", () => {
    it('ranks purely on projected cost when nothing else differs', () => {
      const dear = connect();
      const cheap = connect();
      const mid = connect();
      const cands = [
        candidate(dear, { projectedCostUsd: 0.5 }),
        candidate(cheap, { projectedCostUsd: 0.05 }),
        candidate(mid, { projectedCostUsd: 0.2 }),
      ];

      expect(ids(rank(cands, 'cost-optimized'))).toEqual([cheap, mid, dear]);
    });

    it('still prefers the cheaper candidate when it is on a worse tier', () => {
      const cheapPremium = connect();
      const dearFree = connect();
      const cands = [
        candidate(dearFree, { tier: 'free', projectedCostUsd: 0.5 }),
        candidate(cheapPremium, { tier: 'premium', projectedCostUsd: 0.01 }),
      ];
      expect(ids(rank(cands, 'cost-optimized'))).toEqual([cheapPremium, dearFree]);
    });
  });

  describe("strategy 'fastest'", () => {
    it('ranks on measured latency when nothing else differs', () => {
      const slow = connect();
      const quick = connect();
      const mid = connect();
      setHealth(slow, { p50LatencyMs: 900 });
      setHealth(quick, { p50LatencyMs: 120 });
      setHealth(mid, { p50LatencyMs: 400 });

      const cands = [candidate(slow), candidate(quick), candidate(mid)];
      expect(ids(rank(cands, 'fastest'))).toEqual([quick, mid, slow]);
    });

    it('prefers a fast expensive candidate over a slow free one', () => {
      const quick = connect();
      const slow = connect();
      setHealth(quick, { p50LatencyMs: 100 });
      setHealth(slow, { p50LatencyMs: 5_000 });

      const cands = [
        candidate(slow, { tier: 'free', projectedCostUsd: 0 }),
        candidate(quick, { tier: 'premium', projectedCostUsd: 1 }),
      ];
      expect(ids(rank(cands, 'fastest'))).toEqual([quick, slow]);
    });
  });

  describe("strategy 'quality-first'", () => {
    /** Same three prices, used to show cost-optimized and quality-first disagree. */
    function priceLadder(): { cheap: string; mid: string; dear: string; cands: RouteCandidate[] } {
      const cheap = connect();
      const mid = connect();
      const dear = connect();
      return {
        cheap,
        mid,
        dear,
        cands: [
          candidate(cheap, { projectedCostUsd: 0.05 }),
          candidate(dear, { projectedCostUsd: 0.5 }),
          candidate(mid, { projectedCostUsd: 0.2 }),
        ],
      };
    }

    it('lets the most expensive candidate win', () => {
      // Pricier models are generally stronger, so a high price becomes evidence
      // of quality rather than a penalty.
      const { dear, cands } = priceLadder();
      expect(rank(cands, 'quality-first')[0]?.connectionId).toBe(dear);
    });

    it('inverts the cost value rather than merely ignoring it', () => {
      const { cheap, dear, cands } = priceLadder();
      const out = rank(cands, 'quality-first');
      expect(factor(pick(out, dear), 'cost').value).toBe(1);
      expect(factor(pick(out, cheap), 'cost').value).toBe(0);
    });

    it('produces exactly the reverse ordering of cost-optimized on the same input', () => {
      const { cands } = priceLadder();
      const cheapest = ids(rank(cands, 'cost-optimized'));
      const best = ids(rank(cands, 'quality-first'));
      expect(best).toEqual([...cheapest].reverse());
    });

    it('explains that the price is being read as a quality signal', () => {
      const { dear, cands } = priceLadder();
      const out = rank(cands, 'quality-first');
      expect(factor(pick(out, dear), 'cost').note).toBe(
        '$0.50 projected — price used as a quality signal',
      );
    });

    it('leaves an all-equal cost spread neutral rather than inverting it to zero', () => {
      const a = connect();
      const b = connect();
      const out = rank(
        [candidate(a, { projectedCostUsd: 0.1 }), candidate(b, { projectedCostUsd: 0.1 })],
        'quality-first',
      );
      expect(out.map((s) => factor(s, 'cost').value)).toEqual([0.5, 0.5]);
    });
  });

  describe("strategies 'priority' and 'failover'", () => {
    /**
     * A chain whose last member is the one the blended score would have picked,
     * so following the chain is visibly a decision and not a coincidence.
     */
    function chain(): { first: string; second: string; third: string; combo: Combo; cands: RouteCandidate[] } {
      const first = connect({ priority: 100 });
      const second = connect({ priority: 100 });
      const third = connect({ priority: 100 });

      setHealth(first, {
        successCount: 50,
        failureCount: 50,
        p50LatencyMs: 5_000,
        consecutiveFailures: 3,
      });
      setHealth(third, { successCount: 100, failureCount: 0, p50LatencyMs: 10 });

      return {
        first,
        second,
        third,
        combo: comboWith([
          { connectionId: first, modelId: MODEL, order: 0 },
          { connectionId: second, modelId: MODEL, order: 1 },
          { connectionId: third, modelId: MODEL, order: 2 },
        ]),
        cands: [
          candidate(third, { projectedCostUsd: 0 }),
          candidate(first, { projectedCostUsd: 5 }),
          candidate(second, { projectedCostUsd: 1 }),
        ],
      };
    }

    for (const strategy of ['priority', 'failover'] as const) {
      it(`follows the chain under '${strategy}' even when the score disagrees`, () => {
        const { first, second, third, combo, cands } = chain();
        const out = rank(cands, strategy, { combo });

        expect(ids(out)).toEqual([first, second, third]);
        // The blended score would have chosen the opposite end of the chain.
        expect(pick(out, third).score).toBeGreaterThan(pick(out, first).score);
      });

      it(`still computes the full factor trace under '${strategy}'`, () => {
        // Ordering ignores the score, but the decision trace must stay
        // explanatory — the UI renders the same table for every strategy.
        const { first, combo, cands } = chain();
        const scored = pick(rank(cands, strategy, { combo }), first);

        expect(scored.factors.map((f) => f.name)).toEqual([...FACTOR_ORDER]);
        expect(scored.score).toBeGreaterThan(0);
        for (const f of scored.factors) expect(f.note.length).toBeGreaterThan(0);
      });

      it(`sorts by connection priority under '${strategy}' when there is no chain`, () => {
        const low = connect({ priority: 5 });
        const mid = connect({ priority: 30 });
        const high = connect({ priority: 90 });

        const out = rank([candidate(mid), candidate(high), candidate(low)], strategy);
        expect(ids(out)).toEqual([low, mid, high]);
      });

      it(`places a candidate outside the chain behind every chain member under '${strategy}'`, () => {
        // Even with the best connection priority in the set: not being in the
        // policy is the stronger signal.
        const inChain = connect({ priority: 100 });
        const stray = connect({ priority: 1 });
        const combo = comboWith([{ connectionId: inChain, modelId: MODEL, order: 5 }]);

        const out = rank([candidate(stray), candidate(inChain)], strategy, { combo });
        expect(ids(out)).toEqual([inChain, stray]);
      });

      it(`breaks a full priority tie with the blended score under '${strategy}'`, () => {
        const dear = connect({ priority: 10 });
        const cheap = connect({ priority: 10 });
        const out = rank(
          [candidate(dear, { projectedCostUsd: 1 }), candidate(cheap, { projectedCostUsd: 0 })],
          strategy,
        );
        expect(ids(out)).toEqual([cheap, dear]);
      });

      it(`prefers the chain position over the connection priority under '${strategy}'`, () => {
        const late = connect({ priority: 1 });
        const early = connect({ priority: 199 });
        const combo = comboWith([
          { connectionId: early, modelId: MODEL, order: 0 },
          { connectionId: late, modelId: MODEL, order: 1 },
        ]);

        expect(ids(rank([candidate(late), candidate(early)], strategy, { combo }))).toEqual([
          early,
          late,
        ]);
      });

      it(`ignores the rotation counter under '${strategy}'`, () => {
        const { combo, cands } = chain();
        const at0 = ids(rank(cands, strategy, { combo, rotation: 0 }));
        const at1 = ids(rank(cands, strategy, { combo, rotation: 1 }));
        expect(at1).toEqual(at0);
      });
    }
  });

  describe("strategy 'round-robin'", () => {
    /** Three candidates with a strict, known score order: a > b > c. */
    function spread(): { a: string; b: string; c: string; cands: RouteCandidate[] } {
      const a = connect();
      const b = connect();
      const c = connect();
      return {
        a,
        b,
        c,
        cands: [
          candidate(a, { projectedCostUsd: 0 }),
          candidate(b, { projectedCostUsd: 0.5 }),
          candidate(c, { projectedCostUsd: 1 }),
        ],
      };
    }

    it('returns the plain score order at rotation zero', () => {
      const { a, b, c, cands } = spread();
      expect(ids(rank(cands, 'round-robin', { rotation: 0 }))).toEqual([a, b, c]);
    });

    it('advances the head by one on each successive rotation', () => {
      // Without this, every request in a burst lands on whichever member
      // happened to score highest.
      const { a, b, c, cands } = spread();
      const heads = [0, 1, 2, 3, 4].map(
        (rotation) => rank(cands, 'round-robin', { rotation })[0]?.connectionId,
      );
      expect(heads).toEqual([a, b, c, a, b]);
    });

    it('gives three consecutive requests three different members', () => {
      const { cands } = spread();
      const heads = [7, 8, 9].map(
        (rotation) => rank(cands, 'round-robin', { rotation })[0]?.connectionId,
      );
      expect(new Set(heads).size).toBe(3);
    });

    it('rotates without dropping or duplicating a candidate', () => {
      const { a, b, c, cands } = spread();
      for (const rotation of [0, 1, 2, 3, 11]) {
        const out = rank(cands, 'round-robin', { rotation });
        expect(ids(out).sort()).toEqual([a, b, c].sort());
      }
    });

    it('preserves the relative order behind the rotated head', () => {
      const { a, b, c, cands } = spread();
      expect(ids(rank(cands, 'round-robin', { rotation: 1 }))).toEqual([b, c, a]);
      expect(ids(rank(cands, 'round-robin', { rotation: 2 }))).toEqual([c, a, b]);
    });

    it('leaves a single eligible candidate alone at any rotation', () => {
      const solo = connect();
      for (const rotation of [0, 1, 7]) {
        expect(ids(rank([candidate(solo)], 'round-robin', { rotation }))).toEqual([solo]);
      }
    });

    it('still returns every candidate for a negative rotation', () => {
      const { a, b, c, cands } = spread();
      const out = rank(cands, 'round-robin', { rotation: -1 });
      expect(ids(out).sort()).toEqual([a, b, c].sort());
    });

    it('rotates only the eligible candidates, never the excluded tail', () => {
      const { a, b, c, cands } = spread();
      const barred = connect();
      const withExcluded = [...cands, candidate(barred, { excludedReason: 'Breaker open' })];

      const out = rank(withExcluded, 'round-robin', { rotation: 1 });
      expect(ids(out)).toEqual([b, c, a, barred]);
    });

    it('leaves every other strategy unrotated', () => {
      const { cands } = spread();
      for (const strategy of ALL_STRATEGIES) {
        if (strategy === 'round-robin') continue;
        expect(ids(rank(cands, strategy, { rotation: 2 }))).toEqual(ids(rank(cands, strategy)));
      }
    });
  });
});
