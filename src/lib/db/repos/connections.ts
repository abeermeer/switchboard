import type { Connection, CostTier } from '@/types/core';
import { getDb, toBool, toInt, transact } from '@/lib/db/client';
import {
  asRow,
  asRows,
  changeCount,
  num,
  numOrNull,
  oneOfOrNull,
  str,
  strOrNull,
  type Bind,
  type Row,
} from '@/lib/db/rows';
import { getProvider } from '@/lib/providers/registry';
import { id } from '@/lib/utils';

const COST_TIERS: readonly CostTier[] = ['free', 'cheap', 'standard', 'premium'];

const COLUMNS = `
  id, provider_id, label, enabled, tier_override, priority,
  base_url_override, monthly_budget_usd, created_at, updated_at
`;

function toConnection(row: Row): Connection {
  return {
    id: str(row.id),
    providerId: str(row.provider_id),
    label: str(row.label),
    enabled: toBool(row.enabled),
    tierOverride: oneOfOrNull<CostTier>(row.tier_override, COST_TIERS),
    priority: num(row.priority, 100),
    baseUrlOverride: strOrNull(row.base_url_override),
    monthlyBudgetUsd: numOrNull(row.monthly_budget_usd),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

export function listConnections(): Connection[] {
  const rows = asRows(
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM connections ORDER BY priority ASC, created_at ASC`)
      .all(),
  );
  return rows.map(toConnection);
}

export function getConnection(connectionId: string): Connection | null {
  const row = asRow(
    getDb().prepare(`SELECT ${COLUMNS} FROM connections WHERE id = ?`).get(connectionId),
  );
  return row ? toConnection(row) : null;
}

export function listConnectionsByProvider(providerId: string): Connection[] {
  const rows = asRows(
    getDb()
      .prepare(
        `SELECT ${COLUMNS} FROM connections WHERE provider_id = ? ORDER BY priority ASC, created_at ASC`,
      )
      .all(providerId),
  );
  return rows.map(toConnection);
}

export function createConnection(input: {
  providerId: string;
  label?: string;
  priority?: number;
  baseUrlOverride?: string | null;
  monthlyBudgetUsd?: number | null;
  tierOverride?: CostTier | null;
}): Connection {
  const providerId = input.providerId.trim();
  if (!providerId) throw new Error('createConnection requires a providerId');

  const connectionId = id('conn');
  const now = Date.now();
  const label = input.label?.trim() || getProvider(providerId)?.name || providerId;

  getDb()
    .prepare(
      `INSERT INTO connections
         (id, provider_id, label, enabled, tier_override, priority,
          base_url_override, monthly_budget_usd, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      connectionId,
      providerId,
      label,
      toInt(true),
      input.tierOverride ?? null,
      input.priority ?? 100,
      input.baseUrlOverride ?? null,
      input.monthlyBudgetUsd ?? null,
      now,
      now,
    );

  const created = getConnection(connectionId);
  if (!created) throw new Error(`Connection ${connectionId} vanished immediately after insert`);
  return created;
}

export function updateConnection(
  connectionId: string,
  patch: Partial<Omit<Connection, 'id' | 'createdAt'>>,
): Connection | null {
  if (!getConnection(connectionId)) return null;

  const assignments: string[] = [];
  const params: Bind[] = [];
  const set = (column: string, value: Bind): void => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.providerId !== undefined) set('provider_id', patch.providerId);
  if (patch.label !== undefined) set('label', patch.label);
  if (patch.enabled !== undefined) set('enabled', toInt(patch.enabled));
  if (patch.tierOverride !== undefined) set('tier_override', patch.tierOverride);
  if (patch.priority !== undefined) set('priority', Math.trunc(patch.priority));
  if (patch.baseUrlOverride !== undefined) set('base_url_override', patch.baseUrlOverride);
  if (patch.monthlyBudgetUsd !== undefined) set('monthly_budget_usd', patch.monthlyBudgetUsd);
  set('updated_at', patch.updatedAt ?? Date.now());

  params.push(connectionId);
  getDb()
    .prepare(`UPDATE connections SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...params);

  return getConnection(connectionId);
}

export function deleteConnection(connectionId: string): boolean {
  return transact((handle) => {
    // credentials/health/combo_members/lockouts/discovered_models cascade via FK;
    // latency_samples deliberately has no FK (it is written on a hot path), so it
    // would otherwise keep rows for a connection that no longer exists.
    handle.prepare('DELETE FROM latency_samples WHERE connection_id = ?').run(connectionId);
    const result = handle.prepare('DELETE FROM connections WHERE id = ?').run(connectionId);
    return changeCount(result) > 0;
  });
}
