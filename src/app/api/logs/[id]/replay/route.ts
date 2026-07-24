import { getRequestLog } from '@/lib/db/repos/log';
import { route } from '@/lib/router';
import { findModel } from '@/lib/providers/registry';
import { settleRequest } from '@/lib/usage/cost';
import { fail, guard, handle, ok } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Re-issues a stored request through the router as it is configured *now*.
 *
 * The point is comparison: a request that failed over three providers last week
 * can be replayed after a config change to confirm the fix, with the original
 * decision returned alongside the new one.
 */
export function POST(req: Request, ctx: Ctx): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const { id } = await ctx.params;
    const original = getRequestLog(id);
    if (original === null) return fail(404, 'Request not found.');

    if (original.requestBody === null || typeof original.requestBody !== 'object') {
      return fail(
        400,
        'This request has no stored payload to replay. Enable payload logging in Settings to capture future requests.',
      );
    }

    const body = { ...(original.requestBody as Record<string, unknown>) };
    // Replaying a stream would produce bytes nobody is reading.
    delete body['stream'];

    const result = await route({
      modality: original.modality,
      requestedModel: original.requestedModel,
      body,
      stream: false,
      apiKey: null,
      signal: req.signal,
    });

    const winner = result.decision.winningAttempt;
    const attempt = winner === null ? null : (result.decision.attempts[winner] ?? null);
    const model = attempt === null ? null : findModel(attempt.providerId, attempt.modelId);

    return ok({
      original: {
        id: original.id,
        ts: original.ts,
        status: original.status,
        resolvedProviderId: original.resolvedProviderId,
        resolvedModelId: original.resolvedModelId,
        durationMs: original.durationMs,
        costUsd: original.costUsd,
        attemptCount: original.attemptCount,
        decision: original.decision,
      },
      replay: {
        ok: result.response?.ok ?? false,
        status: result.response === null || !result.response.ok ? 'error' : 'success',
        error: result.error?.message ?? null,
        resolvedProviderId: attempt?.providerId ?? null,
        resolvedModelId: attempt?.modelId ?? null,
        durationMs: result.decision.totalDurationMs,
        costUsd: settleRequest(attempt?.providerId ?? null, attempt?.modelId ?? null, result.response?.usage ?? null).costUsd,
        usage: result.response?.usage ?? null,
        attemptCount: result.decision.attempts.length,
        decision: result.decision,
        body: result.response?.json ?? null,
      },
    });
  });
}
