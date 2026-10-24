import { route } from '@/lib/router';
import {
  authenticate,
  corsHeaders,
  jsonError,
  policyDenied,
  preflight,
  statusForErrorKind,
} from '@/lib/api/respond';
import { speechSchema, firstIssue } from '@/lib/api/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Text-to-speech returns audio bytes, not JSON, so it bypasses the shared
 * handler: there is no usage object to parse and nothing to normalize. The
 * adapter hands back the upstream stream and it goes straight to the client.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = authenticate(req);
  if (auth.error !== null) return auth.error;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonError(400, 'Request body must be valid JSON.');
  }

  const parsed = speechSchema.safeParse(raw);
  if (!parsed.success) return jsonError(400, firstIssue(parsed.error));

  const body = parsed.data as Record<string, unknown>;
  const requestedModel = typeof body['model'] === 'string' ? body['model'] : 'auto';

  // This route skips the shared handler, so it has to apply a key's policy
  // restriction itself.
  const notAllowed = policyDenied(auth.key, requestedModel, req);
  if (notAllowed !== null) return notAllowed;

  const result = await route({
    modality: 'audio.speech',
    requestedModel,
    body,
    stream: true,
    apiKey: auth.key,
    signal: req.signal,
  });

  if (result.response === null || !result.response.ok) {
    const err = result.error;
    return jsonError(
      err === null ? 502 : statusForErrorKind(err.kind),
      err?.message ?? 'No provider could generate speech for this request.',
      'api_error',
      err?.kind ?? null,
    );
  }

  const upstream = result.response;
  const format = typeof body['response_format'] === 'string' ? body['response_format'] : 'mp3';
  const contentType = upstream.headers['content-type'] ?? audioMime(format);

  if (upstream.stream !== null) {
    return new Response(upstream.stream, {
      status: 200,
      headers: { 'content-type': contentType, ...corsHeaders(req) },
    });
  }

  return Response.json(upstream.json ?? {}, { headers: corsHeaders(req) });
}

function audioMime(format: string): string {
  switch (format) {
    case 'opus':
      return 'audio/opus';
    case 'aac':
      return 'audio/aac';
    case 'flac':
      return 'audio/flac';
    case 'wav':
      return 'audio/wav';
    case 'pcm':
      return 'audio/pcm';
    default:
      return 'audio/mpeg';
  }
}

export function OPTIONS(req: Request): Response {
  return preflight(req);
}
