import type {
  Combo,
  CostTier,
  RouteCandidate,
  RoutingStrategy,
  ScoreFactor,
} from '@/types/core';
import { getConnection } from '@/lib/db/repos/connections';
import { snapshotAll } from '@/lib/resilience/breaker';
import { findModel } from '@/lib/providers/registry';
import { formatMs, formatUsd } from '@/lib/utils';

/** Every input the scorer can weigh. Kept as a union so the table is total. */
export type FactorName =
  | 'health'
  | 'latency'
  | 'cost'
  | 'tier'
  | 'priority'
  | 'quota'
  | 'throughput'
  | 'stability';

/**
 * How much each strategy cares about each factor. Exported because the routing
 * page renders this table directly — a user picking a strategy should be able
 * to see exactly what it optimises for rather than trusting a label.
 */
export const STRATEGY_WEIGHTS: Record<RoutingStrategy, Record<FactorName, number>> = {
  'free-first': {
    tier: 0.34,
    cost: 0.22,
    health: 0.18,
    latency: 0.1,
    stability: 0.06,
    priority: 0.05,
    quota: 0.03,
    throughput: 0.02,
  },
  'cost-optimized': {
    cost: 0.44,
    tier: 0.16,
    health: 0.16,
    latency: 0.08,
    stability: 0.06,
    quota: 0.05,
    priority: 0.03,
    throughput: 0.02,
  },
  fastest: {
    latency: 0.4,
    throughput: 0.18,
    health: 0.2,
    stability: 0.1,
    cost: 0.05,
    tier: 0.04,
    priority: 0.02,
    quota: 0.01,
  },
  'quality-first': {
    // Cost is inverted inside scoreCost for this strategy: pricier models are
    // generally stronger, so a high price becomes evidence of quality.
    cost: 0.34,
    health: 0.24,
    latency: 0.12,
    stability: 0.1,
    priority: 0.08,
    throughput: 0.06,
    tier: 0.04,
    quota: 0.02,
  },
  priority: {
    priority: 0.62,
    health: 0.2,
    stability: 0.08,
    latency: 0.04,
    cost: 0.03,
    tier: 0.02,
    quota: 0.01,
    throughput: 0,
  },
  'round-robin': {
    health: 0.5,
    stability: 0.2,
    latency: 0.12,
    cost: 0.08,
    tier: 0.05,
    priority: 0.03,
    quota: 0.02,
    throughput: 0,
  },
  failover: {
    priority: 0.66,
    health: 0.22,
    stability: 0.08,
    latency: 0.02,
    cost: 0.01,
    tier: 0.01,
    quota: 0,
    throughput: 0,
  },
};

const TIER_SCORE: Record<CostTier, number> = {
  free: 1.0,
  cheap: 0.7,
  standard: 0.4,
  premium: 0.15,
};

export interface ScoreContext {
  strategy: RoutingStrategy;
  combo: Combo | null;
  /** Monotonic counter used to rotate the head of the list for round-robin. */
  rotation: number;
}

/**
 * Ranks the eligible candidates best-first, attaching the full arithmetic to
 * each one. Excluded candidates pass through untouched at the end of the list
 * so the caller can render a complete trace.
 */
