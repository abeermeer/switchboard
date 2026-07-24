import type {
  Modality,
  RequestLogDetail,
  RequestLogEntry,
  RoutingDecision,
  TokenUsage,
} from '@/types/core';
import { getDb, parseJson, toBool, toInt, transact } from '@/lib/db/client';
import {
  asRow,
  asRows,
  changeCount,
  escapeLike,
  num,
  numOrNull,
  oneOf,
  safeStringify,
  scalar,
  str,
  strOrNull,
  type Bind,
  type Row,
} from '@/lib/db/rows';
import { clamp } from '@/lib/utils';

const MODALITIES: readonly Modality[] = [
  'chat',
  'embeddings',
  'images',
  'audio.speech',
  'audio.transcription',
  'rerank',
  'moderation',
];

const STATUSES: readonly RequestLogEntry['status'][] = ['success', 'error'];

const COLUMNS = `
  id, ts, api_key_id, modality, requested_model, resolved_connection_id,
  resolved_provider_id, resolved_model_id, status, http_status, duration_ms,
  ttft_ms, streamed, prompt_tokens, completion_tokens, cached_tokens,
  reasoning_tokens, cost_usd, attempt_count, error, client_ip, user_agent
`;

/**
 * A row whose token columns are all zero means the upstream never reported
 * usage. Returning a zeroed TokenUsage would read as "billed nothing", which is
 * a different claim from "we do not know".
 */
function toUsage(row: Row): TokenUsage | null {
  const promptTokens = num(row.prompt_tokens, 0);
  const completionTokens = num(row.completion_tokens, 0);
  const cachedTokens = num(row.cached_tokens, 0);
  const reasoningTokens = num(row.reasoning_tokens, 0);
  if (
    promptTokens === 0 &&
    completionTokens === 0 &&
    cachedTokens === 0 &&
    reasoningTokens === 0
  ) {
    return null;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens,
    reasoningTokens,
  };
}

function toEntry(row: Row): RequestLogEntry {
  return {
    id: str(row.id),
    ts: num(row.ts),
    apiKeyId: strOrNull(row.api_key_id),
    modality: oneOf<Modality>(row.modality, MODALITIES, 'chat'),
    requestedModel: str(row.requested_model),
    resolvedConnectionId: strOrNull(row.resolved_connection_id),
    resolvedProviderId: strOrNull(row.resolved_provider_id),
    resolvedModelId: strOrNull(row.resolved_model_id),
    status: oneOf<RequestLogEntry['status']>(row.status, STATUSES, 'error'),
    httpStatus: num(row.http_status, 0),
    durationMs: num(row.duration_ms, 0),
    ttftMs: numOrNull(row.ttft_ms),
    streamed: toBool(row.streamed),
    usage: toUsage(row),
    costUsd: num(row.cost_usd, 0),
    attemptCount: num(row.attempt_count, 1),
    error: strOrNull(row.error),
    clientIp: strOrNull(row.client_ip),
    userAgent: strOrNull(row.user_agent),
  };
}

