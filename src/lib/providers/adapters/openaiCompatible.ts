import type {
  AdapterError,
  AdapterRequest,
  AdapterResponse,
  Modality,
  ProviderAdapter,
  TokenUsage,
} from '@/types/core';
import {
  EXECUTE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  applyAuth,
  classifyHttpError,
  effectiveBaseUrl,
  extractErrorMessage,
  isRecord,
  networkError,
  normalizeUsage,
  passthroughSse,
  pickHeaders,
  safeJson,
  timedFetch,
} from './shared';

const MODALITY_PATHS: Record<Modality, string> = {
  chat: '/chat/completions',
  embeddings: '/embeddings',
  images: '/images/generations',
  'audio.speech': '/audio/speech',
  'audio.transcription': '/audio/transcriptions',
  rerank: '/rerank',
  moderation: '/moderations',
};

function failure(error: AdapterError, httpStatus: number, ttftMs: number | null): AdapterResponse {
  return {
    ok: false,
    httpStatus,
    json: null,
    stream: null,
    usage: null,
    ttftMs,
    error,
    headers: {},
  };
}

/** Transcription is the one endpoint that speaks multipart rather than JSON. */
function buildFormData(body: Record<string, unknown>, model: string): FormData {
  const form = new FormData();
  form.set('model', model);
  for (const [key, value] of Object.entries(body)) {
    if (key === 'model' || value === undefined || value === null) continue;
    if (value instanceof Blob) {
      const name = value instanceof File ? value.name : 'audio';
      form.set(key, value, name);
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      form.set(key, String(value));
    } else {
      form.set(key, JSON.stringify(value));
    }
  }
  return form;
}

function buildJsonBody(req: AdapterRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req.body, model: req.model };

  if (req.stream) {
    body.stream = true;
    // The only portable way to get token counts out of a streamed completion.
    if (req.modality === 'chat' && body.stream_options === undefined) {
      body.stream_options = { include_usage: true };
    }
  } else {
    delete body.stream;
    delete body.stream_options;
  }
  return body;
}

async function execute(req: AdapterRequest): Promise<AdapterResponse> {
  const startedAt = performance.now();
  const base = effectiveBaseUrl(req.connection, req.provider);

  let url: URL;
  try {
    url = new URL(base + MODALITY_PATHS[req.modality]);
  } catch {
    return failure(
      { kind: 'bad_request', message: `Invalid base URL: ${base}`, retryAfterSec: null, raw: base },
      0,
      null,
    );
  }

  const headers = new Headers({
    accept: req.stream ? 'text/event-stream' : 'application/json',
  });
  applyAuth(url, headers, req.provider, req.credential);

  let payload: BodyInit;
  if (req.modality === 'audio.transcription') {
    payload = buildFormData(req.body, req.model);
  } else {
    headers.set('content-type', 'application/json');
    payload = JSON.stringify(buildJsonBody(req));
  }

  let res: Response;
  try {
    res = await timedFetch(
      url.toString(),
      { method: 'POST', headers, body: payload },
      { timeoutMs: EXECUTE_TIMEOUT_MS, signal: req.signal },
    );
  } catch (err) {
    return failure(networkError(err), 0, null);
  }

  const headersReceivedMs = Math.round(performance.now() - startedAt);
  const surfaced = pickHeaders(res.headers);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return {
      ...failure(classifyHttpError(res.status, text, res.headers), res.status, headersReceivedMs),
      headers: surfaced,
    };
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const isJson = contentType.includes('json');
  // Some OpenAI-compatible servers omit the content-type on SSE responses, so a
  // requested stream that did not come back as JSON is treated as one.
  const isSse = contentType.includes('text/event-stream') || (req.stream && !isJson);

  if (res.body !== null && isSse) {
    const response: AdapterResponse = {
      ok: true,
      httpStatus: res.status,
      json: null,
      stream: null,
      usage: null,
      ttftMs: null,
      error: null,
      headers: surfaced,
    };
    // Mutated from inside the stream: both values only exist once bytes flow.
    response.stream = passthroughSse({
      upstream: res.body,
      onFirstChunk: () => {
        response.ttftMs = Math.round(performance.now() - startedAt);
      },
      onEvent: (event) => {
        if (event.data === '[DONE]') return;
        const parsed = safeJson(event.data);
        if (!isRecord(parsed)) return;
        const usage = normalizeUsage(parsed.usage);
        if (usage) response.usage = usage;
      },
    });
    return response;
  }

  // Audio speech (and any other binary endpoint) hands back raw bytes.
  if (res.body !== null && !isJson && !contentType.startsWith('text/')) {
    return {
      ok: true,
      httpStatus: res.status,
      json: null,
      stream: res.body,
      usage: null,
      ttftMs: headersReceivedMs,
      error: null,
      headers: surfaced,
    };
  }

  const text = await res.text().catch(() => '');
  const parsed = safeJson(text);
  if (!isRecord(parsed)) {
    return {
      ...failure(
        {
          kind: 'unknown',
          message: `Upstream returned non-JSON body: ${text.slice(0, 300)}`,
          retryAfterSec: null,
          raw: text.slice(0, 4_000),
        },
        res.status,
        headersReceivedMs,
      ),
      headers: surfaced,
    };
  }

  const usage: TokenUsage | null = normalizeUsage(parsed.usage);
  return {
    ok: true,
    httpStatus: res.status,
    json: parsed,
    stream: null,
    usage,
    ttftMs: headersReceivedMs,
    error: null,
    headers: surfaced,
  };
}

async function probe(
  req: Omit<AdapterRequest, 'body' | 'stream' | 'modality' | 'model'>,
): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const startedAt = performance.now();
  const base = effectiveBaseUrl(req.connection, req.provider);
  const path = req.provider.modelsPath;

  let url: URL;
  try {
    url = new URL(base + (path ?? ''));
  } catch {
    return { ok: false, latencyMs: 0, error: `Invalid base URL: ${base}` };
  }

  const headers = new Headers({ accept: 'application/json' });
  applyAuth(url, headers, req.provider, req.credential);

  try {
    const res = await timedFetch(
      url.toString(),
      { method: path === undefined ? 'HEAD' : 'GET', headers },
      { timeoutMs: PROBE_TIMEOUT_MS, signal: req.signal },
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    if (res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: true, latencyMs, error: null };
    }

    const text = await res.text().catch(() => '');
    const message = extractErrorMessage(safeJson(text), text || res.statusText);
    return { ok: false, latencyMs, error: `HTTP ${res.status}: ${message.slice(0, 200)}` };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - startedAt),
      error: networkError(err).message,
    };
  }
}

export const openaiCompatibleAdapter: ProviderAdapter = {
  kind: 'openai-compatible',
  supports: (): boolean => true,
  execute,
  probe,
};