export function scoreCandidates(
  candidates: RouteCandidate[],
  strategy: RoutingStrategy,
  ctx: ScoreContext,
): RouteCandidate[] {
  const eligible = candidates.filter((c) => c.excludedReason === null);
  const excluded = candidates.filter((c) => c.excludedReason !== null);

  if (eligible.length === 0) return excluded;

  const weights = STRATEGY_WEIGHTS[strategy];
  const health = snapshotAll();

  // Normalisation bounds. Every relative factor is scored against the best and
  // worst of *this* candidate set, not an absolute scale — "cheapest available"
  // is the only meaningful comparison at routing time.
  const costs = eligible.map((c) => c.projectedCostUsd);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);

  const latencies = eligible.map((c) => health[c.connectionId]?.p50LatencyMs ?? null);
  const known = latencies.filter((v): v is number => v !== null);
  const minLatency = known.length > 0 ? Math.min(...known) : null;
  const maxLatency = known.length > 0 ? Math.max(...known) : null;

  const memberOrder = new Map<string, number>();
  if (ctx.combo !== null) {
    for (const member of ctx.combo.members) {
      memberOrder.set(`${member.connectionId}:${member.modelId}`, member.order);
    }
  }

  const scored = eligible.map((candidate) => {
    const factors: ScoreFactor[] = [];
    const snap = health[candidate.connectionId] ?? null;
    const model = findModel(candidate.providerId, candidate.modelId);
    const connection = getConnection(candidate.connectionId);

    // ── health ───────────────────────────────────────────────────────────────
    const successRate = snap?.successRate ?? 1;
    const halfOpen = snap?.breaker === 'half-open';
    const healthValue = halfOpen ? successRate * 0.5 : successRate;
    factors.push({
      name: 'health',
      value: healthValue,
      weight: weights.health,
      note: halfOpen
        ? 'Breaker half-open — deprioritised until one request proves it recovered'
        : snap === null
          ? 'No history yet, assumed healthy'
          : `${(successRate * 100).toFixed(1)}% success over the recent window`,
    });

    // ── latency ──────────────────────────────────────────────────────────────
    const p50 = snap?.p50LatencyMs ?? null;
    let latencyValue: number;
    let latencyNote: string;
    if (p50 === null || minLatency === null || maxLatency === null) {
      // Unmeasured candidates sit mid-pack: optimistic enough to earn a first
      // request, not so optimistic that they displace a proven fast provider.
      latencyValue = 0.5;
      latencyNote = 'No latency samples yet — neutral placeholder';
    } else if (maxLatency === minLatency) {
      latencyValue = 1;
      latencyNote = `${formatMs(p50)} p50, all candidates equal`;
    } else {
      latencyValue = 1 - (p50 - minLatency) / (maxLatency - minLatency);
      latencyNote =
        p50 === minLatency
          ? `${formatMs(p50)} p50 — fastest healthy candidate`
          : `${formatMs(p50)} p50 vs ${formatMs(minLatency)} best`;
    }
    factors.push({ name: 'latency', value: latencyValue, weight: weights.latency, note: latencyNote });

    // ── cost ─────────────────────────────────────────────────────────────────
    let costValue: number;
    if (maxCost === minCost) {
      costValue = candidate.projectedCostUsd === 0 ? 1 : 0.5;
    } else {
      costValue = 1 - (candidate.projectedCostUsd - minCost) / (maxCost - minCost);
    }
    if (strategy === 'quality-first') costValue = 1 - costValue;
    factors.push({
      name: 'cost',
      value: costValue,
      weight: weights.cost,
      note:
        candidate.projectedCostUsd === 0
          ? 'Free — $0.00 projected for this request'
          : strategy === 'quality-first'
            ? `${formatUsd(candidate.projectedCostUsd)} projected — price used as a quality signal`
            : `${formatUsd(candidate.projectedCostUsd)} projected${
                candidate.projectedCostUsd === minCost ? ' — cheapest candidate' : ''
              }`,
    });

    // ── tier ─────────────────────────────────────────────────────────────────
    factors.push({
      name: 'tier',
      value: TIER_SCORE[candidate.tier],
      weight: weights.tier,
      note: `${candidate.tier} tier`,
    });

    // ── priority ─────────────────────────────────────────────────────────────
    const order = memberOrder.get(`${candidate.connectionId}:${candidate.modelId}`);
    const connectionPriority = connection?.priority ?? 100;
    // Both scales are "lower is better"; 200 covers the usable range of either.
    const rank = order ?? connectionPriority;
    const priorityValue = Math.max(0, 1 - Math.min(rank, 200) / 200);
    factors.push({
      name: 'priority',
      value: priorityValue,
      weight: weights.priority,
      note:
        order !== undefined
          ? `Position ${order + 1} in the policy chain`
          : `Connection priority ${connectionPriority}`,
    });

    // ── quota headroom ───────────────────────────────────────────────────────
    let quotaValue = 1;
    let quotaNote = 'No budget cap set';
    if (connection?.monthlyBudgetUsd != null && connection.monthlyBudgetUsd > 0) {
      // Candidates are already excluded once the budget is spent, so this only
      // needs to shade the ranking as the cap gets close.
      quotaValue = 0.5;
      quotaNote = `Under a $${connection.monthlyBudgetUsd.toFixed(2)}/mo cap`;
    }
    factors.push({ name: 'quota', value: quotaValue, weight: weights.quota, note: quotaNote });

    // ── throughput prior ─────────────────────────────────────────────────────
    const throughput = model?.throughputPrior ?? 0;
    factors.push({
      name: 'throughput',
      value: Math.min(1, throughput / 1000),
      weight: weights.throughput,
      note: throughput > 0 ? `~${throughput} tok/s typical` : 'Throughput unknown',
    });

    // ── stability ────────────────────────────────────────────────────────────
    const consecutive = snap?.consecutiveFailures ?? 0;
    const stabilityValue = consecutive === 0 ? 1 : Math.max(0, 1 - consecutive * 0.25);
    factors.push({
      name: 'stability',
      value: stabilityValue,
      weight: weights.stability,
      note:
        consecutive === 0
          ? 'No recent failures'
          : `${consecutive} consecutive failure${consecutive === 1 ? '' : 's'} since last success`,
    });

    const score = factors.reduce((sum, f) => sum + f.value * f.weight, 0);
    return { ...candidate, score, factors };
  });

  // Strict-order strategies ignore the blended score for ordering, but the
  // score and its factors are still computed so the trace stays explanatory.
  if (strategy === 'priority' || strategy === 'failover') {
    scored.sort((a, b) => {
      const ao = memberOrder.get(`${a.connectionId}:${a.modelId}`) ?? Number.POSITIVE_INFINITY;
      const bo = memberOrder.get(`${b.connectionId}:${b.modelId}`) ?? Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao - bo;
      const ap = getConnection(a.connectionId)?.priority ?? 100;
      const bp = getConnection(b.connectionId)?.priority ?? 100;
      if (ap !== bp) return ap - bp;
      return b.score - a.score;
    });
    return [...scored, ...excluded];
  }

  scored.sort((a, b) => b.score - a.score);

  if (strategy === 'round-robin' && scored.length > 1) {
    // Rotate the head so consecutive requests actually spread across members
    // instead of all landing on whichever one scored highest.
    const offset = ctx.rotation % scored.length;
    const rotated = [...scored.slice(offset), ...scored.slice(0, offset)];
    return [...rotated, ...excluded];
  }

  return [...scored, ...excluded];
}
