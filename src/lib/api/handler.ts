import type { ZodType } from 'zod';
import { z } from 'zod';
import type {
  ChatFeature,
  Modality,
  RequestLogEntry,
  RoutingDecision,
  TokenUsage,
} from '@/types/core';
import { route } from '@/lib/router';
import { insertRequestLog } from '@/lib/db/repos/log';
import { recordUsageBucket } from '@/lib/db/repos/usage';
import { getSettings } from '@/lib/db/repos/settings';
import { findModel } from '@/lib/providers/registry';
import { settleRequest } from '@/lib/usage/cost';
import {
  authenticate,
  clientMeta,
  CORS_HEADERS,
  jsonError,
  statusForErrorKind,
  typeForErrorKind,
} from './respond';
import { firstIssue } from './schemas';

export interface HandleOptions {
  /** Features the request implies, e.g. tools in the body means tools required. */
  deriveFeatures?: (body: Record<string, unknown>) => ChatFeature[];
  /** Non-JSON responses (audio bytes) skip usage parsing. */
  binary?: boolean;
}

export async function handleModality(
  req: Request,
  modality: Modality,
  schema: ZodType,
  options: HandleOptions = {},
): Promise<Response> {
  const startedAt = Date.now();
  const { ip, userAgent } = clientMeta(req);

  const auth = authenticate(req);
  if (auth.error !== null) return auth.error;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'Request body must be valid JSON.');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, firstIssue(parsed.error as z.ZodError));
  }

  const body = parsed.data as Record<string, unknown>;
  const requestedModel = typeof body['model'] === 'string' ? body['model'] : 'auto';
  const stream = body['stream'] === true;

  const result = await route({
    modality,
    requestedModel,
    body,
    stream,
    apiKey: auth.key,
    signal: req.signal,
    requiredFeatures: options.deriveFeatures?.(body) ?? [],
  });

  const settings = getSettings();
  const logPayloads = settings.logPayloads;

  // ── total failure ─────────────────────────────────────────────────────────
  if (result.response === null || !result.response.ok) {
    const err = result.error ?? {
      kind: 'unknown' as const,
      message: 'No provider could serve this request.',
      retryAfterSec: null,
      raw: null,
    };
    const status = statusForErrorKind(err.kind);

    persist(
      {
        modality,
        requestedModel,
        decision: result.decision,
        status: 'error',
        httpStatus: status,
        durationMs: Date.now() - startedAt,
        ttftMs: null,
        streamed: stream,
        usage: null,
        apiKeyId: auth.key?.id ?? null,
        ip,
        userAgent,
        error: err.message,
      },
      logPayloads ? { request: body, response: { error: err.message } } : {},
    );

    const headers: Record<string, string> = { ...traceHeaders(result.decision, 0, null) };
    if (err.retryAfterSec !== null) headers['retry-after'] = String(err.retryAfterSec);

    return jsonError(status, err.message, typeForErrorKind(err.kind), err.kind, headers);
  }

  const response = result.response;
  const winner = result.decision.winningAttempt;
  const attempt = winner === null ? null : (result.decision.attempts[winner] ?? null);
  const model = attempt === null ? null : findModel(attempt.providerId, attempt.modelId);

  // ── streaming ─────────────────────────────────────────────────────────────
  if (stream && response.stream !== null) {
    let usage: TokenUsage | null = null;
    let finished = false;

    // The log row is written when the stream ends — successfully or because the
    // client vanished — so a long generation still produces exactly one entry.
    const finalize = (): void => {
      if (finished) return;
      finished = true;
      usage = response.usage ?? usage;
      const settled = settleRequest(attempt?.providerId ?? null, attempt?.modelId ?? null, usage);

      persist(
        {
          modality,
          requestedModel,
          decision: result.decision,
          status: 'success',
          httpStatus: 200,
          durationMs: Date.now() - startedAt,
          ttftMs: response.ttftMs,
          streamed: true,
          usage,
          apiKeyId: auth.key?.id ?? null,
          ip,
          userAgent,
          error: null,
        },
        logPayloads ? { request: body, response: { streamed: true, usage } } : {},
      );

      if (attempt !== null && usage !== null) {
        recordUsageBucket({
          ts: startedAt,
          connectionId: attempt.connectionId,
          modelId: attempt.modelId,
          ok: true,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          costUsd: settled.costUsd,
          savedUsd: settled.savedUsd,
        });
      }
    };

    const monitored = response.stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        },
        flush() {
          finalize();
        },
      }),
    );

    req.signal.addEventListener('abort', finalize, { once: true });

    return new Response(monitored, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Nginx and friends buffer SSE by default, which silently turns a
        // streaming response into a single delayed blob.
        'x-accel-buffering': 'no',
        ...CORS_HEADERS,
        ...traceHeaders(result.decision, 0, model),
      },
    });
  }

  // ── non-streaming ─────────────────────────────────────────────────────────
  const usage = response.usage;
  const settled = settleRequest(attempt?.providerId ?? null, attempt?.modelId ?? null, usage);
  const durationMs = Date.now() - startedAt;

  persist(
    {
      modality,
      requestedModel,
      decision: result.decision,
      status: 'success',
      httpStatus: response.httpStatus,
      durationMs,
      ttftMs: response.ttftMs,
      streamed: false,
      usage,
      apiKeyId: auth.key?.id ?? null,
      ip,
      userAgent,
      error: null,
    },
    logPayloads ? { request: body, response: response.json } : {},
  );

  if (attempt !== null && usage !== null) {
    recordUsageBucket({
      ts: startedAt,
      connectionId: attempt.connectionId,
      modelId: attempt.modelId,
      ok: true,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: settled.costUsd,
      savedUsd: settled.savedUsd,
    });
  }

  return new Response(JSON.stringify(response.json ?? {}), {
    status: response.httpStatus,
    headers: {
      'content-type': 'application/json',
      ...CORS_HEADERS,
      ...traceHeaders(result.decision, settled.costUsd, model),
    },
  });
}

