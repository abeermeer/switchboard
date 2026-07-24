import { z } from 'zod';
import { route } from '@/lib/router';
import { findModel } from '@/lib/providers/registry';
import { normalizeUsage, settleRequest } from '@/lib/usage/cost';
import { guard, handle, readBody } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  models: z.array(z.string().min(1)).min(1).max(4),
  messages: z.array(z.looseObject({})).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
});

/**
 * Runs one prompt against several models at once and streams the results back
 * as NDJSON, one frame per event. Each model races independently, so the UI can
 * render columns that fill in at their own pace rather than waiting for the
 * slowest to finish.
 *
 * NDJSON rather than SSE because every frame here is a discrete JSON object
 * addressed to one column; there is no single logical stream to reassemble.
 */
export function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const denied = guard(req);
    if (denied !== null) return denied;

    const parsed = await readBody(req, bodySchema);
    if ('error' in parsed) return parsed.error;

    const { models, messages, temperature, maxTokens } = parsed.data;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        const emit = (frame: Record<string, unknown>): void => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
          } catch {
            open = false;
          }
        };

        await Promise.all(
          models.map(async (model) => {
            const startedAt = Date.now();
            emit({ model, event: 'start', ts: startedAt });

            try {
              const result = await route({
                modality: 'chat',
                requestedModel: model,
                body: {
                  model,
                  messages,
                  stream: true,
                  ...(temperature === undefined ? {} : { temperature }),
                  ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
                },
                stream: true,
                apiKey: null,
                signal: req.signal,
              });

              const winner = result.decision.winningAttempt;
              const attempt = winner === null ? null : (result.decision.attempts[winner] ?? null);

              if (result.response === null || !result.response.ok || result.response.stream === null) {
                emit({
                  model,
                  event: 'error',
                  error: result.error?.message ?? 'No provider could serve this model.',
                  durationMs: Date.now() - startedAt,
                });
                return;
              }

              emit({
                model,
                event: 'routed',
                connectionId: attempt?.connectionId ?? null,
                providerId: attempt?.providerId ?? null,
                resolvedModel: attempt?.modelId ?? model,
              });

              const catalogModel =
                attempt === null ? null : findModel(attempt.providerId, attempt.modelId);

              const reader = result.response.stream.getReader();
              const decoder = new TextDecoder();
              let buffer = '';
              let ttftMs: number | null = null;
              let usage = result.response.usage;

              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;

                if (ttftMs === null) {
                  ttftMs = Date.now() - startedAt;
                  emit({ model, event: 'ttft', ttftMs });
                }

                buffer += decoder.decode(value, { stream: true });

                // SSE frames are separated by a blank line; anything after the
                // last separator is a partial frame to carry forward.
                const frames = buffer.split('\n\n');
                buffer = frames.pop() ?? '';

                for (const frame of frames) {
                  const line = frame.split('\n').find((l) => l.startsWith('data: '));
                  if (line === undefined) continue;

                  const payload = line.slice(6).trim();
                  if (payload === '[DONE]') continue;

                  try {
                    const json: unknown = JSON.parse(payload);
                    if (json === null || typeof json !== 'object') continue;
                    const record = json as Record<string, unknown>;

                    const parsedUsage = normalizeUsage(record['usage']);
                    if (parsedUsage !== null) usage = parsedUsage;

                    const choices = record['choices'];
                    if (!Array.isArray(choices)) continue;
                    const first = choices[0];
                    if (first === null || typeof first !== 'object') continue;

                    const delta = (first as Record<string, unknown>)['delta'];
                    if (delta === null || typeof delta !== 'object') continue;

                    const content = (delta as Record<string, unknown>)['content'];
                    if (typeof content === 'string' && content.length > 0) {
                      emit({ model, event: 'delta', delta: content });
                    }
                  } catch {
                    // A malformed frame from one provider must not kill the race.
                  }
                }
              }

              emit({
                model,
                event: 'done',
                usage,
                costUsd: settleRequest(attempt?.providerId ?? null, attempt?.modelId ?? null, usage).costUsd,
                ttftMs,
                durationMs: Date.now() - startedAt,
              });
            } catch (err) {
              emit({
                model,
                event: 'error',
                error: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - startedAt,
              });
            }
          }),
        );

        open = false;
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      },
    });
  });
}
