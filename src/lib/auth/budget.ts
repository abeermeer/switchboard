import type { ApiKey } from '@/types/core';
import { monthToDateCostForApiKey } from '@/lib/db/repos/usage';

export interface BudgetCheck {
  state: 'ok' | 'downgrade' | 'blocked';
  spentUsd: number;
  limitUsd: number | null;
}

/**
 * Month-to-date spend against a key's ceiling.
 *
 * 'downgrade' is the friendlier default: the request still runs, but the router
 * restricts it to free-tier connections so the bill stops growing instead of
 * the client's integration breaking.
 */
export function checkBudget(key: ApiKey): BudgetCheck {
  const limit = key.monthlyBudgetUsd;
  const limitUsd = limit !== null && Number.isFinite(limit) && limit > 0 ? limit : null;

  // Skip the aggregate entirely when there is no ceiling to compare against —
  // this runs on every proxied request, and the number would go unused.
  if (limitUsd === null) return { state: 'ok', spentUsd: 0, limitUsd: null };

  const spentUsd = monthToDateCostForApiKey(key.id);
  if (spentUsd < limitUsd) return { state: 'ok', spentUsd, limitUsd };

  return {
    state: key.onBudgetExceeded === 'block' ? 'blocked' : 'downgrade',
    spentUsd,
    limitUsd,
  };
}

/** 0..1 share of the ceiling consumed, for the dashboard's budget meter. */
export function budgetFraction(check: BudgetCheck): number {
  if (check.limitUsd === null || check.limitUsd <= 0) return 0;
  return Math.min(1, check.spentUsd / check.limitUsd);
}
