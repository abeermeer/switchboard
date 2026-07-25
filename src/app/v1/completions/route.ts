import { handleModality } from '@/lib/api/handler';
import { preflight } from '@/lib/api/respond';
import { chatSchema, completionSchema } from '@/lib/api/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The legacy completions endpoint, shimmed onto chat.
 *
 * Almost no provider still serves /v1/completions, but plenty of older tooling
 * still calls it. Rewriting the prompt into a single user message means those
 * clients keep working against every modern chat model.
 */
export async function POST(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: { message: 'Request body must be valid JSON.', type: 'invalid_request_error' },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return new Response(
      JSON.stringify({
        error: {
          message: issue === undefined ? 'Invalid request body.' : issue.message,
          type: 'invalid_request_error',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }

  const body = parsed.data as Record<string, unknown>;
  const prompt = body['prompt'];
  const text = Array.isArray(prompt) ? prompt.join('\n') : String(prompt ?? '');

  const { prompt: _dropped, ...rest } = body;
  void _dropped;

  const chatBody = { ...rest, messages: [{ role: 'user', content: text }] };

  const shimmed = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(chatBody),
    signal: req.signal,
  });

  // Validated against the chat schema now, since the body was rewritten into
  // chat shape above and no longer matches the completion schema.
  return handleModality(shimmed, 'chat', chatSchema);
}

export function OPTIONS(req: Request): Response {
  return preflight(req);
}