/**
 * Routing telemetry on every response. These headers are how a user debugs a
 * slow or surprising request from curl alone, without opening the dashboard.
 */
function traceHeaders(
  decision: RoutingDecision,
  costUsd: number,
  model: { id: string } | null,
): Record<string, string> {
  const winner = decision.winningAttempt;
  const attempt = winner === null ? null : (decision.attempts[winner] ?? null);

  const headers: Record<string, string> = {
    'x-switchboard-request-id': decision.requestId,
    'x-switchboard-attempts': String(decision.attempts.length),
    'x-switchboard-latency-ms': String(decision.totalDurationMs),
    'x-switchboard-strategy': decision.strategy,
  };

  if (attempt !== null) {
    headers['x-switchboard-provider'] = attempt.providerId;
    headers['x-switchboard-model'] = model?.id ?? attempt.modelId;
    headers['x-switchboard-connection'] = attempt.connectionId;
    headers['x-switchboard-cost-usd'] = costUsd.toFixed(6);
    if (attempt.ttftMs !== null) headers['x-switchboard-ttft-ms'] = String(attempt.ttftMs);

    const chosen = decision.candidates.find(
      (c) => c.connectionId === attempt.connectionId && c.modelId === attempt.modelId,
    );
    if (chosen !== undefined) headers['x-switchboard-tier'] = chosen.tier;
  }

  // Only present when a fallback actually happened, so its presence is itself
  // the signal that the first choice failed.
  const failed = decision.attempts.filter((a) => a.status !== 'success');
  if (failed.length > 0) {
    const reason = failed[0]?.fallbackReason ?? failed[0]?.error ?? 'unknown';
    headers['x-switchboard-fallback-reason'] = reason.slice(0, 200).replace(/[\r\n]+/g, ' ');
  }

  return headers;
}

interface PersistInput {
  modality: Modality;
  requestedModel: string;
  decision: RoutingDecision;
  status: 'success' | 'error';
  httpStatus: number;
  durationMs: number;
  ttftMs: number | null;
  streamed: boolean;
  usage: TokenUsage | null;
  apiKeyId: string | null;
  ip: string | null;
  userAgent: string | null;
  error: string | null;
}

function persist(input: PersistInput, payloads: { request?: unknown; response?: unknown }): void {
  const winner = input.decision.winningAttempt;
  const attempt = winner === null ? null : (input.decision.attempts[winner] ?? null);

  const entry: RequestLogEntry = {
    id: input.decision.requestId,
    ts: input.decision.decidedAt,
    apiKeyId: input.apiKeyId,
    modality: input.modality,
    requestedModel: input.requestedModel,
    resolvedConnectionId: attempt?.connectionId ?? null,
    resolvedProviderId: attempt?.providerId ?? null,
    resolvedModelId: attempt?.modelId ?? null,
    status: input.status,
    httpStatus: input.httpStatus,
    durationMs: input.durationMs,
    ttftMs: input.ttftMs,
    streamed: input.streamed,
    usage: input.usage,
    costUsd: settleRequest(attempt?.providerId ?? null, attempt?.modelId ?? null, input.usage).costUsd,
    attemptCount: input.decision.attempts.length,
    error: input.error,
    clientIp: input.ip,
    userAgent: input.userAgent,
  };

  try {
    insertRequestLog(entry, {
      decision: input.decision,
      request: payloads.request,
      response: payloads.response,
    });
  } catch (err) {
    // Logging must never take down a request that already succeeded upstream.
    console.error('[switchboard] failed to persist request log:', err);
  }
}
