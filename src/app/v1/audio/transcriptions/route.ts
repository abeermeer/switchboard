import type { TokenUsage } from '@/types/core';
import { route } from '@/lib/router';
import { recordRequest, traceHeaders } from '@/lib/api/handler';
import { getSettings } from '@/lib/db/repos/settings';
import { findModel } from '@/lib/providers/registry';
import { settleRequest } from '@/lib/usage/cost';
import {
  authenticate,
  clientMeta,
  corsHeaders,
  jsonError,
  policyDenied,
  preflight,
  statusForErrorKind,
} from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Speech-to-text is multipart, not JSON. The uploaded file is carried through
 * as-is on the body so the adapter can forward the original FormData — decoding
 * and re-encoding audio here would be pure overhead and would break any format
 * the gateway does not know about.
 */
export async function POST(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const { ip, userAgent } = clientMeta(req);
  const auth = authenticate(req);
  if (auth.error !== null) return auth.error;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, 'Request must be multipart/form-data with a "file" field.');
  }

  const file = form.get('file');
  if (file === null) {
    return jsonError(400, 'Missing required field: file.');
  }

  const model = form.get('model');
  const requestedModel = typeof model === 'string' && model.length > 0 ? model : 'auto';

  const notAllowed = policyDenied(auth.key, requestedModel, req);
  if (notAllowed !== null) return notAllowed;

  // The text fields alone are what a log row keeps; the audio stays out of it.
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') fields[key] = value;
  }
  const body: Record<string, unknown> = { __formData: form, ...fields };

  const result = await route({
    modality: 'audio.transcription',
    requestedModel,
    body,
    stream: false,
    apiKey: auth.key,
    signal: req.signal,
  });

  const logPayloads = getSettings().logPayloads;
  // This route bypasses the shared JSON pipeline, and used to bypass its log
  // too: a paid transcription reached no chart, total or key budget.
  const record = (
    status: 'success' | 'error',
    httpStatus: number,
    usage: TokenUsage | null,
    error: string | null,
    response: unknown,
  ): void => {
    recordRequest(
      {
        modality: 'audio.transcription',
        requestedModel,
        decision: result.decision,
        status,
        httpStatus,
        durationMs: Date.now() - startedAt,
        ttftMs: result.response?.ttftMs ?? null,
        streamed: false,
        usage,
        apiKeyId: auth.key?.id ?? null,
        ip,
        userAgent,
        error,
      },
      logPayloads ? { request: fields, response } : {},
    );
  };

  if (result.response === null || !result.response.ok) {
    const err = result.error;
    const status = err === null ? 502 : statusForErrorKind(err.kind);
    const message = err?.message ?? 'No provider could transcribe this audio.';
    record('error', status, null, message, { error: message });
    return jsonError(
      status,
      message,
      'api_error',
      err?.kind ?? null,
      traceHeaders(result.decision, 0, null, result.unrecognizedModel),
      req,
    );
  }

  const response = result.response;
  const winner = result.decision.winningAttempt;
  const attempt = winner === null ? null : (result.decision.attempts[winner] ?? null);
  const servedModel = attempt === null ? null : findModel(attempt.providerId, attempt.modelId);
  const settled = settleRequest(attempt?.providerId ?? null, attempt?.modelId ?? null, response.usage);

  record('success', response.httpStatus, response.usage, null, response.json);

  return Response.json(response.json ?? {}, {
    headers: {
      ...corsHeaders(req),
      ...traceHeaders(result.decision, settled.costUsd, servedModel, result.unrecognizedModel),
    },
  });
}

export function OPTIONS(req: Request): Response {
  return preflight(req);
}
