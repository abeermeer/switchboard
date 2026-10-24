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
import { logger, requestLogger } from '@/lib/logger';
import {
  authenticate,
  clientMeta,
  corsHeaders,
  jsonError,
  policyDenied,
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
    return jsonError(400, 'Request body must be valid JSON.', undefined, null, {}, req);
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, firstIssue(parsed.error as z.ZodError), undefined, null, {}, req);
  }

  const body = parsed.data as Record<string, unknown>;
  const requestedModel = typeof body['model'] === 'string' ? body['model'] : 'auto';
  const stream = body['stream'] === true;

  const notAllowed = policyDenied(auth.key, requestedModel, req);
  if (notAllowed !== null) return notAllowed;

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

  if (result.unrecognizedModel) {
    requestLogger({ requestId: result.decision.requestId, modality, requestedModel }).warn(
      'requested model is not recognised; routed as auto',
      { requestedModel },
    );
  }

  // ── total failure ─────────────────────────────────────────────────────────
  if (result.response === null || !result.response.ok) {
    const err = result.error ?? {
      kind: 'unknown' as const,
      message: 'No provider could serve this request.',
      retryAfterSec: null,
      raw: null,
    };
    const status = statusForErrorKind(err.kind);

    recordRequest(
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

    requestLogger({
      requestId: result.decision.requestId,
      modality,
      requestedModel,
      apiKeyId: auth.key?.id ?? null,
    }).warn('no provider could serve the request', {
      errorKind: err.kind,
      httpStatus: status,
      attempts: result.decision.attempts.length,
      durationMs: Date.now() - startedAt,
      // The per-attempt reasons are what turns "it failed" into something
      // actionable without opening the dashboard.
      tried: result.decision.attempts.map((a) => `${a.providerId}:${a.modelId}=${a.fallbackReason ?? a.status}`),
    });

    const headers: Record<string, string> = { ...traceHeaders(result.decision, 0, null, result.unrecognizedModel) };
    if (err.retryAfterSec !== null) headers['retry-after'] = String(err.retryAfterSec);

    return jsonError(status, err.message, typeForErrorKind(err.kind), err.kind, headers, req);
  }

  const response = result.response;
  const winner = result.decision.winningAttempt;
  const attempt = winner === null ? null : (result.decision.attempts[winner] ?? null);
  const model = attempt === null ? null : findModel(attempt.providerId, attempt.modelId);

  // A fallback is worth a line on its own: the client saw a clean 200, so this
  // is the only place the recovery is visible outside the dashboard.
  if (result.decision.attempts.length > 1) {
    requestLogger({
      requestId: result.decision.requestId,
      modality,
      requestedModel,
      apiKeyId: auth.key?.id ?? null,
    }).warn('recovered by falling back', {
      attempts: result.decision.attempts.length,
      servedBy: `${attempt?.providerId ?? 'unknown'}:${attempt?.modelId ?? 'unknown'}`,
      firstFailure: result.decision.attempts[0]?.fallbackReason ?? null,
    });
  }

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

      recordRequest(
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
        ...corsHeaders(req),
        ...traceHeaders(result.decision, 0, model, result.unrecognizedModel),
      },
    });
  }

  // ── non-streaming ─────────────────────────────────────────────────────────
  const usage = response.usage;
  const settled = settleRequest(attempt?.providerId ?? null, attempt?.modelId ?? null, usage);
  const durationMs = Date.now() - startedAt;

  recordRequest(
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

  return new Response(JSON.stringify(response.json ?? {}), {
    status: response.httpStatus,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(req),
      ...traceHeaders(result.decision, settled.costUsd, model, result.unrecognizedModel),
    },
  });
}

/**
 * Makes an arbitrary string safe to put in an HTTP header value.
 *
 * Header values are ByteStrings: any code point above 255 makes `new Response`
 * throw, which would turn a handled upstream failure into an unhandled 500 —
 * the client would lose the real error entirely. Provider messages routinely
 * carry curly quotes, em-dashes and non-English text, and one of our own
 * fallback reasons contains a typographic apostrophe, so this is reachable in
 * normal operation rather than a theoretical edge case.
 */
function headerSafe(value: string): string {
  return (
    value
      .slice(0, 200)
      .replace(/[\r\n]+/g, ' ')
      // Replace rather than drop, so a fully non-Latin message still reads as
      // "something was here" instead of collapsing to an empty header.
      .replace(/[^\x20-\x7e]/g, '?')
      .trim() || 'unknown'
  );
}

/**
 * Routing telemetry on every response. These headers are how a user debugs a
 * slow or surprising request from curl alone, without opening the dashboard.
 */
export function traceHeaders(
  decision: RoutingDecision,
  costUsd: number,
  model: { id: string } | null,
  unrecognizedModel = false,
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

  // A client that asked for a model the gateway does not know was served
  // whatever "auto" picked. Its own model name is echoed back so the
  // substitution is visible from curl, not only in the dashboard.
  if (unrecognizedModel) headers['x-switchboard-substituted'] = headerSafe(decision.requestedModel);

  // Only present when a fallback actually happened, so its presence is itself
  // the signal that the first choice failed.
  const failed = decision.attempts.filter((a) => a.status !== 'success');
  if (failed.length > 0) {
    const reason = failed[0]?.fallbackReason ?? failed[0]?.error ?? 'unknown';
    headers['x-switchboard-fallback-reason'] = headerSafe(reason);
  }

  return headers;
}

export interface RequestRecord {
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

/**
 * Writes the log row and, for a success, the hourly usage rollup.
 *
 * Every path that spends money upstream goes through here: the gateway, the
 * dashboard playground and request replay. The playground and replay used to
 * route real requests without writing either, so their spend appeared in no
 * chart, total or per-connection budget, and a connection cap could be blown
 * from the dashboard without the gateway ever seeing it.
 */
export function recordRequest(
  input: RequestRecord,
  payloads: { request?: unknown; response?: unknown },
): void {
  persist(input, payloads);

  const winner = input.decision.winningAttempt;
  const attempt = winner === null ? null : (input.decision.attempts[winner] ?? null);
  if (input.status !== 'success' || attempt === null || input.usage === null) return;

  const settled = settleRequest(attempt.providerId, attempt.modelId, input.usage);
  try {
    recordUsageBucket({
      ts: input.decision.decidedAt,
      connectionId: attempt.connectionId,
      modelId: attempt.modelId,
      ok: true,
      promptTokens: input.usage.promptTokens,
      completionTokens: input.usage.completionTokens,
      costUsd: settled.costUsd,
      savedUsd: settled.savedUsd,
    });
  } catch (err) {
    logger.error('failed to record usage', { requestId: input.decision.requestId, err });
  }
}

function persist(input: RequestRecord, payloads: { request?: unknown; response?: unknown }): void {
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
    logger.error('failed to persist request log', { requestId: input.decision.requestId, err });
  }
}
