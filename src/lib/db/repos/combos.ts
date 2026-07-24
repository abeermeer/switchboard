import type { DatabaseSync } from 'node:sqlite';
import type { ChatFeature, Combo, ComboMember, Modality, RoutingStrategy } from '@/types/core';
import { getDb, parseJson, toBool, toInt, transact } from '@/lib/db/client';
import {
  asRow,
  asRows,
  changeCount,
  num,
  numOrNull,
  oneOf,
  scalar,
  str,
  type Bind,
  type Row,
} from '@/lib/db/rows';
import { DEFAULT_SETTINGS, getSettings } from '@/lib/db/repos/settings';
import { id } from '@/lib/utils';

const MODALITIES: readonly Modality[] = [
  'chat',
  'embeddings',
  'images',
  'audio.speech',
  'audio.transcription',
  'rerank',
  'moderation',
];

const STRATEGIES: readonly RoutingStrategy[] = [
  'free-first',
  'cost-optimized',
  'fastest',
  'quality-first',
  'priority',
  'round-robin',
  'failover',
];

const CHAT_FEATURES: readonly ChatFeature[] = [
  'tools',
  'vision',
  'json_mode',
  'reasoning',
  'streaming',
  'prefill',
];

const COLUMNS = `
  id, slug, name, description, modality, strategy, requires, max_cost_per_mtok,
  max_attempts, timeout_ms, enabled, is_default, created_at, updated_at
`;

function toRequires(raw: unknown): ChatFeature[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is ChatFeature =>
    typeof value === 'string' && (CHAT_FEATURES as readonly string[]).includes(value),
  );
}

function toMember(row: Row): ComboMember {
  return {
    connectionId: str(row.connection_id),
    modelId: str(row.model_id),
    order: num(row.sort_order, 0),
    weight: num(row.weight, 1),
    enabled: toBool(row.enabled),
  };
}

function toCombo(row: Row, members: ComboMember[]): Combo {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name),
    description: str(row.description),
    modality: oneOf<Modality>(row.modality, MODALITIES, 'chat'),
    strategy: oneOf<RoutingStrategy>(row.strategy, STRATEGIES, 'free-first'),
    members,
    requires: toRequires(row.requires),
    maxCostPerMTok: numOrNull(row.max_cost_per_mtok),
    maxAttempts: num(row.max_attempts, 4),
    timeoutMs: num(row.timeout_ms, DEFAULT_SETTINGS.defaultTimeoutMs),
    enabled: toBool(row.enabled),
    isDefault: toBool(row.is_default),
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  };
}

function membersFor(comboId: string): ComboMember[] {
  const rows = asRows(
    getDb()
      .prepare(
        `SELECT connection_id, model_id, sort_order, weight, enabled
           FROM combo_members WHERE combo_id = ?
          ORDER BY sort_order ASC, model_id ASC`,
      )
      .all(comboId),
  );
  return rows.map(toMember);
}

/** One pass over combo_members so listCombos does not fan out into N queries. */
function membersByCombo(): Map<string, ComboMember[]> {
  const rows = asRows(
    getDb()
      .prepare(
        `SELECT combo_id, connection_id, model_id, sort_order, weight, enabled
           FROM combo_members ORDER BY combo_id ASC, sort_order ASC, model_id ASC`,
      )
      .all(),
  );
  const grouped = new Map<string, ComboMember[]>();
  for (const row of rows) {
    const comboId = str(row.combo_id);
    const bucket = grouped.get(comboId);
    if (bucket) bucket.push(toMember(row));
    else grouped.set(comboId, [toMember(row)]);
  }
  return grouped;
}

export function listCombos(): Combo[] {
  const rows = asRows(
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM combos ORDER BY is_default DESC, created_at ASC`)
      .all(),
  );
  const grouped = membersByCombo();
  return rows.map((row) => toCombo(row, grouped.get(str(row.id)) ?? []));
}

export function getCombo(comboId: string): Combo | null {
  const row = asRow(getDb().prepare(`SELECT ${COLUMNS} FROM combos WHERE id = ?`).get(comboId));
  return row ? toCombo(row, membersFor(str(row.id))) : null;
}

export function getComboBySlug(slug: string): Combo | null {
  const row = asRow(getDb().prepare(`SELECT ${COLUMNS} FROM combos WHERE slug = ?`).get(slug));
  return row ? toCombo(row, membersFor(str(row.id))) : null;
}

export function getDefaultCombo(): Combo | null {
  const configured = getComboBySlug(getSettings().defaultCombo);
  if (configured) return configured;

  const flagged = asRow(
    getDb().prepare(`SELECT ${COLUMNS} FROM combos WHERE is_default = 1 LIMIT 1`).get(),
  );
  if (flagged) return toCombo(flagged, membersFor(str(flagged.id)));

  const firstEnabled = asRow(
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM combos WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1`)
      .get(),
  );
  return firstEnabled ? toCombo(firstEnabled, membersFor(str(firstEnabled.id))) : null;
}

