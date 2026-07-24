import type { UsageBucket, UsageRollup } from '@/types/core';
import { getDb, toInt } from '@/lib/db/client';
import { asRow, asRows, num, scalar, str, type Row } from '@/lib/db/rows';

const HOUR_MS = 3_600_000;

/** Charts stay readable — and memory bounded — well below this many points. */
const MAX_SERIES_POINTS = 2_000;

const SUM_COLUMNS = `
  COALESCE(SUM(requests), 0)          AS requests,
  COALESCE(SUM(successes), 0)         AS successes,
  COALESCE(SUM(failures), 0)          AS failures,
  COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(cost_usd), 0)          AS cost_usd,
  COALESCE(SUM(saved_usd), 0)         AS saved_usd
`;

function emptyRollup(): UsageRollup {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    savedUsd: 0,
  };
}

function toRollup(row: Row): UsageRollup {
  return {
    requests: num(row.requests, 0),
    successes: num(row.successes, 0),
    failures: num(row.failures, 0),
    promptTokens: num(row.prompt_tokens, 0),
    completionTokens: num(row.completion_tokens, 0),
    costUsd: num(row.cost_usd, 0),
    savedUsd: num(row.saved_usd, 0),
  };
}

function floorTo(ts: number, size: number): number {
  return Math.floor(ts / size) * size;
}

function monthStartUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

export function recordUsageBucket(input: {
  ts: number;
  connectionId: string;
  modelId: string;
  ok: boolean;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  savedUsd: number;
}): void {
  const bucketTs = floorTo(Number.isFinite(input.ts) ? input.ts : Date.now(), HOUR_MS);

  getDb()
    .prepare(
      `INSERT INTO usage_buckets
         (bucket_ts, connection_id, model_id, requests, successes, failures,
          prompt_tokens, completion_tokens, cost_usd, saved_usd)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bucket_ts, connection_id, model_id) DO UPDATE SET
         requests          = usage_buckets.requests + excluded.requests,
         successes         = usage_buckets.successes + excluded.successes,
         failures          = usage_buckets.failures + excluded.failures,
         prompt_tokens     = usage_buckets.prompt_tokens + excluded.prompt_tokens,
         completion_tokens = usage_buckets.completion_tokens + excluded.completion_tokens,
         cost_usd          = usage_buckets.cost_usd + excluded.cost_usd,
         saved_usd         = usage_buckets.saved_usd + excluded.saved_usd`,
    )
    .run(
      bucketTs,
      input.connectionId,
      input.modelId,
      toInt(input.ok),
      toInt(!input.ok),
      Math.max(0, Math.round(input.promptTokens)),
      Math.max(0, Math.round(input.completionTokens)),
      Number.isFinite(input.costUsd) ? input.costUsd : 0,
      Number.isFinite(input.savedUsd) ? input.savedUsd : 0,
    );
}

/**
 * Rebuckets the hourly rollups into `bucketMs` windows and zero-fills every gap
 * up to now. A sparse series makes a quiet hour look like a missing hour, which
 * is a lie the charts should never tell.
 */
export function usageSeries(sinceTs: number, bucketMs: number): UsageBucket[] {
  const size = Number.isFinite(bucketMs) && bucketMs > 0 ? Math.trunc(bucketMs) : HOUR_MS;
  const end = floorTo(Date.now(), size);
  const requestedStart = floorTo(Number.isFinite(sinceTs) ? sinceTs : end, size);

  let start = Math.min(requestedStart, end);
  let count = Math.floor((end - start) / size) + 1;
  if (count > MAX_SERIES_POINTS) {
    count = MAX_SERIES_POINTS;
    start = end - (count - 1) * size;
  }

  const series: UsageBucket[] = [];
  for (let i = 0; i < count; i += 1) {
    series.push({ ts: start + i * size, ...emptyRollup() });
  }

  const rows = asRows(
    getDb()
      .prepare(
        `SELECT bucket_ts, ${SUM_COLUMNS}
           FROM usage_buckets
          WHERE bucket_ts >= ?
          GROUP BY bucket_ts
          ORDER BY bucket_ts ASC`,
      )
      // Hourly rows carry the whole hour, so widen the floor to avoid dropping
      // the partial hour that the first bucket starts inside.
      .all(floorTo(start, HOUR_MS)),
  );

  for (const row of rows) {
    const index = Math.floor((num(row.bucket_ts, 0) - start) / size);
    const target = series[index];
    if (!target) continue;
    const rollup = toRollup(row);
    target.requests += rollup.requests;
    target.successes += rollup.successes;
    target.failures += rollup.failures;
    target.promptTokens += rollup.promptTokens;
    target.completionTokens += rollup.completionTokens;
    target.costUsd += rollup.costUsd;
    target.savedUsd += rollup.savedUsd;
  }

  return series;
}

export function usageTotals(sinceTs: number): UsageRollup {
  const row = asRow(
    getDb()
      .prepare(`SELECT ${SUM_COLUMNS} FROM usage_buckets WHERE bucket_ts >= ?`)
      .get(floorTo(Number.isFinite(sinceTs) ? sinceTs : 0, HOUR_MS)),
  );
  return row ? toRollup(row) : emptyRollup();
}

export function usageByConnection(sinceTs: number): Record<string, UsageRollup> {
  const rows = asRows(
    getDb()
      .prepare(
        `SELECT connection_id, ${SUM_COLUMNS}
           FROM usage_buckets
          WHERE bucket_ts >= ?
          GROUP BY connection_id`,
      )
      .all(floorTo(Number.isFinite(sinceTs) ? sinceTs : 0, HOUR_MS)),
  );

  const out: Record<string, UsageRollup> = {};
  for (const row of rows) {
    const connectionId = str(row.connection_id);
    if (connectionId) out[connectionId] = toRollup(row);
  }
  return out;
}

export function usageByModel(
  sinceTs: number,
): Array<{ connectionId: string; modelId: string } & UsageRollup> {
  const rows = asRows(
    getDb()
      .prepare(
        `SELECT connection_id, model_id, ${SUM_COLUMNS}
           FROM usage_buckets
          WHERE bucket_ts >= ?
          GROUP BY connection_id, model_id
          ORDER BY cost_usd DESC, requests DESC`,
      )
      .all(floorTo(Number.isFinite(sinceTs) ? sinceTs : 0, HOUR_MS)),
  );

  return rows.map((row) => ({
    connectionId: str(row.connection_id),
    modelId: str(row.model_id),
    ...toRollup(row),
  }));
}

export function monthToDateCostForConnection(connectionId: string): number {
  return num(
    scalar(
      getDb()
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS cost
             FROM usage_buckets
            WHERE connection_id = ? AND bucket_ts >= ?`,
        )
        .get(connectionId, monthStartUtc()),
      'cost',
    ),
    0,
  );
}

export function monthToDateCostForApiKey(apiKeyId: string): number {
  // usage_buckets has no key dimension, so per-key spend comes from the log.
  return num(
    scalar(
      getDb()
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS cost
             FROM request_log
            WHERE api_key_id = ? AND ts >= ?`,
        )
        .get(apiKeyId, monthStartUtc()),
      'cost',
    ),
    0,
  );
}
