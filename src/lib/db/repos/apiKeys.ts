import { createHash, randomBytes } from 'node:crypto';
import type { ApiKey } from '@/types/core';
import { getDb, parseJson, toBool, toInt } from '@/lib/db/client';
import {
  asRow,
  asRows,
  changeCount,
  num,
  numOrNull,
  oneOf,
  str,
  type Bind,
  type Row,
} from '@/lib/db/rows';
import { id } from '@/lib/utils';

/** Marks a Switchboard client secret. 8 chars, so prefix = this + 4 random. */
const SECRET_PREFIX = 'sb-live-';
/** 30 random bytes encode to exactly 40 unpadded base64url characters. */
const SECRET_BYTES = 30;
const PREFIX_LENGTH = 12;

const BUDGET_ACTIONS: readonly ApiKey['onBudgetExceeded'][] = ['block', 'downgrade-to-free'];

const COLUMNS = `
  id, name, prefix, allowed_combos, monthly_budget_usd, on_budget_exceeded,
  rate_limit_per_min, enabled, created_at, last_used_at, expires_at
`;

/**
 * A plain SHA-256 over the secret, not a KDF.
 *
 * Every stored secret is 240 bits of CSPRNG output, so there is no password to
 * grind: an attacker holding the hash has to brute-force the full keyspace
 * either way, and bcrypt/scrypt would only buy a slow hash on the hot path of
 * every single proxied request.
 */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function normalizeCombos(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const slug = value.trim();
    if (slug !== '' && !out.includes(slug)) out.push(slug);
  }
  return out;
}

function readCombos(raw: unknown): string[] {
  const parsed = parseJson<unknown>(raw, []);
  if (!Array.isArray(parsed)) return [];
  return normalizeCombos(parsed.filter((value): value is string => typeof value === 'string'));
}

function toApiKey(row: Row): ApiKey {
  return {
    id: str(row.id),
    name: str(row.name),
    prefix: str(row.prefix),
    allowedCombos: readCombos(row.allowed_combos),
    monthlyBudgetUsd: numOrNull(row.monthly_budget_usd),
    onBudgetExceeded: oneOf(row.on_budget_exceeded, BUDGET_ACTIONS, 'downgrade-to-free'),
    rateLimitPerMin: numOrNull(row.rate_limit_per_min),
    enabled: toBool(row.enabled),
    createdAt: num(row.created_at),
    lastUsedAt: numOrNull(row.last_used_at),
    expiresAt: numOrNull(row.expires_at),
  };
}

export function listApiKeys(): ApiKey[] {
  const rows = asRows(
    getDb().prepare(`SELECT ${COLUMNS} FROM api_keys ORDER BY created_at DESC`).all(),
  );
  return rows.map(toApiKey);
}

export function getApiKey(keyId: string): ApiKey | null {
  const row = asRow(getDb().prepare(`SELECT ${COLUMNS} FROM api_keys WHERE id = ?`).get(keyId));
  return row ? toApiKey(row) : null;
}

/**
 * Mints a key. The returned `secret` is the only copy that will ever exist —
 * the database holds nothing but its SHA-256 and the display prefix.
 */
export function createApiKey(input: {
  name: string;
  allowedCombos?: string[];
  monthlyBudgetUsd?: number | null;
  onBudgetExceeded?: 'block' | 'downgrade-to-free';
  rateLimitPerMin?: number | null;
  expiresAt?: number | null;
}): { key: ApiKey; secret: string } {
  const secret = `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
  const keyId = id('key');
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO api_keys
         (id, name, prefix, key_hash, allowed_combos, monthly_budget_usd,
          on_budget_exceeded, rate_limit_per_min, enabled, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      keyId,
      input.name.trim() || 'Untitled key',
      secret.slice(0, PREFIX_LENGTH),
      hashSecret(secret),
      JSON.stringify(normalizeCombos(input.allowedCombos)),
      input.monthlyBudgetUsd ?? null,
      input.onBudgetExceeded ?? 'downgrade-to-free',
      input.rateLimitPerMin ?? null,
      toInt(true),
      now,
      null,
      input.expiresAt ?? null,
    );

  const key = getApiKey(keyId);
  if (!key) throw new Error(`API key ${keyId} vanished immediately after insert`);
  return { key, secret };
}

/**
 * Resolves a presented secret to a live key, or null.
 *
 * The lookup is an indexed equality on the hash, so it leaks nothing useful in
 * its timing: the comparand is a hash of attacker-supplied input, and matching
 * a prefix of it tells you nothing about the 240-bit secret behind a real row.
 */
export function verifyApiKey(secret: string): ApiKey | null {
  const presented = secret.trim();
  if (!presented.startsWith(SECRET_PREFIX)) return null;

  const row = asRow(
    getDb()
      .prepare(`SELECT ${COLUMNS} FROM api_keys WHERE key_hash = ?`)
      .get(hashSecret(presented)),
  );
  if (!row) return null;

  const key = toApiKey(row);
  if (!key.enabled) return null;
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return null;
  return key;
}

export function updateApiKey(
  keyId: string,
  patch: Partial<Omit<ApiKey, 'id' | 'createdAt' | 'prefix'>>,
): ApiKey | null {
  if (!getApiKey(keyId)) return null;

  const assignments: string[] = [];
  const params: Bind[] = [];
  const set = (column: string, value: Bind): void => {
    assignments.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.name !== undefined) set('name', patch.name.trim() || 'Untitled key');
  if (patch.allowedCombos !== undefined) {
    set('allowed_combos', JSON.stringify(normalizeCombos(patch.allowedCombos)));
  }
  if (patch.monthlyBudgetUsd !== undefined) set('monthly_budget_usd', patch.monthlyBudgetUsd);
  if (patch.onBudgetExceeded !== undefined && BUDGET_ACTIONS.includes(patch.onBudgetExceeded)) {
    set('on_budget_exceeded', patch.onBudgetExceeded);
  }
  if (patch.rateLimitPerMin !== undefined) {
    set(
      'rate_limit_per_min',
      patch.rateLimitPerMin === null ? null : Math.max(0, Math.trunc(patch.rateLimitPerMin)),
    );
  }
  if (patch.enabled !== undefined) set('enabled', toInt(patch.enabled));
  if (patch.lastUsedAt !== undefined) set('last_used_at', patch.lastUsedAt);
  if (patch.expiresAt !== undefined) set('expires_at', patch.expiresAt);

  if (assignments.length === 0) return getApiKey(keyId);

  params.push(keyId);
  getDb()
    .prepare(`UPDATE api_keys SET ${assignments.join(', ')} WHERE id = ?`)
    .run(...params);

  return getApiKey(keyId);
}

export function deleteApiKey(keyId: string): boolean {
  return changeCount(getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(keyId)) > 0;
}

/** Stamps last-used. Called once per authenticated request, hence the bare UPDATE. */
export function touchApiKey(keyId: string): void {
  getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), keyId);
}

/** True when the key may call this combo slug. An empty allow-list means all. */
export function canUseCombo(key: ApiKey, comboSlug: string): boolean {
  return key.allowedCombos.length === 0 || key.allowedCombos.includes(comboSlug);
}
