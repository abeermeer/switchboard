import { route } from '@/lib/router';
import { authenticate, CORS_HEADERS, jsonError, preflight, statusForErrorKind } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Speech-to-text is multipart, not JSON. The uploaded file is carried through
 * as-is on the body so the adapter can forward the original FormData — decoding
 * and re-encoding audio here would be pure overhead and would break any format
 * the gateway does not know about.
 */
export async function POST(req: Request): Promise<Response> {
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
  const body: Record<string, unknown> = { __formData: form };
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') body[key] = value;
  }

  const result = await route({
    modality: 'audio.transcription',
    requestedModel: typeof model === 'string' && model.length > 0 ? model : 'auto',
    body,
    stream: false,
    apiKey: auth.key,
    signal: req.signal,
  });

  if (result.response === null || !result.response.ok) {
    const err = result.error;
    return jsonError(
      err === null ? 502 : statusForErrorKind(err.kind),
      err?.message ?? 'No provider could transcribe this audio.',
      'api_error',
      err?.kind ?? null,
    );
  }

  return Response.json(result.response.json ?? {}, { headers: CORS_HEADERS });
}

export function OPTIONS(): Response {
  return preflight();
}