export function insertRequestLog(
  entry: RequestLogEntry,
  payloads?: { decision?: RoutingDecision | null; request?: unknown; response?: unknown },
): void {
  const usage = entry.usage;

  transact((handle) => {
    handle
      .prepare(
        `INSERT OR REPLACE INTO request_log
           (id, ts, api_key_id, modality, requested_model, resolved_connection_id,
            resolved_provider_id, resolved_model_id, status, http_status, duration_ms,
            ttft_ms, streamed, prompt_tokens, completion_tokens, cached_tokens,
            reasoning_tokens, cost_usd, saved_usd, attempt_count, error, client_ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        Math.round(entry.ts),
        entry.apiKeyId,
        entry.modality,
        entry.requestedModel,
        entry.resolvedConnectionId,
        entry.resolvedProviderId,
        entry.resolvedModelId,
        entry.status,
        Math.round(entry.httpStatus),
        Math.round(entry.durationMs),
        entry.ttftMs === null ? null : Math.round(entry.ttftMs),
        toInt(entry.streamed),
        usage ? Math.round(usage.promptTokens) : 0,
        usage ? Math.round(usage.completionTokens) : 0,
        usage ? Math.round(usage.cachedTokens) : 0,
        usage ? Math.round(usage.reasoningTokens) : 0,
        entry.costUsd,
        0,
        Math.round(entry.attemptCount),
        entry.error,
        entry.clientIp,
        entry.userAgent,
      );

    if (!payloads) return;
    const decision = payloads.decision ? safeStringify(payloads.decision) : null;
    const request = safeStringify(payloads.request);
    const response = safeStringify(payloads.response);
    if (decision === null && request === null && response === null) return;

    handle
      .prepare(
        `INSERT OR REPLACE INTO request_payloads
           (request_id, decision_json, request_json, response_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(entry.id, decision, request, response);
  });
}

export interface LogQuery {
  limit?: number;
  offset?: number;
  status?: 'success' | 'error';
  connectionId?: string;
  apiKeyId?: string;
  modality?: Modality;
  since?: number;
  search?: string;
}

function buildWhere(q: LogQuery): { clause: string; params: Bind[] } {
  const conditions: string[] = [];
  const params: Bind[] = [];

  if (q.status) {
    conditions.push('status = ?');
    params.push(q.status);
  }
  if (q.connectionId) {
    conditions.push('resolved_connection_id = ?');
    params.push(q.connectionId);
  }
  if (q.apiKeyId) {
    conditions.push('api_key_id = ?');
    params.push(q.apiKeyId);
  }
  if (q.modality) {
    conditions.push('modality = ?');
    params.push(q.modality);
  }
  if (typeof q.since === 'number' && Number.isFinite(q.since)) {
    conditions.push('ts >= ?');
    params.push(Math.round(q.since));
  }

  const search = q.search?.trim();
  if (search) {
    const term = `%${escapeLike(search)}%`;
    conditions.push(
      `(requested_model LIKE ? ESCAPE '\\'
        OR resolved_model_id LIKE ? ESCAPE '\\'
        OR error LIKE ? ESCAPE '\\')`,
    );
    params.push(term, term, term);
  }

  return {
    clause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export function listRequestLogs(q: LogQuery): { rows: RequestLogEntry[]; total: number } {
  const { clause, params } = buildWhere(q);
  const db = getDb();

  const total = num(
    scalar(db.prepare(`SELECT COUNT(*) AS n FROM request_log${clause}`).get(...params), 'n'),
    0,
  );

  const limit = clamp(Math.trunc(q.limit ?? 50), 1, 500);
  const offset = Math.max(0, Math.trunc(q.offset ?? 0));

  const rows = asRows(
    db
      .prepare(
        `SELECT ${COLUMNS} FROM request_log${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset),
  );

  return { rows: rows.map(toEntry), total };
}

export function getRequestLog(logId: string): RequestLogDetail | null {
  const row = asRow(
    getDb()
      .prepare(
        `SELECT l.*, p.decision_json, p.request_json, p.response_json
           FROM request_log l
           LEFT JOIN request_payloads p ON p.request_id = l.id
          WHERE l.id = ?`,
      )
      .get(logId),
  );
  if (!row) return null;

  return {
    ...toEntry(row),
    decision: parseJson<RoutingDecision | null>(row.decision_json, null),
    requestBody: parseJson<unknown>(row.request_json, null),
    responseBody: parseJson<unknown>(row.response_json, null),
  };
}

export function pruneLogs(olderThanTs: number): number {
  if (!Number.isFinite(olderThanTs)) return 0;
  // request_payloads cascades on delete, so the heavy rows go with the log rows.
  const result = getDb()
    .prepare('DELETE FROM request_log WHERE ts < ?')
    .run(Math.round(olderThanTs));
  return changeCount(result);
}
