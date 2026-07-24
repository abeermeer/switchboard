/**
 * node:sqlite hands back null-prototype objects whose columns are typed as
 * `unknown`. Every repo needs the same narrowing primitives to turn one of
 * those into a domain object without ever spreading a raw row, so they live
 * here instead of being copy-pasted into six files.
 */

export type Row = Record<string, unknown>;

/** Everything node:sqlite will accept as a bound parameter. */
export type Bind = string | number | bigint | Uint8Array | null;

export function asRow(value: unknown): Row | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Row;
}

export function asRows(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  const out: Row[] = [];
  for (const candidate of value) {
    const row = asRow(candidate);
    if (row) out.push(row);
  }
  return out;
}

/** Reads one column off a single-row result, e.g. `SELECT COUNT(*) AS n`. */
export function scalar(result: unknown, column: string): unknown {
  const row = asRow(result);
  return row ? row[column] : undefined;
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Narrows a TEXT column to a union member, falling back when it drifted. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export function oneOfOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

/** Row count touched by a `run()`, which reports `changes` as number | bigint. */
export function changeCount(result: unknown): number {
  return num(scalar(result, 'changes'), 0);
}

/** `%` and `_` are wildcards; user search text must not smuggle them in. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** JSON for a column, degrading to null rather than throwing on cycles. */
export function safeStringify(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}