function insertMember(
  handle: DatabaseSync,
  comboId: string,
  member: ComboMember,
  fallbackOrder: number,
): void {
  // OR REPLACE: the primary key is (combo, connection, model), so a caller that
  // lists the same pair twice should collapse rather than abort the transaction.
  handle
    .prepare(
      `INSERT OR REPLACE INTO combo_members
         (combo_id, connection_id, model_id, sort_order, weight, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      comboId,
      member.connectionId,
      member.modelId,
      Number.isFinite(member.order) ? Math.trunc(member.order) : fallbackOrder,
      Number.isFinite(member.weight) ? Math.trunc(member.weight) : 1,
      toInt(member.enabled),
    );
}

export function createCombo(input: {
  slug: string;
  name: string;
  description?: string;
  modality?: Modality;
  strategy?: RoutingStrategy;
  requires?: ChatFeature[];
  maxCostPerMTok?: number | null;
  maxAttempts?: number;
  timeoutMs?: number;
  members?: ComboMember[];
}): Combo {
  const slug = input.slug.trim();
  if (!slug) throw new Error('Combo slug cannot be empty');
  if (getComboBySlug(slug)) throw new Error(`Combo slug "${slug}" is already in use`);

  const comboId = id('combo');
  const now = Date.now();
  const members = input.members ?? [];

  transact((handle) => {
    handle
      .prepare(
        `INSERT INTO combos
           (id, slug, name, description, modality, strategy, requires, max_cost_per_mtok,
            max_attempts, timeout_ms, enabled, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        comboId,
        slug,
        input.name.trim() || slug,
        input.description ?? '',
        input.modality ?? 'chat',
        input.strategy ?? 'free-first',
        JSON.stringify(input.requires ?? []),
        input.maxCostPerMTok ?? null,
        input.maxAttempts ?? 4,
        input.timeoutMs ?? DEFAULT_SETTINGS.defaultTimeoutMs,
        toInt(true),
        toInt(false),
        now,
        now,
      );

    members.forEach((member, index) => insertMember(handle, comboId, member, index));
  });

  const created = getCombo(comboId);
  if (!created) throw new Error(`Combo ${comboId} vanished immediately after insert`);
  return created;
}

export function updateCombo(
  comboId: string,
  patch: Partial<Omit<Combo, 'id' | 'createdAt' | 'members'>>,
): Combo | null {
  const existing = getCombo(comboId);
  if (!existing) return null;

  if (patch.slug !== undefined) {
    const slug = patch.slug.trim();
    if (!slug) throw new Error('Combo slug cannot be empty');
    const clash = getComboBySlug(slug);
    if (clash && clash.id !== comboId) throw new Error(`Combo slug "${slug}" is already in use`);
  }

  const assignments: string[] = [];
  const params: Bind[] = [];
  const set = (column: string, value: Bind): void => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.slug !== undefined) set('slug', patch.slug.trim());
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.description !== undefined) set('description', patch.description);
  if (patch.modality !== undefined) set('modality', patch.modality);
  if (patch.strategy !== undefined) set('strategy', patch.strategy);
  if (patch.requires !== undefined) set('requires', JSON.stringify(patch.requires));
  if (patch.maxCostPerMTok !== undefined) set('max_cost_per_mtok', patch.maxCostPerMTok);
  if (patch.maxAttempts !== undefined) set('max_attempts', Math.max(1, Math.trunc(patch.maxAttempts)));
  if (patch.timeoutMs !== undefined) set('timeout_ms', Math.max(1, Math.trunc(patch.timeoutMs)));
  if (patch.enabled !== undefined) set('enabled', toInt(patch.enabled));
  if (patch.isDefault !== undefined) set('is_default', toInt(patch.isDefault));
  set('updated_at', patch.updatedAt ?? Date.now());

  params.push(comboId);

  transact((handle) => {
    // Exactly one row may carry the default flag, or getDefaultCombo becomes a
    // coin toss between whichever row SQLite returns first.
    if (patch.isDefault === true) {
      handle.prepare('UPDATE combos SET is_default = 0 WHERE id != ?').run(comboId);
    }
    handle.prepare(`UPDATE combos SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
  });

  return getCombo(comboId);
}

export function deleteCombo(comboId: string): boolean {
  const result = getDb().prepare('DELETE FROM combos WHERE id = ?').run(comboId);
  return changeCount(result) > 0;
}

export function setComboMembers(comboId: string, members: ComboMember[]): void {
  transact((handle) => {
    handle.prepare('DELETE FROM combo_members WHERE combo_id = ?').run(comboId);
    members.forEach((member, index) => insertMember(handle, comboId, member, index));
    handle.prepare('UPDATE combos SET updated_at = ? WHERE id = ?').run(Date.now(), comboId);
  });
}

/**
 * Seeds the starter policies on a fresh install only. Re-creating them whenever
 * one is missing would resurrect combos the user deliberately deleted, so the
 * check is "the table is empty", not "this slug is absent".
 */
export function ensureSeedCombos(): void {
  const existing = num(scalar(getDb().prepare('SELECT COUNT(*) AS n FROM combos').get(), 'n'), 0);
  if (existing > 0) return;

  // Seeded with no members: an empty member list means "consider every eligible
  // connection", which is what a user with zero providers configured wants.
  const auto = createCombo({
    slug: 'auto',
    name: 'Auto',
    description: 'Free tiers first, climbing to paid providers only when nothing free can serve.',
    strategy: 'free-first',
    requires: [],
    maxAttempts: 4,
  });
  updateCombo(auto.id, { isDefault: true });

  createCombo({
    slug: 'free-only',
    name: 'Free only',
    description: 'Never spends money. Fails rather than falling back to a paid provider.',
    strategy: 'free-first',
    maxCostPerMTok: 0,
  });

  createCombo({
    slug: 'fast',
    name: 'Fast',
    description: 'Lowest observed latency wins, cost is a tiebreaker.',
    strategy: 'fastest',
  });

  createCombo({
    slug: 'quality',
    name: 'Quality',
    description: 'Strongest available model for the job, cost ignored.',
    strategy: 'quality-first',
  });
}
