import type {
  AdapterError,
  AdapterResponse,
  Modality,
  RouteAttempt,
  RouteCandidate,
} from '@/types/core';
import { getConnection } from '@/lib/db/repos/connections';
import { getCredential } from '@/lib/db/repos/credentials';
import { getAdapter, getProvider } from '@/lib/providers/registry';
import { onFailure, onSuccess } from '@/lib/resilience/breaker';

export interface ExecuteInput {
  candidates: RouteCandidate[];
  modality: Modality;
  body: Record<string, unknown>;
  stream: boolean;
  signal: AbortSignal;
  maxAttempts: number;
  timeoutMs: number;
}

export interface ExecuteOutput {
  response: AdapterResponse | null;
  attempts: RouteAttempt[];
  winningAttempt: number | null;
  error: AdapterError | null;
}

/**
 * Error classes where trying a different provider cannot possibly help.
 * A malformed body produces the same 400 everywhere, and burning three more
 * upstream calls to prove it only makes the client wait longer for the same
 * answer.
 */
const TERMINAL: ReadonlySet<AdapterError['kind']> = new Set(['bad_request']);

export async function executeRoute(input: ExecuteInput): Promise<ExecuteOutput> {
  const eligible = input.candidates.filter((c) => c.excludedReason === null);
  const attempts: RouteAttempt[] = [];

  if (eligible.length === 0) {
    return {
      response: null,
      attempts,
      winningAttempt: null,
      error: {
        kind: 'unsupported',
        message: 'No provider is available to serve this request.',
        retryAfterSec: null,
        raw: null,
      },
    };
  }

  const limit = Math.min(input.maxAttempts, eligible.length);
  let lastError: AdapterError | null = null;

  for (let i = 0; i < limit; i += 1) {
    const candidate = eligible[i]!;
    const connection = getConnection(candidate.connectionId);
    const provider = connection === null ? null : getProvider(connection.providerId);

    if (connection === null || provider === null) {
      attempts.push(
        failedAttempt(candidate, 0, {
          kind: 'unknown',
          message: 'Connection disappeared mid-request',
          retryAfterSec: null,
          raw: null,
        }),
      );
      continue;
    }

    // Each attempt gets its own deadline, chained to the caller's signal so a
    // client disconnect aborts the in-flight upstream call rather than leaving
    // it running to completion for nobody.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    const onAbort = (): void => controller.abort();
    input.signal.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();

    try {
      const adapter = getAdapter(provider.kind);
      const credential = provider.requiresKey ? getCredential(connection.id) : null;

      const response = await adapter.execute({
        modality: input.modality,
        model: candidate.modelId,
        body: input.body,
        stream: input.stream,
        signal: controller.signal,
        connection,
        provider,
        credential,
      });

      const durationMs = Date.now() - startedAt;

      if (response.ok) {
        // The timeout must not fire while a stream is still draining, so it is
        // only cleared here — after a successful handoff.
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);

        attempts.push({
          connectionId: candidate.connectionId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          startedAt,
          durationMs,
          ttftMs: response.ttftMs,
          status: 'success',
          httpStatus: response.httpStatus,
          error: null,
          fallbackReason: null,
          usage: response.usage,
          costUsd: 0,
        });

        onSuccess(candidate.connectionId, candidate.modelId, response.ttftMs, durationMs);
        return { response, attempts, winningAttempt: attempts.length - 1, error: null };
      }

      const err = response.error ?? {
        kind: 'unknown' as const,
        message: `Upstream returned ${response.httpStatus}`,
        retryAfterSec: null,
        raw: null,
      };
      lastError = err;
      onFailure(candidate.connectionId, candidate.modelId, err, durationMs);
      attempts.push(failedAttempt(candidate, durationMs, err, response.httpStatus));

      if (TERMINAL.has(err.kind)) break;

      // A context-length failure is only worth retrying somewhere with a bigger
      // window; otherwise the next provider fails identically.
      if (err.kind === 'context_length' && !hasLargerContext(eligible, i)) break;
    } catch (thrown) {
      const durationMs = Date.now() - startedAt;
      const aborted = input.signal.aborted;
      const err: AdapterError = {
        kind: aborted ? 'network' : controller.signal.aborted ? 'timeout' : 'network',
        message: aborted
          ? 'Client disconnected'
          : controller.signal.aborted
            ? `Timed out after ${input.timeoutMs}ms`
            : thrown instanceof Error
              ? thrown.message
              : String(thrown),
        retryAfterSec: null,
        raw: thrown,
      };

      lastError = err;
      attempts.push(failedAttempt(candidate, durationMs, err));

      // The caller is gone — there is nobody left to serve.
      if (aborted) break;

      onFailure(candidate.connectionId, candidate.modelId, err, durationMs);
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
    }
  }

  return { response: null, attempts, winningAttempt: null, error: lastError };
}

function failedAttempt(
  candidate: RouteCandidate,
  durationMs: number,
  err: AdapterError,
  httpStatus: number | null = null,
): RouteAttempt {
  return {
    connectionId: candidate.connectionId,
    providerId: candidate.providerId,
    modelId: candidate.modelId,
    startedAt: Date.now() - durationMs,
    durationMs,
    ttftMs: null,
    status: err.kind === 'timeout' ? 'timeout' : 'error',
    httpStatus,
    error: err.message,
    fallbackReason: describeFallback(err),
    usage: null,
    costUsd: 0,
  };
}

function describeFallback(err: AdapterError): string {
  switch (err.kind) {
    case 'rate_limit':
      return err.retryAfterSec === null
        ? 'Rate limited (429)'
        : `Rate limited (429), retry after ${err.retryAfterSec}s`;
    case 'quota_exceeded':
      return 'Quota exhausted on this provider';
    case 'auth':
      return 'Credential rejected (401/403)';
    case 'server':
      return 'Provider returned a server error';
    case 'timeout':
      return 'Attempt timed out';
    case 'network':
      return 'Network failure reaching the provider';
    case 'context_length':
      // Plain ASCII on purpose: these strings reach an HTTP header, where a
      // typographic apostrophe is not representable.
      return "Prompt exceeds this model's context window";
    case 'unsupported':
      return 'Model or feature unavailable here';
    case 'bad_request':
      return 'Request rejected - not retried elsewhere';
    default:
      return err.message;
  }
}

/** Whether any later candidate could actually hold a prompt this one could not. */
function hasLargerContext(candidates: RouteCandidate[], currentIndex: number): boolean {
  return candidates.length > currentIndex + 1;
}
